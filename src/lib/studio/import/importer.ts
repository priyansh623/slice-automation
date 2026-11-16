/**
 * The Scene Pack importer: a resumable, idempotent import of the manifest's images into the Studio, built on the existing
 * storage and registration code (putR2Only, makeGridThumbnail, registerObjectIfAbsent, the registry and tombstone protections).
 *
 *   dry run   reads the manifest, the source files, the database and R2 and reports what WOULD happen. It writes nothing.
 *   apply     uploads originals and thumbnails, registers one asset row per version, imports the metadata layer.
 *
 * Guarantees: an existing R2 object is never overwritten (an object that is already there is checked by its real content hash);
 * nothing is ever deleted; a changed image or a pack move registers a NEW version and archives the old row (never moves or
 * edits it); each image is independent, so one failure never stops the others; a rerun after any interruption finishes the work.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssets, studioPacks } from '@/db/schema.pg';
import { ObjectExistsError } from '@/lib/object-store/types';
import { registerObjectIfAbsent } from '@/lib/object-store/registry';
import { assetThumbKey, STUDIO_IMAGE_MAX_BYTES, STUDIO_MAX_PIXELS } from '../keys';
import { inspectImage, makeGridThumbnail, sha256Of } from '../image-store';
import { isRemovedKeyError } from '../references';
import { createImportedPack, getAssetView, listAssetVersions, registerImportedAsset, replaceImportedLayer, setAssetThumbKey, setAssetOriginalFilename, setPackArchived, findPackByImportKey, StudioError } from '../repository';
import type { ImportedLayer } from '../metadata';
import { assetKeyFor, emptyState, MANIFEST_VERSION, validateManifest, type ImportManifest, type ManifestImage, type ImportState, type StateStore, type StateVersion } from './manifest';

export interface ImportStorage {
  r2Configured(): boolean;
  headR2(bucket: 'uploads', key: string): Promise<{ size: number; contentType: string | null } | null>;
  downloadR2Only(bucket: 'uploads', key: string): Promise<Buffer>;
  putR2Only(bucket: 'uploads', key: string, body: Buffer, opts: { contentType: string }): Promise<unknown>;
}
export interface ImportDeps {
  storage: ImportStorage;
  /** The bytes of a source file by its path inside the source folder ("<folder>/<file>"), or null if it is not there. */
  readSource(relativePath: string): Promise<Buffer | null>;
  /** Every file present in the source folder (".DS_Store" excluded), to report files the manifest does not know. */
  listSource?(): Promise<string[]>;
  userId: string;
  state?: StateStore;
}
export interface ImportOptions {
  apply: boolean;
  /** Dry run only: also download each existing R2 original and check its hash (slow). Apply always checks. */
  verifyR2?: boolean;
  /** Import only these permanent IDs. */
  only?: string[];
}

export type Action = 'create' | 'new_version' | 'move' | 'skip' | 'update_metadata' | 'repair' | 'invalid' | 'failed' | 'missing';
export interface ImageOutcome {
  importKey: string; action: Action; detail?: string; assetId?: number; version?: number; storageKey?: string;
  r2?: 'uploaded' | 'verified' | 'would_upload' | 'unchecked'; thumbnail?: 'created' | 'present' | 'would_create' | 'failed';
  supersedes?: number; notes?: string[];
}
export interface ImportReport {
  mode: 'dry-run' | 'apply';
  packs: Array<{ key: string; action: 'create' | 'exists' | 'mismatch' | 'failed'; detail?: string }>;
  images: ImageOutcome[];
  missing: string[]; unexpected: string[]; duplicateHashes: string[][]; manifestIssues: string[];
  /** Problems writing the state file. The database is correct; the state file is a record and is rebuilt from the database on the next run. */
  stateWarnings: string[];
  counts: Record<string, number>;
}

class ImportFailure extends Error { constructor(public readonly action: 'invalid' | 'failed', message: string) { super(message); } }

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => a.localeCompare(b))) : x));

/** The imported layer an image should have: the manifest's scene metadata plus provenance and lineage. No timestamps, so a rerun compares equal. */
export function desiredLayer(m: ImportManifest, im: ManifestImage, lineage: { version: number; supersedes_asset_id: number | null }): ImportedLayer {
  return { ...im.imported, source: { import_key: im.importKey, source_folder: im.source.folder, source_file: im.source.file, manifest_version: m.manifestVersion }, status: 'needs_human_review', version: lineage.version, lineage };
}

