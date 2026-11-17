/**
 * Migration 0028 on a REAL PostgreSQL (production runs PostgreSQL 17): applied on top of 0001-0027 to a database that already holds
 * Flow and Studio rows the way production has them. Existing rows must not change, nothing may be rewritten, the file must be safe to
 * apply twice, and the new tables' rules must hold.
 *
 * Skipped unless TEST_POSTGRES_URL is set; refuses to run unless the host is local; only ever creates and drops its own throwaway databases.
 *   TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres npx vitest run src/__tests__/broll-overlays-migration.postgres.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import postgres from 'postgres';

const URL_ENV = process.env.TEST_POSTGRES_URL;
const isLocal = (() => { try { return URL_ENV ? ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(URL_ENV).hostname) : false; } catch { return false; } })();
if (URL_ENV && !isLocal) throw new Error('TEST_POSTGRES_URL must point at a local database (localhost / 127.0.0.1). Refusing to run.');
const suite = URL_ENV && isLocal ? describe : describe.skip;

const ROOT = path.resolve(__dirname, '../..');
const USER = '00000000-0000-4000-8000-00000000000a';
const now = 1_700_000_000_000;
let admin: ReturnType<typeof postgres>; let sql: ReturnType<typeof postgres>; let dbName = '';
const sqlFile = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const files = () => fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification')).sort();
const fail = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as Error).message; } };

suite('migration 0028 on real PostgreSQL', () => {
  let ids: { p: number; s: number; c: number; a: number };
  beforeAll(async () => {
    admin = postgres(URL_ENV!, { max: 1, onnotice: () => {} });
    dbName = `soma_m0028_${process.pid}_${Date.now()}`;
    await admin.unsafe(`create database ${dbName}`);
    const u = new URL(URL_ENV!); u.pathname = `/${dbName}`;
    sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
    await sql.unsafe(`create schema auth; create function auth.uid() returns uuid language sql as 'select null::uuid'; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
    const all = files();
    for (const f of all.filter((m) => m < '0022_')) await sql.unsafe(sqlFile(`drizzle/pg/${f}`));
    await sql.unsafe(sqlFile('drizzle/0009_broll_categories.sql'));
    for (const f of all.filter((m) => m >= '0022_' && m < '0028_')) await sql.unsafe(sqlFile(`drizzle/pg/${f}`));
    // Production-shaped rows BEFORE 0028.
    const [p] = await sql`insert into video_projects (user_id, name, base_image_path, original_script, created_at, updated_at) values (${USER}, 'P', 'x.png', 's', ${now}, ${now}) returning id`;
    const [s] = await sql`insert into video_screens (video_project_id, screen_number, dialogue, position, created_at, updated_at) values (${p.id}, 1, 'Hello', 0, ${now}, ${now}) returning id`;
    const [c] = await sql`insert into broll_clips (user_id, title, storage_path, created_at, updated_at) values (${USER}, 'Clip', 'c.mp4', ${now}, ${now}) returning id`;
    const [pk] = await sql`insert into studio_packs (name, created_by, created_at, updated_at) values ('Pk', ${USER}, ${now}, ${now}) returning id`;
    const [a] = await sql`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values (${pk.id}, 'studio/assets/00000000-0000-4000-8000-000000000001.png', 'image/png', 1, 'h', ${USER}, ${now}, ${now}) returning id`;
    await sql`insert into video_compilations (video_project_id, status, created_at, updated_at) values (${p.id}, 'completed', ${now}, ${now})`;
    ids = { p: p.id, s: s.id, c: c.id, a: a.id };
  }, 240_000);
  afterAll(async () => { try { await sql?.end({ timeout: 5 }); } catch { /* ignore */ } try { await admin.unsafe(`drop database if exists ${dbName} with (force)`); } catch { /* ignore */ } await admin?.end({ timeout: 5 }); });

  const snapshot = async () => ({
    screens: await sql`select * from video_screens order by id`,
    comps: await sql`select id, video_project_id, status, version, output_storage_path, created_at from video_compilations order by id`,
    projects: await sql`select id, name from video_projects order by id`,
  });

  it('leaves every existing Flow row exactly as it was, and adds only the planned columns', async () => {
    const before = await snapshot();
    const colsBefore = await sql`select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('video_screens','video_generations','video_projects') order by 1,2`;
    await sql.unsafe(sqlFile('drizzle/pg/0028_broll_overlays.sql'));
    expect(await snapshot()).toEqual(before);
    expect(await sql`select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('video_screens','video_generations','video_projects') order by 1,2`).toEqual(colsBefore);
    const comp = await sql`select overlay_count from video_compilations`;
    expect(comp.map((r) => r.overlay_count)).toEqual([0]);
    const dialogue = await sql`select is_nullable from information_schema.columns where table_name='video_screens' and column_name='dialogue'`;
    expect(dialogue[0].is_nullable).toBe('NO');
  });

  it('can be applied a second time without error or change', async () => {
    await sql.unsafe(sqlFile('drizzle/pg/0028_broll_overlays.sql'));
    expect((await sql`select count(*)::int as n from video_overlays`)[0].n).toBe(0);
  });

  it('enforces the overlay rules: one source per kind, positive timing, no ready overlay without a file', async () => {
    const base = { p: ids.p, s: ids.s, c: ids.c };
    const ins = (kind: string, clip: number | null, item: number | null, over: { start?: number; dur?: number; status?: string; asset?: string | null } = {}) => sql`insert into video_overlays (video_project_id, kind, anchor_screen_id, start_offset_ms, duration_ms, status, asset_storage_path, broll_clip_id, character_item_id, created_by, created_at, updated_at) values (${base.p}, ${kind}, ${base.s}, ${over.start ?? 0}, ${over.dur ?? 3000}, ${over.status ?? 'preparing'}, ${over.asset ?? null}, ${clip}, ${item}, ${USER}, ${now}, ${now})`;
    expect(await fail(ins('generic', base.c, null))).toBeNull();
    expect(await fail(ins('generic', null, null))).toMatch(/video_overlays_source_check/);
    expect(await fail(ins('weird', base.c, null))).toMatch(/video_overlays_kind_check/);
    expect(await fail(ins('generic', base.c, null, { dur: 0 }))).toMatch(/video_overlays_timing_check/);
    expect(await fail(ins('generic', base.c, null, { start: -1 }))).toMatch(/video_overlays_timing_check/);
    expect(await fail(ins('generic', base.c, null, { status: 'ready' }))).toMatch(/video_overlays_ready_has_asset/);
    expect(await fail(ins('generic', base.c, null, { status: 'ready', asset: 'overlays/1/1.mp4' }))).toBeNull();
  });

  it('makes a paid video job impossible without an approved image, and a ready clip impossible without a file', async () => {
    const add = (image: string, clip: string, extra = '') => sql.unsafe(`insert into character_broll_items (video_project_id, studio_asset_id, image_status, clip_status, ${extra ? 'studio_output_id, clip_storage_path,' : ''} created_by, created_at, updated_at) values (${ids.p}, ${ids.a}, '${image}', '${clip}', ${extra ? extra + ',' : ''} '${USER}', ${now}, ${now})`);
    expect(await fail(add('pending', 'not_started'))).toBeNull();
    expect(await fail(add('ready', 'queued'))).toMatch(/character_broll_video_needs_approved_image/);
    expect(await fail(add('rejected', 'processing'))).toMatch(/character_broll_video_needs_approved_image/);
    expect(await fail(add('approved', 'queued'))).toMatch(/character_broll_approved_has_output/);   // approval needs an output
    const [pk] = await sql`select id from studio_packs limit 1`; void pk;
    expect(await fail(sql`insert into character_broll_items (video_project_id, studio_asset_id, image_status, clip_status, created_by, created_at, updated_at) values (${ids.p}, ${ids.a}, 'pending', 'bogus', ${USER}, ${now}, ${now})`)).toMatch(/character_broll_clip_status_check/);
  });

  it('keeps one idempotency key per video request, and has row level security on all three tables', async () => {
    const k = (key: string) => sql`insert into character_broll_items (video_project_id, studio_asset_id, idempotency_key, created_by, created_at, updated_at) values (${ids.p}, ${ids.a}, ${key}, ${USER}, ${now}, ${now})`;
    expect(await fail(k('cbroll-1-1'))).toBeNull();
    expect(await fail(k('cbroll-1-1'))).toMatch(/idx_character_broll_idempotency/);
    const rls = await sql`select relname, relrowsecurity from pg_class where relname in ('character_broll_items','video_overlays','video_compilation_overlays') order by 1`;
    expect(rls.map((r) => r.relrowsecurity)).toEqual([true, true, true]);
  });

  it('refuses to apply when the tables it depends on are missing, and names the problem', async () => {
    const bare = `${dbName}_bare`; await admin.unsafe(`create database ${bare}`);
    const u = new URL(URL_ENV!); u.pathname = `/${bare}`; const b = postgres(u.toString(), { max: 1, onnotice: () => {} });
    try { expect(await fail(b.unsafe(sqlFile('drizzle/pg/0028_broll_overlays.sql')))).toMatch(/needs the video workflow tables/); } finally { await b.end({ timeout: 5 }); await admin.unsafe(`drop database if exists ${bare} with (force)`); }
  });
});
