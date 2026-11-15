/**
 * Adding and deleting scenes, and compile eligibility, against a real in-memory Postgres built from the repository's
 * migrations. The real routes and services run; only the database handle, Supabase auth, storage and the model call are
 * replaced. No video is requested and nothing is deleted from storage.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import * as schema from '@/db/schema.pg';

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: '00000000-0000-4000-8000-00000000a11c' as string | null,
  messages: [] as string[],
  failClaude: false,
  storageCalls: [] as string[],
}));

vi.mock('@/db', () => ({
  db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }),
}));
vi.mock('@/lib/object-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/object-store')>()),
  getStorage: () => new Proxy({}, {
    get: (_t, prop) => async () => {
      holder.storageCalls.push(String(prop));
      return prop === 'signedReadUrl' ? null : undefined;
    },
  }),
}));
vi.mock('@/lib/object-store/registry', () => ({ locate: async () => new Map() }));
vi.mock('@/services/anthropic', () => ({
  callClaude: vi.fn(async (_p: number, message: string) => {
    holder.messages.push(message);
    if (holder.failClaude) throw new Error('model down');
    return '**Scene prompt**\n\n**Character**\nA young man.\n\n**Dialogue**\nnone\n\n**Audio**\nAmbient only.';
  }),
  encodeImageFromStorage: vi.fn(async () => ({ base64: 'eA==', mimeType: 'image/png' })),
  loadConversation: vi.fn(async () => []),
}));

import { POST as addScene } from '@/app/api/v1/video-projects/[id]/screens/route';
import { DELETE as deleteSceneRoute } from '@/app/api/v1/video-projects/[id]/screens/[n]/route';
import { GET as getProject } from '@/app/api/v1/video-projects/[id]/route';
import { POST as startCompilation } from '@/app/api/v1/video-projects/[id]/compilations/route';
import { PUT as putBreakdown } from '@/app/api/v1/video-projects/[id]/breakdown/route';
import { POST as approveScene } from '@/app/api/v1/video-projects/[id]/screens/[n]/approve/route';
import { GET as listDeletedRoute } from '@/app/api/v1/video-projects/[id]/screens/route';
import { POST as restoreRoute } from '@/app/api/v1/video-projects/[id]/screens/restore/route';
import { POST as retryCreation } from '@/app/api/v1/video-projects/[id]/screens/retry/route';
import { POST as generateAll } from '@/app/api/v1/video-projects/[id]/generate-all/route';
import { PUT as putPrompt, POST as postPrompt } from '@/app/api/v1/video-projects/[id]/screens/[n]/prompt/route';
import { createSceneRow, ADD_SCENE_LEASE_MS, originalNumberOf, deletedMarker } from '@/services/scene-management';
import { summarizeApproval } from '@/lib/scene-approval';

const ROOT = path.resolve(__dirname, '../..');
const ALICE = '00000000-0000-4000-8000-00000000a11c';
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

async function migrate(target: PGlite): Promise<void> {
  await target.exec(`create schema if not exists auth; create or replace function auth.uid() returns uuid language sql as 'select null::uuid'; create or replace function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const files = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification')).sort();
  for (const f of files.filter((m) => m < '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
  await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
  for (const f of files.filter((m) => m >= '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  holder.db = db;
  await migrate(pg);
}, 120_000);
afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  holder.userId = ALICE;
  holder.messages = [];
  holder.failClaude = false;
  holder.storageCalls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await pg.exec('truncate video_projects restart identity cascade');
});

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const ctxN = (id: number, n: number) => ({ params: Promise.resolve({ id: String(id), n: String(n) }) });
const json = (body: unknown, method = 'POST') => new NextRequest('http://localhost/api', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function makeProject(n = 3, opts: { approved?: boolean } = {}) {
  const now = Date.now();
  const [p] = await db.insert(schema.videoProjects).values({ userId: ALICE, name: 'P', baseImagePath: 'x/y.png', originalScript: 'script', createdAt: now, updatedAt: now }).returning();
  const screens: { id: number; gen: number }[] = [];
  for (let i = 1; i <= n; i++) {
    const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: p.id, screenNumber: i, dialogue: `line ${i}`, position: i, createdAt: now, updatedAt: now }).returning();
    const [v] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: s.id, version: 1, promptText: `prompt ${i}`, source: 'claude', createdAt: now }).returning();
    const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: s.id, promptVersionId: v.id, status: 'completed', videoStoragePath: `screen-${s.id}/c.mp4`, mediaGenerationId: `m${s.id}`, createdAt: now, updatedAt: now }).returning();
    if (opts.approved !== false) await db.update(schema.videoScreens).set({ approvedGenerationId: g.id }).where(eq(schema.videoScreens.id, s.id));
    screens.push({ id: s.id, gen: g.id });
  }
  return { projectId: p.id, screens };
}

async function sequence(projectId: number) {
  const rows = await db.select().from(schema.videoScreens).where(eq(schema.videoScreens.videoProjectId, projectId)).orderBy(asc(schema.videoScreens.position));
  return rows.filter((r) => r.screenNumber > 0);
}
async function apiScreens(projectId: number) {
  const res = await getProject(new NextRequest('http://localhost/api'), ctx(projectId));
  return ((await res.json()) as { screens: { id: number; screenNumber: number; approvedGenerationId: number | null }[] }).screens;
}
let attempt = 0;
// Every attempt carries a retry key, as the form does; a test that wants to repeat an attempt passes its own.
const add = (projectId: number, body: Record<string, unknown>) => addScene(json({ requestId: `attempt-${++attempt}-key`, ...body }), ctx(projectId));
const del = (projectId: number, n: number, screenId: number) => deleteSceneRoute(new NextRequest(`http://localhost/api?screenId=${screenId}`, { method: 'DELETE' }), ctxN(projectId, n));
async function expectConsistent(projectId: number) {
  const seq = await sequence(projectId);
  expect(seq.map((s) => s.screenNumber)).toEqual(seq.map((_, i) => i + 1));
  const positions = seq.map((s) => s.position);
  expect(new Set(positions).size).toBe(positions.length);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
}

describe('compile eligibility (the existing approval rule, shared)', () => {
  const s = (n: number, approved: boolean) => ({ screenNumber: n, approvedGenerationId: approved ? n * 10 : null });
  it('is enabled only when every scene is approved', () => {
    expect(summarizeApproval([s(1, true), s(2, true)])).toMatchObject({ eligible: true, reason: null, total: 2, approved: 2 });
  });
  it('is disabled with the count of scenes still needing approval', () => {
    expect(summarizeApproval([s(1, true), s(2, false), s(3, false)])).toMatchObject({ eligible: false, reason: '2 scenes still need approval.', unapprovedScreenNumbers: [2, 3] });
    expect(summarizeApproval([s(1, true), s(2, false)]).reason).toBe('1 scene still needs approval (Scene 2).');
  });
  it('is disabled with no scenes, and ignores deleted scenes', () => {
    expect(summarizeApproval([]).eligible).toBe(false);
    expect(summarizeApproval([s(1, true), { screenNumber: -5, approvedGenerationId: null }])).toMatchObject({ eligible: true, total: 1 });
  });
});

describe('adding a scene', () => {
  it('adds at the end, writes the prompt from the dialogue, and does not approve it', async () => {
    const { projectId } = await makeProject(2);
    const res = await add(projectId, { dialogue: 'Zero joining fee, zero hidden charges.' });
    expect(res.status).toBe(201);
    const body = await res.json() as { screen: { screenNumber: number }; promptText: string; version: number };
    expect(body.screen.screenNumber).toBe(3);
    expect(body.version).toBe(1);

    const msg = holder.messages[0];
    expect(msg).toContain('Scene 3 dialogue: "Zero joining fee, zero hidden charges."');
    expect(msg).toContain('Preserve the original dialogue exactly.');
    expect(msg).toContain('script'); // the project's script is part of the context

    const seq = await sequence(projectId);
    expect(seq).toHaveLength(3);
    expect(seq[2].dialogue).toBe('Zero joining fee, zero hidden charges.');
    expect(seq[2].approvedGenerationId).toBeNull();
    const versions = await db.select().from(schema.screenPromptVersions).where(eq(schema.screenPromptVersions.videoScreenId, seq[2].id));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ source: 'claude' });
    expect(await db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.videoScreenId, seq[2].id))).toHaveLength(0); // no video requested
    await expectConsistent(projectId);
  });

  it('writes the prompt exactly the way "Write prompt" does for any other scene', async () => {
    const a = await makeProject(2);
    await add(a.projectId, { dialogue: 'Get yours today.' });
    const viaAdd = holder.messages[0];

    holder.messages = [];
    const b = await makeProject(2);
    const now = Date.now();
    await db.insert(schema.videoScreens).values({ videoProjectId: b.projectId, screenNumber: 3, dialogue: 'Get yours today.', position: 3, createdAt: now, updatedAt: now });
    expect((await postPrompt(json({}), ctxN(b.projectId, 3))).status).toBe(200);
    expect(holder.messages[0]).toBe(viaAdd);
  });

  it('adding to a project with no scenes writes Scene 1 the way Scene 1 is normally written', async () => {
    const { projectId } = await makeProject(1);
    await del(projectId, 1, (await sequence(projectId))[0].id);
    expect((await add(projectId, { dialogue: 'Welcome in.' })).status).toBe(201);
    expect(holder.messages[0]).toContain('Script for Scene 1: "Welcome in."');
  });

  it('inserts between scenes, renumbering the later ones and keeping their approvals and history', async () => {
    const { projectId, screens } = await makeProject(3);
    const res = await add(projectId, { dialogue: 'Inserted', afterScreenId: screens[0].id });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { screen: { screenNumber: number } }).screen.screenNumber).toBe(2);

    const seq = await sequence(projectId);
    expect(seq.map((s) => s.screenNumber)).toEqual([1, 2, 3, 4]);
    expect(seq[0].id).toBe(screens[0].id);
    expect(seq[2].id).toBe(screens[1].id);
    expect(seq[3].id).toBe(screens[2].id);
    expect(seq[2].approvedGenerationId).toBe(screens[1].gen);
    expect(seq[1].approvedGenerationId).toBeNull();
    await expectConsistent(projectId);
    expect((await db.select().from(schema.videoGenerations)).length).toBe(3); // nothing created or removed
  });

  it('requires dialogue, and rejects an unknown insert position without changing anything', async () => {
    const { projectId } = await makeProject(2);
    expect((await add(projectId, { dialogue: '   ' })).status).toBe(400);
    expect((await add(projectId, {})).status).toBe(400);
    expect((await add(projectId, { dialogue: 'x', afterScreenId: 999999 })).status).toBe(409);
    expect((await add(projectId, { dialogue: 'x', afterScreenId: 'a' })).status).toBe(400);
    expect(await sequence(projectId)).toHaveLength(2);
    expect(holder.messages).toHaveLength(0);
  });

  it('keeps the scene, marked failed with the typed text saved, when the prompt cannot be written', async () => {
    const { projectId, screens } = await makeProject(3);
    holder.failClaude = true;
    const res = await add(projectId, { dialogue: 'Say this', afterScreenId: screens[0].id });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe('prompt_failed');
    // visible in the sequence, numbering intact, and described as failed with its brief
    const seq = await sequence(projectId);
    expect(seq).toHaveLength(4);
    await expectConsistent(projectId);
    const api = await apiScreensFull(projectId);
    expect(api[1]).toMatchObject({ screenNumber: 2, creationState: 'failed', hasPrompt: false, creationBrief: { dialogue: 'Say this' } });
  });

  it('requires a signed-in user', async () => {
    const { projectId } = await makeProject(1);
    holder.userId = null;
    expect((await add(projectId, { dialogue: 'x' })).status).toBe(401);
  });

  it('a manually added scene behaves like a normal one: it is edited, approved and compiled', async () => {
    const { projectId, screens } = await makeProject(2);
    await add(projectId, { dialogue: 'Extra scene' });
    const seq = await sequence(projectId);
    const extra = seq[2];

    // Compile is not possible while the new scene is unapproved: the list the page held is out of date
    const stale = await startCompilation(json({ scenes: screens.map((s) => ({ videoScreenId: s.id, videoGenerationId: s.gen })), knownSceneIds: screens.map((s) => s.id) }), ctx(projectId));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('scenes_changed');

    // Give it a finished video and approve it through the normal route
    const [v] = await db.select().from(schema.screenPromptVersions).where(eq(schema.screenPromptVersions.videoScreenId, extra.id));
    const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: extra.id, promptVersionId: v.id, status: 'completed', videoStoragePath: 'screen-x/c.mp4', mediaGenerationId: 'mx', createdAt: Date.now(), updatedAt: Date.now() }).returning();
    expect((await approveScene(json({ generationId: g.id }), ctxN(projectId, 3))).status).toBe(200);
    expect(summarizeApproval(await apiScreens(projectId)).eligible).toBe(true);

    const all = [...screens.map((s) => ({ videoScreenId: s.id, videoGenerationId: s.gen })), { videoScreenId: extra.id, videoGenerationId: g.id }];
    const ok = await startCompilation(json({ scenes: all }), ctx(projectId));
    expect(ok.status).toBe(201);
    const sel = await db.select().from(schema.compilationSceneSelections);
    expect(sel.map((x) => x.videoScreenId).sort()).toEqual([...screens.map((s) => s.id), extra.id].sort());
  });
});

describe('deleting a scene', () => {
  it('removes it from the sequence and renumbers, keeping every prompt, video and approval', async () => {
    const { projectId, screens } = await makeProject(4);
    const before = { versions: (await db.select().from(schema.screenPromptVersions)).length, gens: (await db.select().from(schema.videoGenerations)).length };
    const res = await del(projectId, 2, screens[1].id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deletedScreenNumber: 2, remaining: 3, keptGenerations: 1 });

    const seq = await sequence(projectId);
    expect(seq.map((s) => s.id)).toEqual([screens[0].id, screens[2].id, screens[3].id]);
    expect(seq.map((s) => s.screenNumber)).toEqual([1, 2, 3]);
    expect(seq.map((s) => s.approvedGenerationId)).toEqual([screens[0].gen, screens[2].gen, screens[3].gen]);
    await expectConsistent(projectId);

    // Nothing was deleted: the row, its prompt version and its video are all still there, and storage was never called
    const hidden = (await db.select().from(schema.videoScreens).where(eq(schema.videoScreens.id, screens[1].id)))[0];
    expect(hidden.screenNumber).toBeLessThan(0);
    expect((await db.select().from(schema.screenPromptVersions)).length).toBe(before.versions);
    expect((await db.select().from(schema.videoGenerations)).length).toBe(before.gens);
    expect(holder.storageCalls.filter((c) => c === 'delete')).toEqual([]);

    // The page data (and so a refresh) no longer includes it
    expect((await apiScreens(projectId)).map((s) => s.screenNumber)).toEqual([1, 2, 3]);
  });

  it('updates compile eligibility: deleting the only unapproved scene makes the project compilable', async () => {
    const { projectId, screens } = await makeProject(3);
    await db.update(schema.videoScreens).set({ approvedGenerationId: null }).where(eq(schema.videoScreens.id, screens[1].id));
    expect(summarizeApproval(await apiScreens(projectId)).eligible).toBe(false);
    await del(projectId, 2, screens[1].id);
    expect(summarizeApproval(await apiScreens(projectId))).toMatchObject({ eligible: true, total: 2 });
  });

  it('compiles the updated sequence, and refuses a list that still contains the deleted scene', async () => {
    const { projectId, screens } = await makeProject(3);
    await del(projectId, 2, screens[1].id);
    const old = await startCompilation(json({ scenes: screens.map((s) => ({ videoScreenId: s.id, videoGenerationId: s.gen })) }), ctx(projectId));
    expect(old.status).toBe(409);
    expect(await db.select().from(schema.videoCompilations)).toHaveLength(0);

    const fresh = [screens[0], screens[2]].map((s) => ({ videoScreenId: s.id, videoGenerationId: s.gen }));
    expect((await startCompilation(json({ scenes: fresh }), ctx(projectId))).status).toBe(201);
    expect((await db.select().from(schema.compilationSceneSelections)).map((x) => x.videoScreenId).sort()).toEqual([screens[0].id, screens[2].id].sort());
  });

  it('is blocked while the scene is generating, while a compilation runs, and with out-of-date numbers', async () => {
    const { projectId, screens } = await makeProject(3);
    const [v] = await db.select().from(schema.screenPromptVersions).where(eq(schema.screenPromptVersions.videoScreenId, screens[1].id));
    const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: screens[1].id, promptVersionId: v.id, status: 'processing', createdAt: Date.now(), updatedAt: Date.now() }).returning();
    const generating = await del(projectId, 2, screens[1].id);
    expect(generating.status).toBe(409);
    expect(((await generating.json()) as { code: string }).code).toBe('generation_running');
    await db.update(schema.videoGenerations).set({ status: 'completed' }).where(eq(schema.videoGenerations.id, g.id));

    const now = Date.now();
    const [c] = await db.insert(schema.videoCompilations).values({ videoProjectId: projectId, status: 'processing', createdAt: now, updatedAt: now }).returning();
    const compiling = await del(projectId, 2, screens[1].id);
    expect(compiling.status).toBe(409);
    expect(((await compiling.json()) as { code: string }).code).toBe('compilation_running');
    await db.update(schema.videoCompilations).set({ status: 'completed' }).where(eq(schema.videoCompilations.id, c.id));

    // The page thinks the scene is number 3, but the id says otherwise: the wrong scene is never deleted
    const stale = await del(projectId, 3, screens[1].id);
    expect(stale.status).toBe(409);
    expect(await sequence(projectId)).toHaveLength(3);
    expect((await del(projectId, 2, screens[1].id)).status).toBe(200);
  });

  it('can delete the only scene, and a scene added afterwards becomes Scene 1', async () => {
    const { projectId, screens } = await makeProject(1);
    expect((await del(projectId, 1, screens[0].id)).status).toBe(200);
    expect(await apiScreens(projectId)).toEqual([]);
    expect(summarizeApproval([]).eligible).toBe(false);

    const res = await add(projectId, { dialogue: 'A fresh start' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { screen: { screenNumber: number } }).screen.screenNumber).toBe(1);
    await expectConsistent(projectId);
    expect(holder.messages[0]).toContain('This is my character'); // Scene 1 is written like a first scene
  });

  it('deleting an unknown or already deleted scene is a 404 and changes nothing', async () => {
    const { projectId, screens } = await makeProject(3);
    await del(projectId, 3, screens[2].id);
    expect((await del(projectId, 3, screens[2].id)).status).toBe(404);
    expect((await del(projectId, 1, 999999)).status).toBe(404);
    expect(await sequence(projectId)).toHaveLength(2);
    await expectConsistent(projectId);
  });

  it('a scene from another project cannot be deleted through this one', async () => {
    const a = await makeProject(2);
    const b = await makeProject(2);
    expect((await del(a.projectId, 1, b.screens[0].id)).status).toBe(404);
    expect(await sequence(b.projectId)).toHaveLength(2);
  });
});

describe('rapid and repeated changes', () => {
  it('many simultaneous adds never produce a gap or a duplicate number', async () => {
    const { projectId } = await makeProject(2);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => add(projectId, { dialogue: `scene ${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await sequence(projectId)).toHaveLength(8);
    await expectConsistent(projectId);
  });

  it('simultaneous adds and deletes leave the sequence consistent; a delete made with a stale number is refused, never misdirected', async () => {
    const { projectId, screens } = await makeProject(5);
    const results = await Promise.all([
      del(projectId, 2, screens[1].id), del(projectId, 4, screens[3].id),
      add(projectId, { dialogue: 'a', afterScreenId: screens[0].id }), add(projectId, { dialogue: 'b' }),
    ]);
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 201 || s === 409)).toBe(true);
    const deleted = statuses.slice(0, 2).filter((s) => s === 200).length;
    await expectConsistent(projectId);
    expect((await sequence(projectId)).length).toBe(5 - deleted + 2);
    // A refused delete deleted nothing: the scenes that were not deleted are all still in the sequence
    const alive = new Set((await sequence(projectId)).map((s) => s.id));
    results.slice(0, 2).forEach((r, i) => { if (r.status === 409) expect(alive.has(screens[i === 0 ? 1 : 3].id)).toBe(true); });
  });

  it('add then delete then add keeps numbering contiguous after every step and across a reload', async () => {
    const { projectId, screens } = await makeProject(3);
    await add(projectId, { dialogue: 'x', afterScreenId: screens[0].id });
    await expectConsistent(projectId);
    await del(projectId, 3, screens[1].id);
    await expectConsistent(projectId);
    await add(projectId, { dialogue: 'y' });
    await expectConsistent(projectId);
    const a = await apiScreens(projectId);
    const b = await apiScreens(projectId);
    expect(a).toEqual(b);
    expect(a.map((s) => s.screenNumber)).toEqual([1, 2, 3, 4]);
  });
});

describe('interaction with the breakdown editor', () => {
  it('a deleted scene is not treated as removed or blocked by the breakdown save', async () => {
    const { projectId, screens } = await makeProject(3);
    await del(projectId, 2, screens[1].id);
    const res = await putBreakdown(json({ screens: [{ screenNumber: 1, dialogue: 'line 1' }, { screenNumber: 2, dialogue: 'line 3' }] }, 'PUT'), ctx(projectId));
    expect(res.status).toBe(200);
    expect(await db.select().from(schema.videoScreens).where(eq(schema.videoScreens.id, screens[1].id))).toHaveLength(1);
    expect((await sequence(projectId)).map((s) => s.id)).toEqual([screens[0].id, screens[2].id]);
  });

  it('changing the dialogue of an approved scene clears its approval, so compile needs it approved again', async () => {
    const { projectId, screens } = await makeProject(2);
    await putBreakdown(json({ screens: [{ screenNumber: 1, dialogue: 'line 1' }, { screenNumber: 2, dialogue: 'a different line' }] }, 'PUT'), ctx(projectId));
    const seq = await sequence(projectId);
    expect(seq[0].approvedGenerationId).toBe(screens[0].gen);
    expect(seq[1].approvedGenerationId).toBeNull();
    const summary = summarizeApproval(await apiScreens(projectId));
    expect(summary).toMatchObject({ eligible: false, unapprovedScreenNumbers: [2] });
  });
});

const putBreak = (projectId: number, screens: unknown[]) => putBreakdown(json({ screens }, 'PUT'), ctx(projectId));
async function apiScreensFull(projectId: number) {
  const res = await getProject(new NextRequest('http://localhost/api'), ctx(projectId));
  return ((await res.json()) as { screens: Record<string, unknown>[] }).screens;
}
const retryRoute = (projectId: number, screenId: number) => retryCreation(json({ screenId }), ctx(projectId));
// Pretends the request that was writing this scene's prompt was cut off long ago.
async function ageCreation(screenId: number) {
  const rows = await db.select().from(schema.analyticsEvents).where(eq(schema.analyticsEvents.eventType, 'scene_creation'));
  const row = rows.find((r) => (r.payload as { screenId: number }).screenId === screenId)!;
  await db.update(schema.analyticsEvents).set({ payload: { ...(row.payload as object), at: Date.now() - ADD_SCENE_LEASE_MS - 1000 } }).where(eq(schema.analyticsEvents.id, row.id));
}
const restore = (projectId: number, screenId: number) => restoreRoute(json({ screenId }), ctx(projectId));
const approvalOf = async (projectId: number) => Object.fromEntries((await sequence(projectId)).map((r) => [r.id, r.approvedGenerationId]));

describe('approval is withdrawn by every change that alters what a scene produces', () => {
  const unchanged = (n: number) => ({ screenNumber: n, dialogue: `line ${n}`, durationSeconds: null });

  it('a manual prompt edit clears only that scene, keeps its history, and says so', async () => {
    const { projectId, screens } = await makeProject(3);
    const res = await putPrompt(json({ promptText: 'a changed prompt' }, 'PUT'), ctxN(projectId, 2));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approvalCleared: boolean }).approvalCleared).toBe(true);
    expect(await approvalOf(projectId)).toEqual({ [screens[0].id]: screens[0].gen, [screens[1].id]: null, [screens[2].id]: screens[2].gen });
    // history intact: the approved clip and the prompt it came from are still there
    expect(await db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, screens[1].gen))).toHaveLength(1);
    expect(await db.select().from(schema.screenPromptVersions).where(eq(schema.screenPromptVersions.videoScreenId, screens[1].id))).toHaveLength(2);
    expect(summarizeApproval(await apiScreens(projectId))).toMatchObject({ eligible: false, unapprovedScreenNumbers: [2] });
  });

  it('writing a revised prompt from feedback clears the approval', async () => {
    const { projectId, screens } = await makeProject(2);
    const res = await postPrompt(json({ nlFeedback: 'make him smile more' }), ctxN(projectId, 2));
    expect(res.status).toBe(200);
    expect((await approvalOf(projectId))[screens[1].id]).toBeNull();
    expect((await approvalOf(projectId))[screens[0].id]).toBe(screens[0].gen);
  });

  it('a duration change clears the approval, a dialogue change too, and a save that changes nothing keeps every approval', async () => {
    const { projectId, screens } = await makeProject(3);
    await putBreak(projectId, [unchanged(1), unchanged(2), unchanged(3)]);
    expect(await approvalOf(projectId)).toEqual({ [screens[0].id]: screens[0].gen, [screens[1].id]: screens[1].gen, [screens[2].id]: screens[2].gen });

    await putBreak(projectId, [unchanged(1), { ...unchanged(2), durationSeconds: 8 }, unchanged(3)]);
    expect(await approvalOf(projectId)).toEqual({ [screens[0].id]: screens[0].gen, [screens[1].id]: null, [screens[2].id]: screens[2].gen });
  });

  it('moving scenes (add, delete, restore) changes no scene content, so approvals stay', async () => {
    const { projectId, screens } = await makeProject(3);
    await add(projectId, { dialogue: 'Between', afterScreenId: screens[0].id });
    await del(projectId, 3, screens[1].id);
    await restore(projectId, screens[1].id);
    const approvals = await approvalOf(projectId);
    for (const sc of screens) expect(approvals[sc.id]).toBe(sc.gen);
  });

  it('a scene whose approval was withdrawn can be approved again from its existing clip', async () => {
    const { projectId, screens } = await makeProject(2);
    await putPrompt(json({ promptText: 'edited' }, 'PUT'), ctxN(projectId, 1));
    expect((await approveScene(json({ generationId: screens[0].gen }), ctxN(projectId, 1))).status).toBe(200);
    expect((await approvalOf(projectId))[screens[0].id]).toBe(screens[0].gen);
  });
});

describe('adding a scene survives timeouts, retries and refreshes', () => {
  const countScenes = async (projectId: number) => (await db.select().from(schema.videoScreens).where(eq(schema.videoScreens.videoProjectId, projectId))).length;

  it('a failed attempt keeps the scene, and the retry with the same requestId finishes that scene instead of adding another', async () => {
    const { projectId } = await makeProject(2);
    holder.failClaude = true;
    const first = await add(projectId, { dialogue: 'Hi', requestId: 'req-failure-1' });
    expect(first.status).toBe(502);
    expect(await countScenes(projectId)).toBe(3);
    holder.failClaude = false;
    const second = await add(projectId, { dialogue: 'Hi', requestId: 'req-failure-1' });
    expect(second.status).toBe(201);
    expect(await countScenes(projectId)).toBe(3);
  });

  it('a request cut off by the time limit leaves a visible, unapprovable scene, and the retry takes that same scene over', async () => {
    const { projectId } = await makeProject(2);
    // Simulate the cut-off: the scene row exists (the prompt step never finished).
    const created = await createSceneRow(projectId, { dialogue: 'Hello there', requestId: 'req-timeout-01', userId: ALICE });
    expect(created.state).toBe('created');
    expect((await sequence(projectId)).map((s) => s.screenNumber)).toEqual([1, 2, 3]);
    // ...it can never be approved: it has no video
    expect((await approveScene(json({ generationId: 999999 }), ctxN(projectId, 3))).status).toBe(404);
    expect(summarizeApproval(await apiScreens(projectId)).eligible).toBe(false);

    // A retry right away is told to wait: the first request may still be running
    const tooSoon = await add(projectId, { dialogue: 'My scene', requestId: 'req-timeout-01' });
    expect(tooSoon.status).toBe(409);
    expect(((await tooSoon.json()) as { code: string }).code).toBe('in_progress');
    expect(await countScenes(projectId)).toBe(3);

    // After the lease has passed the earlier request is dead: the retry finishes the same scene
    await ageCreation(created.screen.id);
    const retry = await add(projectId, { dialogue: 'Typed later', requestId: 'req-timeout-01' });
    expect(retry.status).toBe(201);
    expect(await countScenes(projectId)).toBe(3);
    const finished = (await sequence(projectId))[2];
    expect(finished.id).toBe(created.screen.id);
    expect(finished.dialogue).toBe('Typed later');
    expect(finished.approvedGenerationId).toBeNull();
    expect(await db.select().from(schema.screenPromptVersions).where(eq(schema.screenPromptVersions.videoScreenId, finished.id))).toHaveLength(1);
  });

  it('repeating a request whose answer was lost returns the same scene without writing a second prompt', async () => {
    const { projectId } = await makeProject(2);
    const first = await add(projectId, { dialogue: 'Once', requestId: 'req-lost-0001' });
    expect(first.status).toBe(201);
    const modelCalls = holder.messages.length;
    const again = await add(projectId, { dialogue: 'Once', requestId: 'req-lost-0001' });
    expect(again.status).toBe(200);
    const a = (await first.json()) as { screen: { id: number } };
    const b = (await again.json()) as { screen: { id: number }; alreadyCreated: boolean };
    expect(b.screen.id).toBe(a.screen.id);
    expect(b.alreadyCreated).toBe(true);
    expect(holder.messages.length).toBe(modelCalls);
    expect(await countScenes(projectId)).toBe(3);
  });

  it('duplicate submissions at the same moment create one scene', async () => {
    const { projectId } = await makeProject(2);
    const results = await Promise.all([1, 2, 3].map(() => add(projectId, { dialogue: 'Double click', requestId: 'req-double-01' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(await countScenes(projectId)).toBe(3);
    await expectConsistent(projectId);
  });

  it('different attempts (different requestIds) are different scenes', async () => {
    const { projectId } = await makeProject(1);
    await add(projectId, { dialogue: 'A', requestId: 'req-aaaaaaaa' });
    await add(projectId, { dialogue: 'B', requestId: 'req-bbbbbbbb' });
    expect(await countScenes(projectId)).toBe(3);
  });
});

describe('restoring a deleted scene', () => {
  it('puts it back at its original place with its prompts, videos and approval, and nothing duplicated or deleted', async () => {
    const { projectId, screens } = await makeProject(4);
    const before = await db.select().from(schema.videoGenerations);
    await del(projectId, 2, screens[1].id);
    expect((await sequence(projectId)).map((s) => s.id)).toEqual([screens[0].id, screens[2].id, screens[3].id]);

    const list = (await (await listDeletedRoute(new NextRequest('http://localhost/api'), ctx(projectId))).json()) as { deleted: { id: number; originalNumber: number }[] };
    expect(list.deleted).toMatchObject([{ id: screens[1].id, originalNumber: 2 }]);

    const res = await restore(projectId, screens[1].id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ screenId: screens[1].id, screenNumber: 2 });
    expect((await sequence(projectId)).map((s) => s.id)).toEqual(screens.map((s) => s.id));
    await expectConsistent(projectId);
    expect(await approvalOf(projectId)).toEqual(Object.fromEntries(screens.map((s) => [s.id, s.gen])));
    expect(await db.select().from(schema.videoGenerations)).toHaveLength(before.length);
    expect(await db.select().from(schema.videoScreens).where(eq(schema.videoScreens.videoProjectId, projectId))).toHaveLength(4);
    expect(holder.storageCalls).not.toContain('remove');
    expect(summarizeApproval(await apiScreens(projectId)).eligible).toBe(true);
    // nothing left to restore
    expect(((await (await listDeletedRoute(new NextRequest('http://localhost/api'), ctx(projectId))).json()) as { deleted: unknown[] }).deleted).toHaveLength(0);
  });

  it('restores the first and last scenes, and several deleted scenes in any order', async () => {
    const { projectId, screens } = await makeProject(4);
    await del(projectId, 4, screens[3].id);
    await del(projectId, 1, screens[0].id);
    expect((await sequence(projectId)).map((s) => s.id)).toEqual([screens[1].id, screens[2].id]);
    expect(((await restore(projectId, screens[3].id)).status)).toBe(200); // was 4, now the sequence is shorter: goes last
    expect(((await restore(projectId, screens[0].id)).status)).toBe(200); // was 1: goes first
    expect((await sequence(projectId)).map((s) => s.id)).toEqual([screens[0].id, screens[1].id, screens[2].id, screens[3].id]);
    await expectConsistent(projectId);
  });

  it('restoring updates compile eligibility and does not change a scene that was approved', async () => {
    const { projectId, screens } = await makeProject(3, { approved: true });
    // Make scene 2 unapproved, delete it: the rest is compilable
    await putPrompt(json({ promptText: 'x' }, 'PUT'), ctxN(projectId, 2));
    await del(projectId, 2, screens[1].id);
    expect(summarizeApproval(await apiScreens(projectId)).eligible).toBe(true);
    await restore(projectId, screens[1].id);
    expect(summarizeApproval(await apiScreens(projectId))).toMatchObject({ eligible: false, unapprovedScreenNumbers: [2] });
  });

  it('refuses to restore a scene that is already in the sequence, unknown scenes, and another project\'s scene', async () => {
    const a = await makeProject(2);
    const b = await makeProject(2);
    expect((await restore(a.projectId, a.screens[0].id)).status).toBe(409);
    expect((await restore(a.projectId, 9999999)).status).toBe(404);
    await del(b.projectId, 1, b.screens[0].id);
    expect((await restore(a.projectId, b.screens[0].id)).status).toBe(404);
    expect((await sequence(b.projectId)).map((s) => s.id)).toEqual([b.screens[1].id]);
  });

  it('records the original number in the marker', () => {
    expect(originalNumberOf(deletedMarker(7, 123))).toBe(7);
    expect(originalNumberOf(-55)).toBeNull();
    expect(deletedMarker(1, 5)).not.toBe(deletedMarker(2, 5));
  });
});

describe('numbering is only a display of the order, never part of a scene or its content', () => {
  it('inserting and deleting in the middle changes numbers, not prompts, videos or compilation references', async () => {
    const { projectId, screens } = await makeProject(4);
    const promptsBefore = (await db.select().from(schema.screenPromptVersions)).map((v) => [v.id, v.promptText]);
    await add(projectId, { dialogue: 'In the middle', afterScreenId: screens[1].id });
    await del(projectId, 1, screens[0].id);
    expect((await db.select().from(schema.screenPromptVersions)).filter((v) => promptsBefore.some(([id]) => id === v.id)).map((v) => [v.id, v.promptText])).toEqual(promptsBefore);

    const seq = await sequence(projectId);
    const scenes = [screens[1], screens[2], screens[3]].map((s) => ({ videoScreenId: s.id, videoGenerationId: s.gen }));
    const created = await startCompilation(json({ scenes, knownSceneIds: seq.map((s) => s.id) }), ctx(projectId));
    // the page saw all four scenes, which is still the current sequence, so this chosen subset is accepted
    expect(created.status).toBe(201);
    const sel = await db.select().from(schema.compilationSceneSelections);
    expect(sel.map((x) => x.videoScreenId).sort()).toEqual(scenes.map((x) => x.videoScreenId).sort());
  });
});

describe('compiling a chosen subset stays supported', () => {
  const all = (screens: { id: number; gen: number }[]) => screens.map((s) => ({ videoScreenId: s.id, videoGenerationId: s.gen }));

  it('accepts a subset of the scenes when the caller does not claim to be sending the whole sequence', async () => {
    const { projectId, screens } = await makeProject(4);
    const res = await startCompilation(json({ scenes: all([screens[0], screens[2]]) }), ctx(projectId));
    expect(res.status).toBe(201);
  });

  it('a page that sends the sequence it saw is refused if a scene was added or deleted since, and accepted when current', async () => {
    const { projectId, screens } = await makeProject(3);
    const ids = screens.map((s) => s.id);
    await add(projectId, { dialogue: 'Added after the page loaded' });
    const stale = await startCompilation(json({ scenes: all(screens), knownSceneIds: ids }), ctx(projectId));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('scenes_changed');
    const current = (await sequence(projectId)).map((s) => s.id);
    expect((await startCompilation(json({ scenes: all(screens), knownSceneIds: current }), ctx(projectId))).status).toBe(201);
  });

  it('a deleted scene can never be compiled, even in a subset', async () => {
    const { projectId, screens } = await makeProject(3);
    await del(projectId, 3, screens[2].id);
    expect((await startCompilation(json({ scenes: all([screens[0], screens[2]]) }), ctx(projectId))).status).toBe(409);
    expect(await db.select().from(schema.videoCompilations)).toHaveLength(0);
  });
});

describe('every added scene shows an accurate state, and an unfinished one can only be retried', () => {
  const stateOfScene = async (projectId: number, n: number) => (await apiScreensFull(projectId)).find((x) => x.screenNumber === n)?.creationState;

  it('is "generating" while the first request may still be running, and a refresh never shows it as ready', async () => {
    const { projectId } = await makeProject(2);
    await createSceneRow(projectId, { dialogue: 'Hello', requestId: 'req-state-gen1', userId: ALICE });
    for (let i = 0; i < 3; i++) expect(await stateOfScene(projectId, 3)).toBe('generating'); // every reload reads the server
    expect((await apiScreensFull(projectId))[2]).toMatchObject({ hasPrompt: false, approvedGenerationId: null });
  });

  it('becomes "interrupted" once the request is long dead, and Retry finishes the same scene from the saved text', async () => {
    const { projectId } = await makeProject(2);
    const c = await createSceneRow(projectId, { dialogue: 'Say this exactly', requestId: 'req-state-int1', userId: ALICE });
    // retrying while it may still be running is refused
    expect((await retryRoute(projectId, c.screen.id)).status).toBe(409);
    await ageCreation(c.screen.id);
    expect(await stateOfScene(projectId, 3)).toBe('interrupted');
    expect((await apiScreensFull(projectId))[2].creationBrief).toEqual({ dialogue: 'Say this exactly' });

    const res = await retryRoute(projectId, c.screen.id);
    expect(res.status).toBe(200);
    expect(await countRows(projectId)).toBe(3); // no duplicate
    expect(holder.messages.at(-1)).toContain('Say this exactly');
    expect(await stateOfScene(projectId, 3)).toBeNull();
    expect((await apiScreensFull(projectId))[2]).toMatchObject({ hasPrompt: true, approvedGenerationId: null });
    // a finished scene has nothing to retry
    expect((await retryRoute(projectId, c.screen.id)).status).toBe(409);
  });

  it('a failed Retry leaves it failed with the text intact, and the next Retry can succeed', async () => {
    const { projectId } = await makeProject(2);
    holder.failClaude = true;
    const res = await add(projectId, { dialogue: 'Keep me', requestId: 'req-state-fail1' });
    expect(res.status).toBe(502);
    const id = (await sequence(projectId))[2].id;
    expect((await retryRoute(projectId, id)).status).toBe(502);
    expect(await stateOfScene(projectId, 3)).toBe('failed');
    expect((await apiScreensFull(projectId))[2].creationBrief).toEqual({ dialogue: 'Keep me' });
    holder.failClaude = false;
    expect((await retryRoute(projectId, id)).status).toBe(200);
    expect(await stateOfScene(projectId, 3)).toBeNull();
    expect(await countRows(projectId)).toBe(3);
  });

  it('an unfinished scene cannot be approved or compiled, and does not block or change the other scenes', async () => {
    const { projectId, screens } = await makeProject(2);
    holder.failClaude = true;
    await add(projectId, { dialogue: 'x', requestId: 'req-state-gate1' });
    const unfinished = (await sequence(projectId))[2];
    expect((await approveScene(json({ generationId: 1 }), ctxN(projectId, 3))).status).toBe(404);
    expect(summarizeApproval(await apiScreens(projectId))).toMatchObject({ eligible: false, unapprovedScreenNumbers: [3] });
    // a compile that includes it cannot name a video for it; one that does not is a subset and the page-level rule stays "all approved"
    const withIt = await startCompilation(json({ scenes: [...screens.map((s) => ({ videoScreenId: s.id, videoGenerationId: s.gen })), { videoScreenId: unfinished.id, videoGenerationId: screens[0].gen }] }), ctx(projectId));
    expect(withIt.status).toBe(422);
    expect(await approvalOf(projectId)).toMatchObject({ [screens[0].id]: screens[0].gen, [screens[1].id]: screens[1].gen });
  });

  it('is not picked up by the generic prompt queue, which would write it without the creator\'s description', async () => {
    const { projectId } = await makeProject(2);
    holder.failClaude = true;
    await add(projectId, { dialogue: 'x', requestId: 'req-state-queue' });
    holder.failClaude = false;
    await generateAll(new NextRequest('http://localhost/api', { method: 'POST' }), ctx(projectId));
    expect(await db.select().from(schema.promptGenerationTasks).where(eq(schema.promptGenerationTasks.videoProjectId, projectId))).toHaveLength(0);
  });

  it('cannot be deleted while it is being written, but can once it is interrupted, failed or finished; and can be restored', async () => {
    const { projectId } = await makeProject(2);
    const c = await createSceneRow(projectId, { dialogue: 'Hello there', requestId: 'req-state-del1', userId: ALICE });
    const blocked = await del(projectId, 3, c.screen.id);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe('generation_running');
    await ageCreation(c.screen.id);
    expect((await del(projectId, 3, c.screen.id)).status).toBe(200);
    expect((await sequence(projectId))).toHaveLength(2);
    expect((await restore(projectId, c.screen.id)).status).toBe(200);
    expect(await stateOfScene(projectId, 3)).toBe('interrupted'); // still unfinished after a restore
  });

  it('breakdown scenes (no creation record) are untouched: no state, and their duration notes are never written or read by creation', async () => {
    const { projectId, screens } = await makeProject(2);
    await db.update(schema.videoScreens).set({ durationNote: '19 words at comfortable pace' }).where(eq(schema.videoScreens.id, screens[0].id));
    await add(projectId, { dialogue: 'x', requestId: 'req-state-note1' });
    const api = await apiScreensFull(projectId);
    expect(api[0]).toMatchObject({ creationState: null, durationNote: '19 words at comfortable pace' });
    expect(api[2].durationNote).toBeNull(); // the retry key is not stored on the scene
    // a breakdown save that echoes durationNote back changes nothing about creation
    await putBreak(projectId, [
      { screenNumber: 1, dialogue: 'line 1', durationNote: '19 words at comfortable pace' },
      { screenNumber: 2, dialogue: 'line 2' },
      { screenNumber: 3, dialogue: '' },
    ]);
    expect(await stateOfScene(projectId, 3)).toBeNull();
    const again = await add(projectId, { dialogue: 'x', requestId: 'req-state-note1' });
    expect(again.status).toBe(200);
    expect(await countRows(projectId)).toBe(3);
  });
});
async function countRows(projectId: number) { return (await db.select().from(schema.videoScreens).where(eq(schema.videoScreens.videoProjectId, projectId))).length; }
