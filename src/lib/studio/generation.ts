/**
 * Running Studio generation jobs: submit queued jobs, poll running ones, store finished images in R2. Used by the Studio worker
 * loop (src/worker/studio.ts), which is separate from the video loop.
 *
 *   queued -> submitting -> processing -> succeeded | failed
 *
 * Rules this file keeps:
 *  - a job is submitted to the provider at most once. As soon as the provider returns a job id it is saved, and from then on
 *    the job is only ever polled;
 *  - a job found "submitting" after a restart is NOT submitted again automatically (it may already have reached the provider and
 *    cost money): it is marked failed as interrupted, and a person can retry it (a new job) if needed;
 *  - every job fails or succeeds on its own: nothing here looks at, waits for or changes another job;
 *  - outputs are stored in R2 only, create-only, with a thumbnail, and never overwrite anything.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioJobs, studioOutputs } from '@/db/schema.pg';
import { outputKey, outputThumbKey, typeOfExt } from './keys';
import { inspectImage, makeGridThumbnail, sha256Of } from './image-store';
import { ProviderError, type ProviderOutput, type ReplacementProvider } from './provider';

export const SUBMIT_LEASE_MS = 5 * 60 * 1000;
/** A job that has been running (counted from when it was sent to the provider, never from when it was queued) this long without a result is given up on (it can be retried as a new job). */
export const JOB_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Longest a single call to the provider (submit or poll) may take before it is given up on. */
export const PROVIDER_CALL_TIMEOUT_MS = 120_000;
/** Longest a single read or write against R2 may take. */
export const STORAGE_CALL_TIMEOUT_MS = 45_000;

/** Rejects with a ProviderError if `work` does not settle in `ms`. The underlying call is not cancelled, only no longer waited for. */
export function withTimeout<T>(work: Promise<T>, ms: number, code: string, message: string, retryable = true): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderError(message, code, retryable)), ms); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
const POLL_BACKOFF_S = [3, 5, 8, 13, 20, 30, 45, 60];
export const pollDelayMs = (pollCount: number): number => POLL_BACKOFF_S[Math.min(pollCount, POLL_BACKOFF_S.length - 1)] * 1000;

export type JobRow = typeof studioJobs.$inferSelect;

export interface GenerationDeps {
  provider: (id: string) => ReplacementProvider;
  /** Reads a stored image (R2). */
  read: (key: string) => Promise<Buffer>;
  /** Stores a new image in R2 only. Resolves to 'exists' if the key was already there (it is never overwritten). */
  put: (key: string, body: Buffer, mime: string) => Promise<'created' | 'exists'>;
  now?: () => number;
  /** Per-call time limits (tests shorten them). */
  providerTimeoutMs?: number;
  storageTimeoutMs?: number;
  /**
   * Whether new jobs may be sent right now (R2 reachable and a provider enabled). When it says no, queued jobs simply stay queued
   * (they are not claimed and not failed) while running jobs are still polled and finished.
   */
  canSubmit?: () => boolean;
}

const EXT_OF_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Takes up to `limit` queued jobs, oldest first. One atomic statement; two callers never get the same job. The ids are picked
 * with ARRAY(subquery), which Postgres evaluates once: `id IN (subquery LIMIT n)` can be re-evaluated and take more than n.
 */
export async function claimQueuedJobs(limit: number, now = Date.now()): Promise<JobRow[]> {
  return db.update(studioJobs)
    .set({ status: 'submitting', claimedAt: now, startedAt: now, updatedAt: now })
    .where(and(eq(studioJobs.status, 'queued'), sql`${studioJobs.id} = any(array(select id from studio_jobs where status = 'queued' order by id limit ${limit} for update skip locked))`))
    .returning();
}

const safeMessage = (m: string) => m.replace(/\s+/g, ' ').trim().slice(0, 300);

export async function failJob(job: JobRow, code: string, message: string, retryable: boolean, now = Date.now()): Promise<void> {
  await db.update(studioJobs)
    .set({ status: 'failed', errorCode: code, errorMessage: safeMessage(message), errorRetryable: retryable, claimedAt: null, nextPollAt: null, finishedAt: now, updatedAt: now })
    .where(and(eq(studioJobs.id, job.id), inArray(studioJobs.status, ['queued', 'submitting', 'processing'])));
}

