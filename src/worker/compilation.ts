/**
 * FFmpeg video compilation worker.
 *
 * Picks up pending videoCompilations rows, resolves scene selections from
 * compilationSceneSelections, downloads each clip from Supabase Storage,
 * concatenates with filter_complex (normalised timestamps + audio padding
 * + silence for audio-less clips), uploads the result, then marks the row
 * completed.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { db } from '../db';
import {
  adminSettings,
  videoCompilations,
  compilationSceneSelections,
  videoGenerations,
  videoProjects,
  videoScreens,
} from '../db/schema.pg';
import { and, asc, eq, lt } from 'drizzle-orm';
import { runFfmpegFilterComplex } from './ffmpeg-utils';

const COMPILATION_LEASE_MS = 30 * 60 * 1000;
const BUCKET_VIDEOS = process.env.SUPABASE_BUCKET_VIDEOS ?? 'videos';

// ── Public entry point ────────────────────────────────────────────────────────

export async function recoverStaleCompilations(): Promise<void> {
  const now = Date.now();
  const staleThreshold = now - COMPILATION_LEASE_MS;
  await db
    .update(videoCompilations)
    .set({ status: 'pending', claimedAt: null, updatedAt: now })
    .where(
      and(
        eq(videoCompilations.status, 'processing'),
        lt(videoCompilations.claimedAt, staleThreshold),
      ),
    );
}

export async function processPendingCompilation(): Promise<boolean> {
  const rows = await db
    .select()
    .from(videoCompilations)
    .where(eq(videoCompilations.status, 'pending'))
    .orderBy(asc(videoCompilations.createdAt))
    .limit(1);

  const compilation = rows[0];
  if (!compilation) return false;

  const now = Date.now();
  await db
    .update(videoCompilations)
    .set({ status: 'processing', claimedAt: now, updatedAt: now })
    .where(eq(videoCompilations.id, compilation.id));

  try {
    const outputStoragePath = await runCompilation(compilation.videoProjectId, compilation.id);
    await db
      .update(videoCompilations)
      .set({ status: 'completed', outputStoragePath, claimedAt: null, updatedAt: Date.now() })
      .where(eq(videoCompilations.id, compilation.id));
    console.log(`[compilation] Job ${compilation.id} completed → ${outputStoragePath}`);
  } catch (err: unknown) {
    await db
      .update(videoCompilations)
      .set({
        status: 'failed',
        claimedAt: null,
        errorMessage: (err instanceof Error ? err.message : String(err)),
        updatedAt: Date.now(),
      })
      .where(eq(videoCompilations.id, compilation.id));
    console.error(`[compilation] Job ${compilation.id} failed:`, err);
  }

  return true;
}

// ── Internal implementation ───────────────────────────────────────────────────

async function runCompilation(projectId: number, compilationId: number): Promise<string> {
  await db
    .select({ id: videoProjects.id })
    .from(videoProjects)
    .where(eq(videoProjects.id, projectId))
    .limit(1)
    .then((rows) => {
      if (!rows[0]) throw new Error(`Project ${projectId} not found`);
    });

  const settingsRows = await db.select().from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
  const crf = settingsRows[0]?.compilationCrf ?? 23;

  // Fetch scene selections ordered by screen position
  const selections = await db
    .select({
      videoScreenId: compilationSceneSelections.videoScreenId,
      videoGenerationId: compilationSceneSelections.videoGenerationId,
      position: videoScreens.position,
    })
    .from(compilationSceneSelections)
    .innerJoin(videoScreens, eq(compilationSceneSelections.videoScreenId, videoScreens.id))
    .where(eq(compilationSceneSelections.compilationId, compilationId))
    .orderBy(asc(videoScreens.position));

  if (selections.length === 0) throw new Error(`Compilation ${compilationId} has no scene selections`);

  const storagePaths: string[] = [];
  for (const sel of selections) {
    const genRows = await db
      .select({ videoStoragePath: videoGenerations.videoStoragePath })
      .from(videoGenerations)
      .where(eq(videoGenerations.id, sel.videoGenerationId))
      .limit(1);
    const gen = genRows[0];
    if (!gen) throw new Error(`Generation ${sel.videoGenerationId} not found`);
    if (!gen.videoStoragePath) {
      throw new Error(`Generation ${sel.videoGenerationId} has no video in storage (still processing?)`);
    }
    storagePaths.push(gen.videoStoragePath);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `compilation-${compilationId}-`));
  try {
    const supabase = serviceClient();
    const localPaths: string[] = [];

    for (let i = 0; i < storagePaths.length; i++) {
      const storagePath = storagePaths[i];
      const { data, error } = await supabase.storage.from(BUCKET_VIDEOS).download(storagePath);
      if (error || !data) {
        throw new Error(`Failed to download clip ${storagePath}: ${error?.message ?? 'no data'}`);
      }
      const localPath = path.join(tmpDir, `clip-${String(i).padStart(3, '0')}.mp4`);
      await fs.writeFile(localPath, Buffer.from(await data.arrayBuffer()));
      localPaths.push(localPath);
    }

    const outputPath = path.join(tmpDir, 'output.mp4');
    runFfmpegFilterComplex(localPaths, outputPath, crf);

    const outputBuffer = await fs.readFile(outputPath);
    const outputStoragePath = `compilations/${projectId}/${Date.now()}-compilation-${compilationId}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET_VIDEOS)
      .upload(outputStoragePath, outputBuffer, { contentType: 'video/mp4', upsert: false });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    return outputStoragePath;
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
