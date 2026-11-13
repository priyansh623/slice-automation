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
import { logCompilationMemory, safely, snapshotMemory } from './container-memory';
import { MAX_COMPILATION_CLIPS, MIN_COMPILATION_CLIPS } from '../lib/compilation-versions';

export type CompilationMethod = 'useapi' | 'ffmpeg';

const CONCATENATE_URL = 'https://api.useapi.net/v1/google-flow/videos/concatenate';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.USEAPI_TOKEN}` };
}

// ── Public entry point ────────────────────────────────────────────────────────

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
  if (rows.length > 0) console.warn(`[compilation] Marked ${rows.length} interrupted compilation(s) as failed: ${rows.map((r) => r.id).join(', ')}`);
  return rows.length;
}

export async function processPendingCompilation(): Promise<boolean> {
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
  const memoryBefore = safely(snapshotMemory); // measurement only: read-only, can never throw into the job, never changes what it does

  try {
    const { outputStoragePath, method } = await runCompilation(compilation.videoProjectId, compilation.id);
    safely(() => logCompilationMemory(compilation.id, 'completed', memoryBefore, snapshotMemory)); // right after the work, before the DB write
    const version = await markCompleted(compilation.videoProjectId, compilation.id, outputStoragePath, method);
    console.log(`[compilation] Job ${compilation.id} completed as version ${version} (${method}) → ${outputStoragePath}`);
  } catch (err: unknown) {
    // Only this row changes. Earlier successful compilations keep their files, versions and availability.
    await db
      .update(videoCompilations)
      .set({
        status: 'failed',
        claimedAt: null,
        errorMessage: (err instanceof Error ? err.message : String(err)),
        updatedAt: Date.now(),
      })
      .where(and(eq(videoCompilations.id, compilation.id), eq(videoCompilations.status, 'processing')));
    console.error(`[compilation] Job ${compilation.id} failed:`, err);
    safely(() => logCompilationMemory(compilation.id, 'failed', memoryBefore, snapshotMemory));
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

async function runCompilation(projectId: number, compilationId: number): Promise<{ outputStoragePath: string; method: CompilationMethod }> {
  // Fetch scene selections ordered by screen position
  const selections = await db
    .select({
      videoGenerationId: compilationSceneSelections.videoGenerationId,
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
  for (const sel of selections) {
    const genRows = await db
      .select({ mediaGenerationId: videoGenerations.mediaGenerationId, videoStoragePath: videoGenerations.videoStoragePath })
      .from(videoGenerations)
      .where(eq(videoGenerations.id, sel.videoGenerationId))
      .limit(1);
    const gen = genRows[0];
    if (!gen) throw new Error(`Generation ${sel.videoGenerationId} not found`);
    clips.push({ sceneNumber: sel.screenNumber, mediaGenerationId: gen.mediaGenerationId, videoStoragePath: gen.videoStoragePath });
  }

  const outputStoragePath = `compilations/${projectId}/${Date.now()}-compilation-${compilationId}.mp4`;

  // Any clip without a media ID (an older generation) means the concatenate endpoint cannot take the whole set, so the
  // stored files are joined with FFmpeg instead. Newer and older clips can be mixed this way.
  if (clips.some((c) => !c.mediaGenerationId)) {
    const missing = clips.find((c) => !c.videoStoragePath);
    if (missing) throw new Error(`Scene ${missing.sceneNumber} clip has no stored video file, so it cannot be compiled.`);
    console.log(`[compilation] Job ${compilationId}: ${clips.filter((c) => !c.mediaGenerationId).length} of ${clips.length} clips have no media ID; joining stored files with FFmpeg`);
    const settings = await db.select({ crf: adminSettings.compilationCrf }).from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
    const crf = settings[0]?.crf ?? 23;
    const video = await compileWithFfmpeg(
      clips.map((c) => ({ storagePath: c.videoStoragePath! })),
      crf,
      { download: (p) => getStorage().download('videos', p) },
    );
    await uploadResult(outputStoragePath, video);
    return { outputStoragePath, method: 'ffmpeg' };
  }

  const mediaGenerationIds = clips.map((c) => c.mediaGenerationId!);

  // Call useapi.net concatenate endpoint (synchronous, ~15-25s)
  console.log(`[compilation] Calling concatenate for job ${compilationId} with ${mediaGenerationIds.length} clips`);
  const res = await fetch(CONCATENATE_URL, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ media: mediaGenerationIds.map((id) => ({ mediaGenerationId: id })) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Concatenate API error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  console.log('[compilation] concatenate response keys:', Object.keys(json));

  // Extract the base64-encoded MP4 from the response
  // useapi.net returns the video as a base64 string in a `video` or `videoBase64` field,
  // or possibly as a `videoUrl` for a hosted file.
  const videoBase64 = (json.encodedVideo ?? json.video ?? json.videoBase64) as string | undefined;
  const videoUrl = json.videoUrl as string | undefined;

  let videoBuffer: Buffer;
  if (videoBase64) {
    videoBuffer = Buffer.from(videoBase64, 'base64');
  } else if (videoUrl) {
    // Some versions return a URL instead of base64
    const dlRes = await fetch(videoUrl);
    if (!dlRes.ok) throw new Error(`Failed to download concatenated video: ${dlRes.status}`);
    videoBuffer = Buffer.from(await dlRes.arrayBuffer());
  } else {
    throw new Error(`Concatenate response missing video data. Keys: ${Object.keys(json).join(', ')}`);
  }

  await uploadResult(outputStoragePath, videoBuffer);
  return { outputStoragePath, method: 'useapi' };
}

async function uploadResult(outputStoragePath: string, video: Buffer): Promise<void> {
  // Store the compilation (Supabase Storage today; R2 once configured)
  try {
    await getStorage().put('videos', outputStoragePath, video, { contentType: 'video/mp4' });
  } catch (uploadErr) {
    throw new Error(`Upload failed: ${(uploadErr as Error).message}`);
  }
}
