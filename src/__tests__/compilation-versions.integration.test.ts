/**
 * Recompilation with version history, against a real in-memory Postgres built from the repository's migrations
 * (including 0024). The real routes and the real worker functions run; only the database handle, Supabase auth,
 * storage, the useapi.net HTTP call and the FFmpeg binary are replaced. No real compilation is ever started.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema.pg';

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: '00000000-0000-4000-8000-00000000a11c' as string | null,
  files: new Map<string, Buffer>(),
  failPut: false,
  ffmpegInputs: [] as string[][],
  failFfmpeg: false,
  fetchCalls: [] as string[],
  concatenateFails: false,
  onPut: null as null | (() => Promise<void>),
  onConcatenate: null as null | (() => Promise<void>),
  onFfmpeg: null as null | (() => void),
}));

vi.mock('@/db', () => ({
  db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }),
}));
vi.mock('@/lib/object-store', () => ({
  getStorage: () => ({
    put: async (_b: string, key: string, body: Buffer) => { if (holder.failPut) throw new Error('storage down'); holder.files.set(key, body); if (holder.onPut) await holder.onPut(); },
    download: async (_b: string, key: string) => { const f = holder.files.get(key); if (!f) throw new Error(`missing ${key}`); return f; },
    signedReadUrl: async (_b: string, key: string) => (holder.files.has(key) ? `https://storage.test/${key}` : null),
  }),
}));
vi.mock('@/worker/ffmpeg-utils', () => ({
  runFfmpegFilterComplex: (inputs: string[], output: string) => {
    holder.onFfmpeg?.();
    holder.ffmpegInputs.push(inputs.map((p) => fs.readFileSync(p).toString()));
    if (holder.failFfmpeg) throw new Error('FFmpeg exited with code 1');
    fs.writeFileSync(output, `ffmpeg-joined:${inputs.map((p) => fs.readFileSync(p).toString()).join('+')}`);
  },
}));

import { GET as listCompilations, POST as startCompilation } from '@/app/api/v1/video-projects/[id]/compilations/route';
import { GET as getVideo } from '@/app/api/v1/video-projects/[id]/compilations/[cid]/video/route';
import { GET as getDownload } from '@/app/api/v1/video-projects/[id]/compilations/[cid]/download/route';
import { processPendingCompilation, markCompleted, recoverStaleCompilations, INTERRUPTED_COMPILATION_MESSAGE } from '@/worker/compilation';
import { resetLifetimeCountersForTests, useCgroupIoForTests, WORKER_LIFETIME } from '@/worker/container-memory';
import { FakeKernel, MIB } from './helpers/fake-cgroup';

const ROOT = path.resolve(__dirname, '../..');
const ALICE = '00000000-0000-4000-8000-00000000a11c';
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

async function migrate(target: PGlite, upTo: string): Promise<void> {
  await target.exec(`create schema if not exists auth; create or replace function auth.uid() returns uuid language sql as 'select null::uuid'; create or replace function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const files = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification') && f.slice(0, 4) <= upTo).sort();
  for (const f of files.filter((m) => m < '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
  await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
  for (const f of files.filter((m) => m >= '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  holder.db = db;
  await migrate(pg, '0024');
  process.env.USEAPI_TOKEN = 'test-token';
}, 120_000);
afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  holder.userId = ALICE;
  holder.files.clear();
  holder.failPut = false;
  holder.failFfmpeg = false;
  holder.ffmpegInputs = [];
  holder.fetchCalls = [];
  holder.concatenateFails = false;
  holder.onPut = null;
  holder.onConcatenate = null;
  holder.onFfmpeg = null;
  useCgroupIoForTests();
  await pg.exec('truncate video_projects restart identity cascade');
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    holder.fetchCalls.push(u);
    if (u.includes('/videos/concatenate')) {
      if (holder.onConcatenate) await holder.onConcatenate();
      if (holder.concatenateFails) return new Response('boom', { status: 500 });
      const ids = (JSON.parse(String(init?.body)) as { media: { mediaGenerationId: string }[] }).media.map((m) => m.mediaGenerationId);
      return new Response(JSON.stringify({ encodedVideo: Buffer.from(`useapi-joined:${ids.join('+')}`).toString('base64') }), { status: 200 });
    }
    // storage.test signed URLs (the download route proxies the file)
    const key = u.replace('https://storage.test/', '');
    const f = holder.files.get(key);
    return f ? new Response(new Uint8Array(f), { status: 200, headers: { 'Content-Type': 'video/mp4' } }) : new Response('nf', { status: 404 });
  }));
});

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const ctxC = (id: number, cid: number) => ({ params: Promise.resolve({ id: String(id), cid: String(cid) }) });
const postReq = (payload: unknown) => new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
const getReq = () => new NextRequest('http://localhost/api');

interface Scene { screenId: number; generations: { id: number; legacy: boolean }[] }

/** A project with `n` scenes. Each scene has a newer-style clip (has a media ID) and a legacy clip (no media ID). */
async function makeProject(n = 3): Promise<{ projectId: number; scenes: Scene[] }> {
  const now = Date.now();
  const [p] = await db.insert(schema.videoProjects).values({ userId: ALICE, name: 'P', baseImagePath: 'x/y.png', originalScript: 's', createdAt: now, updatedAt: now }).returning();
  const scenes: Scene[] = [];
  for (let i = 1; i <= n; i++) {
    const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: p.id, screenNumber: i, dialogue: `d${i}`, position: i, createdAt: now, updatedAt: now }).returning();
    const [v] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: s.id, version: 1, promptText: 'p', source: 'manual', createdAt: now }).returning();
    const gens: Scene['generations'] = [];
    for (const legacy of [false, true]) {
      const key = `screen-${s.id}/${legacy ? 'legacy' : 'new'}-${i}.mp4`;
      const [g] = await db.insert(schema.videoGenerations).values({
        videoScreenId: s.id, promptVersionId: v.id, status: 'completed', videoStoragePath: key,
        mediaGenerationId: legacy ? null : `media-${s.id}`, createdAt: now, updatedAt: now,
      }).returning();
      holder.files.set(key, Buffer.from(`${legacy ? 'L' : 'N'}${i}`));
      gens.push({ id: g.id, legacy });
    }
    scenes.push({ screenId: s.id, generations: gens });
  }
  return { projectId: p.id, scenes };
}

