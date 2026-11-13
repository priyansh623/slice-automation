/**
 * The video workflow is manual: prompts are generated, the user reviews them, and only a user's click on Generate Video
 * (or Generate all scenes) queues video generation and spends provider credits. Run against a real in-memory Postgres
 * built from the repository's migrations; the database handle, auth, storage, the Claude/provider calls and the worker
 * lock are replaced. Route code, queue helpers and the worker's queue processing are real.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema.pg';

const holder = vi.hoisted(() => {
  // The worker module loads .env.local when imported. These values win (dotenv never overrides), so nothing here
  // could ever reach a real database or service.
  process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none';
  process.env.DATABASE_DIRECT_URL = 'postgresql://nobody@127.0.0.1:1/none';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'not-a-real-key';
  process.env.USEAPI_TOKEN = 'not-a-real-token';
  process.env.ANTHROPIC_API_KEY = 'not-a-real-key';
  process.env.MOCK_USEAPI = 'true';
  return {
    db: undefined as unknown,
    userId: null as string | null,
    promptsGenerated: [] as number[],
    briefsExtracted: [] as number[],
    queuedSubmitted: [] as number[],
    manualSubmitted: [] as { projectId: number; screenId: number; promptVersionId: number }[],
  };
});

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
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ storage: { from: () => ({}) } }) }));
vi.mock('@/worker/lock', () => ({ acquireLock: async () => true, releaseLock: async () => undefined, closeLockConnection: async () => undefined }));
vi.mock('@/services/video-workflow', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/video-workflow')>();
  const { db } = await import('@/db');
  const schemaModule = await import('@/db/schema.pg');
  const { eq: equals } = await import('drizzle-orm');
  return {
    ...real,
    // Claude and the video provider are stubbed; everything else in the module (the queue helpers) is real.
    generateInitialScreenPrompt: async (projectId: number, screenId: number) => {
      holder.promptsGenerated.push(screenId);
      await db.insert(schemaModule.screenPromptVersions).values({ videoScreenId: screenId, version: 1, promptText: 'generated prompt', source: 'claude', createdAt: Date.now() });
      void projectId;
    },
    extractAndStoreCreativeBrief: async (projectId: number) => {
      holder.briefsExtracted.push(projectId);
      await db.update(schemaModule.videoProjects).set({ creativeBrief: '{"voiceIdentity":"calm"}' }).where(equals(schemaModule.videoProjects.id, projectId));
    },
    submitQueuedGeneration: async (generationId: number) => {
      holder.queuedSubmitted.push(generationId);
      await db.update(schemaModule.videoGenerations).set({ status: 'processing' }).where(equals(schemaModule.videoGenerations.id, generationId));
    },
    submitVideoGeneration: async (projectId: number, screenId: number, promptVersionId: number) => {
      holder.manualSubmitted.push({ projectId, screenId, promptVersionId });
      const now = Date.now();
      const [g] = await db.insert(schemaModule.videoGenerations).values({ videoScreenId: screenId, promptVersionId, status: 'pending', createdAt: now, updatedAt: now }).returning();
      return { generationId: g.id };
    },
  };
});

import { processPromptTasks, processQueuedGenerations } from '@/worker/index';
import { POST as generateVideo } from '@/app/api/v1/video-projects/[id]/screens/[n]/generate/route';
import { POST as approveGeneration } from '@/app/api/v1/video-projects/[id]/screens/[n]/approve/route';
import { POST as generateAll } from '@/app/api/v1/video-projects/[id]/generate-all/route';
import { POST as generateAllPrompts } from '@/app/api/v1/video-projects/[id]/generate-all-prompts/route';

const USER = '00000000-0000-4000-8000-0000000000b1';
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
  await run('drizzle/0009_broll_categories.sql');
  for (const f of migrations.filter((m) => m >= '0022')) await run(`drizzle/pg/${f}`);
}, 120_000);

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  holder.userId = USER;
  holder.promptsGenerated = [];
  holder.briefsExtracted = [];
  holder.queuedSubmitted = [];
  holder.manualSubmitted = [];
  await pg.exec('truncate prompt_generation_tasks, video_generations, screen_prompt_versions, video_screens, video_projects restart identity cascade');
});

const ctx = (id: number, n: number) => ({ params: Promise.resolve({ id: String(id), n: String(n) }) });
const ctxProject = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const post = (payload?: unknown) => new NextRequest('http://localhost/api/x', payload === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
const generationCount = async () => (await db.select().from(schema.videoGenerations)).length;

async function makeProject(screenCount = 3) {
  const now = Date.now();
  const [p] = await db.insert(schema.videoProjects).values({ userId: USER, name: 'p', baseImagePath: `${USER}/00000000-0000-4000-8000-000000000001.png`, originalScript: 'script', createdAt: now, updatedAt: now }).returning();
  const screens = [];
  for (let i = 1; i <= screenCount; i++) {
    const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: p.id, screenNumber: i, dialogue: `line ${i}`, position: i, createdAt: now, updatedAt: now }).returning();
    screens.push(s);
  }
  return { project: p, screens };
}
async function addPrompt(screenId: number, version = 1) {
  const [v] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: screenId, version, promptText: 'p', source: 'claude', createdAt: Date.now() }).returning();
  return v;
}
async function addGeneration(screenId: number, promptVersionId: number, status = 'completed') {
  const now = Date.now();
  const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: screenId, promptVersionId, status, createdAt: now, updatedAt: now }).returning();
  return g;
}
async function drainPromptTasks(ticks = 6) { for (let i = 0; i < ticks; i++) await processPromptTasks(); }

describe('generating prompts never queues a video', () => {
  it('a finished generate_prompt task leaves no generation and the worker submits nothing', async () => {
    const { project, screens } = await makeProject(2);
    await db.insert(schema.promptGenerationTasks).values({ videoProjectId: project.id, videoScreenId: screens[1].id, taskType: 'generate_prompt', status: 'pending', createdAt: 1, updatedAt: 1 });

    await processPromptTasks();

    expect(holder.promptsGenerated).toEqual([screens[1].id]);
    expect((await db.select().from(schema.screenPromptVersions)).length).toBe(1); // the prompt exists for review
    expect((await db.select().from(schema.promptGenerationTasks))[0].status).toBe('completed');
    expect(await generationCount()).toBe(0); // no video was queued
    await processQueuedGenerations();
    expect(holder.queuedSubmitted).toEqual([]); // and nothing is sent to the provider
  });

  it('approving screen 1 queues brief extraction and prompts for the other screens, but no videos', async () => {
    const { project, screens } = await makeProject(3);
    const pv = await addPrompt(screens[0].id);
    const gen = await addGeneration(screens[0].id, pv.id);

    const res = await approveGeneration(post({ generationId: gen.id }), ctx(project.id, 1));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approvedGenerationId: gen.id, tasksQueued: 3 });

    await drainPromptTasks();
    expect(holder.briefsExtracted).toEqual([project.id]);
    expect(holder.promptsGenerated.sort()).toEqual([screens[1].id, screens[2].id]);
    expect((await db.select().from(schema.promptGenerationTasks)).every((t) => t.status === 'completed')).toBe(true);
    expect(await generationCount()).toBe(1); // only the generation the user had already made
    await processQueuedGenerations();
    expect(holder.queuedSubmitted).toEqual([]);
  });

  it('"Generate all prompts" creates prompts only', async () => {
    const { project, screens } = await makeProject(3);
    const pv = await addPrompt(screens[0].id);
    const gen = await addGeneration(screens[0].id, pv.id);
    await db.update(schema.videoScreens).set({ approvedGenerationId: gen.id }).where(eq(schema.videoScreens.id, screens[0].id));
    await db.update(schema.videoProjects).set({ creativeBrief: '{"voiceIdentity":"calm"}' }).where(eq(schema.videoProjects.id, project.id));

    const res = await generateAllPrompts(post(), ctxProject(project.id));
    expect(res.status).toBeLessThan(300);
    await drainPromptTasks();
    expect(holder.promptsGenerated.length).toBeGreaterThan(0);
    expect(await generationCount()).toBe(1);
    await processQueuedGenerations();
    expect(holder.queuedSubmitted).toEqual([]);
  });
});

describe('a click on Generate Video queues video generation', () => {
  it('submits the chosen prompt for that screen', async () => {
    const { project, screens } = await makeProject(2);
    const pv = await addPrompt(screens[1].id);
    const res = await generateVideo(post({ promptVersionId: pv.id }), ctx(project.id, 2));
    expect(res.status).toBe(201);
    expect(holder.manualSubmitted).toEqual([{ projectId: project.id, screenId: screens[1].id, promptVersionId: pv.id }]);
    expect(await generationCount()).toBe(1);
  });

  it('refuses a stale prompt and a missing prompt without submitting anything', async () => {
    const { project, screens } = await makeProject(1);
    const pv = await addPrompt(screens[0].id);
    await db.update(schema.screenPromptVersions).set({ isStale: true }).where(eq(schema.screenPromptVersions.id, pv.id));
    expect((await generateVideo(post({ promptVersionId: pv.id }), ctx(project.id, 1))).status).toBe(422);
    expect((await generateVideo(post({}), ctx(project.id, 1))).status).toBe(400);
    expect(holder.manualSubmitted).toEqual([]);
    expect(await generationCount()).toBe(0);
  });

  it('requires a signed-in user', async () => {
    const { project, screens } = await makeProject(1);
    const pv = await addPrompt(screens[0].id);
    holder.userId = null;
    expect((await generateVideo(post({ promptVersionId: pv.id }), ctx(project.id, 1))).status).toBe(401);
    expect(holder.manualSubmitted).toEqual([]);
  });

  it('"Generate all scenes" queues videos for screens that have prompts, and the worker then submits exactly those', async () => {
    const { project, screens } = await makeProject(3);
    const pv1 = await addPrompt(screens[0].id);
    const gen1 = await addGeneration(screens[0].id, pv1.id);
    await db.update(schema.videoScreens).set({ approvedGenerationId: gen1.id }).where(eq(schema.videoScreens.id, screens[0].id));
    await db.update(schema.videoProjects).set({ creativeBrief: '{"voiceIdentity":"calm"}' }).where(eq(schema.videoProjects.id, project.id));
    const pv2 = await addPrompt(screens[1].id); // screen 2 has a prompt; screen 3 does not

    const res = await generateAll(post(), ctxProject(project.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number; promptsQueued: number };
    expect(body).toMatchObject({ enqueued: 1, promptsQueued: 1 });

    const queued = (await db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.status, 'queued')));
    expect(queued.map((g) => [g.videoScreenId, g.promptVersionId])).toEqual([[screens[1].id, pv2.id]]);

    await processQueuedGenerations();
    expect(holder.queuedSubmitted).toEqual([queued[0].id]);

    // The prompt generated for screen 3 afterwards waits for the user: no video is queued for it.
    await drainPromptTasks();
    expect(holder.promptsGenerated).toContain(screens[2].id);
    const forScreen3 = await db.select().from(schema.videoGenerations).where(inArray(schema.videoGenerations.videoScreenId, [screens[2].id]));
    expect(forScreen3).toEqual([]);
    await processQueuedGenerations();
    expect(holder.queuedSubmitted).toEqual([queued[0].id]);
  });
});

describe('existing approval behaviour', () => {
  it('approving a later screen only records the approval', async () => {
    const { project, screens } = await makeProject(2);
    const pv = await addPrompt(screens[1].id);
    const gen = await addGeneration(screens[1].id, pv.id);
    const res = await approveGeneration(post({ generationId: gen.id }), ctx(project.id, 2));
    expect(await res.json()).toMatchObject({ approvedGenerationId: gen.id, tasksQueued: 0 });
    expect((await db.select().from(schema.promptGenerationTasks)).length).toBe(0);
    expect((await db.select().from(schema.videoScreens).where(eq(schema.videoScreens.id, screens[1].id)))[0].approvedGenerationId).toBe(gen.id);
  });

  it('rejects approving a generation that belongs to another screen', async () => {
    const { project, screens } = await makeProject(2);
    const pv = await addPrompt(screens[0].id);
    const gen = await addGeneration(screens[0].id, pv.id);
    expect((await approveGeneration(post({ generationId: gen.id }), ctx(project.id, 2))).status).toBe(404);
  });
});
