/**
 * Batches and jobs: one independent, individually tracked and retryable job per image; originals unchanged; outputs in R2
 * only; a job with a provider job id is never submitted again; history is preserved. The provider is the mock; storage is an
 * in-memory R2; the database is an in-memory Postgres built from the repository's migrations. No real provider is involved.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate, call, reportFakeWorker } from './helpers/studio-fakes';

const USER = '00000000-0000-4000-8000-00000000000a';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown, userId: '00000000-0000-4000-8000-00000000000a' as string | null }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { POST as projectsPost } from '@/app/api/v1/studio/projects/route';
import { POST as approvePacks } from '@/app/api/v1/studio/projects/[id]/packs/route';
import { POST as selectionPost } from '@/app/api/v1/studio/projects/[id]/selection/route';
import { GET as batchesGet, POST as batchesPost } from '@/app/api/v1/studio/projects/[id]/batches/route';
import { GET as batchGet } from '@/app/api/v1/studio/projects/[id]/batches/[batchId]/route';
import { POST as retryPost } from '@/app/api/v1/studio/jobs/[id]/retry/route';
import { POST as assetArchive } from '@/app/api/v1/studio/assets/[id]/archive/route';
import { claimQueuedJobs, generationRound, pollJob, pollDelayMs, recoverStaleJobs, storeOutput, SUBMIT_LEASE_MS, JOB_MAX_AGE_MS, type GenerationDeps } from '@/lib/studio/generation';
import { MockReplacementProvider, getProvider } from '@/lib/studio/mock-provider';
import { ProviderError, type ReplacementProvider } from '@/lib/studio/provider';
import { ObjectExistsError } from '@/lib/object-store/types';

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
let r2: FakeR2;
beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); delete process.env.STUDIO_PROVIDER; });
beforeEach(async () => {
  r2 = new FakeR2(); holder.store = r2; holder.userId = USER;
  process.env.STUDIO_PROVIDER = 'mock'; // generation is off unless a provider is chosen on purpose
  await reportFakeWorker(pg);          // and batches need a worker that reports the same provider
  // each test starts from an empty Studio (TRUNCATE does not fire the "never delete" row triggers)
  await pg.exec('truncate studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects restart identity cascade');
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (color: string, w = 400, h = 300) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const P = (id: number) => ({ id: String(id) });
let seq = 0;
const now = () => Date.now();

interface World { proj: number; characterKey: string; characterBuf: Buffer; assets: Array<{ id: number; packId: number; key: string; buf: Buffer; sha: string }> }

/** A project with a character image, approved packs holding `count` source images (stored in R2), all selected. */
async function world(count: number, opts: { select?: boolean } = {}): Promise<World> {
  const proj = (await call(projectsPost, { method: 'POST', body: { name: 'World' } })).json.project.id as number;
  const characterBuf = await png('#aa6633', 600, 800);
  const characterKey = `studio/projects/${proj}/character/${crypto.randomUUID()}.png`;
  r2.browserPut(characterKey, characterBuf, 'image/png');
  await db.update(schema.studioProjects).set({ characterKey, characterMime: 'image/png' }).where(eq(schema.studioProjects.id, proj));
  const packA = (await db.insert(schema.studioPacks).values({ name: `A${++seq}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
  const packB = (await db.insert(schema.studioPacks).values({ name: `B${++seq}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
  await call(approvePacks, { method: 'POST', params: P(proj), body: { packIds: [packA, packB] } });
  const assets: World['assets'] = [];
  for (let i = 0; i < count; i++) {
    const buf = await png(`#${((i * 37 + 40) % 255).toString(16).padStart(2, '0')}4477`, 300 + i, 200);
    const key = `studio/assets/${crypto.randomUUID()}.png`;
    r2.browserPut(key, buf, 'image/png');
    const packId = i % 2 === 0 ? packA : packB;
    const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: key, mime: 'image/png', sizeBytes: buf.length, sha256: sha(buf), createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
    assets.push({ id: a.id, packId, key, buf, sha: sha(buf) });
  }
  if (opts.select !== false) await call(selectionPost, { method: 'POST', params: P(proj), body: { assetIds: assets.map((a) => a.id) } });
  return { proj, characterKey, characterBuf, assets };
}

const depsFor = (provider: ReplacementProvider, over: Partial<GenerationDeps> = {}): GenerationDeps => ({
  provider: () => provider,
  read: (key) => r2.downloadR2Only('uploads', key),
  put: async (key, body, mime) => { try { await r2.putR2Only('uploads', key, body, { contentType: mime }); return 'created'; } catch (e) { if (e instanceof ObjectExistsError) return 'exists'; throw e; } },
  ...over,
});
const jobsOf = (batchId: number) => db.select().from(schema.studioJobs).where(eq(schema.studioJobs.batchId, batchId)).orderBy(schema.studioJobs.id);
async function drain(deps: GenerationDeps, rounds = 60) {
  for (let i = 0; i < rounds; i++) {
    // make every running job due immediately so the test does not wait
    await db.update(schema.studioJobs).set({ nextPollAt: 0 }).where(eq(schema.studioJobs.status, 'processing'));
    if ((await generationRound(deps, { submit: 4, poll: 20 })) === 0) return;
  }
}
const batchOf = async (w: World) => (await call(batchesPost, { method: 'POST', params: P(w.proj), body: {} }));

describe('creating a batch: one independent job per selected image', () => {
  it('turns 15 selected images from two packs into 15 queued jobs, each with its own snapshot, and keeps the selection', async () => {
    const w = await world(15);
    const res = await batchOf(w);
    expect(res.status).toBe(201);
    expect(res.json.batch.totalJobs).toBe(15);
    expect(res.json.jobs).toHaveLength(15);
    expect(res.json.summary).toMatchObject({ total: 15, queued: 15 });
    const jobs = await jobsOf(res.json.batch.id);
    expect(new Set(jobs.map((j) => j.assetId)).size).toBe(15);
    for (const j of jobs) {
      const a = w.assets.find((x) => x.id === j.assetId)!;
      expect(j).toMatchObject({ status: 'queued', attempt: 1, packId: a.packId, sourceKey: a.key, characterKey: w.characterKey, providerJobId: null, retryOfJobId: null, provider: 'mock' });
    }
    expect(await db.select().from(schema.studioSelections).where(eq(schema.studioSelections.projectId, w.proj))).toHaveLength(15);
    expect((await call(batchesGet, { params: P(w.proj) })).json.batches[0]).toMatchObject({ id: res.json.batch.id, totalJobs: 15 });
  });

  it('needs a character image, a non-empty selection, no archived images, and stays within the batch limit', async () => {
    const w = await world(3);
    await db.update(schema.studioProjects).set({ characterKey: null }).where(eq(schema.studioProjects.id, w.proj));
    expect((await batchOf(w)).json.code).toBe('character_required');
    await db.update(schema.studioProjects).set({ characterKey: w.characterKey }).where(eq(schema.studioProjects.id, w.proj));

    await call(assetArchive, { method: 'POST', params: { id: String(w.assets[1].id) }, body: {} });
    const blocked = await batchOf(w);
    expect(blocked.status).toBe(409);
    expect(blocked.json).toMatchObject({ code: 'archived_in_selection', archivedIds: [w.assets[1].id] });
    expect(await db.select().from(schema.studioBatches).where(eq(schema.studioBatches.projectId, w.proj))).toHaveLength(0);

    const empty = await world(2, { select: false });
    expect((await batchOf(empty)).json.code).toBe('empty_selection');

    process.env.STUDIO_MAX_BATCH = '2';
    try { expect((await call(batchesPost, { method: 'POST', params: P(empty.proj), body: {} })).status).toBe(400); } finally { delete process.env.STUDIO_MAX_BATCH; }
  });

  it('can submit a chosen part of the selection, and refuses images that are not selected', async () => {
    const w = await world(4);
    const part = await call(batchesPost, { method: 'POST', params: P(w.proj), body: { assetIds: [w.assets[0].id, w.assets[2].id] } });
    expect(part.json.batch.totalJobs).toBe(2);
    const other = await world(1);
    expect((await call(batchesPost, { method: 'POST', params: P(w.proj), body: { assetIds: [other.assets[0].id] } })).json.code).toBe('not_selected');
  });

  it('does not queue an image that already has a job running (double click)', async () => {
    const w = await world(3);
    expect((await batchOf(w)).status).toBe(201);
    const again = await batchOf(w);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('already_running');
    expect(await db.select().from(schema.studioBatches).where(eq(schema.studioBatches.projectId, w.proj))).toHaveLength(1);
  });

  it('requires a signed-in user', async () => {
    const w = await world(1);
    holder.userId = null;
    expect((await batchOf(w)).status).toBe(401);
    expect((await call(retryPost, { method: 'POST', params: P(1) })).status).toBe(401);
    expect((await call(batchGet, { params: { id: String(w.proj), batchId: '1' } })).status).toBe(401);
  });
});

describe('running a batch: originals in, outputs in R2, nothing overwritten', () => {
  it('sends the ORIGINAL character and source images to the provider, stores 15 outputs in R2 with thumbnails, and leaves every original byte-identical', async () => {
    const w = await world(15);
    const batch = (await batchOf(w)).json.batch.id as number;
    const provider = new MockReplacementProvider({ pollsBeforeDone: 1 });
    await drain(depsFor(provider));

    expect(provider.submitted).toHaveLength(15);                         // each job submitted exactly once
    for (const s of provider.submitted) {
      const job = (await db.select().from(schema.studioJobs).where(eq(schema.studioJobs.id, s.jobId)))[0];
      const a = w.assets.find((x) => x.id === job.assetId)!;
      expect(sha(s.sourceBuf)).toBe(a.sha);                              // the provider received the original source image
      expect(sha(s.characterBuf)).toBe(sha(w.characterBuf));             // and the original character image
    }
    const jobs = await jobsOf(batch);
    expect(jobs.every((j) => j.status === 'succeeded' && j.providerJobId === `mock-${j.id}` && j.finishedAt)).toBe(true);
    const outputs = await db.select().from(schema.studioOutputs).where(eq(schema.studioOutputs.projectId, w.proj));
    expect(outputs).toHaveLength(15);
    for (const o of outputs) {
      expect(o.storageKey).toMatch(new RegExp(`^studio/projects/${w.proj}/outputs/\\d+-a1\\.png$`));
      expect(sha(r2.get(o.storageKey))).toBe(o.sha256);
      expect(r2.has(o.thumbKey!)).toBe(true);
      expect(o).toMatchObject({ reviewStatus: 'pending', assetId: jobs.find((j) => j.id === o.jobId)!.assetId });
    }
    for (const a of w.assets) expect(sha(r2.get(a.key))).toBe(a.sha);   // source images untouched
    expect(sha(r2.get(w.characterKey))).toBe(sha(w.characterBuf));
    expect(r2.deletes).toEqual([]);
    expect((await call(batchGet, { params: { id: String(w.proj), batchId: String(batch) } })).json.summary).toMatchObject({ total: 15, succeeded: 15 });
  });

  it('never overwrites an existing object: running storage twice for one job gives one output and one file', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    const provider = new MockReplacementProvider({ pollsBeforeDone: 0 });
    const deps = depsFor(provider);
    await drain(deps);
    const job = (await jobsOf(batch))[0];
    const puts = r2.puts.length;
    await storeOutput(job, { bytes: await png('#00ff00'), mime: 'image/png' }, deps, provider); // a repeat after a crash
    expect(await db.select().from(schema.studioOutputs).where(eq(schema.studioOutputs.jobId, job.id))).toHaveLength(1);
    expect(r2.puts.length).toBe(puts);
    const out = (await db.select().from(schema.studioOutputs).where(eq(schema.studioOutputs.jobId, job.id)))[0];
    expect(sha(r2.get(out.storageKey))).toBe(out.sha256);             // the first stored file is the one that stays
  });
});

describe('independent jobs: one failure never affects another', () => {
  it('15 jobs where some fail at submit and some while running: the others all succeed, each failure keeps its own error', async () => {
    const w = await world(15);
    const batch = (await batchOf(w)).json.batch.id as number;
    const failSource = new Set([w.assets[2].sha, w.assets[7].sha, w.assets[11].sha]);
    let failPollFor = '';
    const provider = new MockReplacementProvider({
      pollsBeforeDone: 1,
      failSubmit: (i) => (failSource.has(sha(i.sourceImage)) ? { code: 'rejected', message: 'The provider rejected this image.', retryable: false } : null),
      failPoll: (id) => (id === failPollFor ? { code: 'render_failed', message: 'The render did not finish.', retryable: true } : null),
    });
    // pick two jobs (by asset) to fail while running
    const jobs0 = await jobsOf(batch);
    failPollFor = `mock-${jobs0.find((j) => j.assetId === w.assets[4].id)!.id}`;
    await drain(depsFor(provider));

    const jobs = await jobsOf(batch);
    const by = (assetId: number) => jobs.find((j) => j.assetId === assetId)!;
    for (const idx of [2, 7, 11]) expect(by(w.assets[idx].id)).toMatchObject({ status: 'failed', errorCode: 'rejected', errorMessage: 'The provider rejected this image.', errorRetryable: false, providerJobId: null });
    expect(by(w.assets[4].id)).toMatchObject({ status: 'failed', errorCode: 'render_failed', errorRetryable: true, providerJobId: failPollFor });
    expect(jobs.filter((j) => j.status === 'succeeded')).toHaveLength(11);
    expect((await db.select().from(schema.studioOutputs).where(eq(schema.studioOutputs.projectId, w.proj)))).toHaveLength(11);
    expect((await call(batchGet, { params: { id: String(w.proj), batchId: String(batch) } })).json.summary).toMatchObject({ total: 15, succeeded: 11, failed: 4 });
  });

  it('an unknown provider error is recorded without quoting its text, and an unavailable provider fails only its own jobs', async () => {
    const w = await world(2);
    const batch = (await batchOf(w)).json.batch.id as number;
    const exploding: ReplacementProvider = { id: 'mock', submit: async () => { throw Object.assign(new Error('request: Bearer sk-secret-token image=...'), { name: 'FetchError', status: 502 }); }, poll: async () => ({ status: 'processing' }) };
    await drain(depsFor(exploding));
    const jobs = await jobsOf(batch);
    // an unexplained error from submit does not prove the provider did nothing: the outcome is "unknown", and no request text is kept
    expect(jobs.every((j) => j.status === 'submit_unknown' && j.errorCode === 'submit_error' && j.errorRetryable === null)).toBe(true);
    expect(JSON.stringify(jobs)).not.toContain('sk-secret');

    const w2 = await world(1);
    const b2 = (await batchOf(w2)).json.batch.id as number;
    await drain(depsFor(exploding, { provider: (id) => { if (id === 'mock') throw new ProviderError('The "mock" provider is not available yet.', 'provider_unavailable', false); return exploding; } }));
    expect((await jobsOf(b2))[0]).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable', errorRetryable: false });
  });
});

describe('retrying one job', () => {
  async function failedWorld() {
    const w = await world(6);
    const batch = (await batchOf(w)).json.batch.id as number;
    const badSha = w.assets[3].sha;
    const provider = new MockReplacementProvider({ failSubmit: (i) => (sha(i.sourceImage) === badSha ? { code: 'rejected', message: 'No.', retryable: true } : null) });
    await drain(depsFor(provider));
    const jobs = await jobsOf(batch);
    return { w, batch, provider, failed: jobs.find((j) => j.status === 'failed')!, jobs };
  }

  it('creates ONE new job for that image only, keeps the failed one, and leaves every other job untouched', async () => {
    const { w, batch, failed, jobs } = await failedWorld();
    const before = new Map(jobs.map((j) => [j.id, JSON.stringify(j)]));
    const providerCalls = new MockReplacementProvider();
    const res = await call(retryPost, { method: 'POST', params: P(failed.id) });
    expect(res.status).toBe(201);
    expect(res.json.job).toMatchObject({ attempt: 2, retryOfJobId: failed.id, status: 'queued', assetId: failed.assetId, batchId: batch });

    const after = await jobsOf(batch);
    expect(after).toHaveLength(jobs.length + 1);                          // exactly one new row
    for (const j of jobs) expect(JSON.stringify(after.find((x) => x.id === j.id))).toBe(before.get(j.id));  // nothing else changed
    expect(after.find((x) => x.id === failed.id)).toMatchObject({ status: 'failed', errorCode: 'rejected' }); // history kept

    await drain(depsFor(providerCalls));
    expect(providerCalls.submitted).toHaveLength(1);                      // only that one image went to the provider again
    expect(providerCalls.submitted[0].jobId).toBe(res.json.job.id);
    const summary = (await call(batchGet, { params: { id: String(w.proj), batchId: String(batch) } })).json.summary;
    expect(summary).toMatchObject({ total: 6, succeeded: 6, failed: 0 });  // the latest attempt of each image counts
    const detail = (await call(batchGet, { params: { id: String(w.proj), batchId: String(batch) } })).json.jobs;
    expect(detail.filter((j: any) => j.assetId === failed.assetId).map((j: any) => [j.attempt, j.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
    expect((await db.select().from(schema.studioOutputs).where(eq(schema.studioOutputs.jobId, res.json.job.id)))[0].storageKey).toMatch(/-a2\.png$/);
  });

  it('refuses to retry a job that did not fail, one already retried, one still running, or one whose image is archived', async () => {
    const { failed, jobs } = await failedWorld();
    const ok = jobs.find((j) => j.status === 'succeeded')!;
    expect((await call(retryPost, { method: 'POST', params: P(ok.id) })).json.code).toBe('not_failed');
    expect((await call(retryPost, { method: 'POST', params: P(999999) })).status).toBe(404);
    expect((await call(retryPost, { method: 'POST', params: P(failed.id) })).status).toBe(201);
    expect((await call(retryPost, { method: 'POST', params: P(failed.id) })).json.code).toBe('already_active');

    const other = await failedWorld();
    await call(assetArchive, { method: 'POST', params: { id: String(other.failed.assetId) }, body: {} });
    const blocked = await call(retryPost, { method: 'POST', params: P(other.failed.id) });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('asset_archived');
    // archiving kept the whole history
    expect(await db.select().from(schema.studioJobs).where(eq(schema.studioJobs.assetId, other.failed.assetId))).toHaveLength(1);
  });

  it('a retry can fail again and be retried again; every attempt stays on record', async () => {
    const w = await world(2);
    const batch = (await batchOf(w)).json.batch.id as number;
    const badSha = w.assets[0].sha;
    const provider = new MockReplacementProvider({ failSubmit: (i) => (sha(i.sourceImage) === badSha ? { code: 'rejected', message: 'No.', retryable: true } : null) });
    await drain(depsFor(provider));
    let failed = (await jobsOf(batch)).find((j) => j.status === 'failed')!;
    for (let n = 2; n <= 3; n++) {
      const r = await call(retryPost, { method: 'POST', params: P(failed.id) });
      expect(r.json.job).toMatchObject({ attempt: n, retryOfJobId: failed.id });
      await drain(depsFor(provider));
      failed = (await jobsOf(batch)).filter((j) => j.assetId === failed.assetId).at(-1)!;
      expect(failed.status).toBe('failed');
    }
    expect((await jobsOf(batch)).filter((j) => j.assetId === w.assets[0].id).map((j) => j.attempt)).toEqual([1, 2, 3]);
  });
});

describe('never submitted twice: provider job ids, restarts and recovery', () => {
  it('after a worker restart a running job keeps being polled, and is never submitted again', async () => {
    const w = await world(3);
    const batch = (await batchOf(w)).json.batch.id as number;
    const first = new MockReplacementProvider({ pollsBeforeDone: 99 });
    await generationRound(depsFor(first), { submit: 4, poll: 4 });               // all three submitted and now "processing"
    expect(first.submitted).toHaveLength(3);
    const running = await jobsOf(batch);
    expect(running.every((j) => j.status === 'processing' && j.providerJobId)).toBe(true);

    // restart: a brand new provider instance (it has never seen these jobs), recovery runs, the loop continues
    const second = new MockReplacementProvider();
    expect(await recoverStaleJobs(now())).toEqual({ interrupted: 0, timedOut: 0 });
    await drain(depsFor(second));
    expect(second.submitted).toHaveLength(0);                                    // not one job was sent again
    expect((await jobsOf(batch)).every((j) => j.status === 'succeeded')).toBe(true);
    expect((await jobsOf(batch)).map((j) => j.providerJobId)).toEqual(running.map((j) => j.providerJobId)); // ids unchanged
  });

  it('the database itself refuses to change or clear a provider job id', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(new MockReplacementProvider({ pollsBeforeDone: 9 })), { submit: 1, poll: 1 });
    const job = (await jobsOf(batch))[0];
    await expect(db.update(schema.studioJobs).set({ providerJobId: 'other' }).where(eq(schema.studioJobs.id, job.id))).rejects.toThrow();
    await expect(db.update(schema.studioJobs).set({ providerJobId: null }).where(eq(schema.studioJobs.id, job.id))).rejects.toThrow();
  });

  it('a job found "submitting" after a crash is not sent again: its outcome is unknown, and a new job needs an explicit confirmation', async () => {
    const w = await world(2);
    const batch = (await batchOf(w)).json.batch.id as number;
    const crashed = await claimQueuedJobs(1, now() - SUBMIT_LEASE_MS - 1000);    // claimed long ago, then the worker died
    expect(crashed).toHaveLength(1);
    expect(await recoverStaleJobs(now())).toEqual({ interrupted: 1, timedOut: 0 });
    const job = (await jobsOf(batch)).find((j) => j.id === crashed[0].id)!;
    expect(job).toMatchObject({ status: 'submit_unknown', errorCode: 'submit_interrupted', providerJobId: null });
    expect(job.ambiguousAt).not.toBeNull();
    expect(job.errorMessage).toContain('was not sent again');
    const provider = new MockReplacementProvider();
    await drain(depsFor(provider));
    expect(provider.submitted.map((s) => s.jobId)).not.toContain(job.id);        // the interrupted job was not resubmitted by the loop
    const refused = await call(retryPost, { method: 'POST', params: P(job.id) }); // a plain retry could pay twice: refused
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('submit_unknown');
    const retry = await call(retryPost, { method: 'POST', params: P(job.id), body: { confirmDuplicate: true } }); // a person accepts that risk
    expect(retry.status).toBe(201);
    expect((await jobsOf(batch)).find((j) => j.id === job.id)).toMatchObject({ status: 'failed', errorCode: 'submit_unknown_abandoned' });
  });

  it('gives up on a job that has run far too long, but leaves recent ones alone', async () => {
    const w = await world(2);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(new MockReplacementProvider({ pollsBeforeDone: 99 })), { submit: 2, poll: 0 });
    const [old, recent] = await jobsOf(batch);
    await db.update(schema.studioJobs).set({ startedAt: now() - JOB_MAX_AGE_MS - 1000 }).where(eq(schema.studioJobs.id, old.id));
    expect(await recoverStaleJobs(now())).toEqual({ interrupted: 0, timedOut: 1 });
    const after = await jobsOf(batch);
    expect(after.find((j) => j.id === old.id)).toMatchObject({ status: 'failed', errorCode: 'timed_out' });
    expect(after.find((j) => j.id === recent.id)!.status).toBe('processing');
  });

  // C2 regression: the time limit counts from when the job was SENT to the provider, never from when it was queued.
  it('does not time out a job that waited in the queue for longer than the limit but only just started', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await db.update(schema.studioJobs).set({ createdAt: now() - 3 * JOB_MAX_AGE_MS }).where(eq(schema.studioJobs.batchId, batch)); // queued for 6 hours
    await generationRound(depsFor(new MockReplacementProvider({ pollsBeforeDone: 99 })), { submit: 1, poll: 0 });
    expect(await recoverStaleJobs(now())).toEqual({ interrupted: 0, timedOut: 0 });
    expect((await jobsOf(batch))[0].status).toBe('processing');
  });
});

describe('scheduling: atomic claims, back-off and bounded concurrency', () => {
  it('claims queued jobs atomically in order and never the same job twice', async () => {
    const w = await world(5);
    const batch = (await batchOf(w)).json.batch.id as number;
    const a = await claimQueuedJobs(2);
    const b = await claimQueuedJobs(2);
    const c = await claimQueuedJobs(2);
    expect([a.length, b.length, c.length]).toEqual([2, 2, 1]);
    expect(new Set([...a, ...b, ...c].map((j) => j.id)).size).toBe(5);
    expect((await jobsOf(batch)).every((j) => j.status === 'submitting' && j.claimedAt)).toBe(true);
    expect(await claimQueuedJobs(2)).toEqual([]);
  });

  it('asks again later with a growing delay while the provider is still working, and does not poll a job before its time', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    const provider = new MockReplacementProvider({ pollsBeforeDone: 99 });
    const deps = depsFor(provider);
    await generationRound(deps, { submit: 1, poll: 1 });
    let job = (await jobsOf(batch))[0];
    expect(job.nextPollAt).toBeGreaterThan(now());                            // not due yet
    expect(await generationRound(deps, { submit: 1, poll: 1 })).toBe(0);      // so nothing happens
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await db.update(schema.studioJobs).set({ nextPollAt: 0 }).where(eq(schema.studioJobs.id, job.id));
      const before = now();
      job = (await jobsOf(batch))[0];
      await pollJob(job, deps);
      job = (await jobsOf(batch))[0];
      delays.push(job.nextPollAt! - before);
    }
    expect(job.pollCount).toBe(4);
    expect(delays[3]).toBeGreaterThan(delays[0]);
    expect(pollDelayMs(100)).toBe(60_000);                                   // capped
  });

  it('handles a bounded number of jobs per round', async () => {
    const w = await world(10);
    const batch = (await batchOf(w)).json.batch.id as number;
    const provider = new MockReplacementProvider({ pollsBeforeDone: 99 });
    expect(await generationRound(depsFor(provider), { submit: 3, poll: 0 })).toBe(3);
    expect((await jobsOf(batch)).filter((j) => j.status === 'queued')).toHaveLength(7);
  });
});

