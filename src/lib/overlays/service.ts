/**
 * B-roll overlays on a video project: create, list, move, trim, replace, remove. All changes happen under the project row lock (the
 * same lock scene add/delete and compilation requests take), so placements, the limit and a compilation's snapshot always see a
 * consistent project. Overlays are positioned relative to a Flow scene; nothing here changes a Flow scene.
 */
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips, characterBrollItems, videoCompilationOverlays, videoGenerations, videoOverlays, videoProjects, videoScreens } from '@/db/schema.pg';
import { buildSceneSpans, checkPlacement, firstFreePlacement, resolveOverlays, type OverlayTiming, type SceneSpan, type TimelineProblem } from './timeline';

export const overlaysEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => ['1', 'true', 'on', 'yes'].includes((env.BROLL_OVERLAYS_ENABLED ?? '').toLowerCase());
export const overlayLimit = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env.BROLL_OVERLAY_LIMIT); return Number.isInteger(n) && n > 0 ? n : 20; };
export const DEFAULT_OVERLAY_MS = 3000;
export const MIN_OVERLAY_MS = 500;
/** Used for a scene whose length is not known yet (before it has a clip). Compilation always uses the real length. */
export const FALLBACK_SCENE_MS = 8000;

export class OverlayError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

type Tx = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;
export type OverlayRow = typeof videoOverlays.$inferSelect;

/** The Flow scenes in the order they are compiled (position order, deleted scenes excluded) with their best known length. */
export async function planningSpans(tx: Tx, projectId: number): Promise<{ spans: SceneSpan[]; sceneNumbers: Map<number, number>; durationsKnown: Map<number, boolean> }> {
  const screens = await tx.select({ id: videoScreens.id, screenNumber: videoScreens.screenNumber, position: videoScreens.position, durationSeconds: videoScreens.durationSeconds })
    .from(videoScreens).where(and(eq(videoScreens.videoProjectId, projectId), gt(videoScreens.screenNumber, 0))).orderBy(asc(videoScreens.position));
  const ids = screens.map((s) => s.id);
  const gens = ids.length === 0 ? [] : await tx.select({ screenId: videoGenerations.videoScreenId, durationSeconds: videoGenerations.durationSeconds, status: videoGenerations.status, id: videoGenerations.id })
    .from(videoGenerations).where(inArray(videoGenerations.videoScreenId, ids)).orderBy(desc(videoGenerations.id));
  const genLen = new Map<number, number>();
  for (const g of gens) if (g.status === 'completed' && g.durationSeconds && !genLen.has(g.screenId)) genLen.set(g.screenId, g.durationSeconds);
  const known = new Map<number, boolean>();
  const clips = screens.map((s) => { const sec = genLen.get(s.id) ?? s.durationSeconds ?? null; known.set(s.id, sec != null); return { screenId: s.id, durationMs: (sec ?? FALLBACK_SCENE_MS / 1000) * 1000 }; });
  return { spans: buildSceneSpans(clips), sceneNumbers: new Map(screens.map((s) => [s.id, s.screenNumber])), durationsKnown: known };
}

const timing = (o: OverlayRow): OverlayTiming => ({ id: o.id, track: o.track, anchorScreenId: o.anchorScreenId, startOffsetMs: o.startOffsetMs, durationMs: o.durationMs, sourceStartMs: o.sourceStartMs, assetDurationMs: o.assetDurationMs });

export interface OverlayView extends OverlayRow {
  /** The anchor scene was deleted: the overlay is kept, flagged, and never moved to another scene. */
  needsAttention: boolean;
  attentionReason: string | null;
  anchorSceneNumber: number | null;
  /** Placement on the video's clock using the scene lengths known now (the compile uses the real ones). */
  startMs: number | null;
  endMs: number | null;
  problems: TimelineProblem[];
}