const pick = (scenes: Scene[], legacy: (i: number) => boolean) => scenes.map((s, i) => ({ videoScreenId: s.screenId, videoGenerationId: s.generations.find((g) => g.legacy === legacy(i))!.id }));
const allNew = (scenes: Scene[]) => pick(scenes, () => false);
const allLegacy = (scenes: Scene[]) => pick(scenes, () => true);
const mixed = (scenes: Scene[]) => pick(scenes, (i) => i === 1);

async function compile(projectId: number, body: unknown, runWorker = true) {
  const res = await startCompilation(postReq({ scenes: body }), ctx(projectId));
  const json = await res.json() as { id?: number; error?: string };
  if (res.status === 201 && runWorker) await processPendingCompilation();
  return { status: res.status, id: json.id, json };
}
async function list(projectId: number) {
  return (await (await listCompilations(getReq(), ctx(projectId))).json()) as Array<{ id: number; status: string; version: number | null; isCurrent: boolean; method: string | null; sceneCount: number; selections: { videoGenerationId: number }[]; outputStoragePath: string | null; errorMessage: string | null }>;
}

describe('versions', () => {
  it('first compilation is Version 1 and current; second is Version 2 and takes over as current; both are kept', async () => {
    const { projectId, scenes } = await makeProject();
    const first = await compile(projectId, allNew(scenes));
    expect(first.status).toBe(201);
    let rows = await list(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, status: 'completed', version: 1, isCurrent: true, method: 'useapi' });

    const second = await compile(projectId, allNew(scenes));
    rows = await list(projectId);
    expect(rows.map((r) => [r.id, r.version, r.isCurrent])).toEqual([[second.id, 2, true], [first.id, 1, false]]);
  });

  it('keeps each version\'s own video file, clip selection and timestamp; a new compilation never overwrites an earlier one', async () => {
    const { projectId, scenes } = await makeProject();
    const a = await compile(projectId, allNew(scenes));
    const aBefore = (await list(projectId))[0];
    const aFile = holder.files.get(aBefore.outputStoragePath!)!.toString();
    const aCreatedAt = (await db.select().from(schema.videoCompilations).where(eq(schema.videoCompilations.id, a.id!)))[0].createdAt;

    // Recompile with different clips (the legacy clip for scene 2)
    const b = await compile(projectId, mixed(scenes));
    const rows = await list(projectId);
    const v1 = rows.find((r) => r.id === a.id)!;
    const v2 = rows.find((r) => r.id === b.id)!;

    expect(v1.outputStoragePath).not.toBe(v2.outputStoragePath);
    expect(holder.files.get(v1.outputStoragePath!)!.toString()).toBe(aFile); // v1's bytes are untouched
    expect(v1.selections.map((s) => s.videoGenerationId)).toEqual(allNew(scenes).map((s) => s.videoGenerationId));
    expect(v2.selections.map((s) => s.videoGenerationId)).toEqual(mixed(scenes).map((s) => s.videoGenerationId));
    expect(v1.sceneCount).toBe(3);
    expect((await db.select().from(schema.videoCompilations).where(eq(schema.videoCompilations.id, a.id!)))[0].createdAt).toBe(aCreatedAt); // timestamp unchanged
  });

  it('a project can hold many versions (1, 2, 3, 4) with exactly one current', async () => {
    const { projectId, scenes } = await makeProject();
    for (let i = 0; i < 4; i++) await compile(projectId, allNew(scenes));
    const rows = await list(projectId);
    expect(rows.map((r) => r.version)).toEqual([4, 3, 2, 1]);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(rows[0].isCurrent).toBe(true);
    expect(new Set(rows.map((r) => r.outputStoragePath)).size).toBe(4);
  });

  it('numbering is per project', async () => {
    const a = await makeProject();
    const b = await makeProject();
    await compile(a.projectId, allNew(a.scenes));
    await compile(a.projectId, allNew(a.scenes));
    await compile(b.projectId, allNew(b.scenes));
    expect((await list(a.projectId)).map((r) => r.version)).toEqual([2, 1]);
    expect((await list(b.projectId)).map((r) => r.version)).toEqual([1]);
  });
});

