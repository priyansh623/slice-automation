/**
 * Running Studio generation jobs: submit queued jobs, poll running ones, store finished images in R2. Used by the Studio worker
 * loop (src/worker/studio.ts), which is separate from the video loop.
 *
 *   queued -> submitting -> processing -> succeeded | failed
 *                   \-> submit_unknown -> (late answer | lookup | idempotent resend | a person's decision)
 *
 * Rules this file keeps:
 *  - a job is sent to the provider once. As soon as the provider returns a job id it is saved (even if the answer is late, even for
 *    a job already closed), and from then on the job is only ever polled;
 *  - a timeout, an unclear error, or a restart while "submitting" does NOT mean the provider did nothing: the job becomes
 *    "submit_unknown". It is never resent blindly (that could pay for the same image twice). It is resolved only by: the provider's
 *    own late answer; a lookup by idempotency key (if the provider offers one); an automatic resend with the SAME key (only if the
 *    provider declares idempotent submits, a few times at most); or a person confirming that a duplicate charge is acceptable.
 *    Without those guarantees this code cannot give exactly-once submission, so it fails safe: it waits and shows the job;
 *  - only an explicit rejection from the provider (ProviderError, outcome 'rejected') fails a job at submit time;
 *  - every job fails or succeeds on its own: nothing here looks at, waits for or changes another job;
 *  - outputs are stored in R2 only, create-only, with a thumbnail, and never overwrite anything.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioJobs, studioOutputs } from '@/db/schema.pg';
import { outputKey, outputThumbKey, typeOfExt } from './keys';
import { inspectImage, makeGridThumbnail, sha256Of } from './image-store';
import { ProviderError, type ProviderOutput, type ReplacementProvider, type SubmitResult } from './provider';

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
    .set({ status: 'submitting', claimedAt: now, startedAt: sql`coalesce(${studioJobs.startedAt}, ${now})`, submitAttempts: sql`${studioJobs.submitAttempts} + 1`, updatedAt: now })
    .where(and(eq(studioJobs.status, 'queued'), sql`${studioJobs.id} = any(array(select id from studio_jobs where status = 'queued' order by id limit ${limit} for update skip locked))`))
    .returning();
}

const safeMessage = (m: string) => m.replace(/\s+/g, ' ').trim().slice(0, 300);

export async function failJob(job: JobRow, code: string, message: string, retryable: boolean, now = Date.now()): Promise<void> {
  await db.update(studioJobs)
    .set({ status: 'failed', errorCode: code, errorMessage: safeMessage(message), errorRetryable: retryable, claimedAt: null, nextPollAt: null, finishedAt: now, updatedAt: now })
    .where(and(eq(studioJobs.id, job.id), inArray(studioJobs.status, ['queued', 'submitting', 'submit_unknown', 'processing'])));
}

/** Stores a finished image and marks the job succeeded. Safe to run twice for the same job (the same key, one output row). */
export async function storeOutput(job: JobRow, output: ProviderOutput, deps: GenerationDeps, provider: ReplacementProvider): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const providerMs = deps.providerTimeoutMs ?? PROVIDER_CALL_TIMEOUT_MS;
  const storageMs = deps.storageTimeoutMs ?? STORAGE_CALL_TIMEOUT_MS;
  // A job that was already failed or finished (given up on while this result was on its way) is not touched again.
  const [live] = await db.select({ status: studioJobs.status }).from(studioJobs).where(eq(studioJobs.id, job.id)).limit(1);
  if (!live || !['submitting', 'submit_unknown', 'processing'].includes(live.status)) return;
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
    .where(and(eq(studioJobs.id, job.id), inArray(studioJobs.status, ['submitting', 'submit_unknown', 'processing'])));
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

/**
 * The provider has a job for this one. Its id is kept for good, and a job that was "sending" or "unknown" becomes "processing" (it
 * is only ever polled from now on). A job that was meanwhile failed by a person stays failed but still keeps the id, so a paid job
 * is never lost track of. Returns whether the job is now processing.
 */
