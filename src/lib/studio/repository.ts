/**
 * The Scene Pack Repository: packs, their source images and the metadata of each image. One set of records is shared by the
 * Repository tab and the Studio, so images added to a pack here are visible to every project that has approved it.
 *
 * Rules kept here (the database enforces the hard ones, see migration 0025):
 *   - a source image is immutable; "removing" one archives it, and its history stays;
 *   - editing metadata writes `manual` only, re-analysis writes `ai` only (see metadata.ts);
 *   - listPackAssets returns EVERY asset of a pack (active ones by default), whatever its metadata or analysis state.
 */
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssetMetadata, studioAssets, studioPacks } from '@/db/schema.pg';
import { applyManualPatch, effectiveMetadata, type ImportedLayer, type ManualPatch, type MetadataRecord } from './metadata';

export class StudioError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'StudioError';
  }
}

export const MAX_PACK_NAME = 120;
export const MAX_PACK_DESCRIPTION = 2000;
export const DEFAULT_PAGE = 60;
export const MAX_PAGE = 200;

type PackRow = typeof studioPacks.$inferSelect;
type AssetRow = typeof studioAssets.$inferSelect;
type MetaRow = typeof studioAssetMetadata.$inferSelect;

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
};

// ── Packs ────────────────────────────────────────────────────────────────────

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new StudioError('A Scene Pack needs a name.', 400, 'name_required');
  if (name.length > MAX_PACK_NAME) throw new StudioError(`The name is too long (max ${MAX_PACK_NAME} characters).`, 400, 'name_too_long');
  return name;
}
function cleanDescription(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new StudioError('The description must be text.', 400, 'bad_description');
  const d = v.trim();
  if (d.length > MAX_PACK_DESCRIPTION) throw new StudioError(`The description is too long (max ${MAX_PACK_DESCRIPTION} characters).`, 400, 'description_too_long');
  return d || null;
}

export async function createPack(input: { name: unknown; description?: unknown }, userId: string): Promise<PackRow> {
  const now = Date.now();
  const [row] = await db.insert(studioPacks).values({
    name: cleanName(input.name), description: cleanDescription(input.description), createdBy: userId, createdAt: now, updatedAt: now,
  }).returning();
  return row;
}

export async function getPack(id: number): Promise<PackRow> {
  const row = (await db.select().from(studioPacks).where(eq(studioPacks.id, id)).limit(1))[0];
  if (!row) throw new StudioError('Scene Pack not found.', 404, 'pack_not_found');
  return row;
}

export async function updatePack(id: number, input: { name?: unknown; description?: unknown }): Promise<PackRow> {
  await getPack(id);
  const set: Partial<typeof studioPacks.$inferInsert> = { updatedAt: Date.now() };
  if (input.name !== undefined) set.name = cleanName(input.name);
  if (input.description !== undefined) set.description = cleanDescription(input.description);
  if (Object.keys(set).length === 1) throw new StudioError('Nothing to change.', 400, 'nothing_to_change');
  // A new name or description changes what the pack is about, so its recommendation profile is out of date.
  set.profileStale = true;
  const [row] = await db.update(studioPacks).set(set).where(eq(studioPacks.id, id)).returning();
  return row;
}

export async function setPackArchived(id: number, archived: boolean): Promise<PackRow> {
  await getPack(id);
  const now = Date.now();
  const [row] = await db.update(studioPacks).set({ archivedAt: archived ? now : null, updatedAt: now }).where(eq(studioPacks.id, id)).returning();
  return row;
}

export interface PackSummary extends PackRow { assetCount: number; analysisPending: number; analysisFailed: number }