/** Everything about a source file that must hold before it is uploaded. Throws ImportFailure('invalid', ...). */
export async function validateSource(im: ManifestImage, bytes: Buffer): Promise<void> {
  if (bytes.length > STUDIO_IMAGE_MAX_BYTES) throw new ImportFailure('invalid', `file is ${bytes.length} bytes (limit ${STUDIO_IMAGE_MAX_BYTES})`);
  if (bytes.length !== im.sizeBytes) throw new ImportFailure('invalid', `size ${bytes.length} differs from the manifest (${im.sizeBytes})`);
  if (sha256Of(bytes) !== im.sha256) throw new ImportFailure('invalid', 'content differs from the manifest SHA-256 (update the manifest if the image was changed on purpose)');
  let info; try { info = await inspectImage(bytes); } catch { throw new ImportFailure('invalid', 'not a readable PNG, JPEG or WEBP image'); }
  if (info.format !== 'png') throw new ImportFailure('invalid', `format ${info.format}, expected png`);
  if (info.width !== im.width || info.height !== im.height) throw new ImportFailure('invalid', `dimensions ${info.width}x${info.height} differ from the manifest (${im.width}x${im.height})`);
  if (info.width * info.height > STUDIO_MAX_PIXELS) throw new ImportFailure('invalid', 'too many pixels');
}

/** Makes sure the original is in R2. An object that is already there must have exactly this content (checked by hash); it is never overwritten. */
async function ensureOriginal(deps: ImportDeps, key: string, bytes: Buffer, sha: string, o: { apply: boolean; check: boolean }): Promise<'uploaded' | 'verified' | 'would_upload' | 'unchecked'> {
  const head = await deps.storage.headR2('uploads', key);
  if (head) {
    if (!o.check) return 'unchecked';
    const stored = sha256Of(await deps.storage.downloadR2Only('uploads', key));
    if (stored !== sha) throw new ImportFailure('failed', `the R2 object ${key} exists with different content; it is not overwritten`);
    return 'verified';
  }
  if (!o.apply) return 'would_upload';
  try { await deps.storage.putR2Only('uploads', key, bytes, { contentType: 'image/png' }); return 'uploaded'; }
  catch (err) {
    if (!(err instanceof ObjectExistsError)) throw err;
    if (sha256Of(await deps.storage.downloadR2Only('uploads', key)) !== sha) throw new ImportFailure('failed', `the R2 object ${key} appeared with different content; it is not overwritten`);
    return 'verified';
  }
}

/** A thumbnail next to the original. Failing to make one is not fatal: the asset works without it and a rerun repairs it. */
async function ensureThumb(deps: ImportDeps, storageKey: string, bytes: Buffer, apply: boolean): Promise<{ key: string | null; state: 'created' | 'present' | 'would_create' | 'failed' }> {
  const key = assetThumbKey(storageKey);
  if (!key) return { key: null, state: 'failed' };
  try {
    if (await deps.storage.headR2('uploads', key)) return { key, state: 'present' };
    if (!apply) return { key, state: 'would_create' };
    const thumb = await makeGridThumbnail(bytes);
    try { await deps.storage.putR2Only('uploads', key, thumb, { contentType: 'image/webp' }); } catch (err) { if (!(err instanceof ObjectExistsError)) throw err; }
    return { key, state: 'created' };
  } catch { return { key: null, state: 'failed' }; }
}

