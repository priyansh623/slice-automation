/**
 * Stabilisation: deleting a project destroys nothing and is all-or-nothing; one bad image never costs anyone the project list; a failed request is
 * never mistaken for "no projects". On an in-memory Postgres built from the real migrations.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema.pg';
import { migrate } from './helpers/studio-fakes';

const ALICE = '00000000-0000-4000-8000-0000000000a1';
const BOB = '00000000-0000-4000-8000-0000000000b1';
const holder = vi.hoisted(() => ({ db: undefined as unknown, user: '', storage: undefined as unknown, users: [] as Array<{ id: string; email: string }>, usersFail: false }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: holder.user, email: 'viewer@team.test' } } }) } }),
  createServiceClient: () => ({ auth: { admin: { listUsers: async () => holder.usersFail ? { data: { users: [] }, error: { message: 'auth down' } } : { data: { users: holder.users }, error: null } } } }),
}));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.storage }));

import { Storage } from '@/lib/object-store';
import { GET as listProjects } from '@/app/api/v1/video-projects/route';
import { GET as getProject, DELETE as deleteProject } from '@/app/api/v1/video-projects/[id]/route';
import { DELETE as unarchive, POST as archive } from '@/app/api/v1/admin/projects/[id]/archive/route';
import { softDeleteProject, PROJECT_DELETED_MESSAGE } from '@/lib/project-deletion';
import { resetOwnerEmailCacheForTests } from '@/lib/owner-emails';
import { fetchJson, RequestError } from '@/lib/client/fetch-json';

// ── storage with controllable failures ────────────────────────────────────
const fail = { head: new Set<string>(), sign: new Set<string>(), supabaseAll: false };
const heads: string[] = [];
const onR2 = new Set<string>();
const provider = (name: 'supabase' | 'r2') => ({
  name,
  head: async (_b: string, key: string) => { heads.push(key); if (fail.head.has(key)) throw new Error(`Failed to read metadata of uploads/${key} from R2: UnknownError`); return { size: 1, contentType: 'image/png', etag: null }; },
  signedReadUrl: async (_b: string, key: string) => { if (fail.sign.has(key)) throw new Error('sign failed'); return `https://${name}.test/${key}`; },
  signedReadUrls: async (_b: string, keys: string[]) => { if (fail.supabaseAll) throw new Error('supabase down'); return new Map(keys.filter((k) => !fail.sign.has(k)).map((k) => [k, `https://${name}.test/${k}`])); },
});
const makeStorage = () => new Storage({ supabase: provider('supabase') as never, r2: provider('r2') as never, locate: async (_b, keys) => new Map(keys.map((k) => [k, onR2.has(k) ? 'r2' as const : 'supabase' as const])), register: async () => {}, writeProvider: () => 'r2', failover: () => true });

let pg: PGlite; let db: PgliteDatabase<typeof schema>;
beforeAll(async () => { pg = new PGlite(); await migrate(pg); db = drizzle(pg, { schema }); holder.db = db; }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  holder.user = ALICE; holder.storage = makeStorage(); holder.users = [{ id: ALICE, email: 'alice@team.test' }, { id: BOB, email: 'bob@team.test' }]; holder.usersFail = false;
  fail.head.clear(); fail.sign.clear(); fail.supabaseAll = false; heads.length = 0; onR2.clear(); resetOwnerEmailCacheForTests();
  await pg.exec('drop trigger if exists boom on video_compilations; truncate video_projects, studio_projects, studio_assets, studio_packs restart identity cascade');
});

const now = () => Date.now();
async function makeProject(name: string, userId = ALICE, image = `${userId}/${name}.png`) {
  const [p] = await db.insert(schema.videoProjects).values({ userId, name, baseImagePath: image, originalScript: 's', createdAt: now(), updatedAt: now() }).returning();
  const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: p.id, screenNumber: 1, dialogue: 'd', position: 1, createdAt: now(), updatedAt: now() }).returning();
  const [v] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: s.id, version: 1, promptText: 'p', source: 'manual', createdAt: now() }).returning();
  const gen = async (status: string, jobId: string | null = null) => (await db.insert(schema.videoGenerations).values({ videoScreenId: s.id, promptVersionId: v.id, status, jobId, videoStoragePath: status === 'completed' ? 'screen/x.mp4' : null, createdAt: now(), updatedAt: now() }).returning())[0];
  return { p, s, v, gen };
}
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const req = (method = 'GET') => new NextRequest('http://x/api', { method });
const list = async () => (await listProjects()).json() as Promise<Array<{ id: number; name: string; ownerEmail: string | null; baseImagePreviewUrl: string | null }>>;
const countOf = async (table: string) => Number(((await pg.query(`select count(*)::int as n from ${table}`)).rows[0] as { n: number }).n);

/** A project with every kind of record that references it, including those that used to make the delete fail half-way. */
async function fullProject() {
  const x = await makeProject('full');
  const done = await x.gen('completed');
  const queued = await x.gen('queued');
  const inFlight = await x.gen('processing', 'job-1');
  await db.update(schema.videoScreens).set({ approvedGenerationId: done.id }).where(eq(schema.videoScreens.id, x.s.id));
  await pg.exec(`insert into studio_projects (name, video_project_id, created_by, created_at, updated_at) values ('studio', ${x.p.id}, '${ALICE}', 1, 1)`);
  await pg.exec(`insert into studio_packs (name, created_by, created_at, updated_at) values ('pack-${x.p.id}', '${ALICE}', 1, 1)`);
  await pg.exec(`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) select max(id), 'asset-${x.p.id}', 'image/png', 1, 'h-${x.p.id}', '${ALICE}', 1, 1 from studio_packs`);
  await pg.exec(`insert into character_broll_items (video_project_id, studio_asset_id, created_by, created_at, updated_at) select ${x.p.id}, max(id), '${ALICE}', 1, 1 from studio_assets`);
  await pg.exec(`insert into video_overlays (video_project_id, kind, anchor_screen_id, start_offset_ms, duration_ms, character_item_id, created_by, created_at, updated_at) select ${x.p.id}, 'character', ${x.s.id}, 0, 1000, max(id), '${ALICE}', 1, 1 from character_broll_items`);
  await pg.exec(`insert into video_compilations (video_project_id, status, version, output_storage_path, created_at, updated_at) values (${x.p.id}, 'completed', 1, 'compilations/a.mp4', 1, 1), (${x.p.id}, 'pending', null, null, 2, 2)`);
  await pg.exec(`insert into compilation_scene_selections (compilation_id, video_screen_id, video_generation_id, created_at) select id, ${x.s.id}, ${done.id}, 1 from video_compilations`);
  await pg.exec(`insert into prompt_generation_tasks (video_project_id, video_screen_id, task_type, status, created_at, updated_at) values (${x.p.id}, ${x.s.id}, 'generate_prompt', 'pending', 1, 1)`);
  return { ...x, done, queued, inFlight };
}

