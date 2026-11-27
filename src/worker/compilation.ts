/**
 * Video compilation worker.
 *
 * Picks up pending videoCompilations rows and resolves scene selections from compilationSceneSelections.
 *
 *  - When every selected clip has a mediaGenerationId, it calls POST /v1/google-flow/videos/concatenate (useapi.net).
 *  - When any selected clip lacks one (older generations), it joins the clips' stored MP4 files with FFmpeg instead.
 *    That path spends no useapi.net credits and never regenerates a clip. Newer and older clips can be mixed.
 *
 * The result is uploaded to storage and the row is marked completed with the next version number for its project.
 * A failed compilation only marks its own row failed: earlier compilations are never touched.
 * 2–10 clips are supported.
 */

import { isVideoProjectDeleted, PROJECT_DELETED_MESSAGE } from '../lib/project-deletion';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { decodeConcatAnswer } from './concat-stream';
import { CompilationError } from './compilation-error';
import { getStorage } from '../lib/object-store';
import { db } from '../db';
import {
  videoCompilations,
  compilationSceneSelections,
  videoGenerations,
  videoScreens,
  videoProjects,
  adminSettings,
} from '../db/schema.pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { compileWithFfmpeg } from './compilation-ffmpeg';
import { applyOverlays, type CompiledScene } from './compilation-overlay-run';
import { safely, startMemoryProbe, WORKER_LIFETIME } from './container-memory';
import { ffmpegClipLimitMessage, MAX_COMPILATION_CLIPS, MAX_FFMPEG_COMPILATION_CLIPS, MIN_COMPILATION_CLIPS } from '../lib/compilation-versions';

export type CompilationMethod = 'useapi' | 'ffmpeg';

const CONCATENATE_URL = 'https://api.useapi.net/v1/google-flow/videos/concatenate';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.USEAPI_TOKEN}` };
}

// ── Public entry point ────────────────────────────────────────────────────────

export { CompilationError };

/** Successful joins take about 45 s (production median 44 s); four minutes is far beyond normal, and a call that never answers must not hang for ever. */
export const CONCAT_TIMEOUT_MS = 4 * 60_000;
export interface CompilationOptions { concatTimeoutMs?: number; retryDelayMs?: number; uploadTimeoutMs?: number }

/** What is being compiled right now (for the crash report). */
export let activeCompilationId: number | null = null;

/** A storage write that has not finished after this long is not going to; the compilation fails instead of holding the compile loop for ever. */
export const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export const INTERRUPTED_COMPILATION_MESSAGE = 'The worker restarted while this compilation was running. Please compile again.';

/**
 * Run once at worker startup, after the advisory lock is held. Only one worker can hold that lock, so any compilation
 * still marked 'processing' at this point belongs to a worker that no longer exists (it crashed, ran out of memory or
 * was redeployed). Such a compilation is marked failed instead of being queued again: re-running it could crash the
 * worker in a loop, would spend useapi.net credits twice, and would leave the project unable to start a new compilation
 * (only one compilation per project may be waiting or running). The user simply compiles again; earlier versions and
 * 'pending' compilations are not touched.
 */
export async function recoverStaleCompilations(): Promise<number> {
  const rows = await db
    .update(videoCompilations)
    .set({ status: 'failed', claimedAt: null, errorMessage: INTERRUPTED_COMPILATION_MESSAGE, updatedAt: Date.now() })
    .where(eq(videoCompilations.status, 'processing'))
    .returning({ id: videoCompilations.id });
  if (rows.length > 0) console.warn(`[compilation] Marked ${rows.length} interrupted compilation(s) as failed: ${rows.map((r) => r.id).join(', ')} (the worker process that was running them ended; this worker is lifetime ${WORKER_LIFETIME.id}, memory readings of those runs are not comparable)`);
  return rows.length;
}

export async function processPendingCompilation(options: CompilationOptions = {}): Promise<boolean> {
  const rows = await db
    .select()
    .from(videoCompilations)
    .where(eq(videoCompilations.status, 'pending'))
    .orderBy(asc(videoCompilations.createdAt))
    .limit(1);

  const candidate = rows[0];
  if (!candidate) return false;

  // Claim it only if it is still pending, so two workers can never run the same compilation.
  const now = Date.now();
  const claimed = await db
    .update(videoCompilations)
    .set({ status: 'processing', claimedAt: now, updatedAt: now })
    .where(and(eq(videoCompilations.id, candidate.id), eq(videoCompilations.status, 'pending')))
    .returning({ id: videoCompilations.id });
  if (claimed.length === 0) return true;
  const compilation = candidate;
  const startedAt = Date.now();
  console.log(`[compilation] Job ${compilation.id} (project ${compilation.videoProjectId}) started, rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
  const memoryProbe = safely(startMemoryProbe); // measurement only, immediately before the work: can never throw into the job or change what it does

  activeCompilationId = compilation.id;
  try {
    if (await isVideoProjectDeleted(compilation.videoProjectId)) throw new CompilationError(PROJECT_DELETED_MESSAGE);
    const { outputStoragePath, method } = await runCompilation(compilation.videoProjectId, compilation.id, options);
    safely(() => memoryProbe?.finish(compilation.id, 'completed')); // immediately after the work, before any database write
    const version = await markCompleted(compilation.videoProjectId, compilation.id, outputStoragePath, method);
    console.log(`[compilation] Job ${compilation.id} completed as version ${version} (${method}) in ${Math.round((Date.now() - startedAt) / 1000)} s → ${outputStoragePath}`);
  } catch (err: unknown) {
    safely(() => memoryProbe?.finish(compilation.id, 'failed')); // first thing: before the failure is written to the database
    // Only this row changes. Earlier successful compilations keep their files, versions and availability.
    // The person sees a plain message; the full technical error is in the worker log below.
    await db
      .update(videoCompilations)
      .set({
        status: 'failed',
        claimedAt: null,
        errorMessage: err instanceof CompilationError ? err.message : `The video could not be compiled. Please try again. If it keeps failing, report compilation ${compilation.id}.`,
        updatedAt: Date.now(),
      })
      .where(and(eq(videoCompilations.id, compilation.id), eq(videoCompilations.status, 'processing')));
    console.error(`[compilation] Job ${compilation.id} failed after ${Math.round((Date.now() - startedAt) / 1000)} s, rss=${Math.round(process.memoryUsage().rss / 1048576)}MB:`, err);
  } finally {
    activeCompilationId = null;
  }

  return true;
}

