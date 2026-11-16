/**
 * Migration 0027 on a REAL PostgreSQL (the production server is PostgreSQL 17): the exact file is applied on top of 0025 and 0026 to
 * rows written the way production has them (AI metadata only, like the "Cafe" test asset), and the effective values must not change.
 *
 * Skipped unless TEST_POSTGRES_URL is set; refuses to run unless the host is local; only ever creates and drops its own throwaway
 * databases.
 *
 *   TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres npx vitest run src/__tests__/studio-migration-0027.postgres.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import postgres from 'postgres';
import { stripPersonWords } from '@/lib/studio/import/scene-metadata';
import { EXCLUDED, LEGITIMATE } from './helpers/person-corpus';

const URL_ENV = process.env.TEST_POSTGRES_URL;
const isLocal = (() => { try { return URL_ENV ? ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(URL_ENV).hostname) : false; } catch { return false; } })();
if (URL_ENV && !isLocal) throw new Error('TEST_POSTGRES_URL must point at a local database (localhost / 127.0.0.1). Refusing to run.');
const suite = URL_ENV && isLocal ? describe : describe.skip;

const ROOT = path.resolve(__dirname, '../..');
const USER = '00000000-0000-4000-8000-00000000000a';
const FIELDS = ['environment', 'activity', 'objects_props', 'camera_angle', 'framing', 'lighting', 'composition', 'description', 'tags'];
let admin: ReturnType<typeof postgres>;
let sql: ReturnType<typeof postgres>;
let bare: ReturnType<typeof postgres>;
const dbs: string[] = [];
const sqlFile = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const files = () => fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification')).sort();

async function newDb(label: string) {
  const name = `soma_m0027_${label}_${process.pid}_${Date.now()}`;
  await admin.unsafe(`create database ${name}`); dbs.push(name);
  const u = new URL(URL_ENV!); u.pathname = `/${name}`;
  return postgres(u.toString(), { max: 2, onnotice: () => {} });
}

suite('migration 0027 on real PostgreSQL', () => {
  beforeAll(async () => {
    admin = postgres(URL_ENV!, { max: 1, onnotice: () => {} });
    sql = await newDb('main');
    await sql.unsafe(`create schema auth; create function auth.uid() returns uuid language sql as 'select null::uuid'; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
    const all = files();
    for (const f of all.filter((m) => m < '0022_')) await sql.unsafe(sqlFile(`drizzle/pg/${f}`));
    await sql.unsafe(sqlFile('drizzle/0009_broll_categories.sql'));
    for (const f of all.filter((m) => m >= '0022_' && m < '0027_')) await sql.unsafe(sqlFile(`drizzle/pg/${f}`));
  }, 180_000);
  afterAll(async () => {
    try { await sql?.end({ timeout: 5 }); await bare?.end({ timeout: 5 }); } catch { /* ignore */ }
    for (const d of dbs) { try { await admin.unsafe(`drop database if exists ${d} with (force)`); } catch { /* ignore */ } }
    await admin?.end({ timeout: 5 });
  });

  it('is applied to a pre-0027 database; every existing row keeps its effective values; imported = {}', async () => {
    const [pk] = await sql`insert into studio_packs (name, created_by, created_at, updated_at) values ('Cafe', ${USER}, 1, 1) returning id`;
    const [a] = await sql`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, analysis_status, created_by, created_at, updated_at) values (${pk.id}, 'studio/assets/cdae8e3a-eac8-4744-91e4-b6ee8e653d92.png', 'image/png', 6945375, 'b3fd', 'completed', ${USER}, 1, 1) returning id`;
    await sql`insert into studio_asset_metadata (asset_id, ai, manual, created_at, updated_at) values (${a.id}, ${sql.json({ environment: 'modern kitchen', activity: 'tossing noodles into a bowl', objects_props: 'tongs, steel bowl, kettle', camera_angle: 'eye level', framing: 'medium shot', character_position: 'left third, standing', lighting: 'bright overhead light', composition: 'rule of thirds', description: 'A kitchen counter with a steaming pan of noodles.', tags: ['kitchen', 'noodles', 'steam'] })}, ${sql.json({ lighting: 'warm', activity: null })}, 1, 1)`;
    const [b] = await sql`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values (${pk.id}, 'studio/assets/11111111-1111-4111-8111-111111111111.png', 'image/png', 1, 'x', ${USER}, 1, 1) returning id`;
    await sql`insert into studio_asset_metadata (asset_id, ai, manual, created_at, updated_at) values (${b.id}, null, '{}'::jsonb, 1, 1)`;

    const before = Object.fromEntries(await Promise.all(FIELDS.map(async (f) => [f, (await sql`select asset_id, studio_effective(ai, manual, ${f}) as v from studio_asset_metadata order by asset_id`).map((r) => r.v)])));
    // The old vector WITHOUT character_position, recomputed with the old function: what the new vector must equal.
    const exceptPosition = FIELDS.map((f) => `coalesce(studio_effective(ai, manual, '${f}'), '')`).join(` || ' ' || `);
    const expected = (await sql.unsafe(`select tsvector_to_array(to_tsvector('english', ${exceptPosition})) as l from studio_asset_metadata order by asset_id`)).map((r) => (r.l as string[]).sort());
    const oldVector = (await sql`select tsvector_to_array(search_tsv) as l from studio_asset_metadata order by asset_id`).map((r) => r.l as string[]);
    expect(oldVector[0]).toContain('left'); // the old vector did index character_position

    await sql.unsafe(sqlFile('drizzle/pg/0027_studio_scene_packs.sql'));

    const after = Object.fromEntries(await Promise.all(FIELDS.map(async (f) => [f, (await sql`select asset_id, studio_effective(ai, manual, imported, ${f}) as v from studio_asset_metadata order by asset_id`).map((r) => r.v)])));
    expect(after).toEqual(before);
    const rows = await sql`select imported, search_tsv is not null as has_tsv from studio_asset_metadata order by asset_id`;
    expect(rows.every((r) => JSON.stringify(r.imported) === '{}' && r.has_tsv)).toBe(true);
    // the vector holds the same words as before, except those that came only from character_position (no longer indexed)
    const lexemesAfter = (await sql`select tsvector_to_array(search_tsv) as l from studio_asset_metadata order by asset_id`).map((r) => r.l as string[]);
    expect(lexemesAfter.map((l) => [...l].sort())).toEqual(expected);
    // no new keys, no data touched
    expect((await sql`select count(*)::int as n from studio_assets where import_key is not null`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from studio_packs where import_key is not null`)[0].n).toBe(0);
  });

  it('creates the indexes, constraints, triggers and function it promises, and the GIN index is used', async () => {
    const idx = (await sql`select indexname from pg_indexes where schemaname='public' and tablename in ('studio_assets','studio_packs','studio_asset_metadata')`).map((r) => r.indexname);
    for (const n of ['idx_studio_packs_import_key', 'idx_studio_assets_import_key_active', 'idx_studio_assets_import_key', 'idx_studio_asset_metadata_search']) expect(idx).toContain(n);
    const trg = (await sql`select tgname from pg_trigger where not tgisinternal and tgrelid in ('studio_assets'::regclass, 'studio_packs'::regclass)`).map((r) => r.tgname);
    expect(trg).toEqual(expect.arrayContaining(['studio_assets_import_key_trg', 'studio_packs_import_key_trg', 'studio_assets_immutable_trg']));
    expect((await sql`select to_regprocedure('public.studio_effective(jsonb,jsonb,jsonb,text)') as f`)[0].f).not.toBeNull();
    const col = (await sql`select attgenerated from pg_attribute where attrelid='studio_asset_metadata'::regclass and attname='search_tsv'`)[0];
    expect(col.attgenerated).toBe('s');
    const plan = await sql.begin(async (t) => {
      await t.unsafe('set local enable_seqscan = off');
      return (await t.unsafe(`explain select 1 from studio_asset_metadata where search_tsv @@ plainto_tsquery('english','noodles')`)).map((r) => String(r['QUERY PLAN'])).join('\n');
    });
    expect(plan).toMatch(/idx_studio_asset_metadata_search/);
  });

  it('enforces the identity rules: set once, one ACTIVE row per image key, unique pack key', async () => {
    const [pk] = await sql`insert into studio_packs (name, import_key, created_by, created_at, updated_at) values ('Home', 'home-life', ${USER}, 1, 1) returning id`;
    await expect(sql`insert into studio_packs (name, import_key, created_by, created_at, updated_at) values ('Dup', 'home-life', ${USER}, 1, 1)`).rejects.toThrow(/idx_studio_packs_import_key|unique/);
    await expect(sql`update studio_packs set import_key = 'x' where id = ${pk.id}`).rejects.toThrow(/permanent/);
    const [a1] = await sql`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, import_key, created_by, created_at, updated_at) values (${pk.id}, 'studio/assets/22222222-2222-4222-8222-222222222221.png', 'image/png', 1, 'h1', 'IMG-018', ${USER}, 1, 1) returning id`;
    await expect(sql`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, import_key, created_by, created_at, updated_at) values (${pk.id}, 'studio/assets/22222222-2222-4222-8222-222222222222.png', 'image/png', 1, 'h2', 'IMG-018', ${USER}, 1, 1)`).rejects.toThrow(/idx_studio_assets_import_key_active|unique/);
    await sql`update studio_assets set archived_at = 5 where id = ${a1.id}`;
    await sql`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, import_key, created_by, created_at, updated_at) values (${pk.id}, 'studio/assets/22222222-2222-4222-8222-222222222222.png', 'image/png', 1, 'h2', 'IMG-018', ${USER}, 1, 1)`;
    await expect(sql`update studio_assets set import_key = 'IMG-019' where id = ${a1.id}`).rejects.toThrow(/permanent/);
    await expect(sql`update studio_assets set pack_id = pack_id + 1 where id = ${a1.id}`).rejects.toThrow();
  });

  it('removes person and clothing words from the search vector (regex word boundaries behave the same on this server), keeps scene words', async () => {
    const [pk] = await sql`insert into studio_packs (name, created_by, created_at, updated_at) values ('R1', ${USER}, 1, 1) returning id`;
    const [a] = await sql`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values (${pk.id}, 'studio/assets/33333333-3333-4333-8333-333333333333.png', 'image/png', 1, 'r1', ${USER}, 1, 1) returning id`;
    await sql`insert into studio_asset_metadata (asset_id, ai, manual, imported, created_at, updated_at) values (${a.id}, ${sql.json({ description: 'A Young Woman in a white tee and T-shirt, her hair tied, at a cafe table with a mug.', tags: ['woman', 'gen z', 'cafe', 'mug', 'hoodie'], objects_props: 'mug, sunglasses, ring light' })}, '{}'::jsonb, ${sql.json({ fields: { environment: 'cafe', activity: 'a man drinking coffee' } })}, 1, 1)`;
    const l = (await sql`select tsvector_to_array(search_tsv) as l from studio_asset_metadata where asset_id = ${a.id}`)[0].l as string[];
    for (const w of ['woman', 'young', 'tee', 'hair', 'gen', 'hoodi', 'sunglass', 'man', 'shirt']) expect(l, w).not.toContain(w);
    for (const w of ['cafe', 'mug', 'coffe', 'tabl', 'ring', 'light']) expect(l, w).toContain(w);
    // the source values are untouched
    expect((await sql`select studio_effective(ai, manual, imported, 'description') as v from studio_asset_metadata where asset_id = ${a.id}`)[0].v).toMatch(/Young Woman/);
  });

  it('the SQL filter equals the TypeScript filter on every sample, on this server too (excluded descriptions go, scene terms stay)', async () => {
    for (const [t] of EXCLUDED) expect(((await sql`select studio_scene_text(${t}) as v`)[0].v as string).replace(/\s+/g, ' ').trim(), t).toBe(stripPersonWords(t));
    for (const t of LEGITIMATE) expect(((await sql`select studio_scene_text(${t}) as v`)[0].v as string).replace(/\s+/g, ' ').trim(), t).toBe(t);
  });

  it('PostgreSQL 17 supports ALTER COLUMN ... SET EXPRESSION (checked for the record); the migration does not depend on it', async () => {
    const v = Number((await sql`show server_version_num`)[0].server_version_num);
    await sql.unsafe(`create table _gen_probe (a int, b int generated always as (a + 1) stored)`);
    if (v >= 170000) {
      await sql.unsafe(`alter table _gen_probe alter column b set expression as (a + 2)`);
      await sql.unsafe(`insert into _gen_probe (a) values (1)`);
      expect((await sql`select b from _gen_probe`)[0].b).toBe(3);
    } else {
      await expect(sql.unsafe(`alter table _gen_probe alter column b set expression as (a + 2)`)).rejects.toThrow();
    }
    await sql.unsafe(`drop table _gen_probe`);
    expect(sqlFile('drizzle/pg/0027_studio_scene_packs.sql')).not.toMatch(/^\s*ALTER TABLE .*SET EXPRESSION/im);
  });

  it('is safe to run a second time and fails clearly when 0025 and 0026 are missing', async () => {
    await sql.unsafe(sqlFile('drizzle/pg/0027_studio_scene_packs.sql'));
    expect((await sql`select count(*)::int as n from studio_asset_metadata`)[0].n).toBe(3); // the rows of the tests above: nothing lost by a second run
    bare = await newDb('bare');
    await expect(bare.unsafe(sqlFile('drizzle/pg/0027_studio_scene_packs.sql'))).rejects.toThrow(/needs migrations 0025 and 0026/);
  });
});
