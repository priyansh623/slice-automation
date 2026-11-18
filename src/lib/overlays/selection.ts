/**
 * B-roll selection BEFORE generation.
 *
 * What a person picked on the selection screen is kept as IDs only, in video_projects.broll_selection (migration 0029):
 *   generic:   [{ clipId, screenId, overlayId? }]                      a library clip for a Flow scene
 *   character: [{ assetId, screenId, action, itemId?, overlayId? }]    a Scene Pack image for a Flow scene
 * Saving a selection creates NO overlay rows, NO jobs and costs nothing. Later:
 *   - Character B-roll runs through the existing Generation process (personalise -> approve -> video); `startCharacterPick` starts that
 *     process for one pick and records the item id on it, so the finished clip is tied to its scene.
 *   - `populateComposition` turns picks that are USABLE (library clips, and Character clips that finished their video) into overlays,
 *     placed automatically inside their own scene. It records the overlay id on the pick, so opening Composition again never makes a
 *     second overlay and never brings back one a person removed. Overlays a person has edited ('manual') are never moved.
 * All writes happen under the project row lock, the same lock every overlay change takes.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips, characterBrollItems, studioAssets, videoCompilationOverlays, videoOverlays, videoProjects, videoScreens } from '@/db/schema.pg';
import { arrangeAuto } from './arrange';
import { createCharacterItem, CLIP_SECONDS, type ItemRow } from './character';
import { DEFAULT_OVERLAY_MS, MIN_OVERLAY_MS, OverlayError, overlayLimit, planningSpans } from './service';
import type { OverlayTiming } from './timeline';

export interface GenericPick { clipId: number; screenId: number; overlayId?: number }
export interface CharacterPick { assetId: number; screenId: number; action: string; itemId?: number; overlayId?: number; /** set while a start is in progress (ms) */ startingAt?: number }
export interface BrollSelection { version: 1; generic: GenericPick[]; character: CharacterPick[] }
export interface SelectionInput { generic?: Array<{ clipId: number; screenId: number }>; character?: Array<{ assetId: number; screenId: number; action?: string }> }

type Tx = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;
const err = (status: number, code: string, message: string) => new OverlayError(status, code, message);
const lockProject = (tx: Tx, id: number) => tx.select({ id: videoProjects.id }).from(videoProjects).where(eq(videoProjects.id, id)).for('update');
const STARTING_STALE_MS = 2 * 60_000;
/** Library clips and Character clips sit on their own tracks (their own lanes on the timeline), so one of each can play over the same scene. */
export const GENERIC_TRACK = 0;
export const CHARACTER_TRACK = 1;

export const emptySelection = (): BrollSelection => ({ version: 1, generic: [], character: [] });

/** Reads what is stored, tolerating NULL (every project before this feature) and anything malformed. */
export function normaliseSelection(raw: unknown): BrollSelection {
  const out = emptySelection();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as { generic?: unknown; character?: unknown };
  const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
  for (const g of Array.isArray(r.generic) ? r.generic : []) {
    const clipId = int(g?.clipId), screenId = int(g?.screenId);
    if (clipId !== undefined && screenId !== undefined) out.generic.push({ clipId, screenId, ...(int(g.overlayId) !== undefined ? { overlayId: int(g.overlayId) } : {}) });
  }
  for (const c of Array.isArray(r.character) ? r.character : []) {
    const assetId = int(c?.assetId), screenId = int(c?.screenId);
    if (assetId !== undefined && screenId !== undefined) out.character.push({ assetId, screenId, action: typeof c.action === 'string' ? c.action.slice(0, 1000) : '', ...(int(c.itemId) !== undefined ? { itemId: int(c.itemId) } : {}), ...(int(c.overlayId) !== undefined ? { overlayId: int(c.overlayId) } : {}), ...(int(c.startingAt) !== undefined ? { startingAt: int(c.startingAt) } : {}) });
  }
  return out;
}