/** Every pack with the number of active images and how many still need (or failed) analysis. */
export async function listPacks(opts: { includeArchived?: boolean } = {}): Promise<PackSummary[]> {
  const packs = await db.select().from(studioPacks).where(opts.includeArchived ? undefined : isNull(studioPacks.archivedAt)).orderBy(asc(studioPacks.name), asc(studioPacks.id));
  if (packs.length === 0) return [];
  const rows = await db
    .select({
      packId: studioAssets.packId,
      total: count(),
      pending: sql<number>`count(*) filter (where ${studioAssets.analysisStatus} in ('pending','processing'))`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${studioAssets.analysisStatus} = 'failed')`.mapWith(Number),
    })
    .from(studioAssets)
    .where(isNull(studioAssets.archivedAt))
    .groupBy(studioAssets.packId);
  const byPack = new Map(rows.map((r) => [r.packId, r]));
  return packs.map((p) => ({ ...p, assetCount: Number(byPack.get(p.id)?.total ?? 0), analysisPending: byPack.get(p.id)?.pending ?? 0, analysisFailed: byPack.get(p.id)?.failed ?? 0 }));
}

// ── Assets ───────────────────────────────────────────────────────────────────

export interface AssetView {
  asset: AssetRow;
  ai: MetadataRecord | null;
  manual: MetadataRecord;
  /** What an import supplied (scene fields, composition, provenance, review flags). {} when nothing was imported. */
  imported: ImportedLayer;
  metadata: ReturnType<typeof effectiveMetadata>;
  aiAnalyzedAt: number | null;
}

function toView(asset: AssetRow, meta: MetaRow | null): AssetView {
  const ai = (meta?.ai as MetadataRecord | null) ?? null;
  const manual = (meta?.manual as MetadataRecord | null) ?? {};
  const imported = (meta?.imported as ImportedLayer | null) ?? {};
  return { asset, ai, manual, imported, metadata: effectiveMetadata(ai, manual, imported), aiAnalyzedAt: meta?.aiAnalyzedAt ?? null };
}

export interface ListAssetsOptions {
  /** Return assets with an id greater than this (the cursor from the previous page). */
  after?: number;
  limit?: number;
  /** Repository management shows archived images too; the Studio never does. */
  includeArchived?: boolean;
  /** A person's own search text. Only ever applied when asked for: the default is every asset. */
  search?: string;
}

export interface AssetPage {
  items: AssetView[];
  nextCursor: number | null;
  /** All active assets in the pack, regardless of search. */
  totalActive: number;
}

/**
 * THE function that lists a pack's images, for the Repository and (through the approval check) for the Studio.
 * It filters on the pack, on archival (explicit curator action) and on a search the user typed. It never looks at a
 * relevance score, at analysis status, or at any metadata value, so no image can be hidden by what it looks like.
 */
export async function listPackAssets(packId: number, opts: ListAssetsOptions = {}): Promise<AssetPage> {
  // A missing, non-numeric or fractional limit becomes the default (never NaN, which would reach the database as an invalid LIMIT).
  const asked = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : DEFAULT_PAGE;
  const limit = Math.min(Math.max(asked, 1), MAX_PAGE);
  const search = opts.search?.trim();
  const conditions = [eq(studioAssets.packId, packId)];
  if (!opts.includeArchived) conditions.push(isNull(studioAssets.archivedAt));
  if (opts.after !== undefined) conditions.push(gt(studioAssets.id, opts.after));
  if (search) conditions.push(sql`exists (select 1 from studio_asset_metadata m where m.asset_id = ${studioAssets.id} and m.search_tsv @@ plainto_tsquery('english', ${search}))`);

  const rows = await db
    .select({ asset: studioAssets, meta: studioAssetMetadata })
    .from(studioAssets)
    .leftJoin(studioAssetMetadata, eq(studioAssetMetadata.assetId, studioAssets.id))
    .where(and(...conditions))
    .orderBy(asc(studioAssets.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const [{ total }] = await db.select({ total: count() }).from(studioAssets).where(and(eq(studioAssets.packId, packId), isNull(studioAssets.archivedAt)));
  return {
    items: page.map((r) => toView(r.asset, r.meta)),
    nextCursor: rows.length > limit ? page[page.length - 1].asset.id : null,
    totalActive: Number(total),
  };
}

export async function getAssetView(id: number): Promise<AssetView> {
  const row = (await db.select({ asset: studioAssets, meta: studioAssetMetadata }).from(studioAssets).leftJoin(studioAssetMetadata, eq(studioAssetMetadata.assetId, studioAssets.id)).where(eq(studioAssets.id, id)).limit(1))[0];
  if (!row) throw new StudioError('Image not found.', 404, 'asset_not_found');
  return toView(row.asset, row.meta);
}

export interface NewAsset {
  packId: number;
  storageKey: string;
  thumbKey: string | null;
  originalFilename: string | null;
  mime: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  ingestGroup: string | null;
}

/** An asset already recorded for this storage key, or an active asset of the pack with the same SHA-256. */
export async function findExistingAsset(packId: number, storageKey: string, sha256?: string): Promise<{ asset: AssetRow; duplicate: boolean } | null> {
  const byKey = (await db.select().from(studioAssets).where(eq(studioAssets.storageKey, storageKey)).limit(1))[0];
  if (byKey) return { asset: byKey, duplicate: false };
  if (!sha256) return null;
  const bySha = (await db.select().from(studioAssets).where(and(eq(studioAssets.packId, packId), eq(studioAssets.sha256, sha256), isNull(studioAssets.archivedAt))).limit(1))[0];
  return bySha ? { asset: bySha, duplicate: true } : null;
}

export type RegisterResult = { asset: AssetRow; created: boolean; duplicate: boolean };

/**
 * Records a verified upload. Calling it again for the same file returns the same asset; an image the pack already holds
 * (same SHA-256, active) is returned instead of creating a second one; the same image in a different pack is a new asset.
 */
export async function registerAsset(input: NewAsset, userId: string): Promise<RegisterResult> {
  const now = Date.now();
  const find = async () => {
    const byKey = (await db.select().from(studioAssets).where(eq(studioAssets.storageKey, input.storageKey)).limit(1))[0];
    if (byKey) return { asset: byKey, created: false, duplicate: false } as RegisterResult;
    const bySha = (await db.select().from(studioAssets).where(and(eq(studioAssets.packId, input.packId), eq(studioAssets.sha256, input.sha256), isNull(studioAssets.archivedAt))).limit(1))[0];
    return bySha ? ({ asset: bySha, created: false, duplicate: true } as RegisterResult) : null;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    return await db.transaction(async (tx) => {
      const pack = (await tx.select().from(studioPacks).where(eq(studioPacks.id, input.packId)).limit(1))[0];
      if (!pack) throw new StudioError('Scene Pack not found.', 404, 'pack_not_found');
      if (pack.archivedAt) throw new StudioError('This Scene Pack is archived. Restore it before adding images.', 409, 'pack_archived');
      const [asset] = await tx.insert(studioAssets).values({
        packId: input.packId, storageKey: input.storageKey, thumbKey: input.thumbKey, originalFilename: input.originalFilename,
        mime: input.mime, sizeBytes: input.sizeBytes, sha256: input.sha256, width: input.width, height: input.height,
        ingestGroup: input.ingestGroup, analysisStatus: 'pending', createdBy: userId, createdAt: now, updatedAt: now,
      }).returning();
      await tx.insert(studioAssetMetadata).values({ assetId: asset.id, ai: null, manual: {}, createdAt: now, updatedAt: now });
      await tx.update(studioPacks).set({ profileStale: true, updatedAt: now }).where(eq(studioPacks.id, input.packId));
      return { asset, created: true, duplicate: false } as RegisterResult;
    });
  } catch (err) {
    if (isUniqueViolation(err)) { const again = await find(); if (again) return again; }
    throw err;
  }
}

/** Saves a person's edit. Only the manual column changes; the AI output and the file are untouched. */
export async function editMetadata(assetId: number, patch: ManualPatch, userId: string): Promise<AssetView> {
  const view = await getAssetView(assetId);
  const next = applyManualPatch(view.manual, patch);
  const now = Date.now();
  await db.insert(studioAssetMetadata).values({ assetId, ai: null, manual: next, manualUpdatedBy: userId, manualUpdatedAt: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: studioAssetMetadata.assetId, set: { manual: next, manualUpdatedBy: userId, manualUpdatedAt: now, updatedAt: now } });
  await db.update(studioPacks).set({ profileStale: true, updatedAt: now }).where(eq(studioPacks.id, view.asset.packId));
  return getAssetView(assetId);
}

/** Queues the image for analysis again. The AI result will replace `ai` only; manual edits are never touched. */
export async function requestReanalysis(assetId: number): Promise<AssetView> {
  const view = await getAssetView(assetId);
  if (view.asset.archivedAt) throw new StudioError('This image is archived. Restore it before re-analysing.', 409, 'asset_archived');
  await db.update(studioAssets).set({ analysisStatus: 'pending', analysisError: null, claimedAt: null, analysisAttempts: 0, updatedAt: Date.now() }).where(eq(studioAssets.id, assetId));
  return getAssetView(assetId);
}

/** Takes an image out of (or back into) active use. Nothing is deleted: jobs, outputs and selections keep pointing at it. */
export async function setAssetArchived(assetId: number, archived: boolean, userId: string): Promise<AssetView> {
  const view = await getAssetView(assetId);
  const now = Date.now();
  try {
    await db.update(studioAssets).set(archived ? { archivedAt: now, archivedBy: userId, updatedAt: now } : { archivedAt: null, archivedBy: null, updatedAt: now }).where(eq(studioAssets.id, assetId));
  } catch (err) {
    if (isUniqueViolation(err)) throw new StudioError('This pack already has an active copy of this image, so this one cannot be restored.', 409, 'duplicate_active');
    throw err;
  }
  await db.update(studioPacks).set({ profileStale: true, updatedAt: now }).where(eq(studioPacks.id, view.asset.packId));
  return getAssetView(assetId);
}


// ── Import support (migration 0027) ─────────────────────────────────────────

/** A pack by its permanent import key (archived ones included). */
export async function findPackByImportKey(importKey: string): Promise<PackRow | null> {
  return (await db.select().from(studioPacks).where(eq(studioPacks.importKey, importKey)).limit(1))[0] ?? null;
}

/** Creates a pack with a permanent key, or returns the one that already has it. A pack's name and description are never overwritten here. */
export async function createImportedPack(input: { importKey: string; name: string; description: string }, userId: string): Promise<{ pack: PackRow; created: boolean }> {
  const existing = await findPackByImportKey(input.importKey);
  if (existing) return { pack: existing, created: false };
  const now = Date.now();
  try {
    const [row] = await db.insert(studioPacks).values({ name: cleanName(input.name), description: cleanDescription(input.description), importKey: input.importKey, createdBy: userId, createdAt: now, updatedAt: now }).returning();
    return { pack: row, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) { const again = await findPackByImportKey(input.importKey); if (again) return { pack: again, created: false }; }
    throw err;
  }
}

/** Every database row (version) of a source image, oldest first. At most one is active. */
export async function listAssetVersions(importKey: string): Promise<AssetRow[]> {
  return db.select().from(studioAssets).where(eq(studioAssets.importKey, importKey)).orderBy(asc(studioAssets.id));
}

export interface NewImportedAsset extends NewAsset {
  importKey: string;
  imported: ImportedLayer;
  /** 'skipped' keeps the AI worker off an image whose metadata was imported. */
  analysisStatus: 'pending' | 'skipped';
  /** The active row this one replaces (changed content or a new pack): it is archived in the SAME transaction. Never deleted. */
  supersedesAssetId?: number | null;
}

/**
 * Registers one VERSION of a source image. In one transaction it archives the row it supersedes (if any), inserts the new asset
 * with the permanent import_key, and stores the imported layer. Calling it again for the same file returns the existing row.
 * The old row, its R2 object and its history are untouched.
 */
export async function registerImportedAsset(input: NewImportedAsset, userId: string): Promise<{ asset: AssetRow; created: boolean }> {
  const now = Date.now();
  const same = (await db.select().from(studioAssets).where(eq(studioAssets.storageKey, input.storageKey)).limit(1))[0];
  if (same) return { asset: same, created: false };
  return db.transaction(async (tx) => {
    const pack = (await tx.select().from(studioPacks).where(eq(studioPacks.id, input.packId)).limit(1))[0];
    if (!pack) throw new StudioError('Scene Pack not found.', 404, 'pack_not_found');
    if (pack.archivedAt) throw new StudioError('This Scene Pack is archived. Restore it before adding images.', 409, 'pack_archived');
    if (input.supersedesAssetId) {
      const old = (await tx.select().from(studioAssets).where(eq(studioAssets.id, input.supersedesAssetId)).limit(1))[0];
      if (!old || old.importKey !== input.importKey) throw new StudioError('The version being replaced does not belong to this image.', 409, 'version_mismatch');
      if (!old.archivedAt) {
        await tx.update(studioAssets).set({ archivedAt: now, archivedBy: userId, updatedAt: now }).where(eq(studioAssets.id, old.id));
        await tx.update(studioPacks).set({ profileStale: true, updatedAt: now }).where(eq(studioPacks.id, old.packId));
      }
    }
    const [asset] = await tx.insert(studioAssets).values({
      packId: input.packId, storageKey: input.storageKey, thumbKey: input.thumbKey, originalFilename: input.originalFilename,
      mime: input.mime, sizeBytes: input.sizeBytes, sha256: input.sha256, width: input.width, height: input.height,
      ingestGroup: input.ingestGroup, importKey: input.importKey, analysisStatus: input.analysisStatus, createdBy: userId, createdAt: now, updatedAt: now,
    }).returning();
    await tx.insert(studioAssetMetadata).values({ assetId: asset.id, ai: null, manual: {}, imported: input.imported, createdAt: now, updatedAt: now });
    await tx.update(studioPacks).set({ profileStale: true, updatedAt: now }).where(eq(studioPacks.id, input.packId));
    return { asset, created: true };
  });
}

/** Replaces ONLY the imported layer of an asset (a re-import). The manual and AI layers are not touched. */
export async function replaceImportedLayer(assetId: number, imported: ImportedLayer): Promise<void> {
  const now = Date.now();
  const [row] = await db.update(studioAssetMetadata).set({ imported, updatedAt: now }).where(eq(studioAssetMetadata.assetId, assetId)).returning({ id: studioAssetMetadata.assetId });
  if (!row) throw new StudioError('Image not found.', 404, 'asset_not_found');
  const a = (await db.select({ packId: studioAssets.packId }).from(studioAssets).where(eq(studioAssets.id, assetId)).limit(1))[0];
  if (a) await db.update(studioPacks).set({ profileStale: true, updatedAt: now }).where(eq(studioPacks.id, a.packId));
}

/** Follows a renamed source file: only the display file name changes (the identity, the key and the content do not). */
export async function setAssetOriginalFilename(assetId: number, originalFilename: string): Promise<void> {
  await db.update(studioAssets).set({ originalFilename, updatedAt: Date.now() }).where(eq(studioAssets.id, assetId));
}

/** Records a thumbnail made after the asset was registered (a repair). Only fills in a missing key; an existing key is never replaced. */
export async function setAssetThumbKey(assetId: number, thumbKey: string): Promise<boolean> {
  const rows = await db.update(studioAssets).set({ thumbKey, updatedAt: Date.now() }).where(and(eq(studioAssets.id, assetId), isNull(studioAssets.thumbKey))).returning({ id: studioAssets.id });
  return rows.length > 0;
}