/** Stores a finished image and marks the job succeeded. Safe to run twice for the same job (the same key, one output row). */
export async function storeOutput(job: JobRow, output: ProviderOutput, deps: GenerationDeps, provider: ReplacementProvider): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const providerMs = deps.providerTimeoutMs ?? PROVIDER_CALL_TIMEOUT_MS;
  const storageMs = deps.storageTimeoutMs ?? STORAGE_CALL_TIMEOUT_MS;
  // A job that was already failed or finished (given up on while this result was on its way) is not touched again.
  const [live] = await db.select({ status: studioJobs.status }).from(studioJobs).where(eq(studioJobs.id, job.id)).limit(1);
  if (!live || !['submitting', 'processing'].includes(live.status)) return;
  let bytes = output.bytes;
  if (!bytes && output.url) {
    if (!provider.fetchOutput) throw new ProviderError('The provider returned a link but cannot be downloaded from.', 'bad_output', false);
    bytes = await withTimeout(provider.fetchOutput(output.url), providerMs, 'download_timeout', 'Downloading the finished image took too long.');
  }
  if (!bytes || bytes.length === 0) throw new ProviderError('The provider returned an empty result.', 'bad_output', false);
  let info;
  try { info = await inspectImage(bytes); } catch { throw new ProviderError('The provider returned something that is not an image.', 'bad_output', false); }
  const mime = `image/${info.format}`;
  const ext = EXT_OF_MIME[mime];

  const key = outputKey(job.projectId, job.id, job.attempt, ext);
  await withTimeout(deps.put(key, bytes, mime), storageMs, 'storage_timeout', 'Saving the finished image took too long.');
  let thumbKey: string | null = outputThumbKey(job.projectId, job.id, job.attempt);
  try { await withTimeout(deps.put(thumbKey, await makeGridThumbnail(bytes), 'image/webp'), storageMs, 'storage_timeout', 'Saving the thumbnail took too long.'); } catch (err) { console.warn(`[studio-generation] no thumbnail for job ${job.id}:`, (err as Error).message.slice(0, 120)); thumbKey = null; }

  await db.insert(studioOutputs).values({
    jobId: job.id, projectId: job.projectId, assetId: job.assetId, storageKey: key, thumbKey, mime, sizeBytes: bytes.length, width: info.width, height: info.height, sha256: sha256Of(bytes), createdAt: now,
  }).onConflictDoNothing();
  await db.update(studioJobs).set({ status: 'succeeded', errorCode: null, errorMessage: null, errorRetryable: null, claimedAt: null, nextPollAt: null, finishedAt: now, updatedAt: now })
    .where(and(eq(studioJobs.id, job.id), inArray(studioJobs.status, ['submitting', 'processing'])));
}

const describe = (err: unknown): { code: string; message: string; retryable: boolean } => {
  if (err instanceof ProviderError) return { code: err.code, message: err.message, retryable: err.retryable };
  const e = err as { name?: string; status?: number };
  // Unknown errors may quote request details: keep only the class and status.
  return { code: 'error', message: `Generation failed (${e?.status ?? e?.name ?? 'error'}).`, retryable: true };
};

/** Records the provider's job id on a job that has none yet, whatever state the job is in (the database refuses to change it later). */
async function recordProviderJobId(jobId: number, providerJobId: string): Promise<void> {
  await db.update(studioJobs).set({ providerJobId }).where(and(eq(studioJobs.id, jobId), isNull(studioJobs.providerJobId)));
}

/** Submits one claimed job. Never throws: success moves it on, failure is recorded on that job alone. */
export async function submitJob(job: JobRow, deps: GenerationDeps): Promise<'processing' | 'succeeded' | 'failed'> {
  const now = deps.now ?? Date.now;
  const providerMs = deps.providerTimeoutMs ?? PROVIDER_CALL_TIMEOUT_MS;
  const storageMs = deps.storageTimeoutMs ?? STORAGE_CALL_TIMEOUT_MS;
  try {
    const provider = deps.provider(job.provider);
    const [characterImage, sourceImage] = await withTimeout(
      Promise.all([deps.read(job.characterKey), deps.read(job.sourceKey)]), storageMs, 'storage_timeout', 'Reading the images took too long.');
    const result = await withTimeout(provider.submit({
      jobId: job.id, idempotencyKey: `studio-job-${job.id}`,
      characterImage, characterMime: typeOfExt(job.characterKey.split('.').pop() ?? '') ?? 'image/png',
      sourceImage, sourceMime: typeOfExt(job.sourceKey.split('.').pop() ?? '') ?? 'image/png',
    }), providerMs, 'submit_timeout', 'The provider did not answer in time. It may or may not have started this job, so it was not sent again. Retry it if you need it.');
    if (result.kind === 'accepted') {
      // From this moment the job has its provider id for good and is only polled. The update only applies while the job is still
      // "submitting": if it was given up on meanwhile it stays failed, but the provider's id is still kept so nothing is lost track of.
      const moved = await db.update(studioJobs).set({ providerJobId: result.providerJobId, status: 'processing', claimedAt: null, nextPollAt: now() + pollDelayMs(0), updatedAt: now() })
        .where(and(eq(studioJobs.id, job.id), eq(studioJobs.status, 'submitting'), isNull(studioJobs.providerJobId))).returning({ id: studioJobs.id });
      if (moved.length === 0) { await recordProviderJobId(job.id, result.providerJobId); return 'failed'; }
      return 'processing';
    }
    if (result.providerJobId) await recordProviderJobId(job.id, result.providerJobId);
    await storeOutput(job, result.output, deps, provider);
    return 'succeeded';
  } catch (err) {
    const d = describe(err);
    console.error(`[studio-generation] job ${job.id} failed to submit:`, d.code);
    await failJob(job, d.code, d.message, d.retryable, now()).catch((e) => console.error('[studio-generation] could not record a failure:', e));
    return 'failed';
  }
}