async function read(tx: Tx, projectId: number): Promise<BrollSelection> {
  const [p] = await tx.select({ s: videoProjects.brollSelection }).from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  if (!p) throw err(404, 'project_not_found', 'Project not found.');
  return normaliseSelection(p.s);
}
const write = (tx: Tx, projectId: number, sel: BrollSelection) => tx.update(videoProjects).set({ brollSelection: sel }).where(eq(videoProjects.id, projectId));

export const getSelection = (projectId: number) => read(db, projectId);

/** The Flow scenes a pick can be attached to (not deleted). */
async function activeScenes(tx: Tx, projectId: number) {
  const rows = await tx.select({ id: videoScreens.id, n: videoScreens.screenNumber }).from(videoScreens).where(eq(videoScreens.videoProjectId, projectId)).orderBy(asc(videoScreens.position));
  return rows.filter((r) => r.n > 0);
}

/**
 * Replaces the selection with what the person picked. Entries that stay keep their overlay / item links. Nothing is generated or created.
 * A Character pick whose paid image has already been started cannot be dropped here (the work and its cost exist); an automatic overlay
 * of a dropped pick is removed with it, a manual one (a person edited it) stays.
 */
export async function saveSelection(projectId: number, input: SelectionInput): Promise<BrollSelection> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const cur = await read(tx, projectId);
    const scenes = new Set((await activeScenes(tx, projectId)).map((s) => s.id));
    const dedupe = <T,>(list: T[], key: (t: T) => string) => { const seen = new Set<string>(); return list.filter((t) => { const k = key(t); if (seen.has(k)) return false; seen.add(k); return true; }); };
    const generic = dedupe(input.generic ?? [], (g) => `${g.clipId}:${g.screenId}`);
    const character = dedupe(input.character ?? [], (c) => `${c.assetId}:${c.screenId}`);
    if (generic.length + character.length > overlayLimit()) throw err(409, 'overlay_limit', `A video can have at most ${overlayLimit()} B-roll clips.`);
    // A NEW pick needs a live scene. A pick that was already saved is kept as it is even if its scene was deleted since (it is reported, never
    // re-attached), so one stale pick cannot block saving the others; the person removes it when they like.
    for (const e of generic) if (!scenes.has(e.screenId) && !cur.generic.some((o) => o.clipId === e.clipId && o.screenId === e.screenId)) throw err(422, 'scene_not_found', 'One of the chosen scenes no longer exists.');
    for (const e of character) if (!scenes.has(e.screenId) && !cur.character.some((o) => o.assetId === e.assetId && o.screenId === e.screenId)) throw err(422, 'scene_not_found', 'One of the chosen scenes no longer exists.');
    const clipIds = [...new Set(generic.map((g) => g.clipId))];
    if (clipIds.length) { const found = await tx.select({ id: brollClips.id }).from(brollClips).where(inArray(brollClips.id, clipIds)); if (found.length !== clipIds.length) throw err(404, 'clip_not_found', 'A chosen clip is not in the B-roll library.'); }
    const assetIds = [...new Set(character.map((c) => c.assetId))];
    if (assetIds.length) { const found = await tx.select({ id: studioAssets.id, archivedAt: studioAssets.archivedAt }).from(studioAssets).where(inArray(studioAssets.id, assetIds)); if (found.length !== assetIds.length || found.some((a) => a.archivedAt)) throw err(404, 'asset_not_found', 'A chosen Scene Pack image is not available.'); }

    const next = emptySelection();
    for (const g of generic) { const old = cur.generic.find((o) => o.clipId === g.clipId && o.screenId === g.screenId); next.generic.push({ clipId: g.clipId, screenId: g.screenId, ...(old?.overlayId !== undefined ? { overlayId: old.overlayId } : {}) }); }
    for (const c of character) { const old = cur.character.find((o) => o.assetId === c.assetId && o.screenId === c.screenId); next.character.push({ assetId: c.assetId, screenId: c.screenId, action: (c.action ?? old?.action ?? '').slice(0, 1000), ...(old?.itemId !== undefined ? { itemId: old.itemId } : {}), ...(old?.overlayId !== undefined ? { overlayId: old.overlayId } : {}), ...(old?.startingAt !== undefined ? { startingAt: old.startingAt } : {}) }); }
    const droppedStarted = cur.character.filter((o) => o.itemId !== undefined && !next.character.some((n) => n.assetId === o.assetId && n.screenId === o.screenId));
    if (droppedStarted.length) throw err(409, 'already_started', 'A Character B-roll image was already started for that scene, so it cannot be removed here.');

    const dropped = [...cur.generic.filter((o) => !next.generic.some((n) => n.clipId === o.clipId && n.screenId === o.screenId)), ...cur.character.filter((o) => !next.character.some((n) => n.assetId === o.assetId && n.screenId === o.screenId))];
    const overlayIds = dropped.map((d) => d.overlayId).filter((x): x is number => x !== undefined);
    if (overlayIds.length) await tx.delete(videoOverlays).where(and(eq(videoOverlays.videoProjectId, projectId), inArray(videoOverlays.id, overlayIds), eq(videoOverlays.placementSource, 'auto')));
    await write(tx, projectId, next);
    return next;
  });
}