/**
 * Marks the compilation completed and gives it the next version number of its project. Runs in one transaction that
 * holds the project row lock, so version numbers are unique and gap-free however jobs are scheduled. Completed rows
 * that have no version yet (made before migration 0024 was applied) are numbered first, in creation order.
 */
export async function markCompleted(projectId: number, compilationId: number, outputStoragePath: string, method: CompilationMethod): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.select({ id: videoProjects.id }).from(videoProjects).where(eq(videoProjects.id, projectId)).for('update');

    const [{ maxVersion }] = await tx
      .select({ maxVersion: sql<number>`coalesce(max(${videoCompilations.version}), 0)::int` })
      .from(videoCompilations)
      .where(eq(videoCompilations.videoProjectId, projectId));
    let next = Number(maxVersion);

    const unnumbered = await tx
      .select({ id: videoCompilations.id })
      .from(videoCompilations)
      .where(and(
        eq(videoCompilations.videoProjectId, projectId),
        eq(videoCompilations.status, 'completed'),
        sql`${videoCompilations.version} is null`,
      ))
      .orderBy(asc(videoCompilations.createdAt), asc(videoCompilations.id));
    for (const row of unnumbered) {
      next += 1;
      await tx.update(videoCompilations).set({ version: next }).where(eq(videoCompilations.id, row.id));
    }

    next += 1;
    // Only a compilation that is still running can complete. If it was marked failed in the meantime (for example by
    // startup recovery), nothing changes and no version number is used: throwing rolls this whole transaction back.
    const done = await tx
      .update(videoCompilations)
      .set({ status: 'completed', outputStoragePath, method, version: next, claimedAt: null, errorMessage: null, updatedAt: Date.now() })
      .where(and(eq(videoCompilations.id, compilationId), eq(videoCompilations.status, 'processing')))
      .returning({ id: videoCompilations.id });
    if (done.length === 0) throw new Error(`Compilation ${compilationId} is no longer running; it was not marked completed`);
    return next;
  });
}

