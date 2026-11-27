/**
 * Adds a compilation's B-roll overlays to the finished Flow video. Called by the compilation worker AFTER the base video exists
 * (useapi concatenate or the FFmpeg join), and only when the compilation has overlays: a compilation without overlays never
 * reaches this code, so the plain Flow path is unchanged.
 *
 * The overlays were frozen into video_compilation_overlays when the compilation was requested. Here they are placed on the real
 * clock: each Flow clip's actual length is read from its stored file (the nominal seconds on the scene are only a fallback), the
 * scenes are laid end to end in the compiled order, and each overlay's scene-relative position becomes an absolute window.
 * Nothing is silently moved. An overlay that cannot be placed (an overlap that only shows up with the real lengths) fails the
 * compilation with a message that names it, and the previous compilations and the Flow project are untouched.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CompilationError } from './compilation-error';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { videoCompilationOverlays } from '../db/schema.pg';
import { getStorage } from '../lib/object-store';
import { buildSceneSpans, resolveOverlays, type OverlayTiming } from '../lib/overlays/timeline';
import { compositeOverlaysSync, makeWorkDir, probeClip, type CompositeOverlay } from './compilation-overlay';

export interface CompiledScene { screenId: number; sceneNumber: number; storagePath: string | null; nominalSeconds: number | null }

/** The base video can differ from the sum of the clips by encoder padding; beyond this the lengths do not describe the video. */
const MAX_LENGTH_MISMATCH_MS = 1000;

let tablesKnown = false;
/**
 * True once migration 0028 is in the database. A database without it has no overlays by definition, so the plain Flow compile must not
 * even look for them (deploy order must never be able to break compiling). The answer is only cached once it is true.
 */
export async function overlayTablesExist(): Promise<boolean> {
  if (tablesKnown) return true;
  const res = await db.execute(sql`select to_regclass('public.video_compilation_overlays') as t`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Array<{ t: string | null }>;
  tablesKnown = rows[0]?.t != null;
  return tablesKnown;
}

export async function overlaysFor(compilationId: number) {
  return db.select().from(videoCompilationOverlays).where(eq(videoCompilationOverlays.compilationId, compilationId));
}

export interface OverlayRunDeps {
  download: (bucket: 'videos', key: string) => Promise<Buffer>;
}
const defaultDeps = (): OverlayRunDeps => ({ download: (b, k) => getStorage().download(b, k) });

/** Returns the base video unchanged when the compilation has no overlays. */
export async function applyOverlays(compilationId: number, scenes: readonly CompiledScene[], base: Buffer, crf: number, deps: OverlayRunDeps = defaultDeps()): Promise<{ video: Buffer; overlays: number; passes: number; elapsedMs: number } | { video: Buffer; overlays: 0 }> {
  if (!(await overlayTablesExist())) return { video: base, overlays: 0 };
  const rows = await overlaysFor(compilationId);
  if (rows.length === 0) return { video: base, overlays: 0 };

  const dir = await makeWorkDir(`overlay-${compilationId}`);
  try {
    const basePath = path.join(dir, 'base.mp4');
    await fs.writeFile(basePath, base);
    const baseInfo = probeClip(basePath);

    // The actual length of every Flow clip, read one at a time so only one is held in memory.
    const clipMs: Array<{ screenId: number; durationMs: number }> = [];
    for (const s of scenes) {
      let ms: number | null = null;
      if (s.storagePath) {
        const p = path.join(dir, `clip-${s.screenId}.mp4`);
        await fs.writeFile(p, await deps.download('videos', s.storagePath));
        try { ms = Math.round(probeClip(p).durationSec * 1000); } finally { await fs.rm(p, { force: true }); }
      }
      if (ms == null && s.nominalSeconds != null) ms = s.nominalSeconds * 1000;
      if (ms == null) throw new CompilationError(`Scene ${s.sceneNumber} has no known length, so B-roll cannot be placed on it.`);
      clipMs.push({ screenId: s.screenId, durationMs: ms });
    }
    let spans = buildSceneSpans(clipMs);
    const sumMs = spans.reduce((t, s) => t + s.durationMs, 0);
    const baseMs = Math.round(baseInfo.durationSec * 1000);
    if (Math.abs(sumMs - baseMs) > MAX_LENGTH_MISMATCH_MS) {
      throw new CompilationError(`The Flow clips add up to ${(sumMs / 1000).toFixed(1)} s but the joined video is ${(baseMs / 1000).toFixed(1)} s, so B-roll positions cannot be trusted. Compile again; if it repeats, the clips differ from what was joined.`);
    }
    if (sumMs !== baseMs) {
      // Small mismatch (encoder padding): keep each scene's start, give the last scene the remainder, so overlay windows stay where they were set.
      spans = spans.map((s, i) => i === spans.length - 1 ? { ...s, durationMs: Math.max(0, baseMs - s.startMs) } : s);
    }

    const timing: OverlayTiming[] = rows.map((r) => ({ id: r.id, track: r.track, anchorScreenId: r.anchorScreenId, startOffsetMs: r.startOffsetMs, durationMs: r.durationMs, sourceStartMs: r.sourceStartMs, assetDurationMs: r.assetDurationMs }));
    const { resolved, problems } = resolveOverlays(spans, timing);
    if (problems.length > 0) {
      const sceneNo = new Map(scenes.map((s) => [s.screenId, s.sceneNumber]));
      const detail = problems.map((p) => { const r = rows.find((x) => x.id === p.overlayId); return `B-roll on Scene ${r ? sceneNo.get(r.anchorScreenId) ?? '?' : '?'}: ${p.message}`; }).join(' ');
      throw new CompilationError(`The B-roll could not be placed on the video. ${detail}`);
    }

    const byId = new Map(rows.map((r) => [r.id, r]));
    const composite: CompositeOverlay[] = [];
    for (const r of resolved) {
      const row = byId.get(r.id)!;
      const file = path.join(dir, `overlay-${r.id}.mp4`);
      await fs.writeFile(file, await deps.download('videos', row.assetStoragePath));
      composite.push({ id: r.id, track: r.track, startMs: r.startMs, endMs: r.endMs, sourceStartMs: r.sourceStartMs, file });
    }

    const outPath = path.join(dir, 'with-overlays.mp4');
    const result = compositeOverlaysSync(basePath, outPath, composite, crf, undefined, dir);
    // The result must still be the same length as the Flow video: an overlay never shortens or lengthens it.
    const outMs = Math.round(result.durationSec * 1000);
    const frameMs = 1000 / Math.max(1, baseInfo.fps);
    if (Math.abs(outMs - baseMs) > Math.ceil(frameMs * 2)) throw new CompilationError(`Adding B-roll changed the video length from ${(baseMs / 1000).toFixed(2)} s to ${(outMs / 1000).toFixed(2)} s, so the result was discarded.`);

    for (const r of resolved) {
      await db.update(videoCompilationOverlays).set({ resolvedStartMs: Math.round(r.startMs), resolvedEndMs: Math.round(r.endMs) }).where(eq(videoCompilationOverlays.id, byId.get(r.id)!.id));
    }
    return { video: await fs.readFile(outPath), overlays: resolved.length, passes: result.passes, elapsedMs: result.elapsedMs };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