/**
 * Starts the EXISTING Character B-roll process (the personalised image, then the person's approval, then the video) for one pick, and
 * ties the item to the pick. This is the step that costs money, so it only ever runs when a person asks for it on the Generation screen.
 */
export async function startCharacterPick(projectId: number, userId: string, ref: { assetId: number; screenId: number }): Promise<{ item: ItemRow }> {
  const now = Date.now();
  let adopted: ItemRow | undefined;
  await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const sel = await read(tx, projectId);
    const pick = sel.character.find((c) => c.assetId === ref.assetId && c.screenId === ref.screenId);
    if (!pick) throw err(404, 'not_selected', 'That image is not selected for this scene.');
    if (pick.itemId !== undefined) throw err(409, 'already_started', 'This image was already started.');
    if (pick.startingAt !== undefined && now - pick.startingAt < STARTING_STALE_MS) throw err(409, 'already_started', 'This image is already being started.');
    if (pick.startingAt !== undefined) {
      // An earlier start died after creating its item but before recording it: take that item over instead of paying for a second one.
      const used = new Set(sel.character.map((c) => c.itemId).filter((x): x is number => x !== undefined));
      const orphan = (await tx.select().from(characterBrollItems).where(and(eq(characterBrollItems.videoProjectId, projectId), eq(characterBrollItems.studioAssetId, ref.assetId))))
        .find((i) => !used.has(i.id) && i.createdAt >= pick.startingAt! - 1000);
      if (orphan) { pick.itemId = orphan.id; delete pick.startingAt; await write(tx, projectId, sel); adopted = orphan; return; }
    }
    pick.startingAt = now;
    await write(tx, projectId, sel);
  });
  if (adopted) return { item: adopted };
  const clearClaim = async () => db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const sel = await read(tx, projectId);
    const pick = sel.character.find((c) => c.assetId === ref.assetId && c.screenId === ref.screenId);
    if (pick) { delete pick.startingAt; await write(tx, projectId, sel); }
  });
  let item: ItemRow;
  try {
    const sel = await getSelection(projectId);
    const action = sel.character.find((c) => c.assetId === ref.assetId && c.screenId === ref.screenId)?.action ?? '';
    item = await createCharacterItem(projectId, userId, { studioAssetId: ref.assetId, intendedAction: action });
  } catch (e) { await clearClaim(); throw e; }
  await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const sel = await read(tx, projectId);
    const pick = sel.character.find((c) => c.assetId === ref.assetId && c.screenId === ref.screenId);
    if (pick) { pick.itemId = item.id; delete pick.startingAt; await write(tx, projectId, sel); }
  });
  return { item };
}

/**
 * Takes one Character pick off the project, from the Generation screen. The pick and its overlay on the timeline are removed (a compilation that
 * already used the overlay keeps its frozen copy). The item itself is kept on record: if its image or video was already made, that was already
 * charged and is simply not used any more. Nothing is started or charged here.
 */
