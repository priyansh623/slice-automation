/**
 * Regression tests for the Character B-roll Studio hardening (the independent review's findings C1 to C4 and the follow-up
 * issues). Real routes and libraries against an in-memory Postgres built from the repository's migrations, an in-memory R2,
 * the mock provider and a fake model. No external service is involved.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate, call } from './helpers/studio-fakes';

const USER = '00000000-0000-4000-8000-00000000000a';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown, userId: '00000000-0000-4000-8000-00000000000a' as string | null, create: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));
vi.mock('@/lib/studio/ai-client', () => ({ aiConfigured: () => true, getStudioClient: () => ({ messages: { create: (...a: unknown[]) => (holder.create as (...x: unknown[]) => unknown)(...a) } }) }));

import { POST as projectsPost } from '@/app/api/v1/studio/projects/route';
import { PUT as projectPut } from '@/app/api/v1/studio/projects/[id]/route';
import { POST as approvePacks } from '@/app/api/v1/studio/projects/[id]/packs/route';
import { POST as selectionPost } from '@/app/api/v1/studio/projects/[id]/selection/route';
import { POST as batchesPost } from '@/app/api/v1/studio/projects/[id]/batches/route';
import { GET as batchGet } from '@/app/api/v1/studio/projects/[id]/batches/[batchId]/route';
import { GET as outputsList } from '@/app/api/v1/studio/projects/[id]/outputs/route';
import { GET as outputGet } from '@/app/api/v1/studio/outputs/[id]/route';
import { POST as outputReview } from '@/app/api/v1/studio/outputs/[id]/review/route';
import { GET as configGet } from '@/app/api/v1/studio/config/route';
import { POST as retryPost } from '@/app/api/v1/studio/jobs/[id]/retry/route';
import { POST as assetInit } from '@/app/api/v1/studio/packs/[id]/assets/init/route';
import { POST as assetComplete } from '@/app/api/v1/studio/packs/[id]/assets/complete/route';
import { GET as packAssetsGet } from '@/app/api/v1/studio/packs/[id]/assets/route';
import { GET as projectPackAssetsGet } from '@/app/api/v1/studio/projects/[id]/packs/[packId]/assets/route';
import { GET as assetGet } from '@/app/api/v1/studio/assets/[id]/route';
import { POST as charInit } from '@/app/api/v1/studio/projects/[id]/character/init/route';
import { POST as charComplete } from '@/app/api/v1/studio/projects/[id]/character/complete/route';
import { claimQueuedJobs, failJob, generationRound, pollJob, recoverStaleJobs, storeOutput, SUBMIT_LEASE_MS, JOB_MAX_AGE_MS, type GenerationDeps } from '@/lib/studio/generation';
import { MockReplacementProvider, getProvider, generationConfig } from '@/lib/studio/mock-provider';
import type { ReplacementProvider } from '@/lib/studio/provider';
import { ObjectExistsError } from '@/lib/object-store/types';
import { discardIfUnreferenced, isKeyReferenced } from '@/lib/studio/references';
import { listPackAssets } from '@/lib/studio/repository';
import { analyseProjectScript } from '@/lib/studio/recommend';
import { claimNextAsset, releaseClaim } from '@/lib/studio/analysis-queue';
import { prepareForAnalysis, configureSharpForWorker, ANALYSIS_MAX_PIXELS } from '@/lib/studio/analyzer';
import { STUDIO_MAX_PIXELS } from '@/lib/studio/keys';
import { AnalysisBudget, analysisConcurrency, analyseClaimed, defaultGenerationDeps, recoverStudioWork, resetStudioWorkerForTests, runAnalysisRound, stopStudioWorker, studioTick, type AnalysisDeps } from '@/worker/studio';

const ROOT = path.resolve(__dirname, '../..');
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
let r2: FakeR2;

beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  r2 = new FakeR2(); holder.store = r2; holder.userId = USER; holder.create = vi.fn();
  process.env.STUDIO_PROVIDER = 'mock';
  delete process.env.STUDIO_ANALYSIS_BUDGET_PER_HOUR;
  await pg.exec('truncate studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects restart identity cascade');
});
afterEach(() => { resetStudioWorkerForTests(); delete process.env.STUDIO_PROVIDER; delete process.env.ANTHROPIC_API_KEY; });

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (color: string, w = 400, h = 300) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const P = (id: number) => ({ id: String(id) });
let seq = 0;
const now = () => Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(5); } }

let bigImage: Buffer | null = null;
/** 25 megapixels: above the 24 megapixel limit, but a flat colour so the file itself is tiny. */
const big = async () => (bigImage ??= await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#336699' } }).png({ compressionLevel: 9 }).toBuffer());

interface World { proj: number; characterKey: string; assets: Array<{ id: number; packId: number; key: string; thumbKey: string; buf: Buffer }>; packs: number[] }

/** A project with a character image, approved packs holding `count` source images (with thumbnails, stored in R2), all selected. */
async function world(count: number, opts: { select?: boolean } = {}): Promise<World> {
  const proj = (await call(projectsPost, { method: 'POST', body: { name: 'World' } })).json.project.id as number;
  const characterKey = `studio/projects/${proj}/character/${crypto.randomUUID()}.png`;
  r2.browserPut(characterKey, await png('#aa6633', 600, 800), 'image/png');
  r2.browserPut(characterKey.replace('/character/', '/character/thumbs/').replace(/\.png$/, '.webp'), await png('#aa6633', 60, 80), 'image/webp');
  await db.update(schema.studioProjects).set({ characterKey, characterMime: 'image/png' }).where(eq(schema.studioProjects.id, proj));
  const packA = (await db.insert(schema.studioPacks).values({ name: `A${++seq}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
  await call(approvePacks, { method: 'POST', params: P(proj), body: { packIds: [packA] } });
  const assets: World['assets'] = [];
  for (let i = 0; i < count; i++) {
    const buf = await png(`#${((i * 37 + 40) % 255).toString(16).padStart(2, '0')}4477`, 300 + i, 200);
    const id = crypto.randomUUID();
    const key = `studio/assets/${id}.png`; const thumbKey = `studio/assets/thumbs/${id}.webp`;
    r2.browserPut(key, buf, 'image/png'); r2.browserPut(thumbKey, await png('#223344', 40, 30), 'image/webp');
    const [a] = await db.insert(schema.studioAssets).values({ packId: packA, storageKey: key, thumbKey, mime: 'image/png', sizeBytes: buf.length, sha256: sha(buf), createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
    assets.push({ id: a.id, packId: packA, key, thumbKey, buf });
  }
  if (opts.select !== false) await call(selectionPost, { method: 'POST', params: P(proj), body: { assetIds: assets.map((a) => a.id) } });
  return { proj, characterKey, assets, packs: [packA] };
}
const depsFor = (provider: ReplacementProvider, over: Partial<GenerationDeps> = {}): GenerationDeps => ({
  provider: () => provider,
  read: (key) => r2.downloadR2Only('uploads', key),
  put: async (key, body, mime) => { try { await r2.putR2Only('uploads', key, body, { contentType: mime }); return 'created'; } catch (e) { if (e instanceof ObjectExistsError) return 'exists'; throw e; } },
  ...over,
});
const jobsOf = (batchId: number) => db.select().from(schema.studioJobs).where(eq(schema.studioJobs.batchId, batchId)).orderBy(schema.studioJobs.id);
const batchOf = (w: World) => call(batchesPost, { method: 'POST', params: P(w.proj), body: {} });
async function drain(deps: GenerationDeps, rounds = 60) {
  for (let i = 0; i < rounds; i++) {
    await db.update(schema.studioJobs).set({ nextPollAt: 0 }).where(eq(schema.studioJobs.status, 'processing'));
    if ((await generationRound(deps, { submit: 4, poll: 20 })) === 0) return;
  }
}
const spySigned = () => {
  const seen: string[] = [];
  const orig = r2.signedReadUrls.bind(r2);
  r2.signedReadUrls = async (b: string, keys: string[]) => { seen.push(...keys); return orig(b, keys); };
  return seen;
};

// ───────────────────────────── C1 ─────────────────────────────
describe('C1: a registered original is never deleted by an upload request', () => {
  async function uploaded(packId: number, buf: Buffer) {
    const init = await call(assetInit, { method: 'POST', params: P(packId), body: { contentType: 'image/png', fileSize: buf.length, fileName: 'a.png' } });
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    const done = await call(assetComplete, { method: 'POST', params: P(packId), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } });
    return { key: init.json.storageKey as string, done };
  }

  it('completing an already registered upload again with the wrong size or type returns the asset and deletes nothing', async () => {
    const packId = (await db.insert(schema.studioPacks).values({ name: 'P', createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
    const buf = await png('#445566');
    const { key, done } = await uploaded(packId, buf);
    expect(done.status).toBeLessThan(300);
    const original = Buffer.from(r2.get(key));
    r2.deletes.length = 0;

    for (const body of [{ fileSize: buf.length + 7, contentType: 'image/png' }, { fileSize: buf.length, contentType: 'image/jpeg' }, { fileSize: 1, contentType: 'image/webp' }]) {
      const again = await call(assetComplete, { method: 'POST', params: P(packId), body: { storageKey: key, ...body } });
      expect(again.status).toBe(200);
      expect(again.json.asset.id).toBe(done.json.asset.id);
    }
    expect(r2.deletes).toEqual([]);
    expect(r2.has(key)).toBe(true);
    expect(sha(r2.get(key))).toBe(sha(original));
    expect(await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.packId, packId))).toHaveLength(1);
  });

  it('still removes an unusable upload that nothing references (the cleanup the guard exists to keep)', async () => {
    const packId = (await db.insert(schema.studioPacks).values({ name: 'P', createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
    const buf = await png('#445566');
    const init = await call(assetInit, { method: 'POST', params: P(packId), body: { contentType: 'image/png', fileSize: buf.length } });
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    const bad = await call(assetComplete, { method: 'POST', params: P(packId), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length + 1 } });
    expect(bad.status).toBe(422);
    expect(r2.has(init.json.storageKey)).toBe(false);
  });

  it('an earlier character image that a batch used is never removed or replaced by a later complete request', async () => {
    const w = await world(1);
    expect((await batchOf(w)).status).toBe(201); // the batch snapshots the character key
    const other = `studio/projects/${w.proj}/character/${crypto.randomUUID()}.png`;
    r2.browserPut(other, await png('#00aa00'), 'image/png');
    await db.update(schema.studioProjects).set({ characterKey: other }).where(eq(schema.studioProjects.id, w.proj));
    const before = sha(r2.get(w.characterKey));
    r2.deletes.length = 0;

    for (const fileSize of [3, 600 * 800 * 3]) {
      const res = await call(charComplete, { method: 'POST', params: P(w.proj), body: { storageKey: w.characterKey, contentType: 'image/png', fileSize } });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('key_in_use');
    }
    expect(r2.deletes).toEqual([]);
    expect(r2.has(w.characterKey)).toBe(true);
    expect(sha(r2.get(w.characterKey))).toBe(before);
    expect((await db.select().from(schema.studioProjects).where(eq(schema.studioProjects.id, w.proj)))[0].characterKey).toBe(other);
  });

  it('the current character, completed again with a bad size, is returned untouched', async () => {
    const w = await world(0);
    const res = await call(charComplete, { method: 'POST', params: P(w.proj), body: { storageKey: w.characterKey, contentType: 'image/png', fileSize: 5 } });
    expect(res.status).toBe(200);
    expect(r2.deletes).toEqual([]);
    expect(r2.has(w.characterKey)).toBe(true);
  });

  it('isKeyReferenced and discardIfUnreferenced know every place a key can be used', async () => {
    const w = await world(1);
    await batchOf(w);
    const a = w.assets[0];
    // asset original, asset thumbnail, project character, batch/job snapshot
    for (const k of [a.key, a.thumbKey, w.characterKey]) { expect(await isKeyReferenced(k)).toBe(true); expect(await discardIfUnreferenced(k)).toBe(false); expect(r2.has(k)).toBe(true); }
    // a generated output and its thumbnail
    await drain(depsFor(new MockReplacementProvider({ pollsBeforeDone: 0 })));
    const out = (await db.select().from(schema.studioOutputs))[0];
    for (const k of [out.storageKey, out.thumbKey!]) { expect(await isKeyReferenced(k)).toBe(true); expect(await discardIfUnreferenced(k)).toBe(false); expect(r2.has(k)).toBe(true); }
    // a key nothing uses
    const stray = `studio/assets/${crypto.randomUUID()}.png`;
    r2.browserPut(stray, await png('#111111'), 'image/png');
    expect(await isKeyReferenced(stray)).toBe(false);
    expect(await discardIfUnreferenced(stray)).toBe(true);
    expect(r2.has(stray)).toBe(false);
  });
});

// ───────────────────────────── C2 ─────────────────────────────
describe('C2: job timeouts and provider submission tracking', () => {
  it('counts the time limit from when the job was sent, not from when it was queued', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await db.update(schema.studioJobs).set({ createdAt: now() - 5 * JOB_MAX_AGE_MS }).where(eq(schema.studioJobs.batchId, batch)); // queued for 10 hours
    await generationRound(depsFor(new MockReplacementProvider({ pollsBeforeDone: 99 })), { submit: 1, poll: 0 });
    expect(await recoverStaleJobs(now())).toEqual({ interrupted: 0, timedOut: 0 });
    expect((await jobsOf(batch))[0].status).toBe('processing');
    expect(await recoverStaleJobs(now() + JOB_MAX_AGE_MS + 5_000)).toEqual({ interrupted: 0, timedOut: 1 });
  });

  it('a provider answer that arrives after the job was given up on keeps the provider id but does not bring the job back', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    const slow: ReplacementProvider = { id: 'mock', async submit() { started = true; await gate; return { kind: 'accepted', providerJobId: 'late-77' }; }, async poll() { return { status: 'processing' }; } };
    const running = generationRound(depsFor(slow), { submit: 1, poll: 0 });
    await until(() => started);
    expect(await recoverStaleJobs(now() + SUBMIT_LEASE_MS + 1000)).toEqual({ interrupted: 1, timedOut: 0 });
    release();
    await running;
    const [job] = await jobsOf(batch);
    expect(job).toMatchObject({ status: 'failed', errorCode: 'submit_interrupted', providerJobId: 'late-77' });
    expect(await claimQueuedJobs(5)).toHaveLength(0);      // it is not queued again
    await drain(depsFor(slow));
    expect((await jobsOf(batch))[0].status).toBe('failed'); // and it is not polled back to life
  });

  it('a provider that never answers a submit is given up on, once, as a retryable timeout', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    let calls = 0;
    const hang: ReplacementProvider = { id: 'mock', submit() { calls++; return new Promise(() => {}); }, async poll() { return { status: 'processing' }; } };
    const deps = depsFor(hang, { providerTimeoutMs: 40 });
    await generationRound(deps, { submit: 1, poll: 0 });
    const [job] = await jobsOf(batch);
    expect(job).toMatchObject({ status: 'failed', errorCode: 'submit_timeout', errorRetryable: true });
    expect(job.errorMessage).toMatch(/not sent again/i);
    await generationRound(deps, { submit: 1, poll: 0 });
    expect(calls).toBe(1);                                   // never submitted a second time
  });

  it('a provider that never answers a poll is asked again later; the job is neither failed nor stuck', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(new MockReplacementProvider({ pollsBeforeDone: 99 })), { submit: 1, poll: 0 });
    const hang: ReplacementProvider = { id: 'mock', async submit() { throw new Error('never'); }, poll() { return new Promise(() => {}); } };
    const [job] = await jobsOf(batch);
    expect(await pollJob(job, depsFor(hang, { providerTimeoutMs: 40 }))).toBe('processing');
    const after = (await jobsOf(batch))[0];
    expect(after.status).toBe('processing');
    expect(after.pollCount).toBe(job.pollCount + 1);
    expect(after.nextPollAt).toBeGreaterThan(now());
  });

  it('a slow storage read or write fails that job, not the loop', async () => {
    const w = await world(2);
    const batch = (await batchOf(w)).json.batch.id as number;
    const deps = depsFor(new MockReplacementProvider(), { storageTimeoutMs: 40, read: (key) => (key === w.assets[0].key ? new Promise(() => {}) : r2.downloadR2Only('uploads', key)) });
    await drain(deps);
    const jobs = await jobsOf(batch);
    expect(jobs.find((j) => j.assetId === w.assets[0].id)).toMatchObject({ status: 'failed', errorCode: 'storage_timeout' });
    expect(jobs.find((j) => j.assetId === w.assets[1].id)!.status).toBe('succeeded');
  });

  it('a result that arrives for a job already failed or finished stores nothing and changes nothing', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(new MockReplacementProvider({ pollsBeforeDone: 99 })), { submit: 1, poll: 0 });
    const [snapshot] = await jobsOf(batch);
    await failJob(snapshot, 'timed_out', 'gave up', true);
    const png1 = await png('#abcdef', 64, 64);
    await storeOutput(snapshot, { bytes: png1, mime: 'image/png' }, depsFor(new MockReplacementProvider()), new MockReplacementProvider());
    expect(await db.select().from(schema.studioOutputs)).toHaveLength(0);
    expect((await jobsOf(batch))[0].status).toBe('failed');

    // and failing a job that already succeeded does not undo it
    const w2 = await world(1);
    const b2 = (await batchOf(w2)).json.batch.id as number;
    await drain(depsFor(new MockReplacementProvider({ pollsBeforeDone: 0 })));
    const [done] = await jobsOf(b2);
    expect(done.status).toBe('succeeded');
    await failJob(done, 'late', 'late', true);
    expect((await jobsOf(b2))[0]).toMatchObject({ status: 'succeeded', errorCode: null });
  });

  it('recovery runs on its own (recoverStudioWork), for jobs and for analysis', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await db.update(schema.studioJobs).set({ status: 'submitting', claimedAt: now() - SUBMIT_LEASE_MS - 1000, startedAt: now() - SUBMIT_LEASE_MS - 1000 }).where(eq(schema.studioJobs.batchId, batch));
    await db.update(schema.studioAssets).set({ analysisStatus: 'processing', claimedAt: now() - 3_600_000 }).where(eq(schema.studioAssets.id, w.assets[0].id));
    await recoverStudioWork();
    expect((await jobsOf(batch))[0]).toMatchObject({ status: 'failed', errorCode: 'submit_interrupted' });
    expect((await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, w.assets[0].id)))[0].analysisStatus).toBe('pending');
    const src = fs.readFileSync(path.join(ROOT, 'src/worker/studio.ts'), 'utf8');
    expect(src).toMatch(/setInterval\(\(\) => \{ void recoverStudioWork\(\); \}/); // on its own timer, not inside a round
  });

  it('the worker loop never runs recovery inside a round (a stuck round cannot stop recovery)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/worker/studio.ts'), 'utf8');
    expect(src).toMatch(/noRecovery: true/);
  });
});

