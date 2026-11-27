/**
 * A deleted project cannot be changed by anything: not by an already-open tab (every mutating project route), not by the Studio, and not by the
 * workers. Restoring brings everything back. Plus: the admin screen can tell "deleted" from "archived", and the worker's shutdown and stuck-work
 * reporting. In-memory Postgres built from the real migrations.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema.pg';
import { migrate } from './helpers/studio-fakes';

const USER = '00000000-0000-4000-8000-0000000000a1';
const holder = vi.hoisted(() => ({ db: undefined as unknown, claude: 0, submit: (async () => ({ jobId: 'j' })) as () => Promise<unknown> }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } } }) }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-0000000000a1' } } }) } }),
  createServiceClient: () => ({ auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } } }),
}));
vi.mock('@/services/anthropic', async (orig) => ({ ...(await orig<typeof import('@/services/anthropic')>()), callClaude: async () => { holder.claude++; throw new Error('must not be called for a deleted project'); } }));
vi.mock('@/providers/useapi/provider', async (orig) => ({ ...(await orig<typeof import('@/providers/useapi/provider')>()), useapiProvider: { uploadReferenceImage: async () => ({ mediaGenerationId: 'r' }), submitGeneration: () => holder.submit(), pollJob: async () => ({ status: 'started' }), downloadVideo: async () => ({ tempPath: '/dev/null' }) } }));

import { softDeleteProject, PROJECT_DELETED_MESSAGE, isStudioProjectOfDeletedVideo } from '@/lib/project-deletion';
import { POST as adminArchive, DELETE as adminRestore } from '@/app/api/v1/admin/projects/[id]/archive/route';
import { GET as dashboard } from '@/app/api/v1/admin/dashboard/route';
import { claimQueuedJobs } from '@/lib/studio/generation';
import { getProject as getStudioProject } from '@/lib/studio/projects';
import { retryJob } from '@/lib/studio/batches';
import { processPromptTasks, processQueuedGenerations, startQueuedSubmissions, drainSubmissions, resumeSubmissionsForTests, reportStuckWork } from '@/worker/index';
import { processPendingCompilation } from '@/worker/compilation';
import { UseapiGoogleFlowProvider } from '@/providers/useapi/provider';

let pg: PGlite; let db: PgliteDatabase<typeof schema>;
const OVERLAYS = process.env.BROLL_OVERLAYS_ENABLED;
beforeAll(async () => { process.env.BROLL_OVERLAYS_ENABLED = 'true'; pg = new PGlite(); await migrate(pg); db = drizzle(pg, { schema }); holder.db = db; }, 120_000);
afterAll(async () => { process.env.BROLL_OVERLAYS_ENABLED = OVERLAYS; await pg.close(); });
beforeEach(async () => { holder.claude = 0; holder.submit = async () => ({ jobId: 'j' }); resumeSubmissionsForTests(); await pg.exec('truncate video_projects, studio_projects, studio_assets, studio_packs restart identity cascade'); });

async function project() {
  const now = Date.now();
  const [p] = await db.insert(schema.videoProjects).values({ userId: USER, name: 'p', baseImagePath: 'x.png', baseImageMediaId: 'r', originalScript: 's', creativeBrief: '{}', createdAt: now, updatedAt: now }).returning();
  const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: p.id, screenNumber: 1, dialogue: 'd', position: 1, createdAt: now, updatedAt: now }).returning();
  const [v] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: s.id, version: 1, promptText: 'p', source: 'manual', createdAt: now }).returning();
  const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: s.id, promptVersionId: v.id, status: 'completed', videoStoragePath: 'a.mp4', mediaGenerationId: 'm', createdAt: now, updatedAt: now }).returning();
  await db.update(schema.videoScreens).set({ approvedGenerationId: g.id }).where(eq(schema.videoScreens.id, s.id));
  return { p, s, v, g };
}
const snapshot = async () => JSON.stringify(await Promise.all(['video_projects', 'video_screens', 'screen_prompt_versions', 'video_generations', 'video_compilations', 'prompt_generation_tasks', 'video_overlays', 'character_broll_items', 'generation_feedback', 'project_testers'].map(async (t) => (await pg.query(`select * from ${t} order by id`)).rows)));

// Every route file under video-projects/[id] that can change something, with how to call it.
const ROOT = path.join(__dirname, '../app/api/v1/video-projects/[id]');
type Ids = { screenId: number; promptVersionId: number; generationId: number };
const CALLS: Record<string, (ids: Ids) => { method: string; body?: unknown; params?: Record<string, string> }[]> = {
  'route.ts': () => [{ method: 'DELETE' }],
  'analyze/route.ts': () => [{ method: 'POST' }],
  'approve-breakdown/route.ts': () => [{ method: 'POST' }],
  'breakdown/route.ts': () => [{ method: 'PUT', body: { screens: [{ screenNumber: 1, dialogue: 'changed' }] } }],
  'brief/route.ts': () => [{ method: 'PUT', body: { tone: 'changed' } }],
  'broll-selection/route.ts': () => [{ method: 'PUT', body: { choice: 'none' } }],
  'broll-selection/character-remove/route.ts': () => [{ method: 'POST', body: { rowKey: 'x' } }],
  'broll-selection/character-start/route.ts': () => [{ method: 'POST', body: {} }],
  'broll-selection/recommendations/route.ts': () => [{ method: 'POST', body: {} }],
  'character-broll/[cid]/[action]/route.ts': () => [{ method: 'POST', body: {}, params: { cid: '1', action: 'approve-image' } }],
  'compilations/route.ts': (i) => [{ method: 'POST', body: { scenes: [{ videoScreenId: i.screenId, videoGenerationId: i.generationId }] } }],
  'generate-all-prompts/route.ts': () => [{ method: 'POST' }],
  'generate-all/route.ts': () => [{ method: 'POST' }],
  'overlays/route.ts': () => [{ method: 'POST', body: {} }],
  'overlays/populate/route.ts': () => [{ method: 'POST' }],
  'overlays/[oid]/route.ts': () => [{ method: 'PATCH', body: {}, params: { oid: '1' } }, { method: 'DELETE', params: { oid: '1' } }],
  'overlays/[oid]/retry/route.ts': () => [{ method: 'POST', params: { oid: '1' } }],
  'screens/route.ts': () => [{ method: 'POST', body: { dialogue: 'new scene' } }],
  'screens/restore/route.ts': (i) => [{ method: 'POST', body: { screenId: i.screenId } }],
  'screens/retry/route.ts': (i) => [{ method: 'POST', body: { screenId: i.screenId } }],
  'screens/[n]/route.ts': (i) => [{ method: 'DELETE', params: { n: '1' }, body: { screenId: i.screenId } }],
  'screens/[n]/approve/route.ts': (i) => [{ method: 'POST', params: { n: '1' }, body: { generationId: i.generationId } }],
  'screens/[n]/unapprove/route.ts': () => [{ method: 'POST', params: { n: '1' } }],
  'screens/[n]/generate/route.ts': (i) => [{ method: 'POST', params: { n: '1' }, body: { promptVersionId: i.promptVersionId } }],
  'screens/[n]/prompt/route.ts': () => [{ method: 'POST', params: { n: '1' }, body: { nlFeedback: 'x' } }, { method: 'PUT', params: { n: '1' }, body: { promptText: 'changed by an old tab' } }],
  'testers/route.ts': () => [{ method: 'POST', body: { userId: USER } }],
};

function mutatingRoutes(dir = ROOT, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return mutatingRoutes(path.join(dir, e.name), `${prefix}${e.name}/`);
    if (e.name !== 'route.ts') return [];
    return /export\s+(async function|const)\s+(POST|PUT|PATCH|DELETE)\b/.test(fs.readFileSync(path.join(dir, e.name), 'utf8')) ? [`${prefix}route.ts`] : [];
  });
}

describe('an already-open tab cannot change a deleted project', () => {
  it('this test knows every mutating project route (a new one must be added here, with its guard)', () => {
    expect(mutatingRoutes().sort()).toEqual(Object.keys(CALLS).sort());
  });

  for (const route of Object.keys(CALLS)) {
    it(`${route} refuses with 404 and changes nothing`, async () => {
      const x = await project();
      await softDeleteProject(x.p.id);
      const before = await snapshot();
      const mod = (await import(/* @vite-ignore */ `../app/api/v1/video-projects/[id]/${route.replace(/\.ts$/, '')}`)) as Record<string, (r: NextRequest, c: unknown) => Promise<Response>>;
      for (const c of CALLS[route]({ screenId: x.s.id, promptVersionId: x.v.id, generationId: x.g.id })) {
        const req = new NextRequest('http://x/api?screenId=' + x.s.id, { method: c.method, ...(c.body ? { body: JSON.stringify(c.body), headers: { 'content-type': 'application/json' } } : {}) });
        const res = await mod[c.method](req, { params: Promise.resolve({ id: String(x.p.id), ...c.params }) });
        expect(res.status, `${c.method} ${route}`).toBe(404);
      }
      expect(await snapshot()).toBe(before);
      expect(holder.claude).toBe(0);
    });
  }

  it('feedback on a deleted project\'s video is refused too', async () => {
    const x = await project();
    await softDeleteProject(x.p.id);
    const { POST } = await import('@/app/api/v1/generation-feedback/route');
    const res = await POST(new NextRequest('http://x', { method: 'POST', body: JSON.stringify({ videoGenerationId: x.g.id, overallQuality: 5 }) }));
    expect(res.status).toBe(404);
  });
});

