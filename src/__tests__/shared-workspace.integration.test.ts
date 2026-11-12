/**
 * Equal-access tests for the whole application, against a real in-memory Postgres built from the repository's
 * migrations. Only the database handle, Supabase auth and Supabase storage are replaced; route code is real.
 *
 * There are no roles and no per-user data: every signed-in user sees the same projects and can use every
 * endpoint on any project. Signed-out callers are refused everywhere.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema.pg';

const holder = vi.hoisted(() => ({ db: undefined as unknown, userId: null as string | null }));

vi.mock('@/db', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const real = holder.db as Record<string | symbol, unknown>;
      const v = real[prop];
      return typeof v === 'function' ? v.bind(real) : v;
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId, email: `${holder.userId}@example.com` } : null } }) },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: { from: () => ({
      createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/signed' } }),
      createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: 'https://example.test/signed' })) }),
    }) },
    auth: { admin: { listUsers: async () => ({ data: { users: [] } }) } },
  }),
}));

import { GET as listProjects } from '@/app/api/v1/video-projects/route';
import { GET as getProject, DELETE as deleteProject } from '@/app/api/v1/video-projects/[id]/route';
import { GET as getBrief, PUT as putBrief } from '@/app/api/v1/video-projects/[id]/brief/route';
import { PUT as putBreakdown } from '@/app/api/v1/video-projects/[id]/breakdown/route';
import { POST as addTester } from '@/app/api/v1/video-projects/[id]/testers/route';
import { GET as getCompilations } from '@/app/api/v1/video-projects/[id]/compilations/route';
import { POST as postFeedback } from '@/app/api/v1/generation-feedback/route';
import { POST as postAnalytics } from '@/app/api/v1/analytics-events/route';
import { GET as getFeedbackList, POST as postBrollFeedback } from '@/app/api/v1/broll/feedback/route';
import { GET as adminDashboard } from '@/app/api/v1/admin/dashboard/route';
import { GET as getSettings, PUT as putSettings } from '@/app/api/v1/admin/settings/route';
import { GET as adminFeedback } from '@/app/api/v1/admin/feedback/route';
import { GET as adminCredits } from '@/app/api/v1/admin/credits/route';
import { GET as connectionTest } from '@/app/api/v1/admin/connection-test/route';
import { POST as archiveProject, DELETE as unarchiveProject } from '@/app/api/v1/admin/projects/[id]/archive/route';
import { POST as createCategory } from '@/app/api/v1/broll/categories/route';
import { PATCH as patchCategory, DELETE as deleteCategory } from '@/app/api/v1/broll/categories/[catId]/route';

const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-0000000000b0';
const ROOT = path.resolve(__dirname, '../..');

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  holder.db = db;
  await pg.exec(`create schema auth; create function auth.uid() returns uuid language sql as 'select null::uuid'; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const migrations = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00(0[1-9]|1[0-9]|2[0-2])_.*\.sql$/.test(f) && !f.includes('verification')).sort();
  const run = (file: string) => pg.exec(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  for (const f of migrations.filter((m) => m < '0022')) await run(`drizzle/pg/${f}`);
  await run('drizzle/0009_broll_categories.sql'); // the category taxonomy lives outside drizzle/pg
  for (const f of migrations.filter((m) => m >= '0022')) await run(`drizzle/pg/${f}`);
}, 120_000);

afterAll(async () => { await pg.close(); });

beforeEach(() => { holder.userId = ALICE; });

const as = (id: string | null) => { holder.userId = id; };
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const req = (method = 'GET', payload?: unknown) => new NextRequest('http://localhost/api/x', payload === undefined ? { method } : { method, body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });

async function makeProject(owner: string, name: string): Promise<{ projectId: number; screenId: number; generationId: number }> {
  const now = Date.now();
  const [p] = await db.insert(schema.videoProjects).values({ userId: owner, name, baseImagePath: `${owner}/img.png`, originalScript: 'Hello', createdAt: now, updatedAt: now }).returning();
  const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: p.id, screenNumber: 1, dialogue: 'Hi', position: 1, createdAt: now, updatedAt: now }).returning();
  const [v] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: s.id, version: 1, promptText: 'p', source: 'manual', createdAt: now }).returning();
  const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: s.id, promptVersionId: v.id, status: 'completed', createdAt: now, updatedAt: now }).returning();
  return { projectId: p.id, screenId: s.id, generationId: g.id };
}

describe('projects are one shared workspace', () => {
  it('lists every project to every user, whoever created it', async () => {
    const a = await makeProject(ALICE, 'Alice project');
    const b = await makeProject(BOB, 'Bob project');
    for (const who of [ALICE, BOB]) {
      as(who);
      const ids = ((await (await listProjects()).json()) as { id: number }[]).map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining([a.projectId, b.projectId]));
    }
  });

  it('lets every user open, edit the brief of, and add testers to a project they did not create', async () => {
    const { projectId } = await makeProject(ALICE, 'Shared');
    as(BOB);
    expect((await getProject(req(), ctx(projectId))).status).toBe(200);
    expect((await getBrief(req(), ctx(projectId))).status).toBe(200);
    expect((await putBrief(req('PUT', { voiceIdentity: 'calm' }), ctx(projectId))).status).toBe(200);
    expect((await addTester(req('POST', { userId: ALICE }), ctx(projectId))).status).toBe(201);
    expect((await getCompilations(req(), ctx(projectId))).status).toBe(200);
    as(ALICE);
    expect(await (await getBrief(req(), ctx(projectId))).json()).toMatchObject({ voiceIdentity: 'calm' }); // Bob's change is visible to Alice
  });

  it('lets a user who did not create the project change its breakdown', async () => {
    const { projectId } = await makeProject(ALICE, 'Shared');
    as(BOB);
    const res = await putBreakdown(req('PUT', { screens: [{ screenNumber: 1, dialogue: 'Hi there' }] }), ctx(projectId));
    expect([200, 409]).toContain(res.status);
  });

  it('lets every user give feedback on any generation and records each user separately', async () => {
    const { generationId } = await makeProject(ALICE, 'Shared');
    as(BOB);
    expect((await postFeedback(req('POST', { videoGenerationId: generationId, overallQuality: 4 }))).status).toBe(201);
    as(ALICE);
    expect((await postFeedback(req('POST', { videoGenerationId: generationId, overallQuality: 5 }))).status).toBe(201);
    const rows = await db.select().from(schema.generationFeedback);
    expect(rows.filter((r) => r.videoGenerationId === generationId).map((r) => r.userId).sort()).toEqual([ALICE, BOB].sort());
  });

  it('accepts analytics events scoped to a project created by someone else', async () => {
    const { projectId } = await makeProject(ALICE, 'Shared');
    as(BOB);
    expect((await postAnalytics(req('POST', { eventType: 'viewed', videoProjectId: projectId }))).status).toBe(201);
  });

  it('lets any user delete any project', async () => {
    const { projectId } = await makeProject(ALICE, 'To delete');
    as(BOB);
    expect((await deleteProject(req('DELETE'), ctx(projectId))).status).toBe(200);
    expect((await getProject(req(), ctx(projectId))).status).toBe(404);
  });

  it('answers 404 for an unknown project, never 403', async () => {
    as(BOB);
    expect((await getProject(req(), ctx(99999))).status).toBe(404);
    expect((await deleteProject(req('DELETE'), ctx(99999))).status).toBe(404);
    expect((await addTester(req('POST', { userId: ALICE }), ctx(99999))).status).toBe(404);
  });
});

describe('settings, dashboard and management endpoints are open to every signed-in user', () => {
  it('serves the former admin endpoints to two ordinary users alike', async () => {
    await makeProject(ALICE, 'Dash');
    for (const who of [ALICE, BOB]) {
      as(who);
      expect((await adminDashboard(req())).status).toBe(200);
      expect((await getSettings()).status).toBe(200);
      expect((await adminFeedback(req())).status).toBe(200);
      expect((await adminCredits()).status).toBe(200);
      expect((await connectionTest()).status).not.toBe(401);
      expect((await connectionTest()).status).not.toBe(403);
    }
  });

  it('lets any user change settings, and the change is the same for everyone', async () => {
    as(BOB);
    expect((await putSettings(req('PUT', { scene1HookInstruction: 'Open with a question', compilationCrf: 20 }))).status).toBe(200);
    as(ALICE);
    expect(await (await getSettings()).json()).toMatchObject({ scene1HookInstruction: 'Open with a question', compilationCrf: 20 });
  });

  it('lets any user archive and unarchive any project', async () => {
    const { projectId } = await makeProject(ALICE, 'Archive me');
    as(BOB);
    expect((await archiveProject(req('POST'), ctx(projectId))).status).toBe(200);
    expect((await unarchiveProject(req('DELETE'), ctx(projectId))).status).toBe(200);
  });

  it('lets any user manage B-roll categories', async () => {
    as(BOB);
    const created = await createCategory(req('POST', { name: 'Shared category' }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    as(ALICE);
    expect((await patchCategory(req('PATCH', { name: 'Renamed' }), { params: Promise.resolve({ catId: String(id) }) })).status).toBe(200);
    expect((await deleteCategory(req('DELETE'), { params: Promise.resolve({ catId: String(id) }) })).status).toBe(204);
  });

  it('shows B-roll feedback to every user, whoever wrote it', async () => {
    as(ALICE);
    expect((await postBrollFeedback(req('POST', { text: 'Need more cafe footage', nextAction: 'Film it' }))).status).toBe(201);
    as(BOB);
    const rows = (await (await getFeedbackList()).json()) as { text: string }[];
    expect(rows.map((r) => r.text)).toContain('Need more cafe footage');
  });
});

describe('signed-out callers are refused everywhere', () => {
  it('answers 401 on every endpoint', async () => {
    const { projectId, generationId } = await makeProject(ALICE, 'Private to the public');
    as(null);
    const calls: [string, () => Promise<Response>][] = [
      ['projects list', () => listProjects()],
      ['project get', () => getProject(req(), ctx(projectId))],
      ['project delete', () => deleteProject(req('DELETE'), ctx(projectId))],
      ['brief get', () => getBrief(req(), ctx(projectId))],
      ['brief put', () => putBrief(req('PUT', {}), ctx(projectId))],
      ['breakdown', () => putBreakdown(req('PUT', { screens: [] }), ctx(projectId))],
      ['testers', () => addTester(req('POST', { userId: BOB }), ctx(projectId))],
      ['compilations', () => getCompilations(req(), ctx(projectId))],
      ['feedback', () => postFeedback(req('POST', { videoGenerationId: generationId }))],
      ['analytics', () => postAnalytics(req('POST', { eventType: 'x' }))],
      ['dashboard', () => adminDashboard(req())],
      ['settings get', () => getSettings()],
      ['settings put', () => putSettings(req('PUT', {}))],
      ['admin feedback', () => adminFeedback(req())],
      ['credits', () => adminCredits()],
      ['connection test', () => connectionTest()],
      ['archive', () => archiveProject(req('POST'), ctx(projectId))],
      ['category create', () => createCategory(req('POST', { name: 'x' }))],
      ['broll feedback list', () => getFeedbackList()],
    ];
    for (const [label, call] of calls) expect((await call()).status, label).toBe(401);
  });
});

describe('the role system is gone', () => {
  it('has no admin-management or role-check endpoints or page', () => {
    for (const f of ['src/app/api/v1/admin/users/route.ts', 'src/app/api/v1/admin/users/[userId]/route.ts', 'src/app/api/v1/admin/me/route.ts', 'src/app/admin/users/page.tsx']) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(false);
    }
  });

  it('keeps the dashboard, settings and other former admin pages', () => {
    for (const f of ['src/app/admin/dashboard/page.tsx', 'src/app/admin/settings/page.tsx']) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
    }
  });

  it('no application code refers to admin roles, ADMIN_USER_IDS or the admin_users table', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(e.name) || full.endsWith(path.join('db', 'schema.pg.ts'))) continue;
        if (/isAdmin|requireAdmin|ADMIN_USER_IDS|adminUsers|admin_users|app_metadata/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