describe('the provider contract', () => {
  it('the mock produces a valid image from the job alone, so polling after a restart gives the same picture', async () => {
    const p = new MockReplacementProvider();
    const a = await p.poll('mock-42'); const b = await new MockReplacementProvider().poll('mock-42');
    expect(a.status).toBe('succeeded'); expect(b.status).toBe('succeeded');
    if (a.status === 'succeeded' && b.status === 'succeeded') { expect(sha(a.output.bytes!)).toBe(sha(b.output.bytes!)); expect((await sharp(a.output.bytes!).metadata()).format).toBe('png'); }
  });

  it('only the mock exists for now; a real provider is not invented', () => {
    expect(getProvider('mock').id).toBe('mock');
    expect(() => getProvider('higgsfield')).toThrow('not available yet');
    const src = fs.readFileSync(path.resolve(__dirname, '../lib/studio/mock-provider.ts'), 'utf8') + fs.readFileSync(path.resolve(__dirname, '../lib/studio/provider.ts'), 'utf8');
    expect(src).not.toMatch(/https?:\/\/|api\.higgsfield|Authorization|apiKey/i);
  });

  it('keeps generation separate from the video loop and from Claude/Google Flow code', () => {
    const studio = fs.readFileSync(path.resolve(__dirname, '../worker/studio.ts'), 'utf8');
    expect(studio).not.toMatch(/useapi|video-workflow|compilation/);
    const index = fs.readFileSync(path.resolve(__dirname, '../worker/index.ts'), 'utf8');
    const tick = index.slice(index.indexOf('async function tick()'), index.indexOf('export async function processPromptTasks'));
    expect(tick).not.toMatch(/studio/i);
    for (const f of ['generation.ts', 'batches.ts', 'selection.ts']) {
      expect(fs.readFileSync(path.resolve(__dirname, '../lib/studio', f), 'utf8')).not.toMatch(/video-workflow|useapi|anthropic/i);
    }
  });
});

