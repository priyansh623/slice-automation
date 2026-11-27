/**
 * Following accepted video jobs to their end. Safe against every writer of the same row:
 *  - a row is CLAIMED (claimed_at, compare-and-set) before it is looked at, so two passes or two workers never handle one job;
 *  - every write says what it expects to find (still in flight, same provider job), so a stale answer can never overwrite a newer state;
 *  - a generation that has a stored video is never marked failed;
 *  - "completed, but no download link yet" means not ready (the provider documents it), not failed.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { adminSettings, videoGenerations, videoScreens } from '@/db/schema.pg';
import { storeGeneratedVideo } from '@/lib/object-store/generated-video';
import { AuthenticationError, OutputExpiredError, PermanentDownloadError, UnexpectedProviderError } from '@/providers/useapi/errors';
import type { VideoGenerationProvider } from '@/providers/useapi/interface';
import { useapiProvider } from '@/providers/useapi/provider';
import { mapLimit, roundRobin, RULES, UNCONFIRMED_MESSAGE } from '@/services/job-rules';

const IN_FLIGHT = ['pending', 'processing'];

export interface PollDeps {
  provider: Pick<VideoGenerationProvider, 'pollJob' | 'downloadVideo'>;
  store: (tempPath: string, screenId: number, generationId: number) => Promise<string>;
  now: () => number;
}
const defaultPollDeps = (): PollDeps => ({ provider: useapiProvider, store: storeGeneratedVideo, now: () => Date.now() });

type Generation = typeof videoGenerations.$inferSelect;

/** The only way the poller changes a row: still in flight and still the same provider job. Failure additionally requires that no video is stored. */
async function settle(g: Generation, set: Partial<typeof videoGenerations.$inferInsert>, opts: { failing?: boolean } = {}): Promise<boolean> {
  const rows = await db.update(videoGenerations).set(set)
    .where(and(eq(videoGenerations.id, g.id), eq(videoGenerations.jobId, g.jobId!), inArray(videoGenerations.status, IN_FLIGHT), opts.failing ? isNull(videoGenerations.videoStoragePath) : undefined))
    .returning({ id: videoGenerations.id });
  return rows.length > 0;
}
const release = (g: Generation, now: number) => settle(g, { claimedAt: null, updatedAt: now });
const failed = (g: Generation, message: string, now: number) => settle(g, { status: 'failed', errorMessage: message, claimedAt: null, updatedAt: now }, { failing: true });