describe('the Studio and the workers start nothing for a deleted project', () => {
  async function withStudioJob() {
    const x = await project();
    await pg.exec(`insert into studio_projects (name, video_project_id, created_by, created_at, updated_at) values ('s', ${x.p.id}, '${USER}', 1, 1)`);
    await pg.exec(`insert into studio_packs (name, created_by, created_at, updated_at) values ('pk', '${USER}', 1, 1)`);
    await pg.exec(`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values (1, 'a', 'image/png', 1, 'h', '${USER}', 1, 1)`);
    const sid = Number(((await pg.query('select id from studio_projects')).rows[0] as { id: number }).id);
    await pg.exec(`insert into studio_batches (project_id, created_by, provider, character_key, total_jobs, created_at) values (${sid}, '${USER}', 'mock', 'c', 1, 1)`);
    const batch = Number(((await pg.query('select id from studio_batches')).rows[0] as { id: number }).id);
    return { ...x, sid, batch };
  }

  it('queued Character image jobs are cancelled, never claimed, and the Studio record is closed', async () => {
    const x = await withStudioJob();
    await pg.exec(`insert into studio_jobs (batch_id, project_id, asset_id, pack_id, source_key, character_key, provider, status, created_by, created_at, updated_at) values (${x.batch}, ${x.sid}, 1, 1, 's', 'c', 'mock', 'queued', '${USER}', 1, 1)`);
    const [job] = await db.select().from(schema.studioJobs);
    await softDeleteProject(x.p.id);
    expect((await db.select().from(schema.studioJobs).where(eq(schema.studioJobs.id, job.id)))[0].status).toBe('canceled');
    await db.update(schema.studioJobs).set({ status: 'queued' });                          // one that slipped in after the delete
    expect(await claimQueuedJobs(5)).toEqual([]);
    expect(await isStudioProjectOfDeletedVideo(x.sid)).toBe(true);
    await expect(getStudioProject(x.sid)).rejects.toMatchObject({ status: 404 });
    await db.update(schema.studioJobs).set({ status: 'failed', errorRetryable: true });
    await expect(retryJob(job.id, USER)).rejects.toBeTruthy();
  });

  it('work queued by a request that raced the delete is refused at the worker: no AI call, no video submission, no compilation', async () => {
    const x = await project();
    await softDeleteProject(x.p.id);
    let submits = 0; holder.submit = async () => { submits++; return { jobId: 'j' }; };
    const now = Date.now();
    await db.insert(schema.promptGenerationTasks).values({ videoProjectId: x.p.id, videoScreenId: x.s.id, taskType: 'generate_prompt', status: 'pending', createdAt: now, updatedAt: now });
    await db.insert(schema.videoGenerations).values({ videoScreenId: x.s.id, promptVersionId: x.v.id, status: 'queued', createdAt: now, updatedAt: now });
    await db.insert(schema.videoCompilations).values({ videoProjectId: x.p.id, status: 'pending', createdAt: now, updatedAt: now });
    await processPromptTasks(); await processQueuedGenerations(); await processPendingCompilation();
    expect(holder.claude).toBe(0); expect(submits).toBe(0);
    expect((await db.select().from(schema.promptGenerationTasks))[0]).toMatchObject({ status: 'failed', errorMessage: PROJECT_DELETED_MESSAGE });
    expect((await db.select().from(schema.videoGenerations)).filter((g) => g.errorMessage === PROJECT_DELETED_MESSAGE)).toHaveLength(1);
    expect((await db.select().from(schema.videoCompilations))[0]).toMatchObject({ status: 'failed', errorMessage: PROJECT_DELETED_MESSAGE });
  });
});