export async function runImport(manifest: ImportManifest, deps: ImportDeps, opts: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = { mode: opts.apply ? 'apply' : 'dry-run', packs: [], images: [], missing: [], unexpected: [], duplicateHashes: [], manifestIssues: validateManifest(manifest), stateWarnings: [], counts: {} };
  if (report.manifestIssues.length) return finish(report);
  if (opts.apply && !deps.storage.r2Configured()) throw new StudioError('Cloudflare R2 is not configured.', 503, 'r2_unavailable');
  let state: ImportState | undefined;
  try { state = deps.state?.load(); } catch (err) { report.stateWarnings.push(`the state file could not be read and is rebuilt from the database: ${(err as Error).message}`); state = deps.state ? emptyState() : undefined; }

  // Duplicate content across the manifest (same bytes under two permanent IDs).
  const bySha = new Map<string, string[]>();
  for (const im of manifest.images) bySha.set(im.sha256, [...(bySha.get(im.sha256) ?? []), im.importKey]);
  report.duplicateHashes = [...bySha.values()].filter((g) => g.length > 1);

  if (deps.listSource) {
    const known = new Set(manifest.images.map((i) => i.source.relativePath));
    report.unexpected = (await deps.listSource()).filter((f) => !known.has(f)).sort();
  }

  // Packs: found by permanent key; created in apply mode. An existing pack's name and description are never changed by an import.
  const packIds = new Map<string, number | null>();
  for (const p of manifest.packs) {
    try {
      const existing = await findPackByImportKey(p.key);
      if (existing) {
        packIds.set(p.key, existing.id);
        const differs = existing.name !== p.name || (existing.description ?? '') !== p.description;
        report.packs.push({ key: p.key, action: differs ? 'mismatch' : 'exists', detail: differs ? 'name or description was edited since the import; left as it is' : undefined });
      } else if (opts.apply) {
        const { pack } = await createImportedPack({ importKey: p.key, name: p.name, description: p.description }, deps.userId);
        packIds.set(p.key, pack.id); report.packs.push({ key: p.key, action: 'create' });
      } else { packIds.set(p.key, null); report.packs.push({ key: p.key, action: 'create' }); }
      if (state && packIds.get(p.key)) state.packs[p.key] = { packId: packIds.get(p.key)! };
    } catch (err) { packIds.set(p.key, null); report.packs.push({ key: p.key, action: 'failed', detail: (err as Error).message }); }
  }

  const packKeyById = new Map<number, string>();
  for (const [k, id] of packIds) if (id) packKeyById.set(id, k);
  const todo = manifest.images.filter((i) => !opts.only || opts.only.includes(i.importKey));
  for (const im of todo) {
    let out: ImageOutcome;
    try { out = await importOne(manifest, im, deps, opts, packIds); }
    catch (err) {
      if (err instanceof ImportFailure) out = { importKey: im.importKey, action: err.action, detail: err.message };
      else if (isRemovedKeyError(err)) out = { importKey: im.importKey, action: 'failed', detail: 'the database refused a key that was removed earlier (tombstone); a later version number is needed' };
      else out = { importKey: im.importKey, action: 'failed', detail: (err as Error).message };
    }
    if (out.action === 'missing') report.missing.push(im.importKey);
    report.images.push(out);
    if (opts.apply && state && deps.state) {
      // The state file is only a record. It is rebuilt from the database after EVERY image (also an unchanged one), so a failed write
      // or an empty file on another machine is healed by the next run. A failure here never stops the import.
      try { await syncImageState(state, im.importKey, packKeyById); state.updatedAt = Date.now(); deps.state.save(state); }
      catch (err) { report.stateWarnings.push(`${im.importKey}: the state file was not updated (${(err as Error).message}); the database is correct and the next run rebuilds the record`); }
    }
  }
  return finish(report);
}

/** Rebuilds one image's version history in the state file from the database, which is the source of truth. */
async function syncImageState(state: ImportState, importKey: string, packKeyById: Map<number, string>): Promise<void> {
  const rows = await listAssetVersions(importKey);
  if (rows.length === 0) return;
  const versions: StateVersion[] = [];
  for (const [i, r] of rows.entries()) {
    const view = await getAssetView(r.id);
    const lineage = view.imported.lineage as { version?: number; supersedes_asset_id?: number | null } | undefined;
    versions.push({
      version: lineage?.version ?? i + 1, assetId: r.id, packKey: packKeyById.get(r.packId) ?? `pack:${r.packId}`, packId: r.packId, sha256: r.sha256, storageKey: r.storageKey, thumbKey: r.thumbKey,
      supersedesAssetId: lineage?.supersedes_asset_id ?? null, status: r.archivedAt ? 'archived' : 'active', registeredAt: r.createdAt,
    });
  }
  state.images[importKey] = { versions };
}

function finish(r: ImportReport): ImportReport {
  for (const o of r.images) r.counts[o.action] = (r.counts[o.action] ?? 0) + 1;
  for (const p of r.packs) r.counts[`pack_${p.action}`] = (r.counts[`pack_${p.action}`] ?? 0) + 1;
  return r;
}