describe('failure handling', () => {
  it('a failed recompilation leaves the previous version current, playable and downloadable, and uses no version number', async () => {
    const { projectId, scenes } = await makeProject();
    const first = await compile(projectId, allNew(scenes));
    holder.concatenateFails = true;
    const failed = await compile(projectId, allNew(scenes));

    let rows = await list(projectId);
    const failedRow = rows.find((r) => r.id === failed.id)!;
    expect(failedRow).toMatchObject({ status: 'failed', version: null, isCurrent: false, outputStoragePath: null });
    expect(failedRow.errorMessage).toMatch(/Concatenate API error 500/);
    expect(rows.find((r) => r.id === first.id)).toMatchObject({ status: 'completed', version: 1, isCurrent: true });

    expect((await getVideo(getReq(), ctxC(projectId, first.id!))).status).toBe(200);
    const dl = await getDownload(getReq(), ctxC(projectId, first.id!));
    expect(dl.status).toBe(200);
    expect(Buffer.from(await (dl as Response).arrayBuffer()).toString()).toMatch(/^useapi-joined:/);

    // The next success is Version 2: the failure did not consume a number.
    holder.concatenateFails = false;
    await compile(projectId, allNew(scenes));
    rows = await list(projectId);
    expect(rows.filter((r) => r.status === 'completed').map((r) => r.version)).toEqual([2, 1]);
  });

  it('a failed storage upload fails the compilation without touching earlier versions', async () => {
    const { projectId, scenes } = await makeProject();
    const first = await compile(projectId, allNew(scenes));
    holder.failPut = true;
    await compile(projectId, allNew(scenes));
    const rows = await list(projectId);
    expect(rows[0]).toMatchObject({ status: 'failed', version: null });
    expect(rows[0].errorMessage).toMatch(/Upload failed/);
    expect(rows.find((r) => r.id === first.id)).toMatchObject({ status: 'completed', isCurrent: true });
  });

  it('after a failure the project can be compiled again straight away', async () => {
    const { projectId, scenes } = await makeProject();
    holder.concatenateFails = true;
    await compile(projectId, allNew(scenes));
    holder.concatenateFails = false;
    const retry = await compile(projectId, allNew(scenes));
    expect(retry.status).toBe(201);
    expect((await list(projectId)).find((r) => r.id === retry.id)).toMatchObject({ status: 'completed', version: 1, isCurrent: true });
  });
});