describe('admin: deleted and archived are different, and both can be restored', () => {
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
  const r = () => new NextRequest('http://x', { method: 'POST' });
  const rows = async (archived: boolean) => (await dashboard(new NextRequest(`http://x/api${archived ? '?archived=1' : ''}`))).json() as Promise<Array<{ id: number; deletedByUser: boolean }>>;

  it('marks which is which; archiving cannot turn a deleted project visible again; Restore works for both', async () => {
    const del = await project(); const arch = await project();
    await adminArchive(r(), ctx(arch.p.id));
    await softDeleteProject(del.p.id);
    expect(await rows(false)).toEqual([]);
    expect(Object.fromEntries((await rows(true)).map((x) => [x.id, x.deletedByUser]))).toEqual({ [del.p.id]: true, [arch.p.id]: false });
    await adminArchive(r(), ctx(del.p.id));
    expect((await db.select().from(schema.videoProjects).where(eq(schema.videoProjects.id, del.p.id)))[0].archivedAt!).toBeLessThan(0);
    await adminRestore(r(), ctx(del.p.id)); await adminRestore(r(), ctx(arch.p.id));
    expect((await rows(false)).map((x) => x.id).sort()).toEqual([del.p.id, arch.p.id].sort());
    expect(await db.select().from(schema.videoGenerations)).toHaveLength(2);                   // nothing was destroyed on the way
  });
});