describe('deleting a project', () => {
  it('destroys nothing: every scene, video, compilation, overlay, Character item and Studio link is still there', async () => {
    const x = await fullProject();
    const before = { screens: await countOf('video_screens'), gens: await countOf('video_generations'), comps: await countOf('video_compilations'), sel: await countOf('compilation_scene_selections'), studio: await countOf('studio_projects'), overlays: await countOf('video_overlays'), character: await countOf('character_broll_items') };
    expect((await deleteProject(req('DELETE'), ctx(x.p.id))).status).toBe(200);
    expect({ screens: await countOf('video_screens'), gens: await countOf('video_generations'), comps: await countOf('video_compilations'), sel: await countOf('compilation_scene_selections'), studio: await countOf('studio_projects'), overlays: await countOf('video_overlays'), character: await countOf('character_broll_items') }).toEqual(before);
    expect((await getProject(req(), ctx(x.p.id))).status).toBe(404);
    expect(await list()).toEqual([]);
    expect((await deleteProject(req('DELETE'), ctx(x.p.id))).status).toBe(404);
  });

  it('cancels only work that has not been sent to a provider; paid work in flight and finished work are left alone', async () => {
    const x = await fullProject();
    await softDeleteProject(x.p.id);
    const gens = await db.select().from(schema.videoGenerations);
    expect(gens.find((g) => g.id === x.queued.id)).toMatchObject({ status: 'failed', errorMessage: PROJECT_DELETED_MESSAGE });
    expect(gens.find((g) => g.id === x.inFlight.id)!.status).toBe('processing');
    expect(gens.find((g) => g.id === x.done.id)!.status).toBe('completed');
    const comps = await db.select().from(schema.videoCompilations).orderBy(schema.videoCompilations.id);
    expect(comps.map((c) => c.status)).toEqual(['completed', 'failed']);
    expect((await db.select().from(schema.promptGenerationTasks))[0].status).toBe('failed');
  });

  it('is all-or-nothing: if any step fails the project and every record stay exactly as they were, and the API says so', async () => {
    const x = await fullProject();
    await pg.exec(`create or replace function boom() returns trigger language plpgsql as $$begin raise exception 'simulated failure'; end$$;
      create trigger boom before update on video_compilations for each row execute function boom();`);
    const res = await deleteProject(req('DELETE'), ctx(x.p.id));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Nothing was changed/);
    expect((await db.select().from(schema.videoProjects))[0].archivedAt).toBeNull();
    expect((await db.select().from(schema.videoGenerations)).find((g) => g.id === x.queued.id)!.status).toBe('queued');
    expect((await db.select().from(schema.promptGenerationTasks))[0].status).toBe('pending');
    expect((await getProject(req(), ctx(x.p.id))).status).toBe(200);
  });

  it('can be undone with the existing admin Unarchive, and an admin-archived project still shows in the list as before', async () => {
    const a = await makeProject('deleted'); const b = await makeProject('admin-archived');
    await archive(req('POST'), ctx(b.p.id));
    await softDeleteProject(a.p.id);
    expect((await list()).map((p) => p.name)).toEqual(['admin-archived']);
    await unarchive(req('DELETE'), ctx(a.p.id));
    expect((await list()).map((p) => p.name).sort()).toEqual(['admin-archived', 'deleted']);
  });
});

