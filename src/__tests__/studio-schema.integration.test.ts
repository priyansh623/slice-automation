/**
 * The Studio schema's invariants, enforced by the database itself (migration 0025), against an in-memory Postgres built
 * from the repository's migration files. These are the rules no code path may be able to break.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(__dirname, '../..');
let pg: PGlite;
const USER = '00000000-0000-4000-8000-00000000a11c';
const now = () => Date.now();

async function migrate(target: PGlite): Promise<void> {
  await target.exec(`create schema if not exists auth; create or replace function auth.uid() returns uuid language sql as 'select null::uuid'; create or replace function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const files = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification')).sort();
  for (const f of files.filter((m) => m < '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
  await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
  for (const f of files.filter((m) => m >= '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
}

beforeAll(async () => { pg = new PGlite(); await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pg.query<T>(sql, params)).rows;
async function fails(sql: string, params: unknown[] = []): Promise<string> {
  try { await pg.query(sql, params); } catch (e) { return String((e as Error).message); }
  throw new Error(`expected this to fail: ${sql}`);
}

let seq = 0;
async function pack(name = `pack ${++seq}`) {
  return (await q<{ id: number }>(`insert into studio_packs (name, created_by, created_at, updated_at) values ($1,$2,$3,$3) returning id`, [name, USER, now()]))[0].id;
}
async function asset(packId: number, sha = `sha-${++seq}`) {
  return (await q<{ id: number }>(
    `insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values ($1,$2,'image/png',1000,$3,$4,$5,$5) returning id`,
    [packId, `studio/assets/${sha}-${++seq}.png`, sha, USER, now()],
  ))[0].id;
}
async function project() {
  return (await q<{ id: number }>(`insert into studio_projects (name, created_by, created_at, updated_at) values ('p',$1,$2,$2) returning id`, [USER, now()]))[0].id;
}
const approve = (projectId: number, packId: number) =>
  q(`insert into studio_project_packs (project_id, pack_id, source, approved_by, approved_at) values ($1,$2,'manual',$3,$4)`, [projectId, packId, USER, now()]);
const select = (projectId: number, assetId: number, packId: number) =>
  q(`insert into studio_selections (project_id, asset_id, pack_id, added_by, added_at) values ($1,$2,$3,$4,$5)`, [projectId, assetId, packId, USER, now()]);

describe('server-only tables', () => {
  it('has row level security on every studio table, with no policy (only the server can read or write)', async () => {
    const tables = await q<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname like 'studio\\_%' and relkind = 'r' order by relname`);
    expect(tables.map((t) => t.relname)).toEqual([
      'studio_asset_metadata', 'studio_assets', 'studio_batches', 'studio_jobs', 'studio_outputs', 'studio_packs', 'studio_project_packs', 'studio_projects', 'studio_selections',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
    expect(await q(`select 1 from pg_policies where tablename like 'studio\\_%'`)).toHaveLength(0);
  });
});

describe('source images are immutable', () => {
  it('cannot change an asset\'s file, hash, type, size or pack, but its status, dimensions and archival can change', async () => {
    const p1 = await pack(); const p2 = await pack(); const a = await asset(p1);
    for (const set of ["storage_key = 'x'", "sha256 = 'y'", "pack_id = " + p2, "mime = 'image/jpeg'", "size_bytes = 5"]) {
      expect(await fails(`update studio_assets set ${set} where id = $1`, [a])).toContain('immutable');
    }
    await q(`update studio_assets set analysis_status = 'completed', width = 800, height = 600, archived_at = $2 where id = $1`, [a, now()]);
    expect((await q<{ width: number }>(`select width from studio_assets where id = $1`, [a]))[0].width).toBe(800);
  });

  it('is never deleted (archive instead), nor are jobs, outputs or batches', async () => {
    const p = await pack(); const a = await asset(p);
    expect(await fails(`delete from studio_assets where id = $1`, [a])).toContain('never deleted');
  });
});

describe('duplicate images in a pack', () => {
  it('rejects the same SHA-256 twice among a pack\'s active assets, allows it in another pack or after archiving', async () => {
    const p1 = await pack(); const p2 = await pack();
    const first = await asset(p1, 'same-hash');
    expect(await fails(
      `insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values ($1,'studio/assets/dup.png','image/png',1,'same-hash',$2,$3,$3)`,
      [p1, USER, now()],
    )).toContain('duplicate');
    await asset(p2, 'same-hash'); // a different pack may hold the same image
    await q(`update studio_assets set archived_at = $2 where id = $1`, [first, now()]);
    await asset(p1, 'same-hash'); // the archived copy no longer counts
  });
});

describe('selections and approvals', () => {
  it('can only select an asset of a pack the project has approved', async () => {
    const p = await pack(); const a = await asset(p); const proj = await project();
    expect(await fails(`insert into studio_selections (project_id, asset_id, pack_id, added_by, added_at) values ($1,$2,$3,$4,$5)`, [proj, a, p, USER, now()])).toContain('studio_selections_approved_pack_fk');
    await approve(proj, p);
    await select(proj, a, p);
    expect(await q(`select 1 from studio_selections where project_id = $1`, [proj])).toHaveLength(1);
  });

  it('records the asset\'s own pack: a selection with the wrong pack is rejected even if both packs are approved', async () => {
    const p1 = await pack(); const p2 = await pack(); const a = await asset(p1); const proj = await project();
    await approve(proj, p1); await approve(proj, p2);
    expect(await fails(`insert into studio_selections (project_id, asset_id, pack_id, added_by, added_at) values ($1,$2,$3,$4,$5)`, [proj, a, p2, USER, now()])).toContain('studio_selections_asset_pack_fk');
  });

  it('keeps one shared selection across several packs, each row with its original pack and asset', async () => {
    const p1 = await pack(); const p2 = await pack(); const a1 = await asset(p1); const a2 = await asset(p2); const proj = await project();
    await approve(proj, p1); await approve(proj, p2);
    await select(proj, a1, p1); await select(proj, a2, p2);
    const rows = await q<{ asset_id: number; pack_id: number }>(`select asset_id, pack_id from studio_selections where project_id = $1 order by asset_id`, [proj]);
    expect(rows).toEqual([{ asset_id: a1, pack_id: p1 }, { asset_id: a2, pack_id: p2 }]);
    expect(await fails(`insert into studio_selections (project_id, asset_id, pack_id, added_by, added_at) values ($1,$2,$3,$4,$5)`, [proj, a1, p1, USER, now()])).toContain('duplicate'); // once per asset
  });

  it('blocks revoking an approval while its assets are selected, and allows it after the selections are removed', async () => {
    const p = await pack(); const a = await asset(p); const proj = await project();
    await approve(proj, p); await select(proj, a, p);
    expect(await fails(`delete from studio_project_packs where project_id = $1 and pack_id = $2`, [proj, p])).toContain('studio_selections_approved_pack_fk');
    await q(`delete from studio_selections where project_id = $1 and asset_id = $2`, [proj, a]);
    await q(`delete from studio_project_packs where project_id = $1 and pack_id = $2`, [proj, p]);
    expect(await q(`select 1 from studio_project_packs where project_id = $1`, [proj])).toHaveLength(0);
  });

  it('an archived asset keeps its selection record', async () => {
    const p = await pack(); const a = await asset(p); const proj = await project();
    await approve(proj, p); await select(proj, a, p);
    await q(`update studio_assets set archived_at = $2 where id = $1`, [a, now()]);
    expect(await q(`select 1 from studio_selections where asset_id = $1`, [a])).toHaveLength(1);
  });
});

describe('jobs: independent, retried by new rows, never resubmitted, history kept', () => {
  async function setup() {
    const p = await pack(); const proj = await project(); await approve(proj, p);
    const a = await asset(p);
    const batch = (await q<{ id: number }>(`insert into studio_batches (project_id, created_by, provider, character_key, total_jobs, created_at) values ($1,$2,'mock','studio/projects/1/character/c.png',1,$3) returning id`, [proj, USER, now()]))[0].id;
    return { p, proj, a, batch };
  }
  const job = (s: { p: number; proj: number; a: number; batch: number }, attempt = 1, status = 'queued', retryOf: number | null = null) =>
    q<{ id: number }>(
      `insert into studio_jobs (batch_id, project_id, asset_id, pack_id, source_key, character_key, provider, status, attempt, retry_of_job_id, created_by, created_at, updated_at)
       values ($1,$2,$3,$4,'src','chr','mock',$5,$6,$7,$8,$9,$9) returning id`,
      [s.batch, s.proj, s.a, s.p, status, attempt, retryOf, USER, now()],
    );

  it('allows one active job per image per batch; a failed job is retried with a new row and the old one is kept', async () => {
    const s = await setup();
    const [first] = await job(s);
    expect(await fails(
      `insert into studio_jobs (batch_id, project_id, asset_id, pack_id, source_key, character_key, provider, attempt, created_by, created_at, updated_at) values ($1,$2,$3,$4,'src','chr','mock',2,$5,$6,$6)`,
      [s.batch, s.proj, s.a, s.p, USER, now()],
    )).toContain('idx_studio_jobs_one_active');
    await q(`update studio_jobs set status = 'failed', error_message = 'boom' where id = $1`, [first.id]);
    const [retry] = await job(s, 2, 'queued', first.id);
    const all = await q<{ id: number; status: string; attempt: number; retry_of_job_id: number | null }>(`select id, status, attempt, retry_of_job_id from studio_jobs where batch_id = $1 order by id`, [s.batch]);
    expect(all).toEqual([
      { id: first.id, status: 'failed', attempt: 1, retry_of_job_id: null },
      { id: retry.id, status: 'queued', attempt: 2, retry_of_job_id: first.id },
    ]);
  });

  it('keeps a provider job id once it is set: it cannot be changed or cleared', async () => {
    const s = await setup();
    const [j] = await job(s);
    await q(`update studio_jobs set provider_job_id = 'prov-1', status = 'processing' where id = $1`, [j.id]);
    expect(await fails(`update studio_jobs set provider_job_id = 'prov-2' where id = $1`, [j.id])).toContain('provider job id');
    expect(await fails(`update studio_jobs set provider_job_id = null where id = $1`, [j.id])).toContain('provider job id');
    await q(`update studio_jobs set status = 'succeeded' where id = $1`, [j.id]); // other updates still work
  });

  it('treats a job\'s inputs as a snapshot', async () => {
    const s = await setup();
    const [j] = await job(s);
    for (const set of ["source_key = 'other'", "character_key = 'other'", 'attempt = 9']) expect(await fails(`update studio_jobs set ${set} where id = $1`, [j.id])).toContain('snapshot');
  });

  it('never deletes jobs, batches or outputs, and an archived asset keeps its whole history', async () => {
    const s = await setup();
    const [j] = await job(s);
    await q(`insert into studio_outputs (job_id, project_id, asset_id, storage_key, mime, size_bytes, sha256, created_at) values ($1,$2,$3,'studio/projects/1/outputs/1-a1.png','image/png',5,'h',$4)`, [j.id, s.proj, s.a, now()]);
    expect(await fails(`delete from studio_jobs where id = $1`, [j.id])).toContain('never deleted');
    expect(await fails(`delete from studio_batches where id = $1`, [s.batch])).toContain('never deleted');
    expect(await fails(`delete from studio_outputs where job_id = $1`, [j.id])).toContain('never deleted');
    await q(`update studio_assets set archived_at = $2 where id = $1`, [s.a, now()]);
    expect(await q(`select 1 from studio_jobs where asset_id = $1`, [s.a])).toHaveLength(1);
    expect(await q(`select 1 from studio_outputs where asset_id = $1`, [s.a])).toHaveLength(1);
  });

  it('keeps an output\'s file and job fixed, while its review status can change', async () => {
    const s = await setup();
    const [j] = await job(s);
    const [o] = await q<{ id: number }>(`insert into studio_outputs (job_id, project_id, asset_id, storage_key, mime, size_bytes, sha256, created_at) values ($1,$2,$3,'studio/projects/1/outputs/2-a1.png','image/png',5,'h',$4) returning id`, [j.id, s.proj, s.a, now()]);
    expect(await fails(`update studio_outputs set storage_key = 'x' where id = $1`, [o.id])).toContain('cannot change');
    await q(`update studio_outputs set review_status = 'saved', reviewed_at = $2 where id = $1`, [o.id, now()]);
  });
});

describe('metadata: AI and manual are separate, the effective value is manual over AI, and search follows it', () => {
  it('searches the effective values, so a manual edit replaces the AI text and re-analysis does not undo it', async () => {
    const p = await pack(); const a = await asset(p);
    await q(`insert into studio_asset_metadata (asset_id, ai, manual, created_at, updated_at) values ($1,$2,'{}'::jsonb,$3,$3)`, [a, JSON.stringify({ environment: 'busy airport terminal', description: 'A traveller walks through a terminal.' }), now()]);
    const hits = async (term: string) => (await q(`select asset_id from studio_asset_metadata where search_tsv @@ plainto_tsquery('english', $1) and asset_id = $2`, [term, a])).length;
    expect(await hits('airport')).toBe(1);

    await q(`update studio_asset_metadata set manual = $2::jsonb where asset_id = $1`, [a, JSON.stringify({ environment: 'quiet library' })]);
    expect(await hits('library')).toBe(1);
    expect(await hits('airport')).toBe(0);      // the manual value replaced the AI one
    expect(await hits('traveller')).toBe(1);    // fields not edited still come from the AI

    await q(`update studio_asset_metadata set ai = $2::jsonb where asset_id = $1`, [a, JSON.stringify({ environment: 'beach', description: 'A person outdoors.' })]); // re-analysis
    expect(await hits('library')).toBe(1);      // the edit survives re-analysis
    expect(await hits('beach')).toBe(0);
    expect(await hits('outdoors')).toBe(1);

    await q(`update studio_asset_metadata set manual = $2::jsonb where asset_id = $1`, [a, JSON.stringify({ environment: null })]);
    expect(await hits('library')).toBe(0);
    expect(await hits('beach')).toBe(0);        // cleared on purpose: the AI value is ignored for that field
  });
});