describe('worker shutdown, stuck work, and the provider answers', () => {
  it('on shutdown no new submission starts, and the ones already sent are waited for (bounded)', async () => {
    const x = await project();
    const now = Date.now();
    await db.insert(schema.videoGenerations).values({ videoScreenId: x.s.id, promptVersionId: x.v.id, status: 'queued', createdAt: now, updatedAt: now });
    let release!: () => void;
    holder.submit = () => new Promise((res) => { release = () => res({ jobId: 'late' }); });
    const started = await startQueuedSubmissions();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await drainSubmissions(30)).toBe(1);                                                 // still unanswered when the limit passes
    await db.insert(schema.videoGenerations).values({ videoScreenId: x.s.id, promptVersionId: x.v.id, status: 'queued', createdAt: now + 1, updatedAt: now });
    expect(await startQueuedSubmissions()).toEqual([]);
    release();
    expect(await drainSubmissions(1000)).toBe(0);
    await Promise.all(started);
    expect((await db.select().from(schema.videoGenerations)).some((g) => g.jobId === 'late')).toBe(true);
  });

  it('names work that has waited too long', async () => {
    const x = await project();
    const old = Date.now() - 2 * 3_600_000;
    const [q] = await db.insert(schema.videoGenerations).values({ videoScreenId: x.s.id, promptVersionId: x.v.id, status: 'queued', createdAt: old, updatedAt: old }).returning();
    const [p] = await db.insert(schema.videoGenerations).values({ videoScreenId: x.s.id, promptVersionId: x.v.id, status: 'pending', jobId: 'j', createdAt: old, updatedAt: old }).returning();
    expect(await reportStuckWork()).toEqual({ queued: [q.id], unfinished: [p.id] });
  });

  it('reads the job id from both documented submit answers, and sends async only when asked to', async () => {
    const provider = new UseapiGoogleFlowProvider();
    const bodies: Array<Record<string, unknown>> = [];
    const answer = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return new Response(JSON.stringify(body), { status }); }));
    const params = { prompt: 'p', model: 'm', referenceImageMediaId: 'r', duration: 8, aspectRatio: 'portrait', correlationId: 'c' };
    answer({ jobId: 'camel', media: [] });
    expect((await provider.submitGeneration(params)).jobId).toBe('camel');
    expect(bodies[0]).not.toHaveProperty('async');
    process.env.VIDEO_SUBMIT_ASYNC = 'true';
    answer({ jobid: 'lower', status: 'created', response: { media: [] } }, 201);
    expect(await provider.submitGeneration(params)).toEqual({ jobId: 'lower', videoUrl: undefined, mediaGenerationId: undefined });
    expect(bodies[1]).toMatchObject({ async: true });
    delete process.env.VIDEO_SUBMIT_ASYNC; vi.unstubAllGlobals();
  });
});
