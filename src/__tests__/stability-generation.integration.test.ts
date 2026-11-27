/**
 * Stabilisation: video generation jobs. A finished video is never overwritten as failed; a job is sent to the provider at most once; an uncertain
 * outcome is never re-sent; simultaneous requests make one job; one slow job does not hold up others. In-memory Postgres from the real migrations;
 * only the provider and the video store are faked (every submit is a PAID job and is counted).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema.pg';
import { migrate } from './helpers/studio-fakes';

const holder = vi.hoisted(() => ({ db: undefined as unknown, submits: [] as string[], submit: (async () => ({ jobId: 'j' })) as (p: unknown) => Promise<unknown>, poll: (async () => ({ status: 'started' })) as (id: string) => Promise<unknown>, download: (async () => ({ tempPath: '/dev/null', contentType: 'video/mp4' })) as () => Promise<unknown>, storeFails: false }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-0000000000a1' } } }) } }) }));
vi.mock('@/lib/object-store/generated-video', () => ({ storeGeneratedVideo: async (_p: string, screenId: number, genId: number) => { if (holder.storeFails) throw new Error('storage down'); return `screen-${screenId}/gen-${genId}.mp4`; } }));
vi.mock('@/providers/useapi/provider', async (orig) => ({
  ...(await orig<typeof import('@/providers/useapi/provider')>()),
  useapiProvider: {
    uploadReferenceImage: async () => ({ mediaGenerationId: 'ref' }),
    submitGeneration: (p: { correlationId: string }) => { holder.submits.push(p.correlationId); return holder.submit(p); },
    pollJob: (id: string) => holder.poll(id), downloadVideo: () => holder.download(),
  },
}));

import { submitQueuedGeneration, queueGeneration, enqueueAllSceneGenerations } from '@/services/video-workflow';
import { pollInFlightGenerations, pollOneGeneration, recoverAbandonedGenerations } from '@/services/generation-polling';
import { RULES, roundRobin, UNCONFIRMED_MESSAGE } from '@/services/job-rules';
import { processQueuedGenerations, startQueuedSubmissions } from '@/worker/index';
import { POST as generateRoute } from '@/app/api/v1/video-projects/[id]/screens/[n]/generate/route';
import { POST as approveRoute } from '@/app/api/v1/video-projects/[id]/screens/[n]/approve/route';
import { UseapiGoogleFlowProvider } from '@/providers/useapi/provider';
import { RateLimitError, UnexpectedProviderError } from '@/providers/useapi/errors';

let pg: PGlite; let db: PgliteDatabase<typeof schema>;
beforeAll(async () => { pg = new PGlite(); await migrate(pg); db = drizzle(pg, { schema }); holder.db = db; }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  holder.submits = []; holder.storeFails = false;
  holder.submit = async () => ({ jobId: `job-${holder.submits.length}`, videoUrl: 'https://v/x.mp4', mediaGenerationId: 'm' });
  holder.poll = async () => ({ status: 'started' });
  holder.download = async () => { const p = path.join(os.tmpdir(), `soma-t-${Math.random()}`); fs.writeFileSync(p, 'v'); return { tempPath: p, contentType: 'video/mp4' }; };
  await pg.exec('truncate video_projects restart identity cascade');
});

async function project(scenes = 1) {
  const now = Date.now();
  const [p] = await db.insert(schema.videoProjects).values({ userId: '00000000-0000-4000-8000-0000000000a1', name: 'p', baseImagePath: 'x.png', baseImageMediaId: 'ref', originalScript: 's', createdAt: now, updatedAt: now }).returning();
  const out: Array<{ screen: typeof schema.videoScreens.$inferSelect; pv: typeof schema.screenPromptVersions.$inferSelect }> = [];
  for (let i = 1; i <= scenes; i++) {
    const [screen] = await db.insert(schema.videoScreens).values({ videoProjectId: p.id, screenNumber: i, dialogue: `d${i}`, position: i, createdAt: now, updatedAt: now }).returning();
    const [pv] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: screen.id, version: 1, promptText: `prompt ${i}`, source: 'claude', createdAt: now }).returning();
    out.push({ screen, pv });
  }
  return { p, scenes: out };
}
type S = Awaited<ReturnType<typeof project>>['scenes'][number];
async function gen(s: S, over: Partial<typeof schema.videoGenerations.$inferInsert> = {}) {
  const now = Date.now();
  const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: s.screen.id, promptVersionId: s.pv.id, status: 'queued', createdAt: now, updatedAt: now, ...over }).returning();
  return g;
}
const row = async (id: number) => (await db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)))[0];
const all = () => db.select().from(schema.videoGenerations);
const generate = (pid: number, s: S, body: Record<string, unknown> = {}) => generateRoute(new NextRequest('http://x', { method: 'POST', body: JSON.stringify({ promptVersionId: s.pv.id, ...body }), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: String(pid), n: String(s.screen.screenNumber) }) });

describe('a finished video is never overwritten as failed (the production race)', () => {
  it('while the submitter is still saving, the poller leaves the row alone', async () => {
    const { scenes } = await project();
    const g = await gen(scenes[0]);
    let release!: () => void;
    holder.download = () => new Promise((r) => { release = () => { const p = path.join(os.tmpdir(), `soma-t-${Math.random()}`); fs.writeFileSync(p, 'v'); r({ tempPath: p }); }; });
    holder.poll = async () => ({ status: 'completed' });                                   // "completed, no URL": what overwrote 16 videos
    const submitting = submitQueuedGeneration(g.id);
    await vi.waitFor(async () => expect((await row(g.id)).jobId).toBeTruthy());               // the job id is saved before the download
    await pollInFlightGenerations();
    expect((await row(g.id)).status).toBe('processing');
    release(); await submitting;
    expect(await row(g.id)).toMatchObject({ status: 'completed', errorMessage: null });
  });

  it('a stale poll answer arriving after the video was stored changes nothing', async () => {
    const { scenes } = await project();
    const g = await gen(scenes[0], { status: 'processing', jobId: 'j1' });
    holder.poll = async () => {
      await db.update(schema.videoGenerations).set({ status: 'completed', videoStoragePath: 'screen/done.mp4' }).where(eq(schema.videoGenerations.id, g.id));
      return { status: 'failed', errorMessage: 'stale' };
    };
    await pollOneGeneration(g.id);
    expect(await row(g.id)).toMatchObject({ status: 'completed', videoStoragePath: 'screen/done.mp4', errorMessage: null });
  });

  it('a row that has a stored video is completed, never failed', async () => {
    const { scenes } = await project();
    const g = await gen(scenes[0], { status: 'processing', jobId: 'j1', videoStoragePath: 'screen/x.mp4', createdAt: 0 });
    holder.poll = async () => ({ status: 'failed' });
    await pollOneGeneration(g.id);
    expect((await row(g.id)).status).toBe('completed');
  });

  it('"completed" without a download link is waited for, then fetched when the link appears', async () => {
    const { scenes } = await project();
    const g = await gen(scenes[0], { status: 'pending', jobId: 'j1' });
    holder.poll = async () => ({ status: 'completed' });
    await pollOneGeneration(g.id);
    expect((await row(g.id)).status).toBe('processing');
    holder.poll = async () => ({ status: 'completed', videoUrl: 'https://v/y.mp4', outputMediaGenerationId: 'm2' });
    await pollOneGeneration(g.id);
    expect(await row(g.id)).toMatchObject({ status: 'completed', mediaGenerationId: 'm2' });
  });

  it('reads the clip from the documented job answer (response.media), and still from the older top-level shape', async () => {
    const p = new UseapiGoogleFlowProvider();
    const answer = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const item = { videoUrl: 'https://v/a.mp4', mediaGenerationId: 'user:1-media:2' };
    answer({ jobid: 'j', status: 'completed', response: { media: [item] } });
    expect(await p.pollJob('j')).toMatchObject({ status: 'completed', videoUrl: item.videoUrl, outputMediaGenerationId: item.mediaGenerationId });
    answer({ status: 'completed', media: [item] });
    expect((await p.pollJob('j')).videoUrl).toBe(item.videoUrl);
    answer({ status: 'failed', error: 'PUBLIC_ERROR_UNSAFE_GENERATION' });
    expect(await p.pollJob('j')).toMatchObject({ status: 'failed', errorMessage: 'PUBLIC_ERROR_UNSAFE_GENERATION' });
    vi.unstubAllGlobals();
  });

  it('gives up on a job only after 2 hours, and a failed check does not fail a young job', async () => {
    const { scenes } = await project(2);
    const young = await gen(scenes[0], { status: 'pending', jobId: 'a' });
    const old = await gen(scenes[1], { status: 'pending', jobId: 'b', createdAt: Date.now() - RULES.jobMaxAgeMs - 1 });
    holder.poll = async () => { throw new Error('network'); };
    await pollInFlightGenerations();
    expect((await row(young.id)).status).toBe('pending');
    expect((await row(old.id)).status).toBe('failed');
  });
});

describe('a job is sent to the provider at most once', () => {
  it('five simultaneous submitters make one provider call', async () => {
    const { scenes } = await project();
    const g = await gen(scenes[0]);
    await Promise.all([1, 2, 3, 4, 5].map(() => submitQueuedGeneration(g.id)));
    expect(holder.submits).toHaveLength(1);
    expect((await row(g.id)).status).toBe('completed');
  });

  it('a lost answer is marked unconfirmed and never re-sent', async () => {
    const { scenes } = await project();
    const g = await gen(scenes[0]);
    holder.submit = async () => { throw new TypeError('fetch failed'); };
    await processQueuedGenerations(); await processQueuedGenerations(); await recoverAbandonedGenerations(Date.now() + 3_600_000);
    expect(holder.submits).toHaveLength(1);
    expect(await row(g.id)).toMatchObject({ status: 'failed', errorMessage: UNCONFIRMED_MESSAGE });
  });

  it('a busy provider (429) puts it back to wait for Retry-After, then it is sent; after 30 minutes of busy it stops', async () => {
    const { scenes } = await project(2);
    const g = await gen(scenes[0]);
    holder.submit = async () => { throw new RateLimitError('busy', 60_000); };
    await processQueuedGenerations(); await processQueuedGenerations();
    expect(holder.submits).toHaveLength(1);                                                   // not hammered
    expect((await row(g.id)).status).toBe('queued');
    expect((await row(g.id)).claimedAt!).toBeGreaterThan(Date.now() + 50_000);
    const old = await gen(scenes[1], { createdAt: Date.now() - RULES.busyGiveUpMs - 1 });
    await processQueuedGenerations();
    expect((await row(old.id)).status).toBe('failed');
  });

  it('a content refusal fails with a plain message, not the raw provider text', async () => {
    const { scenes } = await project();
    const g = await gen(scenes[0]);
    holder.submit = async () => { throw new UnexpectedProviderError('Submit failed: 400 {"error":"PUBLIC_ERROR_UNSAFE_GENERATION","token":"abc"}', 400); };
    await processQueuedGenerations();
    expect((await row(g.id)).errorMessage).toMatch(/content policy/);
    expect((await row(g.id)).errorMessage).not.toMatch(/PUBLIC_ERROR|abc/);
  });

  it('worker interruption: an abandoned submission is not re-sent; an accepted job is followed again; a fresh claim is left alone', async () => {
    const { scenes } = await project(3);
    const longAgo = Date.now() - RULES.submitStaleMs - 1000;
    const abandoned = await gen(scenes[0], { status: 'processing', claimedAt: longAgo });
    const accepted = await gen(scenes[1], { status: 'processing', claimedAt: longAgo, jobId: 'j-acc' });
    const current = await gen(scenes[2], { status: 'processing', claimedAt: Date.now() });
    await recoverAbandonedGenerations();
    await processQueuedGenerations();
    expect(holder.submits).toEqual([]);
    expect(await row(abandoned.id)).toMatchObject({ status: 'failed', errorMessage: UNCONFIRMED_MESSAGE });
    expect((await row(current.id)).status).toBe('processing');
    holder.poll = async () => ({ status: 'completed', videoUrl: 'https://v/z.mp4' });
    await pollOneGeneration(accepted.id);
    expect((await row(accepted.id)).status).toBe('completed');
  });

  it('if saving the finished video fails, the paid job is kept and fetched again later', async () => {
    const { scenes } = await project();
    const g = await gen(scenes[0]);
    holder.storeFails = true;
    await submitQueuedGeneration(g.id);
    expect(await row(g.id)).toMatchObject({ status: 'pending', jobId: 'job-1' });
    holder.storeFails = false;
    holder.poll = async () => ({ status: 'completed', videoUrl: 'https://v/x.mp4' });
    await pollOneGeneration(g.id);
    expect((await row(g.id)).status).toBe('completed');
    expect(holder.submits).toHaveLength(1);
  });
});

describe('duplicate prevention, with intentional extra takes still possible', () => {
  it('Generate queues at once (no provider call in the request); five simultaneous clicks make one job', async () => {
    const { p, scenes } = await project();
    const res = await Promise.all([1, 2, 3, 4, 5].map(() => generate(p.id, scenes[0])));
    expect(holder.submits).toEqual([]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(await Promise.all(res.map(async (r) => (await r.json()).generationId))).size).toBe(1);
    expect(await all()).toHaveLength(1);
  });

  it('after the first take finishes, the same prompt can be generated again', async () => {
    const { p, scenes } = await project();
    await generate(p.id, scenes[0]); await processQueuedGenerations();
    expect((await generate(p.id, scenes[0])).status).toBe(201);
    expect(await all()).toHaveLength(2);
  });

  it('Generate and Generate All pressed together make one job per scene', async () => {
    const { p, scenes } = await project(3);
    await Promise.all([generate(p.id, scenes[0]), enqueueAllSceneGenerations(p.id), enqueueAllSceneGenerations(p.id), generate(p.id, scenes[1])]);
    const rows = await all();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.videoScreenId)).size).toBe(3);
    await queueGeneration(scenes[0].screen.id, scenes[0].pv.id, 8);
    expect(await all()).toHaveLength(3);
  });

  it('refuses a prompt version of another scene, and approval of an unfinished video', async () => {
    const { p, scenes } = await project(2);
    expect((await generate(p.id, scenes[0], { promptVersionId: scenes[1].pv.id })).status).toBe(404);
    const g = await gen(scenes[0], { status: 'failed' });
    const r = await approveRoute(new NextRequest('http://x', { method: 'POST', body: JSON.stringify({ generationId: g.id }) }), { params: Promise.resolve({ id: String(p.id), n: '1' }) });
    expect(r.status).toBe(409);
  });
});

describe('several projects at once', () => {
  it('projects take turns, so one large project cannot take every slot', () => {
    expect(roundRobin([{ p: 1, n: 1 }, { p: 1, n: 2 }, { p: 1, n: 3 }, { p: 2, n: 4 }, { p: 3, n: 5 }], (r) => r.p).map((r) => r.n)).toEqual([1, 4, 5, 2, 3]);
  });

  it('a submission that hangs holds one slot only: other projects keep being sent, never more than the limit at once', async () => {
    const a = await project(4); const b = await project(1);
    for (const s of a.scenes) await gen(s);
    const other = await gen(b.scenes[0]);
    let running = 0; let max = 0; const hang: Array<() => void> = [];
    holder.submit = async (q) => {
      running++; max = Math.max(max, running);
      const correlation = (q as { correlationId: string }).correlationId;
      if (correlation.includes(`screen-${a.scenes[0].screen.id}-`)) await new Promise<void>((r) => hang.push(r));
      running--; return { jobId: correlation };
    };
    const first = await startQueuedSubmissions();
    await vi.waitFor(async () => expect((await row(other.id)).jobId).toBeTruthy());            // project B went out in the first round
    await vi.waitFor(() => expect(running).toBe(1));                                           // only the hung one is left
    const second = await startQueuedSubmissions();                                             // two free slots are filled
    expect(second).toHaveLength(RULES.submitConcurrency() - 1);
    expect(max).toBeLessThanOrEqual(RULES.submitConcurrency());
    hang.forEach((r) => r());
    await Promise.all([...first, ...second]);
  });
});