// ── Internal implementation ───────────────────────────────────────────────────

async function runCompilation(projectId: number, compilationId: number, options: CompilationOptions = {}): Promise<{ outputStoragePath: string; method: CompilationMethod }> {
  // Fetch scene selections ordered by screen position
  const selections = await db
    .select({
      videoGenerationId: compilationSceneSelections.videoGenerationId,
      videoScreenId: compilationSceneSelections.videoScreenId,
      position: videoScreens.position,
      screenNumber: videoScreens.screenNumber,
    })
    .from(compilationSceneSelections)
    .innerJoin(videoScreens, eq(compilationSceneSelections.videoScreenId, videoScreens.id))
    .where(eq(compilationSceneSelections.compilationId, compilationId))
    .orderBy(asc(videoScreens.position));

  if (selections.length === 0) throw new Error(`Compilation ${compilationId} has no scene selections`);
  if (selections.length < MIN_COMPILATION_CLIPS) throw new Error(`Compilation ${compilationId} needs at least ${MIN_COMPILATION_CLIPS} clips (got ${selections.length})`);
  if (selections.length > MAX_COMPILATION_CLIPS) throw new Error(`Compilation ${compilationId} has too many clips (${selections.length}); max is ${MAX_COMPILATION_CLIPS}`);

  // Look up each clip's media ID (for the concatenate endpoint) and its stored video file (for the FFmpeg path)
  const clips: { sceneNumber: number; mediaGenerationId: string | null; videoStoragePath: string | null }[] = [];
  const compiledScenes: CompiledScene[] = [];
  for (const sel of selections) {
    const genRows = await db
      .select({ mediaGenerationId: videoGenerations.mediaGenerationId, videoStoragePath: videoGenerations.videoStoragePath, durationSeconds: videoGenerations.durationSeconds })
      .from(videoGenerations)
      .where(eq(videoGenerations.id, sel.videoGenerationId))
      .limit(1);
    const gen = genRows[0];
    if (!gen) throw new Error(`Generation ${sel.videoGenerationId} not found`);
    clips.push({ sceneNumber: sel.screenNumber, mediaGenerationId: gen.mediaGenerationId, videoStoragePath: gen.videoStoragePath });
    compiledScenes.push({ screenId: sel.videoScreenId, sceneNumber: sel.screenNumber, storagePath: gen.videoStoragePath, nominalSeconds: gen.durationSeconds });
  }

  const outputStoragePath = `compilations/${projectId}/${Date.now()}-compilation-${compilationId}.mp4`;

  const joinStoredFiles = async (): Promise<{ outputStoragePath: string; method: CompilationMethod }> => {
    // Safety net behind the API check (a job created before the limit existed, or by another path): fail before any download.
    if (clips.length > MAX_FFMPEG_COMPILATION_CLIPS) throw new CompilationError(ffmpegClipLimitMessage(clips.length));
    const missing = clips.find((c) => !c.videoStoragePath);
    if (missing) throw new CompilationError(`Scene ${missing.sceneNumber} clip has no stored video file, so it cannot be compiled.`);
    const settings = await db.select({ crf: adminSettings.compilationCrf }).from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
    const crf = settings[0]?.crf ?? 23;
    const video = await compileWithFfmpeg(
      clips.map((c) => ({ storagePath: c.videoStoragePath! })),
      crf,
      { download: (p) => getStorage().download('videos', p) },
    );
    await uploadResult(outputStoragePath, await withOverlays(compilationId, compiledScenes, video, crf), options.uploadTimeoutMs);
    return { outputStoragePath, method: 'ffmpeg' };
  };

  // Any clip without a media ID (an older generation) means the concatenate endpoint cannot take the whole set, so the
  // stored files are joined with FFmpeg instead. Newer and older clips can be mixed this way.
  if (clips.some((c) => !c.mediaGenerationId)) {
    console.log(`[compilation] Job ${compilationId}: ${clips.filter((c) => !c.mediaGenerationId).length} of ${clips.length} clips have no media ID; joining stored files with FFmpeg`);
    return joinStoredFiles();
  }

  let videoBuffer: Buffer;
  try {
    videoBuffer = await concatenateWithFlow(compilationId, clips.map((c) => c.mediaGenerationId!), options);
  } catch (err) {
    // The provider could not join them. The stored files can be joined here instead, at no cost, when the set is within what this worker can take.
    const canFallBack = clips.length <= MAX_FFMPEG_COMPILATION_CLIPS && clips.every((c) => !!c.videoStoragePath);
    console.warn(`[compilation] Job ${compilationId}: concatenate failed (${(err as Error).message}); ${canFallBack ? 'joining the stored files with FFmpeg' : 'no fallback for this set'}`);
    if (!canFallBack) throw err;
    return joinStoredFiles();
  }

  const settings = await db.select({ crf: adminSettings.compilationCrf }).from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
  await uploadResult(outputStoragePath, await withOverlays(compilationId, compiledScenes, videoBuffer, settings[0]?.crf ?? 23), options.uploadTimeoutMs);
  return { outputStoragePath, method: 'useapi' };
}

