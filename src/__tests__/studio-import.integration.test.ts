/**
 * The Scene Pack importer: dry run, apply, identity and versioning, idempotency, resume after failures, no overwrites, no deletions,
 * thumbnails and their repair, manual edits surviving a re-import, and the one approved clean-up of the legacy Cafe test pack.
 * Real sharp and real migrations (in-memory Postgres); R2 is an in-memory fake.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate } from './helpers/studio-fakes';

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));

import { archiveLegacyTestPack, exitCodeFor, runImport, type ImportDeps } from '@/lib/studio/import/importer';
import { assetKeyFor, MemoryStateStore, validateManifest, type ImportManifest, type ImportState, type ManifestImage, type StateStore } from '@/lib/studio/import/manifest';
import { CLOTHING_PATTERN, PERSON_PATTERNS } from '@/lib/studio/import/scene-metadata';
import { isStudioAssetKey } from '@/lib/studio/keys';
import { getAssetView, listAssetVersions, editMetadata } from '@/lib/studio/repository';

const USER = '00000000-0000-4000-8000-00000000000a';
const ROOT = path.resolve(__dirname, '../..');
let pg: PGlite; let db: PgliteDatabase<typeof schema>;
beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (color: string, w = 90, h = 160) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

class SelectiveR2 extends FakeR2 {
  failKeys: RegExp | null = null;
  async putR2Only(b: string, key: string, buf: Buffer, opts: { contentType: string }) { if (this.failKeys?.test(key)) throw new Error('r2 refused this key'); return super.putR2Only(b, key, buf, opts); }
}

let files: Map<string, Buffer>; let r2: SelectiveR2; let manifest: ImportManifest; let state: MemoryStateStore;
const img = (n: number, pack: string, bytes: Buffer, folder = '1'): ManifestImage => ({
  importKey: `IMG-${String(n).padStart(3, '0')}`, source: { folder, file: `f${n}.png`, relativePath: `${folder}/f${n}.png` }, sha256: sha(bytes), sha1: 'x', sizeBytes: bytes.length, width: 90, height: 160, format: 'png', pack,
  secondaryConcepts: ['a'], confidence: 'high', review: [{ kind: 'metadata_draft' }],
  imported: { fields: { environment: `env ${n}`, activity: `act ${n}`, tags: [`tag${n}`] }, composition: { pose: 'standing' }, operational: { flags: ['FACE_PARTIAL'] }, technical: { format: 'PNG' } },
});
async function setup() {
  files = new Map(); r2 = new SelectiveR2(); state = new MemoryStateStore();
  const mk = async (n: number, pack: string, color: string) => { const b = await png(color); files.set(`1/f${n}.png`, b); return img(n, pack, b); };
  manifest = { manifestVersion: 1, sourceDirectory: 'Scene Packs ', packs: [
    { key: 'pack-a', letter: 'A', name: 'Pack A', description: 'Scenes of A' }, { key: 'pack-b', letter: 'B', name: 'Pack B', description: 'Scenes of B' }],
  images: [await mk(1, 'pack-a', '#ff0000'), await mk(2, 'pack-a', '#00ff00'), await mk(3, 'pack-b', '#0000ff')] };
}
const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
  storage: r2, userId: USER, state,
  readSource: async (p) => files.get(p) ?? null, listSource: async () => [...files.keys()], ...over,
});
const counts = async () => ({
  packs: (await db.select({ c: sql<number>`count(*)::int` }).from(schema.studioPacks))[0].c,
  assets: (await db.select({ c: sql<number>`count(*)::int` }).from(schema.studioAssets))[0].c,
  meta: (await db.select({ c: sql<number>`count(*)::int` }).from(schema.studioAssetMetadata))[0].c,
});
beforeEach(async () => { await pg.exec('truncate studio_asset_metadata, studio_assets, studio_packs, studio_deleted_keys, studio_upload_intents, storage_objects restart identity cascade'); await setup(); });

describe('the real manifest', () => {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/studio-import/manifest.json'), 'utf8')) as ImportManifest;
  it('is valid: 54 images, 8 packs, the approved allocation, permanent IDs, deterministic valid keys', () => {
    expect(validateManifest(real)).toEqual([]);
    expect(real.images).toHaveLength(54);
    expect(real.images.map((i) => i.importKey)).toEqual(Array.from({ length: 54 }, (_, i) => `IMG-${String(i + 1).padStart(3, '0')}`));
    const per = Object.fromEntries(real.packs.map((p) => [p.letter, real.images.filter((i) => i.pack === p.key).length]));
    expect(per).toEqual({ A: 11, B: 6, C: 6, D: 3, E: 3, F: 6, G: 7, H: 12 });
    const keys = real.images.map((i) => assetKeyFor(i.importKey, 1, i.sha256));
    expect(new Set(keys).size).toBe(54);
    expect(keys.every(isStudioAssetKey)).toBe(true);
    expect(assetKeyFor('IMG-018', 1, real.images[17].sha256)).toBe(assetKeyFor('IMG-018', 1, real.images[17].sha256)); // deterministic
    expect(assetKeyFor('IMG-018', 2, real.images[17].sha256)).not.toBe(assetKeyFor('IMG-018', 1, real.images[17].sha256)); // a new version, a new key
  });
  it('IMG-018 is the byte-identical twin of the Cafe test asset and gets its own, different key', () => {
    const i = real.images.find((x) => x.importKey === 'IMG-018')!;
    expect(i.sha256).toBe('b3fd23d740b3794535be20b62966c3831198556a83bb3846bf74712c60454a2b');
    expect(i.pack).toBe('home-life');
    expect(assetKeyFor('IMG-018', 1, i.sha256)).not.toContain('cdae8e3a-eac8-4744-91e4-b6ee8e653d92');
  });
  it('keeps uncertain classifications as review flags and never carries a description of a person', () => {
    const uncertain = real.images.filter((i) => i.confidence !== 'high');
    expect(uncertain.length).toBeGreaterThan(10);
    for (const i of uncertain) expect(i.review.some((r) => r.kind === 'classification_uncertain')).toBe(true);
    expect(JSON.stringify(real)).not.toMatch(/\b(man|woman|he|she|his|her|him|beard|hair|persona)\b/i);
    expect(real.images.every((i) => i.imported.status === undefined)).toBe(true); // provenance is added by the importer, not baked in
  });
});

describe('dry run', () => {
  it('writes nothing: no database rows, no R2 writes, no state; and reports what it would do', async () => {
    const before = await counts();
    const rep = await runImport(manifest, deps(), { apply: false });
    expect(await counts()).toEqual(before);
    expect(r2.puts).toEqual([]); expect(r2.deletes).toEqual([]);
    expect(state.state.updatedAt).toBe(0);
    expect(rep.mode).toBe('dry-run');
    expect(rep.packs.map((p) => p.action)).toEqual(['create', 'create']);
    expect(rep.images.map((i) => i.action)).toEqual(['create', 'create', 'create']);
    expect(rep.images.every((i) => i.r2 === 'would_upload' && i.thumbnail === 'would_create')).toBe(true);
    expect(rep.images[0].storageKey).toBe(assetKeyFor('IMG-001', 1, manifest.images[0].sha256));
  });

  it('reports missing, unexpected, invalid (changed or wrong size) files and duplicate content, without failing', async () => {
    files.delete('1/f2.png');
    files.set('1/stray.png', await png('#abcdef'));
    files.set('1/f3.png', await png('#111111')); // differs from the manifest checksum
    manifest.images.push(img(4, 'pack-b', files.get('1/f1.png')!)); // the same bytes as IMG-001 under another ID
    manifest.images[3].source = { folder: '1', file: 'f4.png', relativePath: '1/f4.png' }; files.set('1/f4.png', files.get('1/f1.png')!);
    const rep = await runImport(manifest, deps(), { apply: false });
    expect(rep.missing).toEqual(['IMG-002']);
    expect(rep.unexpected).toEqual(['1/stray.png']);
    expect(rep.images.find((i) => i.importKey === 'IMG-003')).toMatchObject({ action: 'invalid' });
    expect(rep.duplicateHashes).toEqual([['IMG-001', 'IMG-004']]);
    expect(rep.images.find((i) => i.importKey === 'IMG-001')!.action).toBe('create');
  });

  it('refuses a manifest that describes a person', async () => {
    manifest.images[0].imported.fields!.description = 'Man in a white tee at a desk.';
    const rep = await runImport(manifest, deps(), { apply: false });
    expect(rep.manifestIssues.join(' ')).toMatch(/describes a person/);
    expect(rep.images).toEqual([]);
  });
});

describe('apply', () => {
  it('imports everything: packs with permanent keys, originals at deterministic keys, thumbnails, imported metadata, no AI analysis queued', async () => {
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.counts).toMatchObject({ create: 3, pack_create: 2 });
    expect(await counts()).toEqual({ packs: 2, assets: 3, meta: 3 });
    for (const im of manifest.images) {
      const [a] = await listAssetVersions(im.importKey);
      expect(a.storageKey).toBe(assetKeyFor(im.importKey, 1, im.sha256));
      expect(r2.has(a.storageKey)).toBe(true); expect(sha(r2.get(a.storageKey))).toBe(im.sha256);
      expect(a.thumbKey).toBeTruthy(); expect(r2.has(a.thumbKey!)).toBe(true);
      expect(a.analysisStatus).toBe('skipped');
      expect(a.sha256).toBe(im.sha256); expect(a.originalFilename).toBe(im.source.file);
      const v = await getAssetView(a.id);
      expect(v.metadata.values.environment).toBe(im.imported.fields!.environment);
      expect(v.metadata.provenance.environment).toBe('imported');
      expect(v.imported).toMatchObject({ status: 'needs_human_review', version: 1, lineage: { version: 1, supersedes_asset_id: null }, source: { import_key: im.importKey } });
    }
    const packA = (await db.select().from(schema.studioPacks).where(eq(schema.studioPacks.importKey, 'pack-a')))[0];
    expect((await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.packId, packA.id))).length).toBe(2);
    expect(state.state.images['IMG-001'].versions[0]).toMatchObject({ version: 1, status: 'active', packKey: 'pack-a', supersedesAssetId: null });
    expect(r2.deletes).toEqual([]);
  });

  it('a rerun creates nothing and uploads nothing (idempotent)', async () => {
    await runImport(manifest, deps(), { apply: true });
    const putsBefore = r2.puts.length; const c = await counts();
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.counts).toMatchObject({ skip: 3, pack_exists: 2 });
    expect(r2.puts.length).toBe(putsBefore);
    expect(await counts()).toEqual(c);
  });

  it('one failing image does not stop the others; a rerun finishes it without duplicates', async () => {
    r2.failKeys = new RegExp(assetKeyFor('IMG-002', 1, manifest.images[1].sha256).replace(/[.]/g, '\\.'));
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images.map((i) => i.action)).toEqual(['create', 'failed', 'create']);
    expect(await counts()).toMatchObject({ assets: 2 });
    r2.failKeys = null;
    const again = await runImport(manifest, deps(), { apply: true });
    expect(again.images.map((i) => i.action)).toEqual(['skip', 'create', 'skip']);
    expect(await counts()).toMatchObject({ assets: 3 });
  });

  it('resumes after an interruption between the upload and the database record: the object is verified, not uploaded again', async () => {
    const key = assetKeyFor('IMG-001', 1, manifest.images[0].sha256);
    r2.objects.set(`uploads/${key}`, { buf: files.get('1/f1.png')!, contentType: 'image/png' }); // the crash left it behind
    const rep = await runImport(manifest, deps(), { apply: true });
    const one = rep.images.find((i) => i.importKey === 'IMG-001')!;
    expect(one).toMatchObject({ action: 'create', r2: 'verified' });
    expect(r2.puts).not.toContain(key);
    expect((await listAssetVersions('IMG-001')).length).toBe(1);
  });

  it('never overwrites: an R2 object with different content at the key is a failure for that image only', async () => {
    const key = assetKeyFor('IMG-001', 1, manifest.images[0].sha256);
    r2.objects.set(`uploads/${key}`, { buf: Buffer.from('something else'), contentType: 'image/png' });
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images[0]).toMatchObject({ action: 'failed' });
    expect(rep.images[0].detail).toMatch(/different content/);
    expect(r2.get(key).toString()).toBe('something else');
    expect(rep.images.slice(1).every((i) => i.action === 'create')).toBe(true);
    expect((await listAssetVersions('IMG-001')).length).toBe(0);
  });

  it('a key that was removed earlier (tombstone) fails that image clearly and the rest continue', async () => {
    const key = assetKeyFor('IMG-002', 1, manifest.images[1].sha256);
    await pg.query(`insert into studio_deleted_keys (key, reason, requested_at) values ($1, 'test', 1)`, [key]);
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images[1]).toMatchObject({ action: 'failed' });
    expect(rep.images[1].detail).toMatch(/tombstone/);
    expect(rep.images.filter((i) => i.action === 'create').length).toBe(2);
  });

  it('a thumbnail that cannot be made does not block the asset; a rerun repairs it', async () => {
    r2.failKeys = /\/thumbs\//;
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images.every((i) => i.action === 'create' && i.thumbnail === 'failed')).toBe(true);
    expect((await listAssetVersions('IMG-001'))[0].thumbKey).toBeNull();
    r2.failKeys = null;
    const again = await runImport(manifest, deps(), { apply: true });
    expect(again.images.every((i) => i.action === 'repair')).toBe(true);
    const a = (await listAssetVersions('IMG-001'))[0];
    expect(a.thumbKey).toBeTruthy(); expect(r2.has(a.thumbKey!)).toBe(true);
  });

  it('a missing source file is reported and skipped; the other images import', async () => {
    files.delete('1/f2.png');
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images.map((i) => i.action)).toEqual(['create', 'missing', 'create']);
    expect(rep.missing).toEqual(['IMG-002']);
  });
});

describe('identity, versions and reorganisation', () => {
  it('changed content: the old row is archived and kept, a new row with a new key is registered under the same permanent ID', async () => {
    await runImport(manifest, deps(), { apply: true });
    const [old] = await listAssetVersions('IMG-001');
    const changed = await png('#ffff00'); files.set('1/f1.png', changed);
    manifest.images[0] = { ...manifest.images[0], sha256: sha(changed), sizeBytes: changed.length };
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images[0]).toMatchObject({ action: 'new_version', version: 2, supersedes: old.id });
    const rows = await listAssetVersions('IMG-001');
    expect(rows.map((r) => !!r.archivedAt)).toEqual([true, false]);
    expect(rows[1].storageKey).not.toBe(old.storageKey);
    expect(r2.has(old.storageKey)).toBe(true); // the old object is untouched
    expect(sha(r2.get(old.storageKey))).toBe(old.sha256);
    expect((await getAssetView(rows[1].id)).imported.lineage).toEqual({ version: 2, supersedes_asset_id: old.id });
    expect(state.state.images['IMG-001'].versions.map((v) => v.status)).toEqual(['archived', 'active']);
    expect(r2.deletes).toEqual([]);
  });

  it('pack reorganisation: same permanent ID, new row in the new pack, old row archived; the old row is never moved', async () => {
    await runImport(manifest, deps(), { apply: true });
    const [old] = await listAssetVersions('IMG-001');
    manifest.images[0] = { ...manifest.images[0], pack: 'pack-b' };
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images[0]).toMatchObject({ action: 'move', version: 2 });
    const rows = await listAssetVersions('IMG-001');
    expect(rows[0]).toMatchObject({ id: old.id, packId: old.packId });
    expect(rows[1].packId).not.toBe(old.packId);
    expect(rows[1].storageKey).not.toBe(old.storageKey);
    expect(rows.filter((r) => !r.archivedAt).length).toBe(1);
  });

  it('a renamed or moved source file does not change the identity (the manifest path is only where to read it from)', async () => {
    await runImport(manifest, deps(), { apply: true });
    const [a] = await listAssetVersions('IMG-001');
    files.set('renamed/new-name.png', files.get('1/f1.png')!); files.delete('1/f1.png');
    manifest.images[0] = { ...manifest.images[0], source: { folder: 'renamed', file: 'new-name.png', relativePath: 'renamed/new-name.png' } };
    const rep = await runImport(manifest, deps(), { apply: true });
    // only the recorded source path changes (the imported layer is refreshed); the asset, its key and its file stay
    expect(rep.images[0].action).toBe('update_metadata');
    const rows = await listAssetVersions('IMG-001');
    expect(rows.map((r) => r.id)).toEqual([a.id]);
    expect(rows[0].storageKey).toBe(a.storageKey);
    expect((await getAssetView(a.id)).imported.source).toMatchObject({ import_key: 'IMG-001', source_file: 'new-name.png' });
  });
});

describe('manual edits and re-import', () => {
  it('a re-import refreshes the imported layer and leaves manual edits, including a deliberate clear, untouched', async () => {
    await runImport(manifest, deps(), { apply: true });
    const [a] = await listAssetVersions('IMG-001');
    await editMetadata(a.id, { set: { environment: 'my environment', activity: null }, revert: [] }, USER);
    manifest.images[0].imported = { ...manifest.images[0].imported, fields: { ...manifest.images[0].imported.fields, environment: 'new imported env', activity: 'new imported act', lighting: 'new light' } };
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images[0].action).toBe('update_metadata');
    const v = await getAssetView(a.id);
    expect(v.manual).toEqual({ environment: 'my environment', activity: null });
    expect(v.metadata.values).toMatchObject({ environment: 'my environment', activity: null, lighting: 'new light' });
    expect(v.metadata.provenance).toMatchObject({ environment: 'manual', activity: 'manual', lighting: 'imported' });
  });
});

describe('the legacy Cafe test pack', () => {
  async function legacy(name = 'Cafe', key = 'studio/assets/cdae8e3a-eac8-4744-91e4-b6ee8e653d92.png') {
    const [p] = await db.insert(schema.studioPacks).values({ name, createdBy: USER, createdAt: 1, updatedAt: 1 }).returning();
    const bytes = files.get('1/f3.png')!;
    r2.objects.set(`uploads/${key}`, { buf: bytes, contentType: 'image/png' });
    await db.insert(schema.studioAssets).values({ packId: p.id, storageKey: key, mime: 'image/png', sizeBytes: bytes.length, sha256: sha(bytes), analysisStatus: 'completed', createdBy: USER, createdAt: 1, updatedAt: 1 });
    return { p, key };
  }
  it('is archived (soft) only after checks; the pack, asset record and R2 object are kept; the twin is imported separately with its own key', async () => {
    const { p, key } = await legacy();
    const dry = await archiveLegacyTestPack(manifest, { packId: p.id, expectedName: 'Cafe', duplicateOf: 'IMG-003', apply: false });
    expect(dry).toMatchObject({ ok: true, applied: false });
    expect((await db.select().from(schema.studioPacks).where(eq(schema.studioPacks.id, p.id)))[0].archivedAt).toBeNull();
    const done = await archiveLegacyTestPack(manifest, { packId: p.id, expectedName: 'Cafe', duplicateOf: 'IMG-003', apply: true });
    expect(done).toMatchObject({ ok: true, applied: true });
    expect((await db.select().from(schema.studioPacks).where(eq(schema.studioPacks.id, p.id)))[0].archivedAt).not.toBeNull();
    expect((await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.packId, p.id))).length).toBe(1);
    expect(r2.has(key)).toBe(true); expect(r2.deletes).toEqual([]);
    await runImport(manifest, deps(), { apply: true });
    const [twin] = await listAssetVersions('IMG-003');
    expect(twin.storageKey).not.toBe(key);
    expect(twin.sha256).toBe(sha(r2.get(key)));
    const meta = await getAssetView(twin.id);
    expect(meta.ai).toBeNull(); // the old AI metadata is not copied
  });
  it('refuses the wrong pack, a pack made by an import, or a pack whose asset is not the twin', async () => {
    const { p } = await legacy('Something else');
    expect(await archiveLegacyTestPack(manifest, { packId: p.id, expectedName: 'Cafe', duplicateOf: 'IMG-003', apply: true })).toMatchObject({ ok: false });
    const { p: q } = await legacy('Cafe', 'studio/assets/cdae8e3a-eac8-4744-91e4-b6ee8e653d99.png');
    expect(await archiveLegacyTestPack(manifest, { packId: q.id, expectedName: 'Cafe', duplicateOf: 'IMG-001', apply: true })).toMatchObject({ ok: false });
    expect((await db.select().from(schema.studioPacks).where(eq(schema.studioPacks.id, q.id)))[0].archivedAt).toBeNull();
  });
});

describe('after the audit: IMG-011, the state record, exit codes, repairs and renames', () => {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/studio-import/manifest.json'), 'utf8')) as ImportManifest;

  it('IMG-011 is in Home Life, still flagged for review, and is not described as a restaurant or a pizza shop', () => {
    const i = real.images.find((x) => x.importKey === 'IMG-011')!;
    expect(i.pack).toBe('home-life');
    expect(i.review.map((r) => r.kind)).toEqual(expect.arrayContaining(['classification_uncertain', 'setting_discrepancy']));
    const text = JSON.stringify([i.imported.fields!.environment, i.imported.fields!.description, i.review.map((r) => r.note)]); // (the alternate pack's key is an identifier, not a description)
    expect(text).not.toMatch(/restaurant|pizza (shop|outlet)|outlet|fast food/i);
    expect(i.imported.fields!.environment).toMatch(/decorated room/);
    expect(real.packs.find((p) => p.key === 'home-life')!.description).toMatch(/party room/);
  });

  it('the person patterns in migration 0027 are exactly the patterns the profiles use', () => {
    const sqlText = fs.readFileSync(path.join(ROOT, 'drizzle/pg/0027_studio_scene_packs.sql'), 'utf8');
    const body = /regexp_replace\(translate\(coalesce\(t, ''\), '_', ' '\), '([^']+)', ' ', 'gi'\)/.exec(sqlText)![1];
    expect(body.replace(/\\y/g, '<B>')).toBe([...PERSON_PATTERNS, CLOTHING_PATTERN].join('|'));
  });

  class FlakyState extends MemoryStateStore {
    saves = 0; failSaves = true;
    save(s: ImportState) { this.saves++; if (this.failSaves) throw new Error('disk full'); super.save(s); }
  }
  it('B1: a state file that cannot be written does not stop the import, is reported, and the next run rebuilds it from the database', async () => {
    const flaky = new FlakyState();
    const rep = await runImport(manifest, deps({ state: flaky }), { apply: true });
    expect(rep.images.map((i) => i.action)).toEqual(['create', 'create', 'create']);
    expect(rep.stateWarnings.length).toBe(3);
    expect(exitCodeFor(rep)).toBe(2);
    expect((await counts()).assets).toBe(3);
    // a different (empty) state record, nothing to import: every image is a skip, and the history is back
    const fresh = new MemoryStateStore();
    const again = await runImport(manifest, deps({ state: fresh }), { apply: true });
    expect(again.images.every((i) => i.action === 'skip')).toBe(true);
    expect(again.stateWarnings).toEqual([]);
    expect(exitCodeFor(again)).toBe(0);
    for (const im of manifest.images) {
      const v = fresh.state.images[im.importKey].versions;
      const rows = await listAssetVersions(im.importKey);
      expect(v.map((x) => x.assetId)).toEqual(rows.map((r) => r.id));
      expect(v[0]).toMatchObject({ version: 1, status: 'active', storageKey: rows[0].storageKey, sha256: im.sha256, supersedesAssetId: null });
    }
  });

  it('B1: an unreadable state file is reported and rebuilt; it never blocks the import', async () => {
    const broken: StateStore = { load() { throw new Error('Unexpected token in JSON'); }, save() { /* kept in memory only */ } };
    const rep = await runImport(manifest, deps({ state: broken }), { apply: true });
    expect(rep.stateWarnings[0]).toMatch(/could not be read/);
    expect(rep.images.every((i) => i.action === 'create')).toBe(true);
  });

  it('B1: the history in the state record follows a new version (the old one archived, the new one active)', async () => {
    await runImport(manifest, deps(), { apply: true });
    const b2 = await png('#ffff00'); files.set('1/f1.png', b2);
    manifest.images[0] = { ...manifest.images[0], sha256: sha(b2), sizeBytes: b2.length };
    await runImport(manifest, deps(), { apply: true });
    const v = state.state.images['IMG-001'].versions;
    expect(v.map((x) => [x.version, x.status])).toEqual([[1, 'archived'], [2, 'active']]);
    expect(v[1].supersedesAssetId).toBe(v[0].assetId);
  });

  it('B2: a missing source file, a failed image or an unwritable record is not a clean run (exit 2); a clean run is 0', async () => {
    files.delete('1/f2.png');
    const missing = await runImport(manifest, deps(), { apply: true });
    expect(missing.images.map((i) => i.action)).toEqual(['create', 'missing', 'create']);
    expect(exitCodeFor(missing)).toBe(2);
    files.set('1/f2.png', await png('#00ff00'));
    expect(exitCodeFor(await runImport(manifest, deps(), { apply: true }))).toBe(0);
    expect(exitCodeFor(await runImport(manifest, deps(), { apply: true }))).toBe(0);
  });

  it('B3: an original that went missing from R2 is put back (never overwritten) and reported as a repair, not a skip', async () => {
    await runImport(manifest, deps(), { apply: true });
    const [a] = await listAssetVersions('IMG-001');
    r2.objects.delete(`uploads/${a.storageKey}`);
    const before = r2.deletes.length;
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images.map((i) => i.action)).toEqual(['repair', 'skip', 'skip']);
    expect(rep.images[0].r2).toBe('uploaded');
    expect(rep.images[0].notes?.join(' ')).toMatch(/missing from R2/);
    expect(r2.get(a.storageKey).equals(files.get('1/f1.png')!)).toBe(true);
    expect(r2.deletes.length).toBe(before); // the importer deletes nothing
    // and a dry run says the same without writing
    r2.objects.delete(`uploads/${a.storageKey}`);
    const puts = r2.puts.length;
    const dry = await runImport(manifest, deps(), { apply: false });
    expect(dry.images[0].action).toBe('repair');
    expect(r2.puts.length).toBe(puts);
  });

  it('B4: a renamed source file updates the record\'s file name as well as the imported source; identity, key and content stay', async () => {
    await runImport(manifest, deps(), { apply: true });
    const [a] = await listAssetVersions('IMG-001');
    expect(a.originalFilename).toBe('f1.png');
    files.set('renamed/new-name.png', files.get('1/f1.png')!); files.delete('1/f1.png');
    manifest.images[0] = { ...manifest.images[0], source: { folder: 'renamed', file: 'new-name.png', relativePath: 'renamed/new-name.png' } };
    const dry = await runImport(manifest, deps(), { apply: false });
    expect(dry.images[0].action).toBe('update_metadata');
    expect((await listAssetVersions('IMG-001'))[0].originalFilename).toBe('f1.png'); // a dry run writes nothing
    const rep = await runImport(manifest, deps(), { apply: true });
    expect(rep.images[0].action).toBe('update_metadata');
    const rows = await listAssetVersions('IMG-001');
    expect(rows.map((r) => [r.id, r.storageKey, r.sha256, r.originalFilename])).toEqual([[a.id, a.storageKey, a.sha256, 'new-name.png']]);
    expect((await runImport(manifest, deps(), { apply: true })).images[0].action).toBe('skip');
  });
});
