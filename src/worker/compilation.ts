/**
 * Video compilation worker using useapi.net concatenate endpoint.
 *
 * Picks up pending videoCompilations rows, resolves scene selections from
 * compilationSceneSelections, calls POST /v1/google-flow/videos/concatenate
 * with the mediaGenerationId for each clip, decodes the returned base64 MP4,
 * uploads the result to Supabase Storage, then marks the row completed.
 *
 * Requirements:
 *  - Each selected generation must have mediaGenerationId populated
 *    (stored when the generation completed via the useapi provider).
 *  - 2–10 clips supported by the concatenate endpoint.
 */

import { createClient } from '@supabase/supabase-js';
import { db } from '../db';
import {
  videoCompilations,
  compilationSceneSelections,
  videoGenerations,
  videoScreens,
} from '../db/schema.pg';
import { and, asc, eq, lt } from 'drizzle-orm';

const COMPILATION_LEASE_MS = 30 * 60 * 1000;
const BUCKET_VIDEOS = process.env.SUPABASE_BUCKET_VIDEOS ?? 'videos';
const CONCATENATE_URL = 'https://api.useapi.net/v1/google-flow/videos/concatenate';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.USEAPI_TOKEN}` };
}

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
  // Fetch scene selections ordered by screen position
  const selections = await db
    .select({
      videoGenerationId: compilationSceneSelections.videoGenerationId,
      position: videoScreens.position,
    })
    .from(compilationSceneSelections)
    .innerJoin(videoScreens, eq(compilationSceneSelections.videoScreenId, videoScreens.id))
    .where(eq(compilationSceneSelections.compilationId, compilationId))
    .orderBy(asc(videoScreens.position));

  if (selections.length === 0) throw new Error(`Compilation ${compilationId} has no scene selections`);
  if (selections.length < 2) throw new Error(`Compilation ${compilationId} needs at least 2 clips (got ${selections.length})`);
  if (selections.length > 10) throw new Error(`Compilation ${compilationId} has too many clips (${selections.length}); max is 10`);

  // Resolve mediaGenerationId for each clip
  const mediaGenerationIds: string[] = [];
  for (const sel of selections) {
    const genRows = await db
      .select({ mediaGenerationId: videoGenerations.mediaGenerationId, videoStoragePath: videoGenerations.videoStoragePath })
      .from(videoGenerations)
      .where(eq(videoGenerations.id, sel.videoGenerationId))
      .limit(1);
    const gen = genRows[0];
    if (!gen) throw new Error(`Generation ${sel.videoGenerationId} not found`);
    if (!gen.mediaGenerationId) {
      throw new Error(
        `Scene ${sel.position + 1} clip is missing its media ID (generation ${sel.videoGenerationId}). ` +
        `Please generate a new clip for this scene and approve it, then try compiling again.`,
      );
    }
    mediaGenerationIds.push(gen.mediaGenerationId);
  }

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

  // Upload to Supabase Storage
  const outputStoragePath = `compilations/${projectId}/${Date.now()}-compilation-${compilationId}.mp4`;
  const supabase = serviceClient();
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_VIDEOS)
    .upload(outputStoragePath, videoBuffer, { contentType: 'video/mp4', upsert: false });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  return outputStoragePath;
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