export async function adoptProviderJob(jobId: number, providerJobId: string, now: number): Promise<boolean> {
  await recordProviderJobId(jobId, providerJobId);
  const moved = await db.update(studioJobs)
    .set({ status: 'processing', errorCode: null, errorMessage: null, errorRetryable: null, ambiguousAt: null, claimedAt: null, nextPollAt: now + pollDelayMs(0), updatedAt: now })
    .where(and(eq(studioJobs.id, jobId), inArray(studioJobs.status, ['submitting', 'submit_unknown']), eq(studioJobs.providerJobId, providerJobId)))
    .returning({ id: studioJobs.id });
  return moved.length > 0;
}

/** Marks a job whose submission outcome is not known. Guarded: only a job that is still "submitting" is changed. */
export async function markSubmitUnknown(jobId: number, code: string, message: string, now: number): Promise<boolean> {
  const rows = await db.update(studioJobs)
    .set({ status: 'submit_unknown', errorCode: code, errorMessage: safeMessage(message), errorRetryable: null, ambiguousAt: now, claimedAt: null, updatedAt: now })
    .where(and(eq(studioJobs.id, jobId), eq(studioJobs.status, 'submitting'))).returning({ id: studioJobs.id });
  return rows.length > 0;
}

class SubmitTimeout extends Error {}

const UNKNOWN_MESSAGE = 'The provider did not confirm this job, so it may or may not have started. It was not sent again, to avoid paying for it twice.';

/** Applies a provider answer that arrived AFTER we stopped waiting for it. Never throws. */
async function applyLateSubmitResult(job: JobRow, result: SubmitResult, deps: GenerationDeps, provider: ReplacementProvider): Promise<void> {
  const now = (deps.now ?? Date.now)();
  try {
    if (result.kind === 'accepted') {
      if (await adoptProviderJob(job.id, result.providerJobId, now)) console.log(`[studio-generation] job ${job.id}: the provider answered late; it is now being polled`);
      else console.warn(`[studio-generation] job ${job.id}: late provider answer recorded on a job that is no longer waiting`);
      return;
    }
    if (result.providerJobId) await recordProviderJobId(job.id, result.providerJobId);
    await storeOutput(job, result.output, deps, provider);
  } catch (err) {
    console.warn(`[studio-generation] job ${job.id}: could not apply a late provider answer:`, (err as Error).message?.slice(0, 120));
  }
}