export async function removeCharacterPick(projectId: number, ref: { assetId: number; screenId: number }): Promise<{ removed: true; hadItem: boolean; overlaysRemoved: number }> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const sel = await read(tx, projectId);
    const idx = sel.character.findIndex((c) => c.assetId === ref.assetId && c.screenId === ref.screenId);
    if (idx < 0) throw err(404, 'not_selected', 'That image is not selected for this scene.');
    const [pick] = sel.character.splice(idx, 1);
    const ids = new Set<number>(); if (pick.overlayId !== undefined) ids.add(pick.overlayId);
    if (pick.itemId !== undefined) for (const o of await tx.select({ id: videoOverlays.id }).from(videoOverlays).where(and(eq(videoOverlays.videoProjectId, projectId), eq(videoOverlays.characterItemId, pick.itemId)))) ids.add(o.id);
    const list = [...ids];
    if (list.length) {
      await tx.update(videoCompilationOverlays).set({ overlayId: null }).where(inArray(videoCompilationOverlays.overlayId, list));
      await tx.delete(videoOverlays).where(and(eq(videoOverlays.videoProjectId, projectId), inArray(videoOverlays.id, list)));
    }
    await write(tx, projectId, sel);
    return { removed: true as const, hadItem: pick.itemId !== undefined, overlaysRemoved: list.length };
  });
}

export interface PopulateResult { created: number; moved: number; /** picks that are usable but could not be placed inside their scene without overlapping something */ unplaced: number; /** picks whose scene no longer exists (never re-attached to another scene) */ sceneMissing: number; /** Character picks still going through personalise / approve / video */ waiting: number }

const timingOf = (o: typeof videoOverlays.$inferSelect): OverlayTiming => ({ id: o.id, track: o.track, anchorScreenId: o.anchorScreenId, startOffsetMs: o.startOffsetMs, durationMs: o.durationMs, sourceStartMs: o.sourceStartMs, assetDurationMs: o.assetDurationMs });

/**
 * Fills the timeline from the selection: library clips right away, Character clips once their video is ready. Safe to call on every visit.
 * Never creates a second overlay for a pick, never recreates one a person removed, never moves a 'manual' overlay.
 */