describe('leaving the page and concurrent compilations', () => {
  it('a compilation keeps its state in the database, so a page opened later sees it running and then finished', async () => {
    const { projectId, scenes } = await makeProject();
    await compile(projectId, allNew(scenes));
    const started = await compile(projectId, allNew(scenes), false); // the user starts it, then closes the tab
    let rows = await list(projectId);
    expect(rows[0]).toMatchObject({ id: started.id, status: 'pending', version: null, isCurrent: false });
    expect(rows[1]).toMatchObject({ version: 1, isCurrent: true }); // the old version is still current meanwhile

    await processPendingCompilation(); // the worker finishes regardless of any browser
    rows = await list(projectId);
    expect(rows[0]).toMatchObject({ id: started.id, status: 'completed', version: 2, isCurrent: true });
  });

  it('refuses to start a compilation while another is waiting or running', async () => {
    const { projectId, scenes } = await makeProject();
    const first = await compile(projectId, allNew(scenes), false);
    const second = await compile(projectId, allNew(scenes), false);
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/already in progress/);

    await db.update(schema.videoCompilations).set({ status: 'processing' }).where(eq(schema.videoCompilations.id, first.id!));
    expect((await compile(projectId, allNew(scenes), false)).status).toBe(409);
    expect(await list(projectId)).toHaveLength(1);
  });

  it('two requests at the same moment produce exactly one compilation', async () => {
    const { projectId, scenes } = await makeProject();
    const results = await Promise.all([0, 1, 2].map(() => startCompilation(postReq({ scenes: allNew(scenes) }), ctx(projectId))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await list(projectId)).toHaveLength(1);
  });

  it('the database itself refuses a second waiting/running compilation for a project', async () => {
    const { projectId } = await makeProject();
    const now = Date.now();
    await db.insert(schema.videoCompilations).values({ videoProjectId: projectId, status: 'pending', createdAt: now, updatedAt: now });
    await expect(db.insert(schema.videoCompilations).values({ videoProjectId: projectId, status: 'processing', createdAt: now, updatedAt: now })).rejects.toThrow();
    // finished and failed ones are unlimited
    await db.insert(schema.videoCompilations).values([{ videoProjectId: projectId, status: 'failed', createdAt: now, updatedAt: now }, { videoProjectId: projectId, status: 'failed', createdAt: now, updatedAt: now }]);
  });

  it('different projects can compile at the same time', async () => {
    const a = await makeProject();
    const b = await makeProject();
    expect((await compile(a.projectId, allNew(a.scenes), false)).status).toBe(201);
    expect((await compile(b.projectId, allNew(b.scenes), false)).status).toBe(201);
  });

  it('version numbers stay unique and gap-free even if completions raced (stress of the backstop; the one-active index is dropped for this test only)', async () => {
    const { projectId } = await makeProject();
    const now = Date.now();
    await pg.exec('drop index uq_vc_one_active_per_project');
    try {
      const rows = await db.insert(schema.videoCompilations).values([1, 2, 3, 4, 5].map((i) => ({ videoProjectId: projectId, status: 'processing', createdAt: now + i, updatedAt: now }))).returning();
      const versions = await Promise.all(rows.map((r) => markCompleted(projectId, r.id, `p/${r.id}.mp4`, 'useapi')));
      expect([...versions].sort()).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await pg.exec('truncate video_compilations restart identity cascade');
      await pg.exec(`create unique index uq_vc_one_active_per_project on video_compilations (video_project_id) where status in ('pending', 'processing')`);
    }
  });

  it('numbers earlier completed compilations that have no version yet before taking the next one', async () => {
    const { projectId } = await makeProject();
    const now = Date.now();
    const old = await db.insert(schema.videoCompilations).values([
      { videoProjectId: projectId, status: 'completed', outputStoragePath: 'a.mp4', createdAt: now - 20, updatedAt: now },
      { videoProjectId: projectId, status: 'completed', outputStoragePath: 'b.mp4', createdAt: now - 10, updatedAt: now },
    ]).returning();
    const [fresh] = await db.insert(schema.videoCompilations).values({ videoProjectId: projectId, status: 'processing', createdAt: now, updatedAt: now }).returning();
    expect(await markCompleted(projectId, fresh.id, 'c.mp4', 'ffmpeg')).toBe(3);
    const rows = await list(projectId);
    expect(rows.map((r) => [r.id, r.version])).toEqual([[fresh.id, 3], [old[1].id, 2], [old[0].id, 1]]);
  });
});