/**
 * Asks Google Flow to join the clips. One retry, and only when the provider said it did NOT take the request (busy, unavailable or session being
 * re-verified); after a timeout or a lost connection the request may have run, so it is not repeated.
 */
async function concatenateWithFlow(compilationId: number, mediaGenerationIds: string[], options: CompilationOptions): Promise<Buffer> {
  const timeoutMs = options.concatTimeoutMs ?? CONCAT_TIMEOUT_MS;
  for (let attempt = 1; ; attempt++) {
    console.log(`[compilation] Calling concatenate for job ${compilationId} with ${mediaGenerationIds.length} clips (attempt ${attempt})`);
    const res = await fetch(CONCATENATE_URL, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ media: mediaGenerationIds.map((id) => ({ mediaGenerationId: id })) }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if ([429, 503, 596].includes(res.status) && attempt === 1) {
      await res.text().catch(() => '');
      console.warn(`[compilation] Job ${compilationId}: provider busy (${res.status}), retrying once`);
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 30_000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Concatenate API error ${res.status}: ${text.slice(0, 500)}`);
    }
    if (!res.body) throw new Error('Concatenate response was empty');

    const tmp = path.join(os.tmpdir(), `soma-concat-${compilationId}-${Date.now()}.mp4`);
    try {
      const decoded = await decodeConcatAnswer(res.body, tmp);
      if (decoded.bytes > 0) return await fs.readFile(tmp);
      let videoUrl: string | undefined;
      try { videoUrl = (JSON.parse(decoded.rest) as { videoUrl?: string }).videoUrl; } catch { /* not JSON */ }
      if (!videoUrl) throw new Error(`Concatenate response missing video data: ${decoded.rest.slice(0, 200)}`);
      const dlRes = await fetch(videoUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!dlRes.ok) throw new Error(`Failed to download concatenated video: ${dlRes.status}`);
      return Buffer.from(await dlRes.arrayBuffer());
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
}

/** A compilation with no overlays returns its video untouched (one cheap query); only one with overlays runs the compositing pass. */
async function withOverlays(compilationId: number, scenes: CompiledScene[], video: Buffer, crf: number): Promise<Buffer> {
  const out = await applyOverlays(compilationId, scenes, video, crf);
  if (out.overlays > 0 && 'passes' in out) console.log(`[compilation] Job ${compilationId}: added ${out.overlays} B-roll overlay(s) in ${out.passes} pass(es), ${out.elapsedMs} ms`);
  return out.video;
}

async function uploadResult(outputStoragePath: string, video: Buffer, timeoutMs = UPLOAD_TIMEOUT_MS): Promise<void> {
  // Store the compilation (Supabase Storage today; R2 once configured)
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      getStorage().put('videos', outputStoragePath, video, { contentType: 'video/mp4' }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('upload timed out')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  } catch (uploadErr) {
    console.error('[compilation] Upload failed:', uploadErr);
    throw new CompilationError('Upload failed: the video was made but could not be saved. Please compile again.');
  }
}
