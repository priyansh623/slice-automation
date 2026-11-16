/**
 * Migration 0027 and the three-layer metadata model (manual > imported > AI, per field), the permanent import identity and
 * asset versioning. An in-memory Postgres built from the repository's real migration files.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema.pg';
import { migrate } from './helpers/studio-fakes';

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));

import { effectiveMetadata } from '@/lib/studio/metadata';
import { stripPersonWords } from '@/lib/studio/import/scene-metadata';
import { EXCLUDED, LEGITIMATE } from './helpers/person-corpus';
import { createImportedPack, getAssetView, listAssetVersions, listPackAssets, registerImportedAsset, replaceImportedLayer, editMetadata } from '@/lib/studio/repository';

const USER = '00000000-0000-4000-8000-00000000000a';
const ROOT = path.resolve(__dirname, '../..');
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => { await pg.exec('truncate studio_asset_metadata, studio_assets, studio_packs, studio_deleted_keys, studio_upload_intents restart identity cascade'); });

let seq = 0;
const key = () => `studio/assets/00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}.png`;
async function pack(importKey = `pack-${seq + 1}`) { return (await createImportedPack({ importKey, name: `Pack ${importKey}`, description: 'd' }, USER)).pack; }
const base = (packId: number, importKey: string, over: Record<string, unknown> = {}) => ({
  packId, importKey, storageKey: key(), thumbKey: null, originalFilename: 'x.png', mime: 'image/png', sizeBytes: 10, sha256: `sha-${importKey}-${seq}`, width: 10, height: 10, ingestGroup: null,
  imported: { fields: {} }, analysisStatus: 'skipped' as const, ...over,
});
const sqlEffective = async (assetId: number, field: string) => ((await pg.query<{ v: string | null }>(`select studio_effective(ai, manual, imported, $2) as v from studio_asset_metadata where asset_id = $1`, [assetId, field])).rows[0]?.v);

describe('migration 0027', () => {
  it('fails with a clear message when 0025 and 0026 are not there', async () => {
    const bare = new PGlite();
    await expect(bare.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg/0027_studio_scene_packs.sql'), 'utf8'))).rejects.toThrow(/needs migrations 0025 and 0026/);
    await bare.close();
  });

  it('is safe to run again: nothing is lost and the vector is rebuilt', async () => {
    const p = await pack();
    const { asset } = await registerImportedAsset(base(p.id, 'IMG-001', { imported: { fields: { environment: 'home kitchen' } } }), USER);
    await pg.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg/0027_studio_scene_packs.sql'), 'utf8'));
    expect((await getAssetView(asset.id)).metadata.values.environment).toBe('home kitchen');
    const hit = await pg.query(`select 1 from studio_asset_metadata where search_tsv @@ plainto_tsquery('english','kitchen')`);
    expect(hit.rows.length).toBe(1);
  });

  it('leaves existing rows with imported = {} and the same effective values (what the Cafe test asset looks like)', async () => {
    const p = await pack();
    // A row as migrations 0025/0026 and the upload flow would have written it: AI metadata only.
    const [a] = await db.insert(schema.studioAssets).values({ packId: p.id, storageKey: key(), mime: 'image/png', sizeBytes: 1, sha256: 'cafe', analysisStatus: 'completed', createdBy: USER, createdAt: 1, updatedAt: 1 }).returning();
    await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, ai: { environment: 'modern kitchen', activity: 'tossing noodles', tags: ['kitchen', 'noodles'], character_position: 'left third' }, manual: {}, createdAt: 1, updatedAt: 1 });
    const v = await getAssetView(a.id);
    expect(v.imported).toEqual({});
    expect(v.metadata.values.environment).toBe('modern kitchen');
    expect(v.metadata.provenance.environment).toBe('ai');
    expect(v.metadata.values.tags).toEqual(['kitchen', 'noodles']);
    expect(await sqlEffective(a.id, 'environment')).toBe('modern kitchen');
  });
});

describe('per-field precedence: manual > imported > AI', () => {
  async function asset(ai: Record<string, unknown>, imported: Record<string, unknown>, manual: Record<string, unknown>) {
    const p = await pack();
    const { asset } = await registerImportedAsset(base(p.id, `IMG-${++seq}`, { imported: { fields: imported } }), USER);
    await db.update(schema.studioAssetMetadata).set({ ai, manual }).where(eq(schema.studioAssetMetadata.assetId, asset.id));
    return asset.id;
  }

  it('the worked example: environment and activity from imported, lighting from manual, the rest from AI', async () => {
    const id = await asset({ environment: 'ai env', lighting: 'ai light', activity: 'ai act', composition: 'ai comp' }, { environment: 'imp env', activity: 'imp act' }, { lighting: 'manual light' });
    const m = (await getAssetView(id)).metadata;
    expect(m.values).toMatchObject({ environment: 'imp env', activity: 'imp act', lighting: 'manual light', composition: 'ai comp' });
    expect(m.provenance).toMatchObject({ environment: 'imported', activity: 'imported', lighting: 'manual', composition: 'ai' });
    for (const [f, want] of [['environment', 'imp env'], ['activity', 'imp act'], ['lighting', 'manual light'], ['composition', 'ai comp']] as const) expect(await sqlEffective(id, f)).toBe(want);
  });

  it('a manually cleared field stays cleared: it does not fall back to imported or AI', async () => {
    const id = await asset({ environment: 'ai env' }, { environment: 'imp env' }, { environment: null });
    const m = (await getAssetView(id)).metadata;
    expect(m.values.environment).toBeNull();
    expect(m.provenance.environment).toBe('manual');
    expect(await sqlEffective(id, 'environment')).toBeNull();
  });

  it('reverting a manual edit reveals the imported value; with no imported value, the AI value', async () => {
    const id = await asset({ environment: 'ai env', activity: 'ai act' }, { environment: 'imp env' }, {});
    await editMetadata(id, { set: { environment: 'mine', activity: 'mine too' }, revert: [] }, USER);
    expect((await getAssetView(id)).metadata.values).toMatchObject({ environment: 'mine', activity: 'mine too' });
    await editMetadata(id, { set: {}, revert: ['environment', 'activity'] }, USER);
    const m = (await getAssetView(id)).metadata;
    expect(m.values).toMatchObject({ environment: 'imp env', activity: 'ai act' });
    expect(m.provenance).toMatchObject({ environment: 'imported', activity: 'ai' });
  });

  it('empty imported values (null, empty string, empty list) are "none supplied": the AI value shows, in TypeScript and in SQL', async () => {
    const id = await asset({ environment: 'ai env', tags: ['ai-tag'] }, { environment: '', tags: [], lighting: null }, {});
    const m = (await getAssetView(id)).metadata;
    expect(m.values.environment).toBe('ai env');
    expect(m.values.tags).toEqual(['ai-tag']);
    expect(await sqlEffective(id, 'environment')).toBe('ai env');
    expect(effectiveMetadata({ lighting: 'ai' }, {}, { fields: { lighting: null } }).values.lighting).toBe('ai');
  });

  it('re-import replaces only the imported layer; re-analysis and manual edits are untouched', async () => {
    const id = await asset({ environment: 'ai env' }, { environment: 'imp env', activity: 'imp act' }, { activity: 'mine' });
    await replaceImportedLayer(id, { fields: { environment: 'imp env v2' }, status: 'v2' });
    const v = await getAssetView(id);
    expect(v.manual).toEqual({ activity: 'mine' });
    expect(v.ai).toEqual({ environment: 'ai env' });
    expect(v.metadata.values).toMatchObject({ environment: 'imp env v2', activity: 'mine' });
  });

  it('AI re-analysis cannot overwrite imported or manual values', async () => {
    const id = await asset({ environment: 'old ai' }, { environment: 'imp env' }, {});
    const { completeAnalysis } = await import('@/lib/studio/analysis-queue');
    const [row] = await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, id));
    await completeAnalysis(row, { environment: 'new ai', lighting: 'new ai light' }, 'm');
    const v = await getAssetView(id);
    expect(v.metadata.values).toMatchObject({ environment: 'imp env', lighting: 'new ai light' });
    expect(v.imported.fields).toEqual({ environment: 'imp env' });
  });
});

describe('search follows the effective values and never indexes the position of a person', () => {
  it('finds imported scene text; does not find composition, subject or character_position text', async () => {
    const p = await pack();
    const { asset } = await registerImportedAsset(base(p.id, 'IMG-100', {
      imported: { fields: { environment: 'home kitchen', activity: 'cooking noodles', tags: ['kitchen', 'steam'], character_position: 'left third standing' }, composition: { pose: 'leaning forward', face_visibility: 'partial' } },
    }), USER);
    expect((await listPackAssets(p.id, { search: 'kitchen' })).items.map((i) => i.asset.id)).toEqual([asset.id]);
    expect((await listPackAssets(p.id, { search: 'noodles' })).items.length).toBe(1);
    for (const term of ['leaning', 'partial', 'left third', 'standing']) expect((await listPackAssets(p.id, { search: term })).items.length, term).toBe(0);
  });

  it('a manual edit changes what search finds', async () => {
    const p = await pack();
    const { asset } = await registerImportedAsset(base(p.id, 'IMG-101', { imported: { fields: { environment: 'cafe' } } }), USER);
    await editMetadata(asset.id, { set: { environment: 'gym' }, revert: [] }, USER);
    expect((await listPackAssets(p.id, { search: 'gym' })).items.length).toBe(1);
    expect((await listPackAssets(p.id, { search: 'cafe' })).items.length).toBe(0);
  });
});

describe('permanent import identity', () => {
  it('an import_key is set once and can never change or be removed (assets and packs)', async () => {
    const p = await pack('pack-x');
    const { asset } = await registerImportedAsset(base(p.id, 'IMG-200'), USER);
    await expect(pg.exec(`update studio_assets set import_key = 'IMG-999' where id = ${asset.id}`)).rejects.toThrow(/permanent/);
    await expect(pg.exec(`update studio_assets set import_key = null where id = ${asset.id}`)).rejects.toThrow(/permanent/);
    await expect(pg.exec(`update studio_packs set import_key = 'other' where id = ${p.id}`)).rejects.toThrow(/permanent/);
    // an asset or pack that has no key yet can be given one once
    const [legacy] = await db.insert(schema.studioPacks).values({ name: 'legacy', createdBy: USER, createdAt: 1, updatedAt: 1 }).returning();
    await pg.exec(`update studio_packs set import_key = 'legacy-key' where id = ${legacy.id}`);
    await expect(pg.exec(`update studio_packs set import_key = 'legacy-key-2' where id = ${legacy.id}`)).rejects.toThrow(/permanent/);
  });

  it('only one ACTIVE row may carry a key; a pack key is unique even when archived', async () => {
    const p = await pack();
    await registerImportedAsset(base(p.id, 'IMG-300'), USER);
    await expect(registerImportedAsset(base(p.id, 'IMG-300'), USER)).rejects.toThrow();
    const dup = await createImportedPack({ importKey: p.importKey!, name: 'Renamed', description: 'x' }, USER);
    expect(dup.created).toBe(false);
    expect(dup.pack.id).toBe(p.id);
    expect(dup.pack.name).toBe(p.name); // an existing pack is never renamed by an import
  });

  it('a new version supersedes the old row in one step: the old row is archived with its history, never deleted, never changed', async () => {
    const p = await pack();
    const v1 = (await registerImportedAsset(base(p.id, 'IMG-400', { sha256: 'aaa' }), USER)).asset;
    const v2 = (await registerImportedAsset(base(p.id, 'IMG-400', { sha256: 'bbb', supersedesAssetId: v1.id, imported: { fields: {}, lineage: { version: 2, supersedes_asset_id: v1.id } } }), USER)).asset;
    const versions = await listAssetVersions('IMG-400');
    expect(versions.map((v) => v.id)).toEqual([v1.id, v2.id]);
    expect(versions[0].archivedAt).not.toBeNull();
    expect(versions[1].archivedAt).toBeNull();
    expect(versions[0].storageKey).toBe(v1.storageKey); // the original row's file is untouched
    expect((await getAssetView(v2.id)).imported.lineage).toEqual({ version: 2, supersedes_asset_id: v1.id });
  });

  it('a pack reorganisation keeps the identity: same key, new row in the new pack, old row archived; pack_id is never changed in place', async () => {
    const a = await pack('pack-a'); const b = await pack('pack-b');
    const old = (await registerImportedAsset(base(a.id, 'IMG-500'), USER)).asset;
    await expect(pg.exec(`update studio_assets set pack_id = ${b.id} where id = ${old.id}`)).rejects.toThrow(/immutable/);
    const moved = (await registerImportedAsset(base(b.id, 'IMG-500', { supersedesAssetId: old.id }), USER)).asset;
    expect(moved.packId).toBe(b.id);
    const rows = await listAssetVersions('IMG-500');
    expect(rows.filter((r) => !r.archivedAt).map((r) => r.id)).toEqual([moved.id]);
    expect(rows.find((r) => r.id === old.id)!.packId).toBe(a.id);
  });

  it('refuses to supersede a row that belongs to a different image', async () => {
    const p = await pack();
    const x = (await registerImportedAsset(base(p.id, 'IMG-600'), USER)).asset;
    await expect(registerImportedAsset(base(p.id, 'IMG-601', { supersedesAssetId: x.id }), USER)).rejects.toThrow(/does not belong/);
  });

  it('the same bytes may live in two packs (a different asset row each), as the Cafe test asset and IMG-018 will', async () => {
    const cafe = await pack('legacy-cafe'); const home = await pack('home-life');
    await registerImportedAsset(base(cafe.id, 'IMG-700', { sha256: 'same-bytes' }), USER);
    await expect(registerImportedAsset(base(home.id, 'IMG-018', { sha256: 'same-bytes' }), USER)).resolves.toMatchObject({ created: true });
  });

  it('registering the same file again returns the existing row (idempotent)', async () => {
    const p = await pack();
    const input = base(p.id, 'IMG-800');
    const first = await registerImportedAsset(input, USER);
    const again = await registerImportedAsset(input, USER);
    expect(again.created).toBe(false);
    expect(again.asset.id).toBe(first.asset.id);
    const n = await db.select({ c: sql<number>`count(*)::int` }).from(schema.studioAssets);
    expect(n[0].c).toBe(1);
  });

  it('a pack can be archived without touching its assets (the approved way to retire the Cafe test pack)', async () => {
    const cafe = await pack('legacy-cafe-2');
    const a = (await registerImportedAsset(base(cafe.id, 'IMG-900'), USER)).asset;
    const { setPackArchived } = await import('@/lib/studio/repository');
    await setPackArchived(cafe.id, true);
    const [row] = await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, a.id));
    expect(row.archivedAt).toBeNull();
    expect(row.storageKey).toBe(a.storageKey);
    expect((await db.select().from(schema.studioPacks).where(eq(schema.studioPacks.id, cafe.id)))[0].archivedAt).not.toBeNull();
  });
});

describe('R1: person and clothing words never reach the search index, whichever layer they come from', () => {
  const lexemes = async (assetId: number) => (await pg.query<{ l: string[] }>(`select tsvector_to_array(search_tsv) as l from studio_asset_metadata where asset_id = $1`, [assetId])).rows[0].l;
  const found = async (packId: number, term: string) => (await listPackAssets(packId, { search: term })).items.length;

  it('AI text that describes a person is searchable only by its scene words', async () => {
    const p = await pack();
    const { asset } = await registerImportedAsset(base(p.id, 'IMG-200', { imported: { fields: {} } }), USER);
    await pg.query(`update studio_asset_metadata set ai = $2::jsonb where asset_id = $1`, [asset.id, JSON.stringify({
      description: 'A young woman in a white tee and blue jeans sitting at a cafe table with a mug, her hair tied back.', environment: 'cafe', activity: 'drinking coffee, smiling',
      tags: ['woman', 'bearded', 'gen z', 'cafe', 'mug', 'hoodie'], composition: 'centre, a man standing', objects_props: 'mug, sunglasses, ring light',
    })]);
    for (const term of ['woman', 'young', 'tee', 'jeans', 'hair', 'bearded', 'gen z', 'hoodie', 'sunglasses', 'man']) expect(await found(p.id, term), term).toBe(0);
    for (const term of ['cafe', 'mug', 'coffee', 'table', 'ring light']) expect(await found(p.id, term), term).toBe(1);
    const l = await lexemes(asset.id);
    for (const w of ['woman', 'young', 'tee', 'jean', 'hair', 'beard', 'hoodi', 'sunglass', 'man']) expect(l, w).not.toContain(w);
  });

  it('manual and imported text are held to the same rule; the stored values themselves are not altered', async () => {
    const p = await pack();
    const { asset } = await registerImportedAsset(base(p.id, 'IMG-201', { imported: { fields: { environment: 'office', description: 'A man at a desk with a laptop' }, composition: { pose: 'leaning forward', face_visibility: 'partial' } } }), USER);
    await editMetadata(asset.id, { set: { activity: 'a woman typing on a laptop' }, revert: [] }, USER);
    expect(await found(p.id, 'man')).toBe(0);
    expect(await found(p.id, 'woman')).toBe(0);
    expect(await found(p.id, 'laptop')).toBe(1);
    expect(await found(p.id, 'desk')).toBe(1);
    expect(await found(p.id, 'typing')).toBe(1);
    const view = await getAssetView(asset.id);
    expect(view.manual.activity).toBe('a woman typing on a laptop'); // what a person wrote is kept as written; it is simply never indexed
  });

  it('composition metadata is preserved on the asset and still not a filter', async () => {
    const p = await pack();
    const { asset } = await registerImportedAsset(base(p.id, 'IMG-202', { imported: { fields: { environment: 'gym' }, composition: { pose: 'leaning forward', gaze: 'to camera', face_visibility: 'partial', subject_scale: 'medium' } } }), USER);
    expect((await getAssetView(asset.id)).imported.composition).toMatchObject({ pose: 'leaning forward', face_visibility: 'partial' });
    for (const term of ['leaning', 'camera', 'partial']) expect(await found(p.id, term), term).toBe(0);
    expect(await found(p.id, 'gym')).toBe(1);
  });
});

describe('R1 precision: the SQL index filter and the TypeScript filter agree, and keep legitimate scene terms searchable', () => {
  const sqlStrip = async (t: string) => ((await pg.query<{ v: string }>(`select studio_scene_text($1) as v`, [t])).rows[0].v).replace(/\s+/g, ' ').trim();
  it('the same output on every excluded and legitimate sample', async () => {
    for (const [t] of EXCLUDED) expect(await sqlStrip(t), t).toBe(stripPersonWords(t));
    for (const t of LEGITIMATE) expect(await sqlStrip(t), t).toBe(t);
  });
  it('hair salon, old building and young audience stay searchable; the person description beside them does not', async () => {
    const p = await pack();
    const { asset } = await registerImportedAsset(base(p.id, 'IMG-300', { imported: { fields: { environment: 'hair salon', description: 'A young woman in an old building with a young audience', tags: ['salon', 'bearded man'] } } }), USER);
    const f = async (term: string) => (await listPackAssets(p.id, { search: term })).items.length;
    for (const term of ['salon', 'hair', 'old', 'building', 'young', 'audience', 'hair salon']) expect(await f(term), term).toBe(1);
    for (const term of ['woman', 'bearded', 'man']) expect(await f(term), term).toBe(0);
    expect(asset.id).toBeGreaterThan(0);
  });
});