describe('worker crash and restart', () => {
  it('startup recovery marks an interrupted compilation failed (not re-queued), leaving pending jobs and earlier versions alone', async () => {
    const a = await makeProject();
    const b = await makeProject();
    const first = await compile(a.projectId, allNew(a.scenes));
    const interrupted = await compile(a.projectId, allNew(a.scenes), false);
    await db.update(schema.videoCompilations).set({ status: 'processing', claimedAt: Date.now() }).where(eq(schema.videoCompilations.id, interrupted.id!));
    const waiting = await compile(b.projectId, allNew(b.scenes), false); // another project's pending job

    expect(await recoverStaleCompilations()).toBe(1);

    const rowsA = await list(a.projectId);
    expect(rowsA.find((r) => r.id === interrupted.id)).toMatchObject({ status: 'failed', version: null, isCurrent: false, errorMessage: INTERRUPTED_COMPILATION_MESSAGE });
    expect(rowsA.find((r) => r.id === first.id)).toMatchObject({ status: 'completed', version: 1, isCurrent: true });
    expect((await list(b.projectId))[0]).toMatchObject({ id: waiting.id, status: 'pending' });
  });

  it('the project can be compiled again right after recovery, and the interrupted attempt used no version number', async () => {
    const { projectId, scenes } = await makeProject();
    const first = await compile(projectId, allNew(scenes));
    const stuck = await compile(projectId, allNew(scenes), false);
    await db.update(schema.videoCompilations).set({ status: 'processing', claimedAt: Date.now() }).where(eq(schema.videoCompilations.id, stuck.id!));
    expect((await compile(projectId, allNew(scenes), false)).status).toBe(409); // blocked while the dead job is still "processing"

    await recoverStaleCompilations();
    const again = await compile(projectId, allNew(scenes));
    expect(again.status).toBe(201);
    const rows = await list(projectId);
    expect(rows.filter((r) => r.status === 'completed').map((r) => r.version)).toEqual([2, 1]);
    expect(rows.find((r) => r.id === first.id)?.isCurrent).toBe(false);
    expect(rows.find((r) => r.id === again.id)?.isCurrent).toBe(true);
  });

  it('a crash after the file was uploaded but before completion leaves an unreferenced file, no version, and a clean retry', async () => {
    const { projectId, scenes } = await makeProject();
    const job = await compile(projectId, allNew(scenes), false);
    await db.update(schema.videoCompilations).set({ status: 'processing', claimedAt: Date.now() }).where(eq(schema.videoCompilations.id, job.id!));
    holder.files.set(`compilations/${projectId}/orphan.mp4`, Buffer.from('finished but never recorded')); // uploaded, then the worker died

    await recoverStaleCompilations();
    const retry = await compile(projectId, allNew(scenes));
    const rows = await list(projectId);
    expect(rows.find((r) => r.id === job.id)).toMatchObject({ status: 'failed', version: null, outputStoragePath: null });
    expect(rows.find((r) => r.id === retry.id)).toMatchObject({ status: 'completed', version: 1 });
    expect(rows.every((r) => r.outputStoragePath !== `compilations/${projectId}/orphan.mp4`)).toBe(true);
  });

  it('a job that was recovered while its old run was still finishing cannot complete or overwrite the row', async () => {
    const { projectId, scenes } = await makeProject();
    const job = await compile(projectId, allNew(scenes), false);
    holder.onPut = async () => { holder.onPut = null; await recoverStaleCompilations(); }; // restart happens just as the upload finishes
    await processPendingCompilation();
    const row = (await list(projectId))[0];
    expect(row).toMatchObject({ id: job.id, status: 'failed', version: null, errorMessage: INTERRUPTED_COMPILATION_MESSAGE });
  });

  it('markCompleted refuses a compilation that is not running, without using a version number', async () => {
    const { projectId } = await makeProject();
    const now = Date.now();
    const [failed] = await db.insert(schema.videoCompilations).values({ videoProjectId: projectId, status: 'failed', createdAt: now, updatedAt: now }).returning();
    await expect(markCompleted(projectId, failed.id, 'x.mp4', 'ffmpeg')).rejects.toThrow(/no longer running/);
    const [ok] = await db.insert(schema.videoCompilations).values({ videoProjectId: projectId, status: 'processing', createdAt: now, updatedAt: now }).returning();
    expect(await markCompleted(projectId, ok.id, 'y.mp4', 'ffmpeg')).toBe(1);
  });
});


describe('completion guard: a finished or failed job can never be overwritten', () => {
  const rowOf = async (id: number) => (await db.select().from(schema.videoCompilations).where(eq(schema.videoCompilations.id, id)))[0];

  it('markCompleted cannot overwrite a job that is already completed: path, method, version, status and timestamps stay exactly as they were', async () => {
    const { projectId, scenes } = await makeProject();
    const done = await compile(projectId, allNew(scenes));
    const before = await rowOf(done.id!);
    expect(before).toMatchObject({ status: 'completed', version: 1, method: 'useapi' });

    await expect(markCompleted(projectId, done.id!, 'compilations/other.mp4', 'ffmpeg')).rejects.toThrow(/no longer running/);
    expect(await rowOf(done.id!)).toEqual(before); // every column identical, including updatedAt
  });

  it('markCompleted cannot overwrite a failed job either, and the failed row keeps its error and has no version', async () => {
    const { projectId, scenes } = await makeProject();
    holder.concatenateFails = true;
    const failed = await compile(projectId, allNew(scenes));
    const before = await rowOf(failed.id!);
    expect(before).toMatchObject({ status: 'failed', version: null, outputStoragePath: null });

    await expect(markCompleted(projectId, failed.id!, 'compilations/x.mp4', 'useapi')).rejects.toThrow(/no longer running/);
    expect(await rowOf(failed.id!)).toEqual(before);
  });

  it('failed, rejected and interrupted attempts never consume a version number', async () => {
    const { projectId, scenes } = await makeProject();
    const v1 = await compile(projectId, allNew(scenes));                                   // Version 1
    holder.concatenateFails = true;
    const failed = await compile(projectId, allNew(scenes));                               // a failed attempt
    holder.concatenateFails = false;
    const stuck = await compile(projectId, allNew(scenes), false);                         // an interrupted attempt
    await db.update(schema.videoCompilations).set({ status: 'processing', claimedAt: Date.now() }).where(eq(schema.videoCompilations.id, stuck.id!));
    await recoverStaleCompilations();
    for (const id of [v1.id!, failed.id!, stuck.id!]) {                                    // three rejected completions
      await expect(markCompleted(projectId, id, 'compilations/nope.mp4', 'useapi')).rejects.toThrow(/no longer running/);
    }
    const next = await compile(projectId, allNew(scenes));
    const rows = await list(projectId);
    expect(rows.find((r) => r.id === next.id)).toMatchObject({ status: 'completed', version: 2 });   // 2, not 5
    expect(rows.filter((r) => r.status === 'completed').map((r) => r.version).sort()).toEqual([1, 2]);
    expect(rows.filter((r) => r.status === 'failed').every((r) => r.version === null)).toBe(true);
  });

  it('a rejected completion rolls back everything, including the numbering of older unnumbered completed rows', async () => {
    const { projectId } = await makeProject();
    const now = Date.now();
    const [old] = await db.insert(schema.videoCompilations).values({ videoProjectId: projectId, status: 'completed', outputStoragePath: 'old.mp4', createdAt: now - 10, updatedAt: now }).returning();
    const [failed] = await db.insert(schema.videoCompilations).values({ videoProjectId: projectId, status: 'failed', createdAt: now, updatedAt: now }).returning();
    await expect(markCompleted(projectId, failed.id, 'x.mp4', 'ffmpeg')).rejects.toThrow();
    expect((await rowOf(old.id)).version).toBeNull(); // untouched: the whole transaction was rolled back
  });

  it('an old run that FAILS after startup recovery cannot overwrite the recovery message or the row', async () => {
    const { projectId, scenes } = await makeProject();
    const job = await compile(projectId, allNew(scenes), false);
    holder.onConcatenate = async () => { holder.onConcatenate = null; await recoverStaleCompilations(); holder.concatenateFails = true; };
    await processPendingCompilation();
    expect(await rowOf(job.id!)).toMatchObject({ status: 'failed', version: null, errorMessage: INTERRUPTED_COMPILATION_MESSAGE, outputStoragePath: null });
  });
});