async function importOne(m: ImportManifest, im: ManifestImage, deps: ImportDeps, o: ImportOptions, packIds: Map<string, number | null>): Promise<ImageOutcome> {
  const bytes = await deps.readSource(im.source.relativePath);
  if (!bytes) return { importKey: im.importKey, action: 'missing', detail: `source file ${im.source.relativePath} not found` };
  await validateSource(im, bytes);

  const packId = packIds.get(im.pack) ?? null;
  const versions = await listAssetVersions(im.importKey);
  const active = versions.find((v) => !v.archivedAt) ?? null;
  const notes: string[] = [];
  const same = (await db.select({ id: studioAssets.id, packId: studioAssets.packId }).from(studioAssets).where(and(eq(studioAssets.sha256, im.sha256), ne(studioAssets.importKey, im.importKey))).limit(3));
  if (same.length) notes.push(`the same bytes already exist as asset(s) ${same.map((s) => s.id).join(', ')} under other identities (kept as they are)`);

  // ── unchanged: verify, repair, refresh metadata ──
  if (active && active.sha256 === im.sha256 && packId !== null && active.packId === packId) {
    const r2 = await ensureOriginal(deps, active.storageKey, bytes, im.sha256, { apply: o.apply, check: o.apply || !!o.verifyR2 });
    let thumb: ImageOutcome['thumbnail'] = 'present'; let action: Action = 'skip';
    // An original that had gone missing from R2 is put back (never overwritten): that is a repair, not a skip.
    if (r2 === 'uploaded' || r2 === 'would_upload') { action = 'repair'; notes.push('the original was missing from R2 and is uploaded again'); }
    const th = await ensureThumb(deps, active.storageKey, bytes, o.apply);
    if (th.state !== 'present') { thumb = th.state; action = 'repair'; if (o.apply && th.key && th.state === 'created' && !active.thumbKey) await setAssetThumbKey(active.id, th.key); }
    else if (!active.thumbKey && o.apply && th.key) { await setAssetThumbKey(active.id, th.key); action = 'repair'; }
    // A renamed source file keeps the identity; the record's file name follows the manifest.
    if (active.originalFilename !== im.source.file) { if (o.apply) await setAssetOriginalFilename(active.id, im.source.file); if (action === 'skip') action = 'update_metadata'; notes.push(`file name ${active.originalFilename ?? '(none)'} -> ${im.source.file}`); }
    const view = await getAssetView(active.id);
    const lineage = (view.imported.lineage as { version: number; supersedes_asset_id: number | null } | undefined) ?? { version: versions.indexOf(active) + 1, supersedes_asset_id: null };
    const want = desiredLayer(m, im, lineage);
    if (stable(view.imported) !== stable(want)) { if (o.apply) await replaceImportedLayer(active.id, want); if (action === 'skip') action = 'update_metadata'; notes.push('imported metadata refreshed (manual edits untouched)'); }
    return { importKey: im.importKey, action, assetId: active.id, version: lineage.version, storageKey: active.storageKey, r2, thumbnail: thumb, notes };
  }

  // ── a new version: first import, changed content, or a different pack ──
  const action: Action = !active ? 'create' : active.sha256 !== im.sha256 ? 'new_version' : 'move';
  const version = versions.length + 1;
  const storageKey = assetKeyFor(im.importKey, version, im.sha256);
  const r2 = await ensureOriginal(deps, storageKey, bytes, im.sha256, { apply: o.apply, check: true });
  const th = await ensureThumb(deps, storageKey, bytes, o.apply);
  if (!o.apply) return { importKey: im.importKey, action, version, storageKey, r2, thumbnail: th.state, supersedes: active?.id, notes };
  if (packId === null) throw new ImportFailure('failed', `pack ${im.pack} is not available`);
  await registerObjectIfAbsent({ bucket: 'uploads', key: storageKey, provider: 'r2', sizeBytes: bytes.length, contentType: 'image/png', sha256: im.sha256, verifiedAt: Date.now() });
  const lineage = { version, supersedes_asset_id: active?.id ?? null };
  const { asset } = await registerImportedAsset({
    packId, importKey: im.importKey, storageKey, thumbKey: th.key && th.state !== 'failed' ? th.key : null, originalFilename: im.source.file, mime: 'image/png', sizeBytes: bytes.length, sha256: im.sha256,
    width: im.width, height: im.height, ingestGroup: null, imported: desiredLayer(m, im, lineage), analysisStatus: 'skipped', supersedesAssetId: active?.id ?? null,
  }, deps.userId);
  return { importKey: im.importKey, action, assetId: asset.id, version, storageKey, r2, thumbnail: th.state, supersedes: active?.id, notes };
}

