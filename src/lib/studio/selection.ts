/**
 * The ONE shared selection of a project, across all its approved packs. Every row keeps the asset id and the pack id the image
 * came from. An image archived after it was selected stays selected (so nothing silently disappears) and is shown as archived,
 * but it can no longer enter a new generation batch (see batches.ts).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssets, studioPacks, studioProjectPacks, studioSelections } from '@/db/schema.pg';
import { getProject } from './projects';
import { StudioError } from './repository';

export const MAX_SELECTION = 500;

export interface SelectionItem {
  assetId: number; packId: number; packName: string; addedAt: number; addedBy: string;
  asset: typeof studioAssets.$inferSelect;
  archived: boolean;
}

export async function listSelection(projectId: number): Promise<SelectionItem[]> {
  await getProject(projectId);
  const rows = await db
    .select({ sel: studioSelections, asset: studioAssets, packName: studioPacks.name })
    .from(studioSelections)
    .innerJoin(studioAssets, eq(studioAssets.id, studioSelections.assetId))
    .innerJoin(studioPacks, eq(studioPacks.id, studioSelections.packId))
    .where(eq(studioSelections.projectId, projectId))
    .orderBy(asc(studioSelections.addedAt), asc(studioSelections.assetId));
  return rows.map((r) => ({ assetId: r.sel.assetId, packId: r.sel.packId, packName: r.packName, addedAt: r.sel.addedAt, addedBy: r.sel.addedBy, asset: r.asset, archived: r.asset.archivedAt !== null }));
}

function cleanIds(v: unknown): number[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'number' && Number.isInteger(x) && x > 0)) throw new StudioError('assetIds must be a list of image ids.', 400, 'invalid_ids');
  return [...new Set(v as number[])];
}

/** Adds images to the selection. Each must belong to a pack this project has approved, and must not be archived. */
export async function addToSelection(projectId: number, assetIds: unknown, userId: string): Promise<{ added: number[]; already: number[] }> {
  await getProject(projectId);
  const ids = cleanIds(assetIds);
  const assets = await db.select().from(studioAssets).where(inArray(studioAssets.id, ids));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const approved = new Set((await db.select({ packId: studioProjectPacks.packId }).from(studioProjectPacks).where(eq(studioProjectPacks.projectId, projectId))).map((r) => r.packId));
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) throw new StudioError(`Image ${id} was not found.`, 404, 'asset_not_found');
    if (!approved.has(a.packId)) throw new StudioError('That image is in a Scene Pack this project has not approved.', 403, 'pack_not_approved');
    if (a.archivedAt) throw new StudioError('An archived image cannot be added to the selection.', 409, 'asset_archived');
  }
  const existing = new Set((await db.select({ assetId: studioSelections.assetId }).from(studioSelections).where(and(eq(studioSelections.projectId, projectId), inArray(studioSelections.assetId, ids)))).map((r) => r.assetId));
  const toAdd = ids.filter((id) => !existing.has(id));
  if (toAdd.length > 0) {
    const total = (await db.select({ assetId: studioSelections.assetId }).from(studioSelections).where(eq(studioSelections.projectId, projectId))).length;
    if (total + toAdd.length > MAX_SELECTION) throw new StudioError(`A selection can hold at most ${MAX_SELECTION} images.`, 409, 'selection_full');
    const now = Date.now();
    // The pack id is always the asset's own (never taken from the client); the database also enforces it.
    await db.insert(studioSelections).values(toAdd.map((assetId) => ({ projectId, assetId, packId: byId.get(assetId)!.packId, addedBy: userId, addedAt: now }))).onConflictDoNothing();
  }
  return { added: toAdd, already: ids.filter((id) => existing.has(id)) };
}

/** Removes the given images from the selection, or all of them when no ids are given. */
export async function removeFromSelection(projectId: number, assetIds?: unknown): Promise<number> {
  await getProject(projectId);
  const where = assetIds === undefined ? eq(studioSelections.projectId, projectId) : and(eq(studioSelections.projectId, projectId), inArray(studioSelections.assetId, cleanIds(assetIds)));
  const removed = await db.delete(studioSelections).where(where).returning({ assetId: studioSelections.assetId });
  return removed.length;
}