describe('memory measurement does not change what a compilation does', () => {
  const outcome = async () => {
    const { projectId, scenes } = await makeProject();
    const done = await compile(projectId, allLegacy(scenes));
    const ok = (await list(projectId))[0];
    holder.concatenateFails = true;
    await compile(projectId, allNew(scenes));
    holder.concatenateFails = false;
    const bad = (await list(projectId))[0];
    return { done: done.status, ok: { status: ok.status, version: ok.version, method: ok.method, isCurrent: ok.isCurrent }, bad: { status: bad.status, version: bad.version } };
  };
  const field = (line: string, key: string) => new RegExp(`${key}=(\\S+)`).exec(line)?.[1];

  it('logs before and after readings for a completed job and a failed one, with the lifetime and the isolated peak', async () => {
    resetLifetimeCountersForTests();                                           // a freshly started worker process
    const kernel = new FakeKernel();
    useCgroupIoForTests(kernel.io());
    holder.onFfmpeg = () => { kernel.use(260 * MIB); kernel.use(125 * MIB); };   // the FFmpeg join pushes memory up, then it falls back
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await outcome();
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[memory] compilation'));
    vi.restoreAllMocks();
    expect(lines).toHaveLength(2);

    const [completed, failed] = lines;
    expect(completed).toContain('completed:');
    expect(field(completed, 'lifetime')).toBe(WORKER_LIFETIME.id);
    expect(field(completed, 'job_n')).toBe('1');
    expect(field(completed, 'before_current_mib')).toBe('110');
    expect(field(completed, 'before_peak_mib')).toBe('110');
    expect(field(completed, 'after_current_mib')).toBe('125');
    expect(field(completed, 'after_peak_mib')).toBe('260');
    expect(field(completed, 'run_peak_mib')).toBe('260');
    expect(field(completed, 'basis')).toBe('new-record');

    // The failed job (useapi path, so no FFmpeg): memory did not rise, so the earlier record is only an upper bound
    // unless a proven reset isolates it. Either way the readings chain on from the previous run.
    expect(failed).toContain('failed:');
    expect(field(failed, 'job_n')).toBe('2');
    expect(field(failed, 'before_peak_mib')).toBe(field(completed, 'after_peak_mib'));
    expect(field(failed, 'before_current_mib')).toBe(field(completed, 'after_current_mib'));
    expect(['reset', 'upper-bound']).toContain(field(failed, 'basis'));
  });

  it('gives exactly the same results with a healthy kernel, no cgroup files at all, or a kernel that throws on every read', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useCgroupIoForTests({ read: () => null, openPeak: () => ({ error: 'ENOENT' }) });
    const unavailable = await outcome();
    await pg.exec('truncate video_projects restart identity cascade');
    const kernel = new FakeKernel();
    useCgroupIoForTests(kernel.io());
    holder.onFfmpeg = () => { kernel.use(300 * MIB); };
    const healthy = await outcome();
    await pg.exec('truncate video_projects restart identity cascade');
    holder.onFfmpeg = null;
    useCgroupIoForTests({ read: () => { throw new Error('cgroup read exploded'); }, openPeak: () => { throw new Error('cgroup open exploded'); } });
    const broken = await outcome();
    vi.restoreAllMocks();
    expect(healthy).toEqual(unavailable);
    expect(broken).toEqual(unavailable);
    expect(unavailable.ok).toMatchObject({ status: 'completed', version: 1, method: 'ffmpeg', isCurrent: true });
    expect(unavailable.bad).toMatchObject({ status: 'failed', version: null });
  });

  it('names the new worker lifetime when it marks interrupted compilations failed, so that run is explicit', async () => {
    const { projectId, scenes } = await makeProject();
    const stuck = await compile(projectId, allNew(scenes), false);
    await db.update(schema.videoCompilations).set({ status: 'processing', claimedAt: Date.now() }).where(eq(schema.videoCompilations.id, stuck.id!));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await recoverStaleCompilations();
    const line = String(warn.mock.calls[0][0]);
    vi.restoreAllMocks();
    expect(line).toContain(`${stuck.id}`);
    expect(line).toContain(`lifetime ${WORKER_LIFETIME.id}`);
    expect(line).toMatch(/not comparable/);
  });
});

