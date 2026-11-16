/**
 * Pack-first approval. A project sees no individual image until it approves the pack that holds it. Once a pack is approved
 * EVERY non-archived image of that pack is available to the project, through the same listPackAssets() the Repository uses:
 * no relevance score, metadata value or analysis state decides whether an image shows. Approval can be given to a
 * recommended pack or to any other pack the person chooses.
 */
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssets, studioPacks, studioProjectPacks, studioSelections } from '@/db/schema.pg';
import { getProject } from './projects';
import { listPackAssets, StudioError, type AssetPage, type ListAssetsOptions } from './repository';

interface Recommended { packId: number }

export async function approvePacks(projectId: number, packIds: number[], userId: string): Promise<{ approved: number[]; already: number[] }> {
  const project = await getProject(projectId);
  const ids = [...new Set(packIds)];
  if (ids.length === 0) throw new StudioError('Choose at least one Scene Pack.', 400, 'no_packs');
  const packs = await db.select().from(studioPacks).where(inArray(studioPacks.id, ids));
  const found = new Map(packs.map((p) => [p.id, p]));
  for (const id of ids) {
    const p = found.get(id);
    if (!p) throw new StudioError(`Scene Pack ${id} was not found.`, 404, 'pack_not_found');
    if (p.archivedAt) throw new StudioError(`"${p.name}" is archived. Restore it before approving it.`, 409, 'pack_archived');
  }
  const recommended = new Set(((project.recommendations as Recommended[] | null) ?? []).map((r) => r.packId));
  const existing = new Set((await db.select({ packId: studioProjectPacks.packId }).from(studioProjectPacks).where(and(eq(studioProjectPacks.projectId, projectId), inArray(studioProjectPacks.packId, ids)))).map((r) => r.packId));
  const toAdd = ids.filter((id) => !existing.has(id));
  if (toAdd.length > 0) {
    const now = Date.now();
    await db.insert(studioProjectPacks).values(toAdd.map((packId) => ({ projectId, packId, source: recommended.has(packId) ? 'recommended' : 'manual', approvedBy: userId, approvedAt: now }))).onConflictDoNothing();
  }
  return { approved: toAdd, already: ids.filter((id) => existing.has(id)) };
}

/** Takes a pack back out of the project. Blocked while any of its images is still selected; history is never touched. */
export async function revokePack(projectId: number, packId: number): Promise<void> {
  await getProject(projectId);
  const row = (await db.select().from(studioProjectPacks).where(and(eq(studioProjectPacks.projectId, projectId), eq(studioProjectPacks.packId, packId))).limit(1))[0];
  if (!row) throw new StudioError('This pack is not approved for the project.', 404, 'not_approved');
  const [{ n }] = await db.select({ n: count() }).from(studioSelections).where(and(eq(studioSelections.projectId, projectId), eq(studioSelections.packId, packId)));
  if (Number(n) > 0) {
    throw new StudioError(`${n} image${Number(n) === 1 ? ' is' : 's are'} still selected from this pack. Remove ${Number(n) === 1 ? 'it' : 'them'} from the selection first.`, 409, 'pack_has_selections');
  }
  await db.delete(studioProjectPacks).where(and(eq(studioProjectPacks.projectId, projectId), eq(studioProjectPacks.packId, packId)));
}

export interface ApprovedPack {
  packId: number; name: string; description: string | null; packArchived: boolean; source: string; approvedAt: number;
  activeAssetCount: number;
  /** Images added to the pack after this project approved it. They are already visible; this just says so. */
  newSinceApproval: number;
  selectedCount: number;
}

export async function listProjectPacks(projectId: number): Promise<ApprovedPack[]> {
  await getProject(projectId);
  const approvals = await db
    .select({ packId: studioProjectPacks.packId, source: studioProjectPacks.source, approvedAt: studioProjectPacks.approvedAt, name: studioPacks.name, description: studioPacks.description, archivedAt: studioPacks.archivedAt })
    .from(studioProjectPacks).innerJoin(studioPacks, eq(studioPacks.id, studioProjectPacks.packId))
    .where(eq(studioProjectPacks.projectId, projectId)).orderBy(studioPacks.name);
  if (approvals.length === 0) return [];
  const ids = approvals.map((a) => a.packId);
  const assetCounts = await db.select({ packId: studioAssets.packId, total: count(), createdAt: sql<number>`max(${studioAssets.createdAt})`.mapWith(Number) }).from(studioAssets).where(and(inArray(studioAssets.packId, ids), isNull(studioAssets.archivedAt))).groupBy(studioAssets.packId);
  const selected = await db.select({ packId: studioSelections.packId, n: count() }).from(studioSelections).where(and(eq(studioSelections.projectId, projectId), inArray(studioSelections.packId, ids))).groupBy(studioSelections.packId);
  const newer = await db.select({ packId: studioAssets.packId, n: count() }).from(studioAssets)
    .innerJoin(studioProjectPacks, and(eq(studioProjectPacks.packId, studioAssets.packId), eq(studioProjectPacks.projectId, projectId)))
    .where(and(inArray(studioAssets.packId, ids), isNull(studioAssets.archivedAt), sql`${studioAssets.createdAt} > ${studioProjectPacks.approvedAt}`)).groupBy(studioAssets.packId);
  const total = new Map(assetCounts.map((c) => [c.packId, Number(c.total)]));
  const sel = new Map(selected.map((c) => [c.packId, Number(c.n)]));
  const nw = new Map(newer.map((c) => [c.packId, Number(c.n)]));
  return approvals.map((a) => ({
    packId: a.packId, name: a.name, description: a.description, packArchived: a.archivedAt !== null, source: a.source, approvedAt: a.approvedAt,
    activeAssetCount: total.get(a.packId) ?? 0, newSinceApproval: nw.get(a.packId) ?? 0, selectedCount: sel.get(a.packId) ?? 0,
  }));
}

export async function requireApproval(projectId: number, packId: number): Promise<void> {
  const row = (await db.select().from(studioProjectPacks).where(and(eq(studioProjectPacks.projectId, projectId), eq(studioProjectPacks.packId, packId))).limit(1))[0];
  if (!row) throw new StudioError('Approve this Scene Pack for the project to see its images.', 403, 'pack_not_approved');
}

/**
 * The images a project sees in an approved pack: ALL of the pack's non-archived images, a page at a time. Only an approved pack
 * can be listed; nothing else about an image affects whether it is listed (search narrows only when the person types one).
 */
export async function listApprovedPackAssets(projectId: number, packId: number, opts: Omit<ListAssetsOptions, 'includeArchived'> = {}): Promise<AssetPage> {
  await getProject(projectId);
  await requireApproval(projectId, packId);
  return listPackAssets(packId, { ...opts, includeArchived: false });
}