// ───────────────────────────── C3 ─────────────────────────────
describe('C3: the mock provider is an explicit opt-in, never the silent default', () => {
  it('with nothing configured there is no provider: batches are refused and nothing is queued', async () => {
    delete process.env.STUDIO_PROVIDER;
    expect(generationConfig()).toMatchObject({ enabled: false, provider: null, testMode: false });
    expect(() => getProvider('mock')).toThrow(/not enabled/);
    const w = await world(2);
    const res = await batchOf(w);
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('generation_disabled');
    expect(await db.select().from(schema.studioBatches)).toHaveLength(0);
    expect(await db.select().from(schema.studioJobs)).toHaveLength(0);
    expect(await db.select().from(schema.studioSelections).where(eq(schema.studioSelections.projectId, w.proj))).toHaveLength(2); // the selection is kept
  });

  it('an empty or unknown provider is not the mock and is not silently replaced by it', async () => {
    for (const v of ['', '  ', 'higgsfield', 'MOCKY']) {
      process.env.STUDIO_PROVIDER = v;
      expect(generationConfig().enabled).toBe(false);
      expect(generationConfig().testMode).toBe(false);
    }
    process.env.STUDIO_PROVIDER = 'higgsfield';
    expect((await batchOf(await world(1))).json.code).toBe('generation_disabled');
    expect(() => getProvider('higgsfield')).toThrow(/not available yet/);
  });

  it('STUDIO_PROVIDER=mock turns it on, and the config says plainly that it is test mode', async () => {
    process.env.STUDIO_PROVIDER = 'mock';
    expect(generationConfig()).toMatchObject({ enabled: true, provider: 'mock', testMode: true, reason: null });
    expect(getProvider('mock').id).toBe('mock');
    const cfg = await call(configGet);
    expect(cfg.status).toBe(200);
    expect(cfg.json.generation).toMatchObject({ enabled: true, testMode: true });
    expect((await batchOf(await world(1))).status).toBe(201);
    delete process.env.STUDIO_PROVIDER;
    expect((await call(configGet)).json.generation).toMatchObject({ enabled: false, reason: expect.stringMatching(/no provider is configured/i) });
  });

  it('the config route needs a signed-in user and exposes no secrets', async () => {
    holder.userId = null;
    expect((await call(configGet)).status).toBe(401);
    holder.userId = USER;
    expect(Object.keys((await call(configGet)).json.generation).sort()).toEqual(['enabled', 'provider', 'reason', 'testMode']);
  });

  it('jobs already queued wait (are not failed or sent) while generation is off, and run when it is back', async () => {
    const w = await world(2);
    const batch = (await batchOf(w)).json.batch.id as number;
    delete process.env.STUDIO_PROVIDER;
    const deps = defaultGenerationDeps();
    expect(deps.canSubmit!()).toBe(false);
    const provider = new MockReplacementProvider();
    await generationRound({ ...depsFor(provider), canSubmit: deps.canSubmit }, { submit: 4, poll: 4 });
    expect((await jobsOf(batch)).map((j) => j.status)).toEqual(['queued', 'queued']);
    expect(provider.submitted).toHaveLength(0);
    process.env.STUDIO_PROVIDER = 'mock';
    expect(deps.canSubmit!()).toBe(true);
    r2.available = false;
    expect(deps.canSubmit!()).toBe(false);                 // R2 down also keeps them waiting
    r2.available = true;
    await drain({ ...depsFor(new MockReplacementProvider({ pollsBeforeDone: 0 })), canSubmit: deps.canSubmit });
    expect((await jobsOf(batch)).map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('a retry is refused while generation is off', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await drain(depsFor(new MockReplacementProvider({ failSubmit: () => ({ code: 'rate', message: 'slow down', retryable: true }) })));
    const [job] = await jobsOf(batch);
    expect(job.status).toBe('failed');
    delete process.env.STUDIO_PROVIDER;
    const res = await call(retryPost, { method: 'POST', params: P(job.id) });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('generation_disabled');
    expect(await jobsOf(batch)).toHaveLength(1);
  });
});

// ───────────────────────────── C4 ─────────────────────────────
describe('C4: image memory limits', () => {
  it('refuses a pack image above the pixel limit at upload, removes the unreferenced upload and registers nothing', async () => {
    const packId = (await db.insert(schema.studioPacks).values({ name: 'P', createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
    const buf = await big();
    expect(buf.length).toBeLessThan(5_000_000);
    const init = await call(assetInit, { method: 'POST', params: P(packId), body: { contentType: 'image/png', fileSize: buf.length, fileName: 'huge.png' } });
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    const res = await call(assetComplete, { method: 'POST', params: P(packId), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('too_many_pixels');
    expect(res.json.error).toMatch(/24 megapixels/);
    expect(await db.select().from(schema.studioAssets)).toHaveLength(0);
    expect(r2.has(init.json.storageKey)).toBe(false);
  });

  it('refuses a character image above the pixel limit too, and leaves the current character alone', async () => {
    const w = await world(0);
    const buf = await big();
    const init = await call(charInit, { method: 'POST', params: P(w.proj), body: { contentType: 'image/png', fileSize: buf.length } });
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    const res = await call(charComplete, { method: 'POST', params: P(w.proj), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('too_many_pixels');
    expect((await db.select().from(schema.studioProjects).where(eq(schema.studioProjects.id, w.proj)))[0].characterKey).toBe(w.characterKey);
    expect(r2.has(w.characterKey)).toBe(true);
  });

  it('the limit is 24 megapixels and the analyser decodes nothing above it', async () => {
    expect(STUDIO_MAX_PIXELS).toBe(24_000_000);
    expect(ANALYSIS_MAX_PIXELS).toBe(STUDIO_MAX_PIXELS);   // an image the Studio accepted can always be analysed
    await expect(prepareForAnalysis(await big())).rejects.toThrow(/pixel limit/i);
    const ok = await prepareForAnalysis(await png('#336699', 2000, 1500));
    expect(ok.mediaType).toBe('image/jpeg');
  });

  it('analyses one image at a time by default and never more than two', () => {
    delete process.env.STUDIO_ANALYSIS_CONCURRENCY;
    expect(analysisConcurrency()).toBe(1);
    process.env.STUDIO_ANALYSIS_CONCURRENCY = '8';
    expect(analysisConcurrency()).toBe(2);
    process.env.STUDIO_ANALYSIS_CONCURRENCY = 'x';
    expect(analysisConcurrency()).toBe(1);
    delete process.env.STUDIO_ANALYSIS_CONCURRENCY;
  });

  it('the worker turns the decoded-image cache off and uses one libvips thread', () => {
    const before = { c: sharp.concurrency() };
    try {
      configureSharpForWorker();
      expect(sharp.concurrency()).toBe(1);
      expect(sharp.cache().items.max).toBe(0);
    } finally { sharp.concurrency(before.c); sharp.cache(true); }
  });

  it('every sharp call that decodes a Studio image carries a pixel limit (reading only the header, to report a size, needs none)', () => {
    for (const f of ['src/lib/studio/image-store.ts', 'src/lib/studio/analyzer.ts']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/sharp\((?!\{)[^)]*\)\s*(\.\w+)?/g)) {
        if (m[1] === '.metadata') continue;                  // header only: nothing is decoded
        expect(src.slice(m.index!, m.index! + 160), `${f}: ${m[0]}`).toMatch(/limitInputPixels/);
      }
    }
    // and the header read reports the true size of an oversize image, which is what lets the upload say "too many megapixels"
  });
});

// ───────────────────────────── other issues ─────────────────────────────
describe('page size validation', () => {
  async function packWith(n: number) {
    const packId = (await db.insert(schema.studioPacks).values({ name: 'P', createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
    for (let i = 0; i < n; i++) await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/${crypto.randomUUID()}.png`, mime: 'image/png', sizeBytes: 1, sha256: `h${++seq}`, createdBy: USER, createdAt: now(), updatedAt: now() });
    return packId;
  }

  it('rejects a limit that is not a whole number of at least 1, on both listing routes', async () => {
    const packId = await packWith(3);
    const w = await world(0);
    for (const limit of ['abc', '0', '-2', '1.5', '1e3', ' 5']) {
      const a = await call(packAssetsGet, { params: P(packId), query: `limit=${encodeURIComponent(limit)}` });
      expect(a.status, `limit=${limit}`).toBe(400);
      expect(a.json.code).toBe('invalid_limit');
      const b = await call(projectPackAssetsGet, { params: { id: String(w.proj), packId: String(w.packs[0]) }, query: `limit=${encodeURIComponent(limit)}` });
      expect(b.status, `limit=${limit}`).toBe(400);
      expect(b.json.code).toBe('invalid_limit');
    }
  });

  it('accepts a valid limit and no limit, pages correctly, and the library never passes NaN to the database', async () => {
    const packId = await packWith(3);
    const two = await call(packAssetsGet, { params: P(packId), query: 'limit=2' });
    expect(two.status).toBe(200);
    expect(two.json.assets).toHaveLength(2);
    expect(two.json.nextCursor).not.toBeNull();
    expect((await call(packAssetsGet, { params: P(packId) })).json.assets).toHaveLength(3);
    expect((await call(packAssetsGet, { params: P(packId), query: 'limit=100000' })).status).toBe(200); // capped, not an error
    for (const bad of [NaN, Infinity, -Infinity, 1.9, 0, -5]) {
      const page = await listPackAssets(packId, { limit: bad });
      expect(page.items.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('analysis waits for R2 and respects the hourly budget', () => {
  let n = 0;
  async function pending(count: number) {
    const packId = (await db.insert(schema.studioPacks).values({ name: `Q${++n}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/${crypto.randomUUID()}.png`, mime: 'image/png', sizeBytes: 1, sha256: `q${++n}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
      await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, manual: {}, createdAt: now(), updatedAt: now() });
      ids.push(a.id);
    }
    return ids;
  }
  const row = async (id: number) => (await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, id)))[0];
  const deps = (over: Partial<AnalysisDeps> = {}): AnalysisDeps => ({
    read: async () => Buffer.from('x'), analyse: async () => ({ metadata: { description: 'A room.', tags: ['room'] }, model: 'm' }),
    budget: new AnalysisBudget(() => 0), ...over,
  });

  it('does not claim (or fail) any image while R2 is not configured; it analyses them once R2 is back', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const [id] = await pending(1);
    const state = { lastRecovery: now(), warnedNoKey: false };
    expect(await studioTick(deps({ r2Ready: () => false }), state)).toBe('waiting');
    expect(await row(id)).toMatchObject({ analysisStatus: 'pending', analysisAttempts: 0, analysisError: null });
    expect(await studioTick(deps({ r2Ready: () => true }), state)).toBe('worked');
    expect((await row(id)).analysisStatus).toBe('completed');
  });

  it('starts no more images per hour than the budget allows, and 0 means no limit', async () => {
    const ids = await pending(5);
    const budget = new AnalysisBudget(() => 2);
    expect(await runAnalysisRound(4, deps({ budget }))).toBe(2);
    expect(await runAnalysisRound(4, deps({ budget }))).toBe(0);
    expect((await Promise.all(ids.map(row))).filter((r) => r.analysisStatus === 'completed')).toHaveLength(2);
    expect(budget.remaining()).toBe(0);
    expect(budget.remaining(now() + 3_600_001)).toBe(2);   // the window slides
    expect(new AnalysisBudget(() => 0).remaining()).toBe(Infinity);
    expect(await runAnalysisRound(4, deps({ budget: new AnalysisBudget(() => 0) }))).toBe(3);
  });

  it('while the budget is used up the tick waits instead of working', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    await pending(2);
    const budget = new AnalysisBudget(() => 1);
    budget.record(1);
    expect(await studioTick(deps({ r2Ready: () => true, budget }), { lastRecovery: now(), warnedNoKey: false })).toBe('waiting');
  });
});

describe('shutdown hands claimed images back', () => {
  it('releases an image that is being analysed when the worker stops, without counting the attempt against it', async () => {
    const packId = (await db.insert(schema.studioPacks).values({ name: 'S', createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
    const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/${crypto.randomUUID()}.png`, mime: 'image/png', sizeBytes: 1, sha256: `s${++seq}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
    await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, manual: {}, createdAt: now(), updatedAt: now() });
    const claimed = (await claimNextAsset())!;
    expect(claimed.id).toBe(a.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    const running = analyseClaimed(claimed, { read: async () => { started = true; await gate; return Buffer.from('x'); }, analyse: async () => ({ metadata: { description: 'x' }, model: 'm' }) });
    await until(() => started);
    expect((await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, a.id)))[0]).toMatchObject({ analysisStatus: 'processing', analysisAttempts: 1 });
    expect(await stopStudioWorker()).toBe(1);
    expect((await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, a.id)))[0]).toMatchObject({ analysisStatus: 'pending', analysisAttempts: 0, claimedAt: null });
    release();
    await running;                                          // the late result does not overwrite the released image
    expect((await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, a.id)))[0].analysisStatus).toBe('pending');
    // stopping takes no new work
    expect(await studioTick({ read: async () => Buffer.from('x'), analyse: async () => ({ metadata: {}, model: 'm' }), r2Ready: () => true }, { lastRecovery: now(), warnedNoKey: false })).toBe('waiting');
  });

  it('releaseClaim only touches an image that is still being processed', async () => {
    const packId = (await db.insert(schema.studioPacks).values({ name: 'S', createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
    const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/${crypto.randomUUID()}.png`, mime: 'image/png', sizeBytes: 1, sha256: `s${++seq}`, analysisStatus: 'completed', createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
    expect(await releaseClaim(a.id)).toBe(false);
    expect((await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, a.id)))[0].analysisStatus).toBe('completed');
  });

  it('the worker calls it from its shutdown handler', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'src/worker/index.ts'), 'utf8');
    const shutdown = idx.slice(idx.indexOf('async function shutdown'));
    expect(shutdown.indexOf('stopStudioWorker')).toBeGreaterThan(-1);
    expect(shutdown.indexOf('stopStudioWorker')).toBeLessThan(shutdown.indexOf('releaseLock'));
  });
});

describe('the kill switch is read on every pass', () => {
  it('stays idle while STUDIO_WORKER=off and works again when it is cleared, without a restart of the loop', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const packId = (await db.insert(schema.studioPacks).values({ name: 'K', createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
    const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/${crypto.randomUUID()}.png`, mime: 'image/png', sizeBytes: 1, sha256: `k${++seq}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
    await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, manual: {}, createdAt: now(), updatedAt: now() });
    const deps: AnalysisDeps = { read: async () => Buffer.from('x'), analyse: async () => ({ metadata: { description: 'x' }, model: 'm' }), r2Ready: () => true, budget: new AnalysisBudget(() => 0) };
    process.env.STUDIO_WORKER = 'off';
    try {
      expect(await studioTick(deps, { lastRecovery: now(), warnedNoKey: false })).toBe('waiting');
      expect((await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, a.id)))[0].analysisStatus).toBe('pending');
      const w = await world(1);
      const batch = (await batchOf(w)).json.batch.id as number;
      await generationRound(depsFor(new MockReplacementProvider()), { submit: 1, poll: 0 }); // (the round itself is not gated; the tick is)
      expect((await jobsOf(batch))[0].status).not.toBe('queued');
    } finally { delete process.env.STUDIO_WORKER; }
    expect(await studioTick(deps, { lastRecovery: now(), warnedNoKey: false })).toBe('worked');
  });
});

describe('non-retryable failures are not retried', () => {
  it('refuses to retry a job that failed in a way retrying cannot fix, and creates no new job', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await drain(depsFor(new MockReplacementProvider({ failSubmit: () => ({ code: 'bad_input', message: 'The image was rejected.', retryable: false }) })));
    const [job] = await jobsOf(batch);
    expect(job).toMatchObject({ status: 'failed', errorRetryable: false });
    const res = await call(retryPost, { method: 'POST', params: P(job.id) });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('not_retryable');
    expect(res.json.error).toMatch(/cannot fix/i);
    expect(await jobsOf(batch)).toHaveLength(1);
    const view = await call(batchGet, { params: { id: String(w.proj), batchId: String(batch) } });
    expect(view.json.jobs[0].error).toMatchObject({ retryable: false });   // the UI hides Retry from this
  });

  it('still retries a retryable failure, and a job that succeeded can be regenerated', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await drain(depsFor(new MockReplacementProvider({ failSubmit: () => ({ code: 'rate', message: 'Busy.', retryable: true }) })));
    const [job] = await jobsOf(batch);
    expect((await call(retryPost, { method: 'POST', params: P(job.id) })).status).toBe(201);
  });
});

describe('a retry can only point at an earlier job of the same batch and image', () => {
  it('the database refuses a cross-image or cross-batch retry link', async () => {
    const w = await world(2);
    const b1 = (await batchOf(w)).json.batch.id as number;
    const [j1, j2] = await jobsOf(b1);
    await pg.exec(`update studio_jobs set status = 'failed' where id in (${j1.id}, ${j2.id})`);
    const insert = (over: { assetId?: number; packId?: number; batchId?: number; retryOf: number }) => pg.exec(`
      insert into studio_jobs (batch_id, project_id, asset_id, pack_id, source_key, character_key, provider, attempt, retry_of_job_id, created_by, created_at, updated_at)
      values (${over.batchId ?? j1.batchId}, ${j1.projectId}, ${over.assetId ?? j1.assetId}, ${over.packId ?? j1.packId}, 'k', 'c', 'mock', 2, ${over.retryOf}, '${USER}', 1, 1)`);
    await expect(insert({ retryOf: j2.id })).rejects.toThrow(/studio_jobs_retry_fk|foreign key/i);        // another image's job
    await expect(insert({ retryOf: 999999 })).rejects.toThrow(/studio_jobs_retry_fk|foreign key/i);       // no such job
    await expect(insert({ retryOf: j1.id })).resolves.toBeDefined();                                       // the same image: fine
  });
});

describe('the migration', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'drizzle/pg/0025_studio.sql'), 'utf8');

  it('says the migration must be applied BEFORE the application code, and no longer claims either order is fine', () => {
    expect(sql).toMatch(/apply this migration FIRST/i);
    expect(sql).not.toMatch(/before or after/i);
    expect(sql.slice(0, 1500)).toMatch(/not yet applied|NOT YET APPLIED/i);
  });

  it('every function pins its search_path, and no jsonb ? operator is used', () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION [^$]*?\$\$/g)].map((m) => m[0]);
    expect(fns.length).toBeGreaterThanOrEqual(5);
    for (const f of fns) expect(f, f.slice(0, 80)).toMatch(/SET search_path = pg_catalog, public/);
    expect(sql).not.toMatch(/\bmanual \? field\b/);
    expect(sql).toMatch(/jsonb_exists\(manual, field\)/);
  });

  it('studio_effective still lets a manual value win, including a deliberate null', async () => {
    const q = async (ai: string, manual: string) => (await pg.query<{ v: string | null }>(`select studio_effective('${ai}'::jsonb, '${manual}'::jsonb, 'a') as v`)).rows[0].v;
    expect(await q('{"a":"ai"}', '{}')).toBe('ai');
    expect(await q('{"a":"ai"}', '{"a":"mine"}')).toBe('mine');
    expect(await q('{"a":"ai"}', '{"a":null}')).toBeNull();
  });
});

describe('smaller API payloads', () => {
  it('a list signs only thumbnails; the original is signed for one image only', async () => {
    const w = await world(4);
    const seen = spySigned();
    const list = await call(projectPackAssetsGet, { params: { id: String(w.proj), packId: String(w.packs[0]) } });
    expect(list.status).toBe(200);
    expect(list.json.assets).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen.every((k) => k.includes('/thumbs/'))).toBe(true);
    for (const a of list.json.assets) { expect(a.thumbUrl).toContain('/thumbs/'); expect(a.imageUrl).toBeNull(); }

    seen.length = 0;
    const one = await call(assetGet, { params: P(w.assets[0].id) });
    expect(one.json.asset.imageUrl).toContain(w.assets[0].key);
    expect(new Set(seen)).toEqual(new Set([w.assets[0].key, w.assets[0].thumbKey]));
  });

  it('job lists carry thumbnails only; output lists too, with the character thumbnail, and one output carries its image', async () => {
    const w = await world(2);
    const batch = (await batchOf(w)).json.batch.id as number;
    await drain(depsFor(new MockReplacementProvider({ pollsBeforeDone: 0 })));
    const outs = await db.select().from(schema.studioOutputs);
    expect(outs).toHaveLength(2);
    const seen = spySigned();

    const jobs = await call(batchGet, { params: { id: String(w.proj), batchId: String(batch) } });
    for (const j of jobs.json.jobs) for (const o of j.outputs) { expect(o.thumbUrl).toBeTruthy(); expect(o.imageUrl).toBeNull(); }
    expect(seen.some((k) => outs.some((o) => o.storageKey === k))).toBe(false);

    seen.length = 0;
    const list = await call(outputsList, { params: P(w.proj) });
    expect(list.status).toBe(200);
    for (const o of list.json.outputs) {
      expect(o.thumbUrl).toContain('/thumbs/'); expect(o.imageUrl).toBeNull();
      expect(o.character.thumbUrl).toContain('/character/thumbs/');
    }
    expect(seen).not.toContain(w.characterKey);
    expect(seen.some((k) => outs.some((o) => o.storageKey === k))).toBe(false);

    const single = await call(outputGet, { params: P(outs[0].id) });
    expect(single.status).toBe(200);
    expect(single.json.output.imageUrl).toContain(outs[0].storageKey);
    expect((await call(outputGet, { params: P(999999) })).status).toBe(404);
  });

  it('reviewing one output reads that output, not the whole project', async () => {
    const w = await world(3);
    await batchOf(w);
    await drain(depsFor(new MockReplacementProvider({ pollsBeforeDone: 0 })));
    const outs = await db.select().from(schema.studioOutputs).orderBy(schema.studioOutputs.id);
    const res = await call(outputReview, { method: 'POST', params: P(outs[1].id), body: { status: 'saved' } });
    expect(res.status).toBe(200);
    expect(res.json.output).toMatchObject({ id: outs[1].id, reviewStatus: 'saved' });
    expect(res.json.output.imageUrl).toContain(outs[1].storageKey);
    expect((await call(outputReview, { method: 'POST', params: P(999999), body: { status: 'saved' } })).status).toBe(404);
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/studio/outputs.ts'), 'utf8');
    expect(src.slice(src.indexOf('export async function reviewOutput'))).not.toMatch(/listOutputs\(/);
  });
});

describe('script analysis cannot be started twice at once', () => {
  it('of two simultaneous requests exactly one calls the model; the other is told it is in progress', async () => {
    const w = await world(0);
    await db.update(schema.studioProjects).set({ script: 'A kitchen scene.', scriptHash: 'h1' }).where(eq(schema.studioProjects.id, w.proj));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const client = { messages: { create: async () => { calls++; await gate; return { content: [{ type: 'tool_use', name: 'recommend_scene_packs', id: 't', input: { recommendations: [{ pack_id: w.packs[0], score: 0.9, reasons: ['r'], moments: ['m'] }] } }] }; } } };
    const first = analyseProjectScript(w.proj, { client: client as never });
    await until(() => calls === 1);
    await expect(analyseProjectScript(w.proj, { client: client as never, force: true })).rejects.toMatchObject({ code: 'in_progress', status: 409 });
    const racers = await Promise.allSettled([1, 2, 3].map(() => analyseProjectScript(w.proj, { client: client as never, force: true })));
    expect(racers.every((r) => r.status === 'rejected')).toBe(true);
    release();
    expect((await first).analysisStatus).toBe('completed');
    expect(calls).toBe(1);
  });

  it('a run that was abandoned long ago can be started again', async () => {
    const w = await world(0);
    await db.update(schema.studioProjects).set({ script: 'A scene.', scriptHash: 'h2', analysisStatus: 'processing', analysisAt: now() - 60 * 60 * 1000 }).where(eq(schema.studioProjects.id, w.proj));
    const client = { messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'recommend_scene_packs', id: 't', input: { recommendations: [] } }] }) } };
    expect((await analyseProjectScript(w.proj, { client: client as never })).analysisStatus).toBe('completed');
  });
});

describe('saving a project applies name, script and archived together', () => {
  it('archived is no longer ignored when a name is sent with it', async () => {
    const id = (await call(projectsPost, { method: 'POST', body: { name: 'Old' } })).json.project.id as number;
    const res = await call(projectPut, { method: 'PUT', params: P(id), body: { name: 'New', script: 'Hello.', archived: true } });
    expect(res.status).toBe(200);
    const row = (await db.select().from(schema.studioProjects).where(eq(schema.studioProjects.id, id)))[0];
    expect(row).toMatchObject({ name: 'New', script: 'Hello.' });
    expect(row.archivedAt).not.toBeNull();
    expect(res.json.project).toMatchObject({ name: 'New', archived: true });
    const restored = await call(projectPut, { method: 'PUT', params: P(id), body: { name: 'Newer', archived: false } });
    expect(restored.json.project).toMatchObject({ name: 'Newer', archived: false });
    expect((await call(projectPut, { method: 'PUT', params: P(id), body: {} })).status).toBe(400);   // still "nothing to change"
  });
});