export async function listOverlays(projectId: number, tx: Tx = db): Promise<{ overlays: OverlayView[]; scenes: Array<SceneSpan & { sceneNumber: number; lengthKnown: boolean }>; totalMs: number; limit: number }> {
  const { spans, sceneNumbers, durationsKnown } = await planningSpans(tx, projectId);
  const rows = await tx.select().from(videoOverlays).where(eq(videoOverlays.videoProjectId, projectId)).orderBy(asc(videoOverlays.createdAt), asc(videoOverlays.id));
  const { resolved, problems } = resolveOverlays(spans, rows.map(timing));
  const byId = new Map(resolved.map((r) => [r.id, r]));
  const overlays: OverlayView[] = rows.map((o) => {
    const r = byId.get(o.id);
    const mine = problems.filter((p) => p.overlayId === o.id);
    const anchorGone = mine.find((p) => p.code === 'anchor_missing');
    return { ...o, needsAttention: !!anchorGone || o.status === 'failed', attentionReason: anchorGone ? 'Its Flow scene was deleted. Move it to another scene or remove it.' : o.status === 'failed' ? (o.errorMessage ?? 'Preparing this clip failed.') : null,
      anchorSceneNumber: sceneNumbers.get(o.anchorScreenId) ?? null, startMs: r?.startMs ?? null, endMs: r?.endMs ?? null, problems: mine };
  });
  const total = spans.reduce((t, s) => Math.max(t, s.startMs + s.durationMs), 0);
  return { overlays, scenes: spans.map((s) => ({ ...s, sceneNumber: sceneNumbers.get(s.screenId) ?? 0, lengthKnown: durationsKnown.get(s.screenId) ?? false })), totalMs: total, limit: overlayLimit() };
}

async function lockProject(tx: Tx, projectId: number) { await tx.select({ id: videoProjects.id }).from(videoProjects).where(eq(videoProjects.id, projectId)).for('update'); }
const clipMsFor = (c: { durationSeconds: number | null }): number | null => (c.durationSeconds != null ? c.durationSeconds * 1000 : null);
const clampDuration = (want: number, assetMs: number | null | undefined, sourceStart: number) => { const room = assetMs != null ? Math.max(0, assetMs - sourceStart) : Infinity; return Math.max(0, Math.min(want, room)); };

export interface CreateGeneric { brollClipId: number; anchorScreenId?: number; startOffsetMs?: number; durationMs?: number; sourceStartMs?: number; track?: number }

/** Places a library clip as an overlay. The library original is only referenced; a silent normalised copy is made by the worker. */
export async function createGenericOverlay(projectId: number, userId: string, input: CreateGeneric): Promise<OverlayRow> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const [clip] = await tx.select().from(brollClips).where(eq(brollClips.id, input.brollClipId)).limit(1);
    if (!clip) throw new OverlayError(404, 'clip_not_found', 'That clip is not in the B-roll library.');
    const existing = await tx.select().from(videoOverlays).where(eq(videoOverlays.videoProjectId, projectId));
    if (existing.length >= overlayLimit()) throw new OverlayError(409, 'overlay_limit', `A video can have at most ${overlayLimit()} B-roll overlays.`);
    const { spans } = await planningSpans(tx, projectId);
    if (spans.length === 0) throw new OverlayError(422, 'no_scenes', 'Add Flow scenes before adding B-roll.');
    const track = input.track ?? 0;
    const sourceStart = Math.max(0, Math.round(input.sourceStartMs ?? 0));
    const assetMs = clip.durationSeconds != null ? clip.durationSeconds * 1000 : null;
    const wanted = Math.round(input.durationMs ?? DEFAULT_OVERLAY_MS);
    const duration = clampDuration(wanted, assetMs, sourceStart);
    if (duration < MIN_OVERLAY_MS) throw new OverlayError(422, 'too_short', `The overlay would be shorter than ${MIN_OVERLAY_MS / 1000} s. Choose an earlier trim point.`);
    let anchor = input.anchorScreenId; let offset = input.startOffsetMs;
    if (anchor == null) {
      const free = firstFreePlacement(spans, existing.map(timing), duration, track);
      if (!free) throw new OverlayError(409, 'no_room', 'There is no free space on the B-roll track for a clip this long.');
      anchor = free.anchorScreenId; offset = free.startOffsetMs;
    }
    const candidate: OverlayTiming = { id: -1, track, anchorScreenId: anchor, startOffsetMs: Math.round(offset ?? 0), durationMs: duration, sourceStartMs: sourceStart, assetDurationMs: assetMs };
    const problems = checkPlacement(spans, existing.map(timing), candidate);
    if (problems.length > 0) throw new OverlayError(409, problems[0].code, problems[0].message);
    const now = Date.now();
    const [row] = await tx.insert(videoOverlays).values({ videoProjectId: projectId, kind: 'generic', track, anchorScreenId: candidate.anchorScreenId, startOffsetMs: candidate.startOffsetMs, durationMs: candidate.durationMs, sourceStartMs: sourceStart, assetDurationMs: assetMs, brollClipId: clip.id, status: 'preparing', createdBy: userId, createdAt: now, updatedAt: now }).returning();
    return row;
  });
}