/** Submits one claimed job. Never throws: success moves it on, a definite failure or an unknown outcome is recorded on that job alone. */
export async function submitJob(job: JobRow, deps: GenerationDeps): Promise<'processing' | 'succeeded' | 'failed' | 'submit_unknown'> {
  const now = deps.now ?? Date.now;
  const providerMs = deps.providerTimeoutMs ?? PROVIDER_CALL_TIMEOUT_MS;
  const storageMs = deps.storageTimeoutMs ?? STORAGE_CALL_TIMEOUT_MS;
  // A job that already has a provider job id (a late answer arrived after it was queued again) is never sent: it is only polled.
  if (job.providerJobId) return (await adoptProviderJob(job.id, job.providerJobId, now())) ? 'processing' : 'failed';
  let provider: ReplacementProvider;
  let inputs: [Buffer, Buffer];
  // Nothing has been sent yet, so a failure here is a plain failure.
  try {
    provider = deps.provider(job.provider);
    inputs = await withTimeout(Promise.all([deps.read(job.characterKey), deps.read(job.sourceKey)]), storageMs, 'storage_timeout', 'Reading the images took too long.');
  } catch (err) {
    const d = describe(err);
    console.error(`[studio-generation] job ${job.id} could not be prepared:`, d.code);
    await failJob(job, d.code, d.message, d.retryable, now()).catch((e) => console.error('[studio-generation] could not record a failure:', e));
    return 'failed';
  }

  // The request is sent. From here on a timeout or an unclear error does NOT mean the provider did nothing.
  const sending = provider.submit({
    jobId: job.id, idempotencyKey: submissionKey(job),
    characterImage: inputs[0], characterMime: typeOfExt(job.characterKey.split('.').pop() ?? '') ?? 'image/png',
    sourceImage: inputs[1], sourceMime: typeOfExt(job.sourceKey.split('.').pop() ?? '') ?? 'image/png',
  });
  let result: SubmitResult;
  try {
    let timer: ReturnType<typeof setTimeout>;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SubmitTimeout()), providerMs); });
    result = await Promise.race([sending, limit]).finally(() => clearTimeout(timer!));
  } catch (err) {
    if (err instanceof ProviderError && err.outcome === 'rejected') {
      console.error(`[studio-generation] job ${job.id} was rejected by the provider:`, err.code);
      await failJob(job, err.code, err.message, err.retryable, now()).catch((e) => console.error('[studio-generation] could not record a failure:', e));
      return 'failed';
    }
    const timedOut = err instanceof SubmitTimeout;
    console.warn(`[studio-generation] job ${job.id}: submission outcome unknown (${timedOut ? 'timeout' : err instanceof ProviderError ? err.code : (err as { name?: string }).name ?? 'error'})`);
    await markSubmitUnknown(job.id, timedOut ? 'submit_timeout' : 'submit_error', UNKNOWN_MESSAGE, now()).catch((e) => console.error('[studio-generation] could not record an unknown outcome:', e));
    // If the provider answers later, that answer is still used (its job id is recorded and the job is polled).
    if (timedOut) void sending.then((late) => applyLateSubmitResult(job, late, deps, provider)).catch(() => { /* a late failure leaves it unknown */ });
    return 'submit_unknown';
  }

  try {
    if (result.kind === 'accepted') return (await adoptProviderJob(job.id, result.providerJobId, now())) ? 'processing' : 'failed';
    if (result.providerJobId) await recordProviderJobId(job.id, result.providerJobId);
    try {
      await storeOutput(job, result.output, deps, provider);
    } catch (err) {
      // The provider already made this image. If it gave us an id, poll for it instead of failing (a retry would pay twice).
      if (result.providerJobId && !(err instanceof ProviderError && !err.retryable)) { await adoptProviderJob(job.id, result.providerJobId, now()); return 'processing'; }
      throw err;
    }
    return 'succeeded';
  } catch (err) {
    const d = describe(err);
    console.error(`[studio-generation] job ${job.id} failed after submission:`, d.code);
    await failJob(job, d.code, d.message, d.retryable, now()).catch((e) => console.error('[studio-generation] could not record a failure:', e));
    return 'failed';
  }
}

/** The idempotency key for a job: stable for the life of the job (and shared by every resend of it). */
export const submissionKey = (job: Pick<JobRow, 'id'>): string => `studio-job-${job.id}`;

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
 * After a restart: a job stuck "submitting" is NOT sent again (it may already have reached the provider); it becomes
 * "submit_unknown" (see reconcileAmbiguousJobs for how it is resolved). A running job (it has a provider id) is left alone and keeps being polled,
 * unless it has run far too long.
 */
export async function recoverStaleJobs(now = Date.now()): Promise<{ interrupted: number; timedOut: number }> {
  const interrupted = await db.update(studioJobs)
    .set({ status: 'submit_unknown', errorCode: 'submit_interrupted', errorMessage: 'This job was interrupted while it was being sent. It may or may not have reached the provider, so it was not sent again.', errorRetryable: null, ambiguousAt: now, claimedAt: null, updatedAt: now })
    .where(and(eq(studioJobs.status, 'submitting'), lt(studioJobs.claimedAt, now - SUBMIT_LEASE_MS))).returning({ id: studioJobs.id });
  const timedOut = await db.update(studioJobs)
    .set({ status: 'failed', errorCode: 'timed_out', errorMessage: 'The provider did not finish this job in time. Retry it if you need it.', errorRetryable: true, claimedAt: null, nextPollAt: null, finishedAt: now, updatedAt: now })
    .where(and(eq(studioJobs.status, 'processing'), or(lt(studioJobs.startedAt, now - JOB_MAX_AGE_MS), and(isNull(studioJobs.startedAt), lt(studioJobs.updatedAt, now - JOB_MAX_AGE_MS))))).returning({ id: studioJobs.id });
  return { interrupted: interrupted.length, timedOut: timedOut.length };
}

