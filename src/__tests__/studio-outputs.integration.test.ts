/** Review of generated images: save, reject, regenerate. Nothing is ever deleted; a saved output keeps its full lineage. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate, call, reportFakeWorker } from './helpers/studio-fakes';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown, userId: '00000000-0000-4000-8000-00000000000a' as string | null }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { POST as projectsPost } from '@/app/api/v1/studio/projects/route';
import { POST as approvePacks } from '@/app/api/v1/studio/projects/[id]/packs/route';
import { POST as selectionPost } from '@/app/api/v1/studio/projects/[id]/selection/route';
import { POST as batchesPost } from '@/app/api/v1/studio/projects/[id]/batches/route';
import { POST as retryPost } from '@/app/api/v1/studio/jobs/[id]/retry/route';
import { POST as regeneratePost } from '@/app/api/v1/studio/jobs/[id]/regenerate/route';
import { GET as outputsGet } from '@/app/api/v1/studio/projects/[id]/outputs/route';
import { POST as reviewPost } from '@/app/api/v1/studio/outputs/[id]/review/route';
import { generationRound, type GenerationDeps } from '@/lib/studio/generation';
import { MockReplacementProvider } from '@/lib/studio/mock-provider';
import { ObjectExistsError } from '@/lib/object-store/types';

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
let r2: FakeR2;
beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); delete process.env.STUDIO_PROVIDER; });
beforeEach(async () => {
  r2 = new FakeR2(); holder.store = r2; holder.userId = USER_A;
  process.env.STUDIO_PROVIDER = 'mock'; // generation is off unless a provider is chosen on purpose
  await reportFakeWorker(pg);          // and batches need a worker that reports the same provider
  await pg.exec('truncate studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects restart identity cascade');
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (c: string) => sharp({ create: { width: 300, height: 200, channels: 3, background: c } }).png().toBuffer();
const P = (id: number) => ({ id: String(id) });
const now = () => Date.now();

async function ran(count = 3) {
  const proj = (await call(projectsPost, { method: 'POST', body: { name: 'R' } })).json.project.id as number;
  const key = `studio/projects/${proj}/character/${crypto.randomUUID()}.png`;
  r2.browserPut(key, await png('#aa5533'), 'image/png');
  const thumb = key.replace('/character/', '/character/thumbs/').replace(/\.png$/, '.webp');
  r2.browserPut(thumb, await png('#aa5533'), 'image/webp');
  await db.update(schema.studioProjects).set({ characterKey: key, characterMime: 'image/png' }).where(eq(schema.studioProjects.id, proj));
  const pk = (await db.insert(schema.studioPacks).values({ name: 'Kitchens', createdBy: USER_A, createdAt: now(), updatedAt: now() }).returning())[0].id;
  await call(approvePacks, { method: 'POST', params: P(proj), body: { packIds: [pk] } });
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const buf = await png(`#${(40 + i * 30).toString(16)}6688`); const k = `studio/assets/${crypto.randomUUID()}.png`; r2.browserPut(k, buf, 'image/png');
    ids.push((await db.insert(schema.studioAssets).values({ packId: pk, storageKey: k, mime: 'image/png', sizeBytes: buf.length, sha256: sha(buf), createdBy: USER_A, createdAt: now(), updatedAt: now() }).returning())[0].id);
  }
  await call(selectionPost, { method: 'POST', params: P(proj), body: { assetIds: ids } });
  const batch = (await call(batchesPost, { method: 'POST', params: P(proj), body: {} })).json.batch.id as number;
  const deps = (): GenerationDeps => ({
    provider: () => new MockReplacementProvider({ pollsBeforeDone: 0 }),
    read: (k) => r2.downloadR2Only('uploads', k),
    put: async (k, b, m) => { try { await r2.putR2Only('uploads', k, b, { contentType: m }); return 'created'; } catch (e) { if (e instanceof ObjectExistsError) return 'exists'; throw e; } },
  });
  const drain = async () => { for (let i = 0; i < 20; i++) { await db.update(schema.studioJobs).set({ nextPollAt: 0 }).where(eq(schema.studioJobs.status, 'processing')); if ((await generationRound(deps(), { submit: 4, poll: 20 })) === 0) return; } };
  await drain();
  return { proj, pk, ids, batch, key, drain };
}
const list = async (proj: number, q?: string) => (await call(outputsGet, { params: P(proj), query: q })).json;
const review = (id: number, status: unknown) => call(reviewPost, { method: 'POST', params: P(id), body: { status } });

describe('reviewing outputs', () => {
  it('requires a signed-in user; then any user can review, and the reviewer is recorded', async () => {
    const w = await ran(1);
    const out = (await list(w.proj)).outputs[0];
    holder.userId = null;
    expect((await call(outputsGet, { params: P(w.proj) })).status).toBe(401);
    expect((await review(out.id, 'saved')).status).toBe(401);
    holder.userId = USER_B;
    const r = await review(out.id, 'saved');
    expect(r.status).toBe(200);
    expect(r.json.output).toMatchObject({ reviewStatus: 'saved', reviewedBy: USER_B });
    expect(r.json.output.reviewedAt).toBeGreaterThan(0);
  });

  it('lists every output with its lineage: source image and pack, character, job and attempt, batch', async () => {
    const w = await ran(3);
    const res = await list(w.proj);
    expect(res.outputs).toHaveLength(3);
    expect(res.counts).toEqual({ pending: 3, saved: 0, rejected: 0 });
    for (const o of res.outputs) {
      expect(o.source).toMatchObject({ packId: w.pk, packName: 'Kitchens', archived: false });
      expect(w.ids).toContain(o.source.assetId);
      expect(o.job).toMatchObject({ attempt: 1, status: 'succeeded', provider: 'mock' });
      expect(o.batch.id).toBe(w.batch);
      expect(o.thumbUrl).toContain('thumbs');
      expect(o.character.thumbUrl).toContain('/character/thumbs/'); // the small copy, never the original
      expect(o.character.thumbUrl).not.toContain(w.key);
    }
  });

  it('saves, rejects and resets, filters by status, and never deletes a file', async () => {
    const w = await ran(3);
    const [a, b, c] = (await list(w.proj)).outputs;
    await review(a.id, 'saved'); await review(b.id, 'rejected');
    expect((await list(w.proj)).counts).toEqual({ pending: 1, saved: 1, rejected: 1 });
    expect((await list(w.proj, 'status=saved')).outputs.map((o: any) => o.id)).toEqual([a.id]);
    expect((await list(w.proj, 'status=rejected')).outputs.map((o: any) => o.id)).toEqual([b.id]);
    expect((await list(w.proj, 'status=pending')).outputs.map((o: any) => o.id)).toEqual([c.id]);
    await review(b.id, 'pending');
    expect((await list(w.proj)).counts).toEqual({ pending: 2, saved: 1, rejected: 0 });
    expect((await call(outputsGet, { params: P(w.proj), query: 'status=bogus' })).status).toBe(400);
    expect((await review(a.id, 'maybe')).status).toBe(400);
    expect((await review(999999, 'saved')).status).toBe(404);
    expect(r2.deletes).toEqual([]);
    for (const o of await db.select().from(schema.studioOutputs)) expect(r2.has(o.storageKey)).toBe(true);
  });

  it('keeps the file and its job fixed: only the review fields can change', async () => {
    const w = await ran(1);
    const o = (await db.select().from(schema.studioOutputs))[0];
    await expect(db.update(schema.studioOutputs).set({ storageKey: 'x' }).where(eq(schema.studioOutputs.id, o.id))).rejects.toThrow();
    await expect(db.delete(schema.studioOutputs).where(eq(schema.studioOutputs.id, o.id))).rejects.toThrow();
    expect(w.proj).toBeGreaterThan(0);
  });
});

describe('regenerating one image', () => {
  it('creates a new job for that image only; the first output (and its saved state) is kept next to the new one', async () => {
    const w = await ran(3);
    const outs = (await list(w.proj)).outputs;
    const target = outs[0];
    await review(target.id, 'saved');
    const others = await db.select().from(schema.studioJobs).where(eq(schema.studioJobs.batchId, w.batch));
    const res = await call(regeneratePost, { method: 'POST', params: P(target.job.id) });
    expect(res.status).toBe(201);
    expect(res.json.job).toMatchObject({ attempt: 2, retryOfJobId: target.job.id, status: 'queued', assetId: target.source.assetId });
    await w.drain();
    const after = await list(w.proj);
    expect(after.outputs).toHaveLength(4);
    const forAsset = after.outputs.filter((o: any) => o.source.assetId === target.source.assetId);
    expect(forAsset.map((o: any) => [o.job.attempt, o.reviewStatus]).sort()).toEqual([[1, 'saved'], [2, 'pending']]);  // the saved one is untouched
    // the other jobs did not change
    const jobs = await db.select().from(schema.studioJobs).where(eq(schema.studioJobs.batchId, w.batch));
    for (const j of others) expect(jobs.find((x) => x.id === j.id)).toMatchObject({ status: j.status, providerJobId: j.providerJobId, attempt: 1 });
    expect(jobs).toHaveLength(4);
  });

  it('only a finished job can be regenerated, only once at a time, and "retry" still only accepts failed jobs', async () => {
    const w = await ran(2);
    const out = (await list(w.proj)).outputs[0];
    expect((await call(retryPost, { method: 'POST', params: P(out.job.id) })).json.code).toBe('not_failed');   // retry is for failed jobs
    expect((await call(regeneratePost, { method: 'POST', params: P(out.job.id) })).status).toBe(201);
    expect((await call(regeneratePost, { method: 'POST', params: P(out.job.id) })).json.code).toBe('already_active');
    expect((await call(regeneratePost, { method: 'POST', params: P(999999) })).status).toBe(404);
    holder.userId = null;
    expect((await call(regeneratePost, { method: 'POST', params: P(out.job.id) })).status).toBe(401);
  });
});