export async function populateComposition(projectId: number, userId: string): Promise<PopulateResult> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const sel = await read(tx, projectId);
    const result: PopulateResult = { created: 0, moved: 0, unplaced: 0, sceneMissing: 0, waiting: 0 };
    const existing = await tx.select().from(videoOverlays).where(eq(videoOverlays.videoProjectId, projectId));
    const { spans } = await planningSpans(tx, projectId);
    const active = new Set(spans.map((s) => s.screenId));
    const items = new Map<number, ItemRow>();
    const itemIds = sel.character.map((c) => c.itemId).filter((x): x is number => x !== undefined);
    if (itemIds.length) for (const it of await tx.select().from(characterBrollItems).where(and(eq(characterBrollItems.videoProjectId, projectId), inArray(characterBrollItems.id, itemIds)))) items.set(it.id, it);
    const clipIds = sel.generic.filter((g) => g.overlayId === undefined).map((g) => g.clipId);
    const clips = new Map<number, typeof brollClips.$inferSelect>();
    if (clipIds.length) for (const c of await tx.select().from(brollClips).where(inArray(brollClips.id, clipIds))) clips.set(c.id, c);

    type Cand = { tempId: number; track: number; apply: (offset: number) => Promise<number>; durationMs: number; assetMs: number | null; screenId: number; done: (overlayId: number) => void };
    const cands: Cand[] = []; let temp = -1; const now = Date.now();
    const room = Math.max(0, overlayLimit() - existing.length);

    for (const g of sel.generic) {
      if (g.overlayId !== undefined) continue;
      if (!active.has(g.screenId)) { result.sceneMissing += 1; continue; }
      const adopt = existing.find((o) => o.kind === 'generic' && o.brollClipId === g.clipId && o.anchorScreenId === g.screenId);
      if (adopt) { g.overlayId = adopt.id; continue; }
      const clip = clips.get(g.clipId); if (!clip) continue;
      const assetMs = clip.durationSeconds != null ? clip.durationSeconds * 1000 : null;
      const duration = Math.min(DEFAULT_OVERLAY_MS, assetMs ?? DEFAULT_OVERLAY_MS);
      if (duration < MIN_OVERLAY_MS) continue;
      cands.push({ tempId: temp--, track: GENERIC_TRACK, durationMs: duration, assetMs, screenId: g.screenId, done: (id) => { g.overlayId = id; },
        apply: async (offset) => (await tx.insert(videoOverlays).values({ videoProjectId: projectId, kind: 'generic', track: GENERIC_TRACK, anchorScreenId: g.screenId, startOffsetMs: offset, durationMs: duration, sourceStartMs: 0, assetDurationMs: assetMs, brollClipId: clip.id, status: 'preparing', placementSource: 'auto', createdBy: userId, createdAt: now, updatedAt: now }).returning({ id: videoOverlays.id }))[0].id });
    }
    for (const c of sel.character) {
      if (c.overlayId !== undefined) continue;
      if (c.itemId === undefined) { result.waiting += 1; continue; }
      const it = items.get(c.itemId);
      if (!it || it.clipStatus !== 'ready' || !it.clipStoragePath) { result.waiting += 1; continue; }
      if (!active.has(c.screenId)) { result.sceneMissing += 1; continue; }
      const adopt = existing.find((o) => o.characterItemId === it.id);
      if (adopt) { c.overlayId = adopt.id; continue; }
      const clipMs = it.clipDurationMs ?? CLIP_SECONDS * 1000;
      const duration = Math.min(clipMs, CLIP_SECONDS * 1000);
      cands.push({ tempId: temp--, track: CHARACTER_TRACK, durationMs: duration, assetMs: clipMs, screenId: c.screenId, done: (id) => { c.overlayId = id; },
        apply: async (offset) => (await tx.insert(videoOverlays).values({ videoProjectId: projectId, kind: 'character', track: CHARACTER_TRACK, anchorScreenId: c.screenId, startOffsetMs: offset, durationMs: duration, sourceStartMs: 0, assetStoragePath: it.clipStoragePath, assetWidth: it.clipWidth, assetHeight: it.clipHeight, assetDurationMs: clipMs, characterItemId: it.id, status: 'ready', placementSource: 'auto', createdBy: userId, createdAt: now, updatedAt: now }).returning({ id: videoOverlays.id }))[0].id });
    }

    const usable = cands.slice(0, room);
    const arranged = arrangeAuto(spans, [
      ...existing.map((o) => ({ ...timingOf(o), placementSource: o.placementSource === 'auto' ? 'auto' as const : 'manual' as const })),
      ...usable.map((c) => ({ id: c.tempId, track: c.track, anchorScreenId: c.screenId, startOffsetMs: 0, durationMs: c.durationMs, sourceStartMs: 0, assetDurationMs: c.assetMs, placementSource: 'auto' as const })),
    ]);
    const unplaced = new Set(arranged.unplaced);
    for (const c of usable) {
      if (unplaced.has(c.tempId)) { result.unplaced += 1; continue; }
      const offset = arranged.moves.find((m) => m.id === c.tempId)?.startOffsetMs ?? 0;
      c.done(await c.apply(offset)); result.created += 1;
    }
    // Existing AUTOMATIC overlays follow the real scene lengths; a person's ('manual') overlays are never touched.
    const autoIds = new Set(existing.filter((o) => o.placementSource === 'auto').map((o) => o.id));
    for (const m of arranged.moves) {
      if (!autoIds.has(m.id)) continue;
      await tx.update(videoOverlays).set({ startOffsetMs: m.startOffsetMs, updatedAt: now }).where(and(eq(videoOverlays.id, m.id), eq(videoOverlays.placementSource, 'auto'))); result.moved += 1;
    }
    await write(tx, projectId, sel);
    return result;
  });
}