/** Polls one running job. Never throws. A transient error just means "ask again later". */
export async function pollJob(job: JobRow, deps: GenerationDeps): Promise<'processing' | 'succeeded' | 'failed'> {
  const now = deps.now ?? Date.now;
  try {
    const provider = deps.provider(job.provider);
    const r = await withTimeout(provider.poll(job.providerJobId!), deps.providerTimeoutMs ?? PROVIDER_CALL_TIMEOUT_MS, 'poll_timeout', 'The provider did not answer in time.');
    if (r.status === 'succeeded') { await storeOutput(job, r.output, deps, provider); return 'succeeded'; }
    if (r.status === 'failed') { await failJob(job, r.code, r.message, r.retryable, now()); return 'failed'; }
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) { await failJob(job, err.code, err.message, false, now()); return 'failed'; }
    if (!(err instanceof ProviderError)) console.warn(`[studio-generation] polling job ${job.id} failed, will ask again:`, (err as { name?: string }).name ?? 'Error');
  }
  await db.update(studioJobs).set({ pollCount: sql`${studioJobs.pollCount} + 1`, nextPollAt: now() + pollDelayMs(job.pollCount + 1), updatedAt: now() }).where(and(eq(studioJobs.id, job.id), eq(studioJobs.status, 'processing')));
  return 'processing';
}

/** Running jobs whose turn to be polled has come. */
export async function dueJobs(limit: number, now = Date.now()): Promise<JobRow[]> {
  return db.select().from(studioJobs).where(and(eq(studioJobs.status, 'processing'), isNotNull(studioJobs.providerJobId), lte(studioJobs.nextPollAt, now))).orderBy(asc(studioJobs.nextPollAt)).limit(limit);
}

/**
 * After a restart: a job stuck "submitting" is NOT sent again (it may already have reached the provider); it is failed as
 * interrupted so a person can retry it deliberately. A running job (it has a provider id) is left alone and keeps being polled,
 * unless it has run far too long.
 */
export async function recoverStaleJobs(now = Date.now()): Promise<{ interrupted: number; timedOut: number }> {
  const interrupted = await db.update(studioJobs)
    .set({ status: 'failed', errorCode: 'submit_interrupted', errorMessage: 'This job was interrupted while it was being sent. It may or may not have reached the provider, so it was not sent again. Retry it if you need it.', errorRetryable: true, claimedAt: null, finishedAt: now, updatedAt: now })
    .where(and(eq(studioJobs.status, 'submitting'), lt(studioJobs.claimedAt, now - SUBMIT_LEASE_MS))).returning({ id: studioJobs.id });
  const timedOut = await db.update(studioJobs)
    .set({ status: 'failed', errorCode: 'timed_out', errorMessage: 'The provider did not finish this job in time. Retry it if you need it.', errorRetryable: true, claimedAt: null, nextPollAt: null, finishedAt: now, updatedAt: now })
    .where(and(eq(studioJobs.status, 'processing'), or(lt(studioJobs.startedAt, now - JOB_MAX_AGE_MS), and(isNull(studioJobs.startedAt), lt(studioJobs.updatedAt, now - JOB_MAX_AGE_MS))))).returning({ id: studioJobs.id });
  return { interrupted: interrupted.length, timedOut: timedOut.length };
}

/** One pass: submit up to `submitLimit` queued jobs and poll up to `pollLimit` due ones, all concurrently. Returns how many it handled. */
export async function generationRound(deps: GenerationDeps, limits: { submit: number; poll: number }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const claimed = deps.canSubmit && !deps.canSubmit() ? [] : await claimQueuedJobs(limits.submit, now);
  const due = await dueJobs(limits.poll, now);
  await Promise.all([...claimed.map((j) => submitJob(j, deps)), ...due.map((j) => pollJob(j, deps))]);
  return claimed.length + due.length;
}