export async function pollOneGeneration(generationId: number, deps: PollDeps = defaultPollDeps()): Promise<void> {
  const t = deps.now();
  const [g] = await db.update(videoGenerations).set({ claimedAt: t })
    .where(and(eq(videoGenerations.id, generationId), inArray(videoGenerations.status, IN_FLIGHT), isNotNull(videoGenerations.jobId),
      or(isNull(videoGenerations.claimedAt), lt(videoGenerations.claimedAt, t - RULES.pollLeaseMs))))
    .returning();
  if (!g) return;                                                    // finished, or someone else has it

  // A stored video is a finished generation, whatever else happened.
  if (g.videoStoragePath) { await settle(g, { status: 'completed', errorMessage: null, claimedAt: null, updatedAt: t }); return; }
  const age = t - g.createdAt;
  const tooOld = age > RULES.jobMaxAgeMs;
  const giveUpMessage = 'The video was not ready after 2 hours. It may still appear in Google Flow; check there before generating again.';

  try {
    const result = await deps.provider.pollJob(g.jobId!);
    const now = deps.now();
    if (typeof result.remainingCredits === 'number') {
      db.update(adminSettings).set({ lastSeenCredits: result.remainingCredits, lastSeenCreditsAt: now }).where(eq(adminSettings.id, 1)).catch(() => {});
    }
    if (result.status === 'failed') { console.warn(`[worker] Gen ${g.id} failed at the provider: ${result.errorMessage}`); await failed(g, friendlyProviderFailure(result.errorMessage), now); return; }
    if (result.status !== 'completed' || !result.videoUrl) {
      if (tooOld) { await failed(g, giveUpMessage, now); return; }
      await settle(g, { status: result.status === 'started' || result.status === 'completed' ? 'processing' : g.status, claimedAt: null, updatedAt: now });
      return;
    }
    const downloaded = await deps.provider.downloadVideo({ jobId: g.jobId!, signedUrl: result.videoUrl, outputMediaGenerationId: result.outputMediaGenerationId ?? null, jobCompletedAt: now });
    let storagePath: string;
    try { storagePath = await deps.store(downloaded.tempPath, g.videoScreenId, g.id); }
    catch (err) { const fs = await import('node:fs/promises'); await fs.unlink(downloaded.tempPath).catch(() => {}); throw err; }
    if (await settle(g, { status: 'completed', videoStoragePath: storagePath, mediaGenerationId: result.outputMediaGenerationId ?? g.mediaGenerationId, errorMessage: null, claimedAt: null, updatedAt: deps.now() })) {
      console.log(`[worker] Gen ${g.id} completed → ${storagePath}`);
    }
  } catch (err) {
    const now = deps.now();
    const gone = err instanceof UnexpectedProviderError && (err.httpStatus === 404 || err.httpStatus === 410);
    if (err instanceof PermanentDownloadError || err instanceof OutputExpiredError || gone) {
      console.error(`[worker] Gen ${g.id} permanently unavailable: ${(err as Error).message}`);
      await failed(g, 'The finished video is no longer available from the provider.', now);
      return;
    }
    if (err instanceof AuthenticationError) console.error('[worker] Video provider authentication failed (check USEAPI_TOKEN); jobs are kept and retried.');
    else console.error(`[worker] Gen ${g.id} check failed (will retry): ${(err as Error).message}`);
    if (tooOld) await failed(g, giveUpMessage, now); else await release(g, now);
  }
}

export function friendlyProviderFailure(raw: string | undefined): string {
  if (raw && /unsafe|policy|minor|prohibited|safety/i.test(raw)) return 'Google Flow refused this prompt or image under its content policy. Change it and generate again.';
  return 'Google Flow could not generate this video. You can generate it again.';
}

/** One pass over everything in flight: bounded, projects taking turns. */
export async function pollInFlightGenerations(deps: PollDeps = defaultPollDeps()): Promise<number> {
  const now = deps.now();
  const rows = await db.select({ id: videoGenerations.id, projectId: videoScreens.videoProjectId }).from(videoGenerations)
    .innerJoin(videoScreens, eq(videoScreens.id, videoGenerations.videoScreenId))
    .where(and(inArray(videoGenerations.status, IN_FLIGHT), isNotNull(videoGenerations.jobId), or(isNull(videoGenerations.claimedAt), lt(videoGenerations.claimedAt, now - RULES.pollLeaseMs))))
    .orderBy(asc(videoGenerations.createdAt), asc(videoGenerations.id));
  if (rows.length === 0) return 0;
  await mapLimit(roundRobin(rows, (r) => r.projectId), RULES.pollConcurrency(), (r) => pollOneGeneration(r.id, deps));
  return rows.length;
}

/**
 * Jobs abandoned by a process that ended. NOTHING IS EVER SENT AGAIN from here: a row without a provider job id may or may not have been accepted,
 * so it is failed with that explanation; a row with a job id is simply released and followed.
 */
export async function recoverAbandonedGenerations(now = Date.now()): Promise<{ unconfirmed: number }> {
  const unconfirmed = await db.update(videoGenerations).set({ status: 'failed', errorMessage: UNCONFIRMED_MESSAGE, claimedAt: null, updatedAt: now })
    .where(and(eq(videoGenerations.status, 'processing'), isNull(videoGenerations.jobId), isNull(videoGenerations.videoStoragePath),
      sql`coalesce(${videoGenerations.claimedAt}, ${videoGenerations.updatedAt}) < ${now - RULES.submitStaleMs}`))
    .returning({ id: videoGenerations.id });
  if (unconfirmed.length) console.warn(`[worker] ${unconfirmed.length} abandoned submission(s) marked unconfirmed (not re-sent): ${unconfirmed.map((r) => r.id).join(', ')}`);
  return { unconfirmed: unconfirmed.length };
}