describe('legacy clips (no media ID)', () => {
  it('compiles legacy clips from their stored files with FFmpeg and makes no useapi.net call', async () => {
    const { projectId, scenes } = await makeProject();
    const r = await compile(projectId, allLegacy(scenes));
    expect(r.status).toBe(201);
    const row = (await list(projectId))[0];
    expect(row).toMatchObject({ status: 'completed', version: 1, isCurrent: true, method: 'ffmpeg' });
    expect(holder.fetchCalls.filter((u) => u.includes('useapi.net'))).toEqual([]);
    expect(holder.ffmpegInputs[0]).toEqual(['L1', 'L2', 'L3']); // scene order
    expect(holder.files.get(row.outputStoragePath!)!.toString()).toBe('ffmpeg-joined:L1+L2+L3');
  });

  it('mixed newer and legacy clips are joined together (FFmpeg for the whole set), in scene order', async () => {
    const { projectId, scenes } = await makeProject();
    await compile(projectId, mixed(scenes));
    const row = (await list(projectId))[0];
    expect(row).toMatchObject({ status: 'completed', method: 'ffmpeg' });
    expect(holder.ffmpegInputs[0]).toEqual(['N1', 'L2', 'N3']);
    expect(holder.fetchCalls.filter((u) => u.includes('useapi.net'))).toEqual([]);
  });

  it('all-newer clips still use the useapi.net concatenate endpoint, exactly once', async () => {
    const { projectId, scenes } = await makeProject();
    await compile(projectId, allNew(scenes));
    expect((await list(projectId))[0].method).toBe('useapi');
    expect(holder.fetchCalls.filter((u) => u.includes('/videos/concatenate'))).toHaveLength(1);
    expect(holder.ffmpegInputs).toEqual([]);
  });

  it('a legacy clip whose stored file is missing fails that compilation with a clear message, spending nothing', async () => {
    const { projectId, scenes } = await makeProject();
    const sel = allLegacy(scenes);
    // The API accepts it (the file existed), then the file record disappears before the worker runs.
    await compile(projectId, sel, false);
    await db.update(schema.videoGenerations).set({ videoStoragePath: null }).where(eq(schema.videoGenerations.id, sel[1].videoGenerationId));
    await processPendingCompilation();
    const row = (await list(projectId))[0];
    expect(row).toMatchObject({ status: 'failed', version: null });
    expect(row.errorMessage).toMatch(/Scene 2 clip has no stored video file/);
    expect(holder.fetchCalls.filter((u) => u.includes('useapi.net'))).toEqual([]);
  });

  it('an FFmpeg failure fails only that compilation and keeps the earlier version', async () => {
    const { projectId, scenes } = await makeProject();
    const first = await compile(projectId, allNew(scenes));
    holder.failFfmpeg = true;
    await compile(projectId, allLegacy(scenes));
    const rows = await list(projectId);
    expect(rows[0]).toMatchObject({ status: 'failed', version: null });
    expect(rows.find((r) => r.id === first.id)).toMatchObject({ status: 'completed', isCurrent: true });
  });

  it('never changes the clips themselves', async () => {
    const { projectId, scenes } = await makeProject();
    const before = JSON.stringify(await db.select().from(schema.videoGenerations).orderBy(schema.videoGenerations.id));
    const files = JSON.stringify([...holder.files.entries()].map(([k, v]) => [k, v.toString()]));
    await compile(projectId, mixed(scenes));
    expect(JSON.stringify(await db.select().from(schema.videoGenerations).orderBy(schema.videoGenerations.id))).toBe(before);
    for (const [k, v] of JSON.parse(files) as [string, string][]) expect(holder.files.get(k)!.toString()).toBe(v);
  });
});

