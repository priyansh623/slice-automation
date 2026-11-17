/**
 * Prepares a library clip for use as an overlay: reads the library original (never modified), makes a silent 720x1280 / 30 fps project
 * copy in our own storage, probes it, and marks the overlay ready. A failure marks only that overlay failed (with a message the page
 * shows, and a Retry); the Flow project and earlier compilations are untouched.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db';
import { brollClips, videoOverlays } from '../db/schema.pg';
import { getStorage } from '../lib/object-store';
import { overlaysEnabled } from '../lib/overlays/service';
import { makeWorkDir, normaliseOverlayClipSync } from './compilation-overlay';

/** A claim older than this belongs to a worker that died; the overlay is picked up again (preparing is idempotent). */
export const INGEST_CLAIM_STALE_MS = 10 * 60 * 1000;

export interface IngestDeps {
  readLibrary: (storagePath: string) => Promise<Buffer>;
  writeProject: (key: string, body: Buffer) => Promise<void>;
  now: () => number;
}
const defaultDeps = (): IngestDeps => ({
  readLibrary: (p) => getStorage().download('uploads', p),
  writeProject: async (key, body) => { await getStorage().put('videos', key, body, { contentType: 'video/mp4' }); },
  now: () => Date.now(),
});

/** Handles at most one overlay per call. Returns true if it did something (the loop then comes straight back). */
export async function processOverlayIngest(deps: IngestDeps = defaultDeps()): Promise<boolean> {
  if (!overlaysEnabled()) return false;
  const now = deps.now();
  const [candidate] = await db.select().from(videoOverlays)
    .where(and(eq(videoOverlays.status, 'preparing'), eq(videoOverlays.kind, 'generic'), or(isNull(videoOverlays.claimedAt), lt(videoOverlays.claimedAt, now - INGEST_CLAIM_STALE_MS))))
    .orderBy(asc(videoOverlays.id)).limit(1);
  if (!candidate) return false;
  const claimed = await db.update(videoOverlays).set({ claimedAt: now, updatedAt: now })
    .where(and(eq(videoOverlays.id, candidate.id), eq(videoOverlays.status, 'preparing'), candidate.claimedAt == null ? isNull(videoOverlays.claimedAt) : eq(videoOverlays.claimedAt, candidate.claimedAt)))
    .returning({ id: videoOverlays.id });
  if (claimed.length === 0) return true;

  const dir = await makeWorkDir(`ingest-${candidate.id}`);
  try {
    if (candidate.brollClipId == null) throw new Error('This overlay has no library clip.');
    const [clip] = await db.select({ storagePath: brollClips.storagePath }).from(brollClips).where(eq(brollClips.id, candidate.brollClipId)).limit(1);
    if (!clip) throw new Error('The library clip was removed.');
    const input = path.join(dir, 'in.bin');
    await fs.writeFile(input, await deps.readLibrary(clip.storagePath));
    const output = path.join(dir, 'out.mp4');
    const r = await normaliseOverlayClipSync(input, output);
    const key = `overlays/${candidate.videoProjectId}/${candidate.id}-${now}.mp4`;
    await deps.writeProject(key, await fs.readFile(output));
    // Only completes if the overlay still wants this clip (it may have been replaced or removed while we worked).
    const done = await db.update(videoOverlays).set({ status: 'ready', assetStoragePath: key, assetWidth: r.width, assetHeight: r.height, assetDurationMs: r.durationMs, errorMessage: null, claimedAt: null, updatedAt: deps.now() })
      .where(and(eq(videoOverlays.id, candidate.id), eq(videoOverlays.status, 'preparing'), eq(videoOverlays.brollClipId, candidate.brollClipId))).returning({ id: videoOverlays.id });
    if (done.length === 0) console.warn(`[overlay-ingest] Overlay ${candidate.id} changed while it was being prepared; the result was discarded`);
    else console.log(`[overlay-ingest] Overlay ${candidate.id} ready (${r.width}x${r.height}, ${r.durationMs} ms, ${r.bytes} bytes)`);
  } catch (err) {
    await db.update(videoOverlays).set({ status: 'failed', claimedAt: null, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500), updatedAt: deps.now() })
      .where(and(eq(videoOverlays.id, candidate.id), eq(videoOverlays.status, 'preparing')));
    console.error(`[overlay-ingest] Overlay ${candidate.id} failed:`, err);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}
