/**
 * Real multi-connection PostgreSQL test of the compilation version and one-active-job logic.
 *
 * The PGlite tests prove the logic and the constraints, but PGlite has a single connection, so it cannot show that the
 * row locks really make concurrent requests take turns. This file does, using a pool of genuinely separate connections.
 *
 * Skipped unless TEST_POSTGRES_URL is set. It REFUSES to run unless the host is local (localhost, 127.0.0.1 or ::1), so it
 * can never touch a hosted or production database. Point it at an empty, disposable database:
 *
 *   TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres npx vitest run src/__tests__/compilation-concurrency.postgres.test.ts
 *
 * It creates the repository's tables from the real migration files (including 0024) in a schema it drops afterwards.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema.pg';

const URL_ENV = process.env.TEST_POSTGRES_URL;
const isLocal = (() => { try { return URL_ENV ? ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(URL_ENV).hostname) : false; } catch { return false; } })();
if (URL_ENV && !isLocal) throw new Error('TEST_POSTGRES_URL must point at a local database (localhost / 127.0.0.1). Refusing to run.');
const suite = URL_ENV && isLocal ? describe : describe.skip;

const holder = vi.hoisted(() => ({ db: undefined as unknown, userId: '00000000-0000-4000-8000-00000000a11c', files: new Map<string, Buffer>(), fetchCalls: 0 }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: holder.userId } } }) } }) }));
vi.mock('@/lib/object-store', () => ({
  getStorage: () => ({
    put: async (_b: string, key: string, body: Buffer) => { holder.files.set(key, body); },
    download: async (_b: string, key: string) => holder.files.get(key)!,
    signedReadUrl: async (_b: string, key: string) => `https://storage.test/${key}`,
  }),
}));

import { GET as listCompilations, POST as startCompilation } from '@/app/api/v1/video-projects/[id]/compilations/route';
import { processPendingCompilation, markCompleted } from '@/worker/compilation';

const ROOT = path.resolve(__dirname, '../..');
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const SCHEMA = 'soma_concurrency_test';
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

suite('compilation versions under real concurrent connections', () => {
  beforeAll(async () => {
    // Every connection uses the test schema; max: 30 so many requests are genuinely in flight together.
    client = postgres(URL_ENV!, { max: 30, onnotice: () => {}, connection: { search_path: `${SCHEMA}, public` } });
    db = drizzle(client, { schema });
    holder.db = db;
    await client.unsafe(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA};`);
    await client.unsafe(`create schema if not exists auth; create or replace function auth.uid() returns uuid language sql as 'select null::uuid'; create or replace function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
    // Run the migrations on ONE dedicated connection so search_path applies to all of them.
    const files = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00(0[1-9]|1[0-9]|2[0-4])_.*\.sql$/.test(f) && !f.includes('verification')).sort();
    const one = postgres(URL_ENV!, { max: 1, onnotice: () => {}, connection: { search_path: `${SCHEMA}, public` } });
    try {
      for (const f of files.filter((m) => m < '0022_')) await one.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
      await one.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
      for (const f of files.filter((m) => m >= '0022_')) await one.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
    } finally { await one.end(); }
    process.env.USEAPI_TOKEN = 'test-token';
  }, 180_000);

  afterAll(async () => {
    await client.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await client.end();
  });

  beforeEach(async () => {
    holder.files.clear();
    holder.fetchCalls = 0;
    await client.unsafe('truncate video_projects restart identity cascade');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/videos/concatenate')) {
        holder.fetchCalls++;
        await new Promise((r) => setTimeout(r, 30)); // a slow job keeps the window for races open
        const ids = (JSON.parse(String(init?.body)) as { media: { mediaGenerationId: string }[] }).media.map((m) => m.mediaGenerationId);
        return new Response(JSON.stringify({ encodedVideo: Buffer.from(`joined:${ids.join('+')}`).toString('base64') }), { status: 200 });
      }
      return new Response('nf', { status: 404 });
    }));
  });

  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
  const post = (projectId: number, scenes: unknown) => startCompilation(new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify({ scenes }), headers: { 'content-type': 'application/json' } }), ctx(projectId));
  const list = async (projectId: number) => (await (await listCompilations(new NextRequest('http://localhost/api'), ctx(projectId))).json()) as Array<{ id: number; status: string; version: number | null; isCurrent: boolean }>;

  async function makeProject(): Promise<{ projectId: number; scenes: { videoScreenId: number; videoGenerationId: number }[] }> {
    const now = Date.now();
    const [p] = await db.insert(schema.videoProjects).values({ userId: ALICE, name: 'P', baseImagePath: 'x/y.png', originalScript: 's', createdAt: now, updatedAt: now }).returning();
    const scenes: { videoScreenId: number; videoGenerationId: number }[] = [];
    for (let i = 1; i <= 3; i++) {
      const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: p.id, screenNumber: i, dialogue: 'd', position: i, createdAt: now, updatedAt: now }).returning();
      const [v] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: s.id, version: 1, promptText: 'p', source: 'manual', createdAt: now }).returning();
      const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: s.id, promptVersionId: v.id, status: 'completed', videoStoragePath: `s${s.id}.mp4`, mediaGenerationId: `m${s.id}`, createdAt: now, updatedAt: now }).returning();
      scenes.push({ videoScreenId: s.id, videoGenerationId: g.id });
    }
    return { projectId: p.id, scenes };
  }
  const activeCount = async (projectId: number) => Number((await client`select count(*)::int n from video_compilations where video_project_id = ${projectId} and status in ('pending','processing')`)[0].n);

  it('25 simultaneous requests for one project create exactly one compilation', async () => {
    const { projectId, scenes } = await makeProject();
    const results = await Promise.all(Array.from({ length: 25 }, () => post(projectId, scenes)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(24);
    expect(await activeCount(projectId)).toBe(1);
    expect((await list(projectId))).toHaveLength(1);
  }, 60_000);

  it('simultaneous requests for different projects do not block each other', async () => {
    const projects = await Promise.all(Array.from({ length: 8 }, () => makeProject()));
    const results = await Promise.all(projects.map((p) => post(p.projectId, p.scenes)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
  }, 60_000);

  it('concurrent completions get unique, gap-free version numbers (real row locks; the one-active index is dropped for this test only)', async () => {
    const { projectId } = await makeProject();
    const now = Date.now();
    await client.unsafe('drop index if exists uq_vc_one_active_per_project');
    try {
      const rows = await db.insert(schema.videoCompilations).values(Array.from({ length: 12 }, (_, i) => ({ videoProjectId: projectId, status: 'processing', createdAt: now + i, updatedAt: now }))).returning();
      const versions = await Promise.all(rows.map((r) => markCompleted(projectId, r.id, `out/${r.id}.mp4`, 'useapi')));
      expect([...versions].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      const stored = (await client`select version from video_compilations where video_project_id = ${projectId} order by version`).map((r) => r.version);
      expect(stored).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    } finally {
      await client.unsafe('truncate video_compilations restart identity cascade');
      await client.unsafe(`create unique index if not exists uq_vc_one_active_per_project on video_compilations (video_project_id) where status in ('pending', 'processing')`);
    }
  }, 60_000);

  it('requests racing a completion either see the running job or the finished one, never two jobs and never a duplicate version', async () => {
    const { projectId, scenes } = await makeProject();
    for (let round = 1; round <= 5; round++) {
      const started = await post(projectId, scenes);
      expect(started.status).toBe(201);
      const [, ...posts] = await Promise.all([
        processPendingCompilation(),                                             // the worker finishes the job...
        ...Array.from({ length: 10 }, () => post(projectId, scenes)),            // ...while 10 more requests arrive
      ]);
      const codes = posts.map((r) => r.status);
      expect(codes.every((c) => c === 201 || c === 409)).toBe(true);
      expect(codes.filter((c) => c === 201).length).toBeLessThanOrEqual(1);
      expect(await activeCount(projectId)).toBeLessThanOrEqual(1);
      while (await activeCount(projectId) > 0) await processPendingCompilation(); // drain a job a request slipped in
    }
    const rows = await list(projectId);
    const versions = rows.filter((r) => r.status === 'completed').map((r) => r.version!).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1)); // unique and gap-free
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
  }, 120_000);

  it('two workers claiming the same pending job: only one runs it', async () => {
    const { projectId, scenes } = await makeProject();
    expect((await post(projectId, scenes)).status).toBe(201);
    await Promise.all([processPendingCompilation(), processPendingCompilation(), processPendingCompilation()]);
    expect(holder.fetchCalls).toBe(1);
    expect((await list(projectId))[0]).toMatchObject({ status: 'completed', version: 1 });
  }, 60_000);

  it('a mixed workload of requests, claims and completions across projects finishes without deadlocks', async () => {
    const projects = await Promise.all(Array.from({ length: 4 }, () => makeProject()));
    const errors: string[] = [];
    const guard = async <T,>(p: Promise<T>) => { try { return await p; } catch (e) { errors.push(String((e as Error).message)); return null; } };
    for (let round = 0; round < 6; round++) {
      await Promise.all([
        ...projects.flatMap((p) => Array.from({ length: 6 }, () => guard(post(p.projectId, p.scenes)))),
        guard(processPendingCompilation()), guard(processPendingCompilation()),
      ]);
    }
    for (let i = 0; i < 40 && (await client`select count(*)::int n from video_compilations where status in ('pending','processing')`)[0].n > 0; i++) await guard(processPendingCompilation());
    expect(errors.filter((e) => /deadlock/i.test(e))).toEqual([]);
    expect(errors).toEqual([]);
    for (const p of projects) {
      const done = (await list(p.projectId)).filter((r) => r.status === 'completed').map((r) => r.version!).sort((a, b) => a - b);
      expect(done).toEqual(Array.from({ length: done.length }, (_, i) => i + 1));
    }
  }, 180_000);

  it('uses real, separate connections (sanity check for this test file itself)', async () => {
    const pids = await Promise.all(Array.from({ length: 10 }, () => client`select pg_backend_pid() as pid, pg_sleep(0.2)`));
    expect(new Set(pids.map((r) => r[0].pid)).size).toBeGreaterThan(5);
    void eq; void sql;
  }, 30_000);
});