export interface UpdateOverlay { anchorScreenId?: number; startOffsetMs?: number; durationMs?: number; sourceStartMs?: number; track?: number; replaceWithBrollClipId?: number }

export async function updateOverlay(projectId: number, overlayId: number, patch: UpdateOverlay): Promise<OverlayRow> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const all = await tx.select().from(videoOverlays).where(eq(videoOverlays.videoProjectId, projectId));
    const cur = all.find((o) => o.id === overlayId);
    if (!cur) throw new OverlayError(404, 'not_found', 'Overlay not found.');
    const { spans } = await planningSpans(tx, projectId);
    const values: Partial<typeof videoOverlays.$inferInsert> = { updatedAt: Date.now() };
    let assetMs = cur.assetDurationMs;
    if (patch.replaceWithBrollClipId != null) {
      if (cur.kind !== 'generic') throw new OverlayError(422, 'not_generic', 'Only a library clip can be replaced this way. Character B-roll is changed from its own panel.');
      const [clip] = await tx.select().from(brollClips).where(eq(brollClips.id, patch.replaceWithBrollClipId)).limit(1);
      if (!clip) throw new OverlayError(404, 'clip_not_found', 'That clip is not in the B-roll library.');
      Object.assign(values, { brollClipId: clip.id, status: 'preparing', assetStoragePath: null, assetWidth: null, assetHeight: null, assetDurationMs: clipMsFor(clip), errorMessage: null, claimedAt: null, sourceStartMs: 0 });
      assetMs = clip.durationSeconds != null ? clip.durationSeconds * 1000 : null;
    }
    const next: OverlayTiming = {
      id: cur.id, track: patch.track ?? cur.track, anchorScreenId: patch.anchorScreenId ?? cur.anchorScreenId,
      startOffsetMs: Math.max(0, Math.round(patch.startOffsetMs ?? cur.startOffsetMs)),
      sourceStartMs: Math.max(0, Math.round(values.sourceStartMs !== undefined && patch.sourceStartMs === undefined ? 0 : patch.sourceStartMs ?? cur.sourceStartMs)),
      durationMs: Math.round(patch.durationMs ?? cur.durationMs), assetDurationMs: assetMs,
    };
    if (next.durationMs < MIN_OVERLAY_MS) throw new OverlayError(422, 'too_short', `An overlay must be at least ${MIN_OVERLAY_MS / 1000} s long.`);
    if (assetMs != null && next.sourceStartMs + MIN_OVERLAY_MS > assetMs) throw new OverlayError(422, 'trim_beyond_clip', 'The trim point is past the end of the clip.');
    next.durationMs = clampDuration(next.durationMs, assetMs, next.sourceStartMs);
    const problems = checkPlacement(spans, all.map(timing), next);
    if (problems.length > 0) throw new OverlayError(409, problems[0].code, problems[0].message);
    Object.assign(values, { track: next.track, anchorScreenId: next.anchorScreenId, startOffsetMs: next.startOffsetMs, durationMs: next.durationMs, sourceStartMs: next.sourceStartMs });
    const [row] = await tx.update(videoOverlays).set(values).where(eq(videoOverlays.id, overlayId)).returning();
    return row;
  });
}