/** An unknown submission is left alone this long before an idempotent resend is considered (a late answer may still arrive). */
export const AMBIGUOUS_RESEND_AFTER_MS = 60_000;
/** The most times a job is sent to a provider that declares idempotent submits. */
export const MAX_IDEMPOTENT_SENDS = 3;

/**
 * Resolves jobs whose submission outcome is unknown, only in ways that cannot pay twice:
 *  - the provider can look the job up by idempotency key and has it: its id is recorded and the job is polled;
 *  - the provider declares idempotent submits: the SAME job (same key) is queued to be sent again, a few times at most;
 *  - otherwise nothing is done. The job stays visible as "submit_unknown" until a late answer arrives or a person decides.
 */
export async function reconcileAmbiguousJobs(deps: GenerationDeps, opts: { limit?: number; now?: number } = {}): Promise<{ adopted: number; requeued: number; waiting: number }> {
  const now = opts.now ?? (deps.now ?? Date.now)();
  const jobs = await db.select().from(studioJobs).where(eq(studioJobs.status, 'submit_unknown')).orderBy(asc(studioJobs.ambiguousAt)).limit(opts.limit ?? 20);
  const out = { adopted: 0, requeued: 0, waiting: 0 };
  for (const job of jobs) {
    try {
      const provider = deps.provider(job.provider);
      if (job.providerJobId) { if (await adoptProviderJob(job.id, job.providerJobId, now)) out.adopted++; continue; }
      if (provider.findSubmission) {
        const found = await withTimeout(provider.findSubmission(submissionKey(job)), deps.providerTimeoutMs ?? PROVIDER_CALL_TIMEOUT_MS, 'lookup_timeout', 'The provider did not answer in time.');
        if (found) { if (await adoptProviderJob(job.id, found.providerJobId, now)) out.adopted++; continue; }
      }
      if (provider.idempotentSubmit === true && job.submitAttempts < MAX_IDEMPOTENT_SENDS && (job.ambiguousAt ?? 0) <= now - AMBIGUOUS_RESEND_AFTER_MS) {
        const re = await db.update(studioJobs).set({ status: 'queued', errorCode: null, errorMessage: null, errorRetryable: null, ambiguousAt: null, claimedAt: null, updatedAt: now })
          .where(and(eq(studioJobs.id, job.id), eq(studioJobs.status, 'submit_unknown'), isNull(studioJobs.providerJobId))).returning({ id: studioJobs.id });
        if (re.length) { out.requeued++; continue; }
      }
      out.waiting++;
    } catch (err) {
      out.waiting++;
      console.warn(`[studio-generation] could not reconcile job ${job.id}:`, (err as Error).message?.slice(0, 120));
    }
  }
  return out;
}

/** One pass: submit up to `submitLimit` queued jobs and poll up to `pollLimit` due ones, all concurrently. Returns how many it handled. */
export async function generationRound(deps: GenerationDeps, limits: { submit: number; poll: number }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const claimed = deps.canSubmit && !deps.canSubmit() ? [] : await claimQueuedJobs(limits.submit, now);
  const due = await dueJobs(limits.poll, now);
  await Promise.all([...claimed.map((j) => submitJob(j, deps)), ...due.map((j) => pollJob(j, deps))]);
  return claimed.length + due.length;
}