// ── the one approved production clean-up: retire the Cafe test pack ──────────

export interface LegacyArchiveReport { ok: boolean; applied: boolean; reason: string; packId: number }
/**
 * Archives (soft: a flag) the legacy test pack that holds the single test upload. It checks, before doing anything, that the pack
 * is the one expected (name, one active asset, and that asset is byte-identical to the given manifest image). The pack, its asset
 * record, the original and the thumbnail in R2 are all kept as they are. Nothing is deleted.
 */
export async function archiveLegacyTestPack(manifest: ImportManifest, args: { packId: number; expectedName: string; duplicateOf: string; apply: boolean }): Promise<LegacyArchiveReport> {
  const im = manifest.images.find((i) => i.importKey === args.duplicateOf);
  if (!im) return { ok: false, applied: false, reason: `${args.duplicateOf} is not in the manifest`, packId: args.packId };
  const pack = (await db.select().from(studioPacks).where(eq(studioPacks.id, args.packId)).limit(1))[0];
  if (!pack) return { ok: false, applied: false, reason: 'pack not found', packId: args.packId };
  if (pack.name !== args.expectedName) return { ok: false, applied: false, reason: `pack ${args.packId} is called "${pack.name}", not "${args.expectedName}"`, packId: args.packId };
  if (pack.importKey) return { ok: false, applied: false, reason: 'this pack was created by an import; it is not the legacy test pack', packId: args.packId };
  if (pack.archivedAt) return { ok: true, applied: false, reason: 'already archived', packId: args.packId };
  const assets = await db.select().from(studioAssets).where(eq(studioAssets.packId, pack.id));
  if (assets.length !== 1 || assets[0].sha256 !== im.sha256) return { ok: false, applied: false, reason: `expected exactly one asset identical to ${args.duplicateOf}; found ${assets.length}`, packId: args.packId };
  if (!args.apply) return { ok: true, applied: false, reason: 'would archive (nothing changed)', packId: args.packId };
  await setPackArchived(pack.id, true);
  return { ok: true, applied: true, reason: 'archived; pack, asset record and R2 objects kept', packId: args.packId };
}

export { MANIFEST_VERSION };

/** The exit code of a run: 0 only when every image imported (or was already in place) and the record could be written. */
export const exitCodeFor = (r: Pick<ImportReport, 'images' | 'manifestIssues' | 'stateWarnings'>): 0 | 2 =>
  r.images.some((i) => i.action === 'failed' || i.action === 'invalid' || i.action === 'missing') || r.manifestIssues.length || r.stateWarnings.length ? 2 : 0;

export interface OfflineReport { images: Array<{ importKey: string; status: 'ok' | 'missing' | 'invalid'; detail?: string }>; unexpected: string[]; duplicateHashes: string[][]; manifestIssues: string[] }
/** Checks the manifest against the source files only: no database, no R2. */
export async function checkSourceOffline(manifest: ImportManifest, readSource: ImportDeps['readSource'], listSource?: ImportDeps['listSource']): Promise<OfflineReport> {
  const rep: OfflineReport = { images: [], unexpected: [], duplicateHashes: [], manifestIssues: validateManifest(manifest) };
  const bySha = new Map<string, string[]>();
  for (const im of manifest.images) bySha.set(im.sha256, [...(bySha.get(im.sha256) ?? []), im.importKey]);
  rep.duplicateHashes = [...bySha.values()].filter((g) => g.length > 1);
  for (const im of manifest.images) {
    const bytes = await readSource(im.source.relativePath);
    if (!bytes) { rep.images.push({ importKey: im.importKey, status: 'missing', detail: `source file ${im.source.relativePath} not found` }); continue; }
    try { await validateSource(im, bytes); rep.images.push({ importKey: im.importKey, status: 'ok' }); }
    catch (err) { rep.images.push({ importKey: im.importKey, status: 'invalid', detail: (err as Error).message }); }
  }
  if (listSource) { const known = new Set(manifest.images.map((i) => i.source.relativePath)); rep.unexpected = (await listSource()).filter((f) => !known.has(f)).sort(); }
  return rep;
}