describe('the project list survives image problems', () => {
  async function two() {
    const a = await makeProject('a'); const b = await makeProject('b', BOB);
    return { a, b };
  }

  it('one R2 failure (the production incident) costs at most that picture, never the list', async () => {
    const { a, b } = await two();
    onR2.add(a.p.baseImagePath); onR2.add(b.p.baseImagePath);
    fail.head.add(a.p.baseImagePath); fail.sign.add(a.p.baseImagePath);
    const res = await listProjects();
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { id: number }) => r.id === b.p.id).baseImagePreviewUrl).toBeTruthy();
  });

  it('when R2 refuses every request (a rolled or revoked token), files that have a Supabase copy are served from it', async () => {
    onR2.add('both'); onR2.add('r2only'); fail.head.add('both'); fail.head.add('r2only');
    // 'r2only' has no Supabase copy
    fail.sign.clear();
    const storage = new Storage({ supabase: { ...provider('supabase'), signedReadUrl: async (_b: string, k: string) => (k === 'r2only' ? null : `https://supabase.test/${k}`), signedReadUrls: async () => new Map() } as never, r2: provider('r2') as never, locate: async (_b, keys) => new Map(keys.map((k) => [k, 'r2' as const])), register: async () => {}, writeProvider: () => 'r2', failover: () => true });
    expect(await storage.signedReadUrl('videos', 'both', 60)).toBe('https://supabase.test/both');
    expect(await storage.signedReadUrl('videos', 'r2only', 60)).toBe('https://r2.test/r2only');       // nothing else to offer
    const many = await storage.signedReadUrls('videos', ['both', 'r2only'], 60);
    expect(many.get('both')).toBe('https://supabase.test/both');
  });

  it('even a total signing outage still returns every project, without pictures', async () => {
    await two();
    fail.supabaseAll = true;
    const res = await listProjects();
    expect(res.status).toBe(200);
    expect((await res.json()).map((r: { name: string }) => r.name).sort()).toEqual(['a', 'b']);
  });

  it('the storage layer never rejects a whole batch because one existence check failed', async () => {
    onR2.add('k1'); onR2.add('k2'); fail.head.add('k1');
    const urls = await makeStorage().signedReadUrls('uploads', ['k1', 'k2', 'k3'], 60);
    expect([...urls.keys()].sort()).toEqual(['k1', 'k2', 'k3']);
  });

  it('shows each project\'s own creator as owner, not the person looking; unknown if emails cannot be read', async () => {
    await two();
    expect(Object.fromEntries((await list()).map((p) => [p.name, p.ownerEmail]))).toEqual({ a: 'alice@team.test', b: 'bob@team.test' });
    resetOwnerEmailCacheForTests(); holder.usersFail = true;
    expect(Object.fromEntries((await list()).map((p) => [p.name, p.ownerEmail]))).toEqual({ a: 'viewer@team.test', b: null });
  });
});

describe('a failed request is an error, never an empty result', () => {
  const respond = (body: string, status: number) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
  it('rejects error statuses, error pages, and unreadable answers', async () => {
    respond('', 500);
    await expect(fetchJson('/x')).rejects.toMatchObject({ name: 'RequestError', status: 500 });
    respond('{"error":"Unauthorized"}', 401);
    await expect(fetchJson('/x')).rejects.toMatchObject({ status: 401, message: 'Unauthorized' });
    respond('<html>gateway timeout</html>', 200);
    await expect(fetchJson('/x')).rejects.toBeInstanceOf(RequestError);
    respond('[]', 200);
    expect(await fetchJson('/x')).toEqual([]);                              // a REAL empty list
    vi.unstubAllGlobals();
  });
  it('gives up after its time limit instead of loading forever', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))));
    await expect(fetchJson('/x', { timeoutMs: 20 })).rejects.toThrow(/too long/);
    vi.unstubAllGlobals();
  });
});