/** Removes the overlay. Compilations that already used it keep their frozen copy; the stored clip is left in place for them. */
export async function deleteOverlay(projectId: number, overlayId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const [cur] = await tx.select({ id: videoOverlays.id }).from(videoOverlays).where(and(eq(videoOverlays.id, overlayId), eq(videoOverlays.videoProjectId, projectId))).limit(1);
    if (!cur) throw new OverlayError(404, 'not_found', 'Overlay not found.');
    await tx.update(videoCompilationOverlays).set({ overlayId: null }).where(eq(videoCompilationOverlays.overlayId, overlayId));
    await tx.delete(videoOverlays).where(eq(videoOverlays.id, overlayId));
  });
}

/** Puts a failed generic overlay back in the queue for the worker. */
export async function retryOverlay(projectId: number, overlayId: number): Promise<OverlayRow> {
  const [row] = await db.update(videoOverlays).set({ status: 'preparing', errorMessage: null, claimedAt: null, updatedAt: Date.now() })
    .where(and(eq(videoOverlays.id, overlayId), eq(videoOverlays.videoProjectId, projectId), eq(videoOverlays.status, 'failed'), eq(videoOverlays.kind, 'generic'))).returning();
  if (!row) throw new OverlayError(409, 'not_retryable', 'Only a failed library clip can be retried.');
  return row;
}

/**
 * Freezes the project's overlays for a compilation being requested. Runs INSIDE the compilation request's transaction (which already
 * holds the project lock). Refuses, with a message the page can show, if any overlay cannot be compiled: still preparing, failed, or
 * on a scene that no longer exists (never silently moved). Overlays on scenes that are not part of this compilation are refused too,
 * so a compilation of a subset of scenes cannot lose B-roll without anyone noticing.
 */
export async function snapshotOverlaysForCompilation(tx: Tx, projectId: number, compilationId: number, compiledScreenIds: readonly number[]): Promise<{ count: number } | { blocked: string; code: string }> {
  const rows = await tx.select().from(videoOverlays).where(eq(videoOverlays.videoProjectId, projectId)).orderBy(asc(videoOverlays.id));
  if (rows.length === 0) return { count: 0 };
  const active = new Set((await planningSpans(tx, projectId)).spans.map((s) => s.screenId));
  const compiled = new Set(compiledScreenIds);
  const gone = rows.filter((o) => !active.has(o.anchorScreenId));
  if (gone.length > 0) return { code: 'overlay_scene_deleted', blocked: 'A B-roll overlay is attached to a scene that was deleted. Move it to another scene or remove it, then compile again.' };
  const notReady = rows.filter((o) => o.status !== 'ready' || !o.assetStoragePath);
  if (notReady.length > 0) return { code: 'overlay_not_ready', blocked: notReady.some((o) => o.status === 'failed') ? 'A B-roll clip failed to prepare. Retry or remove it, then compile again.' : 'A B-roll clip is still being prepared. Try again in a moment.' };
  const outside = rows.filter((o) => !compiled.has(o.anchorScreenId));
  if (outside.length > 0) return { code: 'overlay_scene_not_compiled', blocked: 'A B-roll overlay is attached to a scene that is not part of this compilation. Include that scene or remove the overlay.' };
  const now = Date.now();
  await tx.insert(videoCompilationOverlays).values(rows.map((o) => ({ compilationId, overlayId: o.id, kind: o.kind, track: o.track, anchorScreenId: o.anchorScreenId, startOffsetMs: o.startOffsetMs, durationMs: o.durationMs, sourceStartMs: o.sourceStartMs, assetStoragePath: o.assetStoragePath!, assetWidth: o.assetWidth, assetHeight: o.assetHeight, assetDurationMs: o.assetDurationMs, createdAt: now })));
  return { count: rows.length };
}

// The character item table is read by the Character B-roll service; re-exported here so callers have one import for overlay data.
export { characterBrollItems };