describe('starting a compilation: validation', () => {
  it('needs at least 2 scenes, each scene once, and clips that are ready', async () => {
    const { projectId, scenes } = await makeProject();
    expect((await compile(projectId, allNew(scenes).slice(0, 1), false)).status).toBe(422);
    expect((await compile(projectId, [allNew(scenes)[0], allNew(scenes)[0]], false)).status).toBe(422);
    await db.update(schema.videoGenerations).set({ status: 'processing' }).where(eq(schema.videoGenerations.id, allNew(scenes)[2].videoGenerationId));
    const notReady = await compile(projectId, allNew(scenes), false);
    expect(notReady.status).toBe(422);
    expect(notReady.json.error).toMatch(/Scene 3 is not ready|Scene 3.*not ready/);
    expect(await list(projectId)).toHaveLength(0);
  });

  it('refuses a clip that has neither a stored file nor a media ID, before any job is created', async () => {
    const { projectId, scenes } = await makeProject();
    const sel = allLegacy(scenes);
    await db.update(schema.videoGenerations).set({ videoStoragePath: null }).where(eq(schema.videoGenerations.id, sel[1].videoGenerationId));
    expect((await compile(projectId, sel, false)).status).toBe(422);
    expect(await list(projectId)).toHaveLength(0);
  });

  it('rejects a clip that belongs to another project', async () => {
    const a = await makeProject();
    const b = await makeProject();
    const res = await compile(a.projectId, [allNew(a.scenes)[0], allNew(b.scenes)[1]], false);
    expect(res.status).toBe(422);
  });

  it('refuses signed-out callers', async () => {
    const { projectId, scenes } = await makeProject();
    holder.userId = null;
    expect((await startCompilation(postReq({ scenes: allNew(scenes) }), ctx(projectId))).status).toBe(401);
  });
});

describe('previous versions stay playable and downloadable', () => {
  it('every successful version can still be played and downloaded after later versions are made', async () => {
    const { projectId, scenes } = await makeProject();
    const ids: number[] = [];
    for (const sel of [allNew(scenes), mixed(scenes), allLegacy(scenes)]) ids.push((await compile(projectId, sel)).id!);

    for (const [i, cid] of ids.entries()) {
      const video = await getVideo(getReq(), ctxC(projectId, cid));
      expect(video.status).toBe(200);
      expect((await video.json() as { signedUrl: string }).signedUrl).toMatch(/^https:\/\/storage\.test\/compilations\//);
      const dl = await getDownload(getReq(), ctxC(projectId, cid));
      expect(dl.status).toBe(200);
      const text = Buffer.from(await (dl as Response).arrayBuffer()).toString();
      expect(text).toMatch(i === 0 ? /^useapi-joined:/ : /^ffmpeg-joined:/);
    }
  });

  it('a compilation that is still running has no video to play or download yet', async () => {
    const { projectId, scenes } = await makeProject();
    const pending = await compile(projectId, allNew(scenes), false);
    expect((await getVideo(getReq(), ctxC(projectId, pending.id!))).status).toBe(404);
    expect((await getDownload(getReq(), ctxC(projectId, pending.id!))).status).toBe(404);
  });
});

describe('migration 0024 on existing data', () => {
  it('numbers existing completed compilations per project, leaves failed ones unnumbered, deletes nothing, and can be re-run', async () => {
    const old = new PGlite();
    try {
      await migrate(old, '0023');
      const q = (sqlText: string) => old.query<Record<string, unknown>>(sqlText);
      await q(`insert into video_projects (id, user_id, name, base_image_path, original_script, created_at, updated_at) values (1,'${ALICE}','a','p','s',1,1),(2,'${ALICE}','b','p','s',1,1)`);
      await q(`insert into video_compilations (id, video_project_id, status, output_storage_path, error_message, created_at, updated_at) values
        (1,1,'failed',null,'missing media ID',100,100),
        (2,1,'completed','compilations/1/a.mp4',null,200,200),
        (3,1,'completed','compilations/1/b.mp4',null,300,300),
        (4,2,'completed','compilations/2/a.mp4',null,150,150)`);
      const before = (await q('select id, status, output_storage_path, error_message, created_at from video_compilations order by id')).rows;

      const sqlText = fs.readFileSync(path.join(ROOT, 'drizzle/pg/0024_compilation_versions.sql'), 'utf8');
      await old.exec(sqlText);
      await old.exec(sqlText); // idempotent

      const after = (await q('select id, status, output_storage_path, error_message, created_at, version, method from video_compilations order by id')).rows;
      expect(after).toHaveLength(4);
      expect(after.map((r) => ({ id: r.id, status: r.status, output_storage_path: r.output_storage_path, error_message: r.error_message, created_at: r.created_at })))
        .toEqual(before.map((r) => ({ id: r.id, status: r.status, output_storage_path: r.output_storage_path, error_message: r.error_message, created_at: r.created_at })));
      expect(after.map((r) => [r.id, r.version])).toEqual([[1, null], [2, 1], [3, 2], [4, 1]]);
      expect(after.every((r) => r.method === null)).toBe(true); // unknown, not guessed
      await expect(q(`insert into video_compilations (video_project_id, status, version, created_at, updated_at) values (1,'completed',2,1,1)`)).rejects.toThrow(); // version already used
    } finally {
      await old.close();
    }
  });
});
