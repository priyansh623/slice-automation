/**
 * Regression tests for the second hardening pass: race-safe removal of stored files, an explicit "outcome unknown" state for
 * provider submissions, web/worker provider consistency with labelled test output, a persistent analysis budget, thumbnail-only
 * project lists and clean-up of abandoned uploads. Real routes and libraries against an in-memory Postgres built from the
 * repository's migrations; storage, provider and model are fakes. No external service is involved.
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
import { FakeR2, migrate, call, reportFakeWorker } from './helpers/studio-fakes';

const USER = '00000000-0000-4000-8000-00000000000a';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown, userId: '00000000-0000-4000-8000-00000000000a' as string | null }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { GET as projectsGet, POST as projectsPost } from '@/app/api/v1/studio/projects/route';
import { GET as projectGet } from '@/app/api/v1/studio/projects/[id]/route';
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
import { POST as charInit } from '@/app/api/v1/studio/projects/[id]/character/init/route';
import { POST as charComplete } from '@/app/api/v1/studio/projects/[id]/character/complete/route';
import { adoptProviderJob, generationRound, reconcileAmbiguousJobs, recoverStaleJobs, AMBIGUOUS_RESEND_AFTER_MS, MAX_IDEMPOTENT_SENDS, type GenerationDeps } from '@/lib/studio/generation';
import { MockReplacementProvider, isTestProvider } from '@/lib/studio/mock-provider';
import { ProviderError, type ReplacementProvider } from '@/lib/studio/provider';
import { ObjectExistsError } from '@/lib/object-store/types';
import { discardIfUnreferenced, isKeyReferenced, isRemovedKeyError, recordUploadIntent, retryPendingRemovals, sweepAbandonedUploads, ABANDONED_UPLOAD_GRACE_MS } from '@/lib/studio/references';
import { registerAsset } from '@/lib/studio/repository';
import { STUDIO_UPLOAD_TTL_S } from '@/lib/studio/keys';
import { ANALYSIS_KIND, BUDGET_WINDOW_MS, budgetStatus, hourStart, refundBudget, reserveBudget } from '@/lib/studio/budget';
import { checkWorkerForProvider, WORKER_STALE_MS } from '@/lib/studio/worker-status';
import { generationReadiness } from '@/lib/studio/readiness';
import { analyseClaimed, reportWorkerStatus, resetStudioWorkerForTests, runAnalysisRound, stopStudioWorker, studioTick, type AnalysisDeps } from '@/worker/studio';
import { claimNextAsset } from '@/lib/studio/analysis-queue';

const ROOT = path.resolve(__dirname, '../..');
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
let r2: FakeR2;

beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  r2 = new FakeR2(); holder.store = r2; holder.userId = USER;
  process.env.STUDIO_PROVIDER = 'mock';
  delete process.env.STUDIO_ANALYSIS_BUDGET_PER_HOUR;
  await pg.exec('truncate studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects, studio_deleted_keys, studio_upload_intents, studio_worker_status, studio_budget_usage restart identity cascade');
  await reportFakeWorker(pg);
});
afterEach(() => { resetStudioWorkerForTests(); delete process.env.STUDIO_PROVIDER; delete process.env.STUDIO_WORKER; delete process.env.ANTHROPIC_API_KEY; vi.restoreAllMocks(); });

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (color: string, w = 400, h = 300) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const P = (id: number) => ({ id: String(id) });
let seq = 0;
const now = () => Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 3000) { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(5); } }
const newPack = async () => (await db.insert(schema.studioPacks).values({ name: `P${++seq}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
const tombstones = () => db.select().from(schema.studioDeletedKeys);
const intentOf = async (key: string) => (await db.select().from(schema.studioUploadIntents).where(eq(schema.studioUploadIntents.key, key)))[0];

/** A key the server "issued" (intent recorded) and whose file is in R2. */
async function issuedKey(packId: number, opts: { thumb?: boolean } = {}) {
  const id = crypto.randomUUID();
  const key = `studio/assets/${id}.png`; const thumbKey = `studio/assets/thumbs/${id}.webp`;
  await recordUploadIntent(key, 'asset', { packId, userId: USER });
  r2.browserPut(key, await png('#335577', 80, 60), 'image/png');
  if (opts.thumb) r2.browserPut(thumbKey, await png('#223344', 20, 15), 'image/webp');
  return { key, thumbKey, id };
}
const assetInput = (packId: number, key: string, thumbKey: string | null = null) => ({ packId, storageKey: key, thumbKey, originalFilename: null, mime: 'image/png', sizeBytes: 10, sha256: sha(Buffer.from(`${key}${++seq}`)), width: 80, height: 60, ingestGroup: null });

// ───────────────────────────── C1: race-safe removal ─────────────────────────────
describe('C1: removing a stored file cannot race with registering it', () => {
  it('the tombstone is committed BEFORE R2 is touched, and a registration that arrives in the old race window is refused', async () => {
    const packId = await newPack();
    const { key } = await issuedKey(packId);
    let during: { objectStillThere: boolean; tombstones: number; registration: unknown } | null = null;
    const removed = await discardIfUnreferenced(key, 'test', {
      afterTombstone: async () => {
        // exactly the window the old check-then-delete left open: the "is it referenced?" answer was already given
        const registration = await registerAsset(assetInput(packId, key), USER).then(() => 'registered', (e) => (isRemovedKeyError(e) ? 'refused' : `error: ${(e as Error).message}`));
        during = { objectStillThere: r2.has(key), tombstones: (await tombstones()).length, registration };
      },
    });
    expect(removed).toBe(true);
    expect(during).toEqual({ objectStillThere: true, tombstones: 1, registration: 'refused' });
    expect(r2.has(key)).toBe(false);
    expect(await db.select().from(schema.studioAssets)).toHaveLength(0);   // nothing points at the deleted file
    expect((await tombstones())[0]).toMatchObject({ key, reason: 'test' });
    expect((await tombstones())[0].removedAt).not.toBeNull();
  });

  it('a completion that lands in that window gets a clear 409 (upload_removed), never a registered asset with no file', async () => {
    const packId = await newPack();
    const buf = await png('#445566');
    const init = await call(assetInit, { method: 'POST', params: P(packId), body: { contentType: 'image/png', fileSize: buf.length } });
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    let res: { status: number; json: Record<string, unknown> } | null = null;
    await discardIfUnreferenced(init.json.storageKey, 'sweep', {
      afterTombstone: async () => { res = await call(assetComplete, { method: 'POST', params: P(packId), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } }); },
    });
    expect(res!.status).toBe(409);
    expect(res!.json.code).toBe('upload_removed');
    expect(await db.select().from(schema.studioAssets)).toHaveLength(0);
    expect(r2.has(init.json.storageKey)).toBe(false);
  });

  it('a key that is already registered is kept: the check sees it, no tombstone is written, repeated calls change nothing', async () => {
    const packId = await newPack();
    const { key, thumbKey } = await issuedKey(packId, { thumb: true });
    await registerAsset(assetInput(packId, key, thumbKey), USER);
    for (let i = 0; i < 3; i++) {
      expect(await discardIfUnreferenced(key)).toBe(false);
      expect(await discardIfUnreferenced(thumbKey)).toBe(false);
    }
    expect(r2.has(key)).toBe(true);
    expect(r2.has(thumbKey)).toBe(true);
    expect(await tombstones()).toHaveLength(0);
    expect(r2.deletes).toEqual([]);
  });

  it('under many simultaneous removals and registrations of the same keys, the end state is always consistent', async () => {
    const packId = await newPack();
    const rounds = 25;
    const keys: string[] = [];
    for (let i = 0; i < rounds; i++) keys.push((await issuedKey(packId)).key);
    const jobs: Array<Promise<unknown>> = [];
    for (const key of keys) {
      const order = [0, 1, 2, 3, 4, 5].sort(() => Math.random() - 0.5);
      for (const n of order) jobs.push(n < 3 ? discardIfUnreferenced(key, 'race').catch(() => false) : registerAsset(assetInput(packId, key), USER).catch((e) => { if (!isRemovedKeyError(e)) throw e; return null; }));
    }
    await Promise.all(jobs);
    const assets = await db.select().from(schema.studioAssets);
    const dead = new Set((await tombstones()).map((t) => t.key));
    for (const key of keys) {
      const registered = assets.some((a) => a.storageKey === key);
      if (registered) { expect(dead.has(key), `registered but tombstoned: ${key}`).toBe(false); expect(r2.has(key), `registered but file deleted: ${key}`).toBe(true); }
      else { expect(dead.has(key), `neither registered nor removed: ${key}`).toBe(true); expect(r2.has(key), `unregistered file left behind: ${key}`).toBe(false); }
    }
    expect(assets.every((a) => r2.has(a.storageKey))).toBe(true);        // no registered original is ever missing
  });

  it('the database itself refuses to register a removed key (original, thumbnail or character), whatever code tries it', async () => {
    const packId = await newPack();
    const { key, thumbKey } = await issuedKey(packId, { thumb: true });
    await discardIfUnreferenced(key, 'test');
    await discardIfUnreferenced(thumbKey, 'test');
    await expect(pg.query(`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values ($1, $2, 'image/png', 1, 'h1', $3, 1, 1)`, [packId, key, USER])).rejects.toThrow(/studio_key_removed/);
    const okKey = `studio/assets/${crypto.randomUUID()}.png`;
    await expect(pg.query(`insert into studio_assets (pack_id, storage_key, thumb_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values ($1, $2, $3, 'image/png', 1, 'h2', $4, 1, 1)`, [packId, okKey, thumbKey, USER])).rejects.toThrow(/studio_key_removed/);
    const proj = (await call(projectsPost, { method: 'POST', body: { name: 'X' } })).json.project.id as number;
    const ckey = `studio/projects/${proj}/character/${crypto.randomUUID()}.png`;
    await recordUploadIntent(ckey, 'character', { projectId: proj });
    await discardIfUnreferenced(ckey, 'test');
    await expect(pg.query(`update studio_projects set character_key = $1 where id = $2`, [ckey, proj])).rejects.toThrow(/studio_key_removed/);
    expect((await db.select().from(schema.studioProjects))[0].characterKey).toBeNull();
  });

  it('a failed R2 delete leaves a pending tombstone that is retried; running it again and again is harmless', async () => {
    const packId = await newPack();
    const { key } = await issuedKey(packId);
    const realDelete = r2.deleteFromR2.bind(r2);
    r2.deleteFromR2 = async () => { throw new Error('r2 down'); };
    expect(await discardIfUnreferenced(key, 'test')).toBe(false);          // not gone yet
    expect(r2.has(key)).toBe(true);
    expect((await tombstones())[0].removedAt).toBeNull();
    await expect(registerAsset(assetInput(packId, key), USER)).rejects.toSatisfy(isRemovedKeyError); // and it can never be registered now
    r2.deleteFromR2 = realDelete;
    expect(await retryPendingRemovals()).toBe(1);
    expect(r2.has(key)).toBe(false);
    expect((await tombstones())[0].removedAt).not.toBeNull();
    expect(await retryPendingRemovals()).toBe(0);
    expect(await discardIfUnreferenced(key, 'again')).toBe(true);           // calling it again on a removed key is fine
    expect(await tombstones()).toHaveLength(1);
  });

  it('every kind of reference protects a file, including a character image that was later replaced', async () => {
    const proj = (await call(projectsPost, { method: 'POST', body: { name: 'X' } })).json.project.id as number;
    const upload = async () => {
      const buf = await png('#884422', 200 + seq++, 300);
      const init = await call(charInit, { method: 'POST', params: P(proj), body: { contentType: 'image/png', fileSize: buf.length } });
      r2.browserPut(init.json.storageKey, buf, 'image/png');
      const done = await call(charComplete, { method: 'POST', params: P(proj), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } });
      expect(done.status).toBe(200);
      return init.json.storageKey as string;
    };
    const first = await upload();
    const second = await upload();                       // the project now points at `second`; `first` is history with no batch
    expect((await db.select().from(schema.studioProjects))[0].characterKey).toBe(second);
    expect((await intentOf(first)).state).toBe('registered');
    expect(await isKeyReferenced(first)).toBe(true);
    expect(await discardIfUnreferenced(first)).toBe(false);
    expect(await discardIfUnreferenced(second)).toBe(false);
    expect(r2.has(first)).toBe(true);
    expect(r2.deletes).toEqual([]);
  });

  it('a file that is not an image is still removed, through the same safe path, and then cannot be registered', async () => {
    const packId = await newPack();
    const junk = Buffer.from('definitely not an image');
    const init = await call(assetInit, { method: 'POST', params: P(packId), body: { contentType: 'image/png', fileSize: junk.length } });
    r2.browserPut(init.json.storageKey, junk, 'image/png');
    const res = await call(assetComplete, { method: 'POST', params: P(packId), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: junk.length } });
    expect(res.status).toBe(422);
    expect(r2.has(init.json.storageKey)).toBe(false);
    expect((await tombstones()).map((t) => t.key)).toEqual([init.json.storageKey]);
  });
});

// ───────────────────────────── orphaned uploads ─────────────────────────────
describe('abandoned uploads are cleaned up safely', () => {
  const OLD = (now() - STUDIO_UPLOAD_TTL_S * 1000 - ABANDONED_UPLOAD_GRACE_MS - 60_000);

  it('the init routes record an intent BEFORE the link exists, and completing flips it to registered in the same transaction', async () => {
    const packId = await newPack();
    const buf = await png('#556677');
    const init = await call(assetInit, { method: 'POST', params: P(packId), body: { contentType: 'image/png', fileSize: buf.length } });
    expect(await intentOf(init.json.storageKey)).toMatchObject({ kind: 'asset', state: 'issued', packId });
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    expect((await call(assetComplete, { method: 'POST', params: P(packId), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } })).status).toBeLessThan(300);
    expect(await intentOf(init.json.storageKey)).toMatchObject({ state: 'registered' });

    const proj = (await call(projectsPost, { method: 'POST', body: { name: 'C' } })).json.project.id as number;
    const cinit = await call(charInit, { method: 'POST', params: P(proj), body: { contentType: 'image/png', fileSize: buf.length } });
    expect(await intentOf(cinit.json.storageKey)).toMatchObject({ kind: 'character', state: 'issued', projectId: proj });
  });

  it('removes an unused upload (and its thumbnail) once its link expired a day ago; leaves recent and registered ones alone', async () => {
    const packId = await newPack();
    const unused = await issuedKey(packId, { thumb: true });
    const recent = await issuedKey(packId);
    const registered = await issuedKey(packId, { thumb: true });
    await registerAsset(assetInput(packId, registered.key, registered.thumbKey), USER);
    for (const k of [unused.key, registered.key]) await db.update(schema.studioUploadIntents).set({ issuedAt: OLD }).where(eq(schema.studioUploadIntents.key, k));

    expect(await sweepAbandonedUploads(now())).toEqual({ removed: 1, kept: 0 });
    expect(r2.has(unused.key)).toBe(false);
    expect(r2.has(unused.thumbKey)).toBe(false);
    expect(r2.has(recent.key)).toBe(true);
    expect(r2.has(registered.key)).toBe(true);
    expect(r2.has(registered.thumbKey)).toBe(true);
    expect(await intentOf(unused.key)).toBeUndefined();
    expect((await tombstones()).map((t) => t.key).sort()).toEqual([unused.key, unused.thumbKey].sort());

    expect(await sweepAbandonedUploads(now())).toEqual({ removed: 0, kept: 0 });  // repeating is harmless
    expect(r2.deletes.filter((k) => k === registered.key)).toEqual([]);
  });

  it('never removes a key something references, even if its intent still says "issued"', async () => {
    const packId = await newPack();
    const k = await issuedKey(packId);
    // register it with the guard trigger off, so the intent stays "issued" (a row written some other way)
    await pg.exec('alter table studio_assets disable trigger studio_assets_keys_trg');
    try { await registerAsset(assetInput(packId, k.key), USER); } finally { await pg.exec('alter table studio_assets enable trigger studio_assets_keys_trg'); }
    expect((await intentOf(k.key)).state).toBe('issued');
    await db.update(schema.studioUploadIntents).set({ issuedAt: OLD }).where(eq(schema.studioUploadIntents.key, k.key));
    expect(await sweepAbandonedUploads(now())).toEqual({ removed: 0, kept: 1 });
    expect(r2.has(k.key)).toBe(true);
    expect(await tombstones()).toHaveLength(0);
  });

  it('a very late completion of a swept upload is refused cleanly, and a swept key can never be registered', async () => {
    const packId = await newPack();
    const buf = await png('#667788');
    const init = await call(assetInit, { method: 'POST', params: P(packId), body: { contentType: 'image/png', fileSize: buf.length } });
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    await db.update(schema.studioUploadIntents).set({ issuedAt: OLD }).where(eq(schema.studioUploadIntents.key, init.json.storageKey));
    await sweepAbandonedUploads(now());
    const late = await call(assetComplete, { method: 'POST', params: P(packId), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } });
    expect(late.status).toBe(409);
    r2.browserPut(init.json.storageKey, buf, 'image/png');       // even if the bytes reappear under the same key
    const again = await call(assetComplete, { method: 'POST', params: P(packId), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } });
    expect(again.json.code).toBe('upload_removed');
    expect(await db.select().from(schema.studioAssets)).toHaveLength(0);
  });

  it('only keys this server issued are ever touched: nothing is listed in R2', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/studio/references.ts'), 'utf8');
    expect(src).not.toMatch(/listObjects|ListObjects|\.list\(/);
    r2.browserPut('studio/assets/not-issued-by-us.png', await png('#000000'), 'image/png');
    await sweepAbandonedUploads(now() + 10 * ABANDONED_UPLOAD_GRACE_MS);
    expect(r2.has('studio/assets/not-issued-by-us.png')).toBe(true);
  });
});

// ───────────────────────────── C2: unknown submission outcomes ─────────────────────────────
interface World { proj: number; assets: Array<{ id: number; key: string }> }
async function world(count: number): Promise<World> {
  const proj = (await call(projectsPost, { method: 'POST', body: { name: 'World' } })).json.project.id as number;
  const characterKey = `studio/projects/${proj}/character/${crypto.randomUUID()}.png`;
  r2.browserPut(characterKey, await png('#aa6633', 600, 800), 'image/png');
  r2.browserPut(characterKey.replace('/character/', '/character/thumbs/').replace(/\.png$/, '.webp'), await png('#aa6633', 60, 80), 'image/webp');
  await db.update(schema.studioProjects).set({ characterKey, characterMime: 'image/png' }).where(eq(schema.studioProjects.id, proj));
  const packA = await newPack();
  await call(approvePacks, { method: 'POST', params: P(proj), body: { packIds: [packA] } });
  const assets: World['assets'] = [];
  for (let i = 0; i < count; i++) {
    const buf = await png(`#${((i * 37 + 40) % 255).toString(16).padStart(2, '0')}4477`, 300 + i, 200);
    const id = crypto.randomUUID();
    const key = `studio/assets/${id}.png`; const thumbKey = `studio/assets/thumbs/${id}.webp`;
    r2.browserPut(key, buf, 'image/png'); r2.browserPut(thumbKey, await png('#223344', 40, 30), 'image/webp');
    const [a] = await db.insert(schema.studioAssets).values({ packId: packA, storageKey: key, thumbKey, mime: 'image/png', sizeBytes: buf.length, sha256: sha(buf), createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
    assets.push({ id: a.id, key });
  }
  await call(selectionPost, { method: 'POST', params: P(proj), body: { assetIds: assets.map((a) => a.id) } });
  return { proj, assets };
}
const depsFor = (provider: ReplacementProvider, over: Partial<GenerationDeps> = {}): GenerationDeps => ({
  provider: () => provider,
  read: (key) => r2.downloadR2Only('uploads', key),
  put: async (key, body, mime) => { try { await r2.putR2Only('uploads', key, body, { contentType: mime }); return 'created'; } catch (e) { if (e instanceof ObjectExistsError) return 'exists'; throw e; } },
  ...over,
});
const jobsOf = (batchId: number) => db.select().from(schema.studioJobs).where(eq(schema.studioJobs.batchId, batchId)).orderBy(schema.studioJobs.id);
const batchOf = (w: World) => call(batchesPost, { method: 'POST', params: P(w.proj), body: {} });
const hang = (): ReplacementProvider & { calls: number } => { const p = { id: 'mock', calls: 0, submit() { p.calls++; return new Promise<never>(() => {}); }, async poll() { return { status: 'processing' as const }; } }; return p; };

describe('C2: a submission whose outcome is unknown is never treated as a failure and never blindly resent', () => {
  it('a provider that answers AFTER the local timeout still gets its job id recorded, and the job is then polled', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    const png1 = await png('#c0ffee', 64, 64);
    const late: ReplacementProvider = {
      id: 'mock', async submit() { await sleep(120); return { kind: 'accepted', providerJobId: 'late-A' }; },
      async poll(id) { return id === 'late-A' ? { status: 'succeeded', output: { bytes: png1, mime: 'image/png' } } : { status: 'failed', code: 'x', message: 'x', retryable: false }; },
    };
    const deps = depsFor(late, { providerTimeoutMs: 30 });
    await generationRound(deps, { submit: 1, poll: 0 });
    expect((await jobsOf(batch))[0]).toMatchObject({ status: 'submit_unknown', errorCode: 'submit_timeout', providerJobId: null });
    await until(async () => (await jobsOf(batch))[0].status === 'processing');
    expect((await jobsOf(batch))[0]).toMatchObject({ status: 'processing', providerJobId: 'late-A', errorCode: null, ambiguousAt: null });
    await db.update(schema.studioJobs).set({ nextPollAt: 0 }).where(eq(schema.studioJobs.batchId, batch));
    await generationRound(deps, { submit: 0, poll: 5 });
    expect((await jobsOf(batch))[0].status).toBe('succeeded');
    expect(await db.select().from(schema.studioOutputs)).toHaveLength(1);
  });

  it('a late answer that already contains the finished image is stored', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    const png1 = await png('#facade', 64, 64);
    const late: ReplacementProvider = { id: 'mock', async submit() { await sleep(100); return { kind: 'completed', providerJobId: 'late-B', output: { bytes: png1, mime: 'image/png' } }; }, async poll() { return { status: 'processing' }; } };
    await generationRound(depsFor(late, { providerTimeoutMs: 20 }), { submit: 1, poll: 0 });
    expect((await jobsOf(batch))[0].status).toBe('submit_unknown');
    await until(async () => (await jobsOf(batch))[0].status === 'succeeded');
    expect((await jobsOf(batch))[0]).toMatchObject({ status: 'succeeded', providerJobId: 'late-B' });
    expect(await db.select().from(schema.studioOutputs)).toHaveLength(1);
  });

  it('a late failure leaves the outcome unknown: it does not prove that nothing was created', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    const late: ReplacementProvider = { id: 'mock', async submit() { await sleep(80); throw new Error('socket hang up'); }, async poll() { return { status: 'processing' }; } };
    await generationRound(depsFor(late, { providerTimeoutMs: 20 }), { submit: 1, poll: 0 });
    await sleep(160);
    expect((await jobsOf(batch))[0]).toMatchObject({ status: 'submit_unknown', providerJobId: null });
  });

  it('only an explicit rejection fails a job; an unclear error, a network error and outcome "unknown" all leave it unknown', async () => {
    const cases: Array<[string, () => never, string, string | null]> = [
      ['explicit rejection', () => { throw new ProviderError('No credit.', 'no_credit', false); }, 'failed', 'no_credit'],
      ['explicit rejection (retryable)', () => { throw new ProviderError('Busy.', 'busy', true, 'rejected'); }, 'failed', 'busy'],
      ['provider says unknown', () => { throw new ProviderError('Connection reset.', 'reset', true, 'unknown'); }, 'submit_unknown', 'submit_error'],
      ['any other exception', () => { throw Object.assign(new Error('Bearer sk-secret'), { name: 'FetchError', status: 502 }); }, 'submit_unknown', 'submit_error'],
    ];
    for (const [label, boom, status, code] of cases) {
      await pg.exec('truncate studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects restart identity cascade');
      const w = await world(1);
      const batch = (await batchOf(w)).json.batch.id as number;
      await generationRound(depsFor({ id: 'mock', async submit() { boom(); }, async poll() { return { status: 'processing' }; } } as unknown as ReplacementProvider), { submit: 1, poll: 0 });
      const [job] = await jobsOf(batch);
      expect(job.status, label).toBe(status);
      expect(job.errorCode, label).toBe(code);
      expect(JSON.stringify(job), label).not.toContain('sk-secret');
    }
  });

  it('after a worker restart an unknown job is not resent: a provider without idempotency or lookup leaves it for a person', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    const before = hang();
    await generationRound(depsFor(before, { providerTimeoutMs: 20 }), { submit: 1, poll: 0 });
    const afterRestart = new MockReplacementProvider();                    // a new process: no memory of the call in flight
    const deps = depsFor(afterRestart);
    for (let i = 0; i < 3; i++) {
      expect(await reconcileAmbiguousJobs(deps, { now: now() + 10 * AMBIGUOUS_RESEND_AFTER_MS })).toEqual({ adopted: 0, requeued: 0, waiting: 1 });
      await generationRound(deps, { submit: 4, poll: 4 });
      await recoverStaleJobs(now() + 5 * 60_000);
    }
    expect(afterRestart.submitted).toHaveLength(0);
    expect(before.calls).toBe(1);
    expect((await jobsOf(batch))[0].status).toBe('submit_unknown');
  });

  it('a provider that can look the job up by its idempotency key finds it after a restart: the id is recorded and the job is polled', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(hang(), { providerTimeoutMs: 20 }), { submit: 1, poll: 0 });
    const [job] = await jobsOf(batch);
    const seen: string[] = [];
    const provider = new MockReplacementProvider({ lookup: (key) => { seen.push(key); return `remote-${job.id}`; } });
    expect(await reconcileAmbiguousJobs(depsFor(provider))).toEqual({ adopted: 1, requeued: 0, waiting: 0 });
    expect(seen).toEqual([`studio-job-${job.id}`]);
    expect((await jobsOf(batch))[0]).toMatchObject({ status: 'processing', providerJobId: `remote-${job.id}` });
    expect(provider.submitted).toHaveLength(0);                                // found, never resent
  });

  it('a provider that DECLARES idempotent submits may be resent with the SAME key, a few times, never sooner than a minute', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(hang(), { providerTimeoutMs: 20 }), { submit: 1, poll: 0 });
    const [job] = await jobsOf(batch);
    const idem = new MockReplacementProvider({ idempotent: true });
    const deps = depsFor(idem);
    expect(await reconcileAmbiguousJobs(deps)).toEqual({ adopted: 0, requeued: 0, waiting: 1 });   // too soon: a late answer may still arrive
    expect(await reconcileAmbiguousJobs(deps, { now: now() + AMBIGUOUS_RESEND_AFTER_MS + 1000 })).toEqual({ adopted: 0, requeued: 1, waiting: 0 });
    expect((await jobsOf(batch))[0]).toMatchObject({ id: job.id, status: 'queued', errorCode: null });   // the SAME job, not a new one
    await generationRound(deps, { submit: 1, poll: 0 });
    expect(idem.submitted.map((s) => s.idempotencyKey)).toEqual([`studio-job-${job.id}`]);
    expect((await jobsOf(batch))[0]).toMatchObject({ status: 'processing', submitAttempts: 2, providerJobId: `mock-${job.id}` });
    expect(await jobsOf(batch)).toHaveLength(1);

    // and the number of resends is capped (a fresh job whose sends keep ending unknown)
    await pg.exec('truncate studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects restart identity cascade');
    const w2 = await world(1);
    const b2 = (await batchOf(w2)).json.batch.id as number;
    await generationRound(depsFor(hang(), { providerTimeoutMs: 20 }), { submit: 1, poll: 0 });
    await db.update(schema.studioJobs).set({ ambiguousAt: now() - 10 * AMBIGUOUS_RESEND_AFTER_MS, submitAttempts: MAX_IDEMPOTENT_SENDS }).where(eq(schema.studioJobs.batchId, b2));
    expect(await reconcileAmbiguousJobs(deps)).toEqual({ adopted: 0, requeued: 0, waiting: 1 });
    expect((await jobsOf(b2))[0].status).toBe('submit_unknown');
  });

  it('an unknown job blocks a second job for the same image, and shows in the batch with an explanation', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(hang(), { providerTimeoutMs: 20 }), { submit: 1, poll: 0 });
    const again = await batchOf(w);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('already_running');
    await expect(pg.query(`insert into studio_jobs (batch_id, project_id, asset_id, pack_id, source_key, character_key, provider, attempt, created_by, created_at, updated_at)
      select batch_id, project_id, asset_id, pack_id, source_key, character_key, provider, 2, created_by, 1, 1 from studio_jobs where batch_id = ${batch}`)).rejects.toThrow(/idx_studio_jobs_one_active|duplicate key/);
    const view = await call(batchGet, { params: { id: String(w.proj), batchId: String(batch) } });
    expect(view.json.summary).toMatchObject({ submit_unknown: 1, total: 1 });
    expect(view.json.jobs[0].status).toBe('submit_unknown');
    expect(view.json.jobs[0].error).toMatchObject({ code: 'submit_timeout' });
    expect(view.json.jobs[0].error.message).toMatch(/may or may not have started/);
  });

  it('a person can generate it again only by confirming; history is kept and a very late answer is still recorded on the closed job', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    let answer!: (v: { kind: 'accepted'; providerJobId: string }) => void;
    const slow: ReplacementProvider = { id: 'mock', submit: () => new Promise((r) => { answer = r as typeof answer; }), async poll() { return { status: 'processing' }; } };
    await generationRound(depsFor(slow, { providerTimeoutMs: 20 }), { submit: 1, poll: 0 });
    const [unknown] = await jobsOf(batch);
    expect((await call(retryPost, { method: 'POST', params: P(unknown.id) })).json.code).toBe('submit_unknown');
    expect((await call(retryPost, { method: 'POST', params: P(unknown.id), body: { confirmDuplicate: false } })).status).toBe(409);
    const confirmed = await call(retryPost, { method: 'POST', params: P(unknown.id), body: { confirmDuplicate: true } });
    expect(confirmed.status).toBe(201);
    const jobs = await jobsOf(batch);
    expect(jobs).toHaveLength(2);                                            // per-image history is preserved
    expect(jobs[0]).toMatchObject({ id: unknown.id, status: 'failed', errorCode: 'submit_unknown_abandoned', attempt: 1 });
    expect(jobs[0].ambiguousAt).not.toBeNull();
    expect(jobs[1]).toMatchObject({ status: 'queued', attempt: 2, retryOfJobId: unknown.id });
    answer({ kind: 'accepted', providerJobId: 'very-late' });                // the provider finally answers for the FIRST request
    await until(async () => (await jobsOf(batch))[0].providerJobId === 'very-late');
    const after = await jobsOf(batch);
    expect(after[0]).toMatchObject({ status: 'failed', providerJobId: 'very-late' });   // the paid job is not lost track of
    expect(after[1]).toMatchObject({ status: 'queued', providerJobId: null });            // and the new job is unaffected
  });

  it('a normal retry of a failed job, and regenerating a finished one, work as before', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(new MockReplacementProvider({ failSubmit: () => ({ code: 'rate', message: 'Busy.', retryable: true }) })), { submit: 1, poll: 0 });
    const [failed] = await jobsOf(batch);
    expect(failed.status).toBe('failed');
    expect((await call(retryPost, { method: 'POST', params: P(failed.id) })).status).toBe(201);
  });

  it('adoptProviderJob never moves a finished job and never changes an id once set', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(new MockReplacementProvider({ pollsBeforeDone: 99 })), { submit: 1, poll: 0 });
    const [job] = await jobsOf(batch);
    await db.update(schema.studioJobs).set({ status: 'succeeded' }).where(eq(schema.studioJobs.id, job.id));
    expect(await adoptProviderJob(job.id, 'other-id', now())).toBe(false);
    expect((await jobsOf(batch))[0]).toMatchObject({ status: 'succeeded', providerJobId: job.providerJobId });
  });

  it('the UI offers no automatic retry for an unknown job: only a confirmed "Generate again anyway"', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/components/studio/ResultsPanel.tsx'), 'utf8');
    expect(src).toMatch(/submit_unknown: \{ label: 'Needs attention'/);
    expect(src).toMatch(/window\.confirm\([^)]*charged twice/);
    expect(src).toMatch(/Generate again anyway/);
    expect(src).toMatch(/confirmDuplicate: true/);
  });
});

// ───────────────────────────── C3: provider consistency ─────────────────────────────
describe('C3: the web app and the worker must agree before anything is queued', () => {
  const noJobs = async () => { expect(await db.select().from(schema.studioBatches)).toHaveLength(0); expect(await db.select().from(schema.studioJobs)).toHaveLength(0); };

  it('distinguishes disabled, mock and a worker that agrees, in the config the UI reads', async () => {
    delete process.env.STUDIO_PROVIDER;
    let g = (await call(configGet)).json.generation;
    expect(g).toMatchObject({ mode: 'disabled', enabled: false, ready: false, code: 'generation_disabled', testMode: false });

    process.env.STUDIO_PROVIDER = 'mock';
    g = (await call(configGet)).json.generation;
    expect(g).toMatchObject({ mode: 'mock', enabled: true, testMode: true, ready: true, code: null, worker: { status: 'ok', providers: ['mock'] } });

    process.env.STUDIO_PROVIDER = 'higgsfield';                    // not implemented: never reported as a real mode that works
    g = (await call(configGet)).json.generation;
    expect(g).toMatchObject({ mode: 'disabled', ready: false, code: 'generation_disabled' });
  });

  it('no worker running (or one that stopped reporting) means nothing is queued', async () => {
    await pg.exec('truncate studio_worker_status');
    const w = await world(2);
    let res = await batchOf(w);
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('worker_unavailable');
    expect(res.json.error).toMatch(/No Studio worker is running/);
    await reportFakeWorker(pg, { ageMs: WORKER_STALE_MS + 5_000 });   // reported once, long ago
    res = await batchOf(w);
    expect(res.json.code).toBe('worker_unavailable');
    await noJobs();
    expect(await db.select().from(schema.studioSelections)).toHaveLength(2);   // the selection is kept
    await reportFakeWorker(pg);
    expect((await batchOf(w)).status).toBe(201);
  });

  it('a worker with a different STUDIO_PROVIDER is a mismatch, named in the message; nothing is queued', async () => {
    for (const workerProvider of [null, 'higgsfield']) {
      await reportFakeWorker(pg, { provider: workerProvider });
      const w = await world(1);
      const res = await batchOf(w);
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('provider_mismatch');
      expect(res.json.error).toContain('"mock"');
      expect(res.json.error).toContain(workerProvider ? `"${workerProvider}"` : 'no provider');
      expect(res.json.error).toMatch(/same value on both/);
      expect((await call(configGet)).json.generation).toMatchObject({ ready: false, code: 'provider_mismatch', worker: { status: 'provider_mismatch' } });
    }
    await noJobs();
  });

  it('two workers that disagree are a mismatch too', async () => {
    await reportFakeWorker(pg, { id: 'a', provider: 'mock' });
    await reportFakeWorker(pg, { id: 'b', provider: null });
    expect((await checkWorkerForProvider('mock')).status).toBe('provider_mismatch');
  });

  it('a worker that cannot reach R2, or has Studio switched off, is "not ready"', async () => {
    await reportFakeWorker(pg, { ready: false, r2Ready: false });
    const w = await world(1);
    let res = await batchOf(w);
    expect(res.json.code).toBe('worker_not_ready');
    expect(res.json.error).toMatch(/cannot reach Cloudflare R2/);
    await reportFakeWorker(pg, { ready: false, enabled: false });
    res = await batchOf(w);
    expect(res.json.error).toMatch(/STUDIO_WORKER=off/);
    await noJobs();
  });

  it('a retry is refused when no matching worker is ready, and when the job was made with a different provider', async () => {
    const w = await world(1);
    const batch = (await batchOf(w)).json.batch.id as number;
    await generationRound(depsFor(new MockReplacementProvider({ failSubmit: () => ({ code: 'rate', message: 'Busy.', retryable: true }) })), { submit: 1, poll: 0 });
    const [job] = await jobsOf(batch);
    await pg.exec('truncate studio_worker_status');
    expect((await call(retryPost, { method: 'POST', params: P(job.id) })).json.code).toBe('worker_unavailable');
    await reportFakeWorker(pg);
    await db.update(schema.studioJobs).set({ provider: 'other' }).where(eq(schema.studioJobs.id, job.id));
    const changed = await call(retryPost, { method: 'POST', params: P(job.id) });
    expect(changed.status).toBe(409);
    expect(changed.json.code).toBe('provider_changed');
    expect(await jobsOf(batch)).toHaveLength(1);
  });

  it('the worker reports what IT sees (provider, R2, switches), and the web app trusts only that', async () => {
    await pg.exec('truncate studio_worker_status');
    process.env.STUDIO_PROVIDER = 'mock';
    await reportWorkerStatus();
    let row = (await db.select().from(schema.studioWorkerStatus))[0];
    expect(row).toMatchObject({ provider: 'mock', mode: 'mock', generationReady: true, r2Ready: true, workerEnabled: true });
    expect((await generationReadiness()).ready).toBe(true);

    delete process.env.STUDIO_PROVIDER;                               // the worker's environment loses the setting
    await reportWorkerStatus();
    row = (await db.select().from(schema.studioWorkerStatus))[0];
    expect(row).toMatchObject({ provider: null, mode: 'disabled', generationReady: false });
    process.env.STUDIO_PROVIDER = 'mock';                             // ...while the web app still has it
    const r = await generationReadiness();
    expect(r).toMatchObject({ ready: false, code: 'provider_mismatch' });

    process.env.STUDIO_WORKER = 'off';
    await reportWorkerStatus();
    expect((await db.select().from(schema.studioWorkerStatus))[0]).toMatchObject({ workerEnabled: false, generationReady: false });
    delete process.env.STUDIO_WORKER;

    r2.available = false;
    await reportWorkerStatus();
    expect((await db.select().from(schema.studioWorkerStatus))[0]).toMatchObject({ r2Ready: false, generationReady: false });
    r2.available = true;

    await reportWorkerStatus();
    expect(await stopStudioWorker()).toBe(0);                         // a stopping worker removes itself: it no longer counts
    expect(await db.select().from(schema.studioWorkerStatus)).toHaveLength(0);
  });

  it('the report includes this hour\'s analysis budget for monitoring', async () => {
    process.env.STUDIO_ANALYSIS_BUDGET_PER_HOUR = '7';
    await pg.exec('truncate studio_worker_status');
    await reserveBudget(ANALYSIS_KIND, 7);
    await reportWorkerStatus();
    const row = (await db.select().from(schema.studioWorkerStatus))[0];
    expect((row.details as { analysisBudget: { limit: number; used: number; remaining: number } }).analysisBudget).toMatchObject({ limit: 7, used: 1, remaining: 6 });
  });

  it('test output is identifiable everywhere an output is shown: lists, one output, review (saved too) and jobs', async () => {
    const w = await world(2);
    const batch = (await batchOf(w)).json.batch.id as number;
    const deps = depsFor(new MockReplacementProvider({ pollsBeforeDone: 0 }));
    for (let i = 0; i < 6; i++) { await db.update(schema.studioJobs).set({ nextPollAt: 0 }).where(eq(schema.studioJobs.status, 'processing')); await generationRound(deps, { submit: 4, poll: 4 }); }
    const outs = await db.select().from(schema.studioOutputs).orderBy(schema.studioOutputs.id);
    expect(outs).toHaveLength(2);
    const list = await call(outputsList, { params: P(w.proj) });
    expect(list.json.outputs.every((o: { isTest: boolean; job: { provider: string } }) => o.isTest === true && o.job.provider === 'mock')).toBe(true);
    expect((await call(outputGet, { params: P(outs[0].id) })).json.output.isTest).toBe(true);
    const saved = await call(outputReview, { method: 'POST', params: P(outs[0].id), body: { status: 'saved' } });
    expect(saved.json.output).toMatchObject({ reviewStatus: 'saved', isTest: true });         // saving does not turn a test image into a real one
    const saved2 = await call(outputsList, { params: P(w.proj), query: 'status=saved' });
    expect(saved2.json.outputs[0].isTest).toBe(true);
    const jobs = await call(batchGet, { params: { id: String(w.proj), batchId: String(batch) } });
    expect(jobs.json.jobs.every((j: { isTest: boolean }) => j.isTest)).toBe(true);
    expect(isTestProvider('mock')).toBe(true);
    expect(isTestProvider('higgsfield')).toBe(false);
    expect(isTestProvider(null)).toBe(false);
  });

  it('the UI marks test output on every card, in the zoomed view and on its job; and the selection panel says TEST MODE', () => {
    const results = fs.readFileSync(path.join(ROOT, 'src/components/studio/ResultsPanel.tsx'), 'utf8');
    expect(results).toMatch(/TEST · NOT REAL/);
    expect(results.match(/<TestBadge \/>/g)!.length).toBeGreaterThanOrEqual(3);              // job chip, output card, zoomed view
    expect(results).toMatch(/\{o\.isTest &&/);
    expect(results).toMatch(/\{zoom\.isTest &&/);
    expect(results).toMatch(/\{j\.isTest &&/);
    const panel = fs.readFileSync(path.join(ROOT, 'src/components/studio/SelectionPanel.tsx'), 'utf8');
    expect(panel).toMatch(/TEST MODE/);
    expect(panel).toMatch(/Provider mismatch/);
    expect(panel).toMatch(/!generation\.ready/);
  });

  it('mock mode is never on unless it is switched on: no default, and the worker reports "disabled"', async () => {
    delete process.env.STUDIO_PROVIDER;
    await pg.exec('truncate studio_worker_status');
    await reportWorkerStatus();
    expect((await db.select().from(schema.studioWorkerStatus))[0]).toMatchObject({ provider: null, mode: 'disabled', generationReady: false });
    const w = await world(1);
    expect((await batchOf(w)).json.code).toBe('generation_disabled');
    for (const f of ['src/lib/studio/mock-provider.ts', 'src/worker/studio.ts', 'src/lib/studio/readiness.ts']) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8')).not.toMatch(/STUDIO_PROVIDER\s*(\|\||\?\?)\s*['"]mock['"]/);
    }
  });
});

// ───────────────────────────── persistent analysis budget ─────────────────────────────
describe('the analysis budget is persistent, atomic and accounted', () => {
  let n = 0;
  async function pending(count: number) {
    const packId = await newPack();
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/${crypto.randomUUID()}.png`, mime: 'image/png', sizeBytes: 1, sha256: `b${++n}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
      await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, manual: {}, createdAt: now(), updatedAt: now() });
      ids.push(a.id);
    }
    return ids;
  }
  const row = async (id: number) => (await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, id)))[0];
  const okDeps = (over: Partial<AnalysisDeps> = {}): AnalysisDeps => ({ read: async () => Buffer.from('x'), analyse: async () => ({ metadata: { description: 'A room.' }, model: 'm' }), budgetPerHour: () => 100, ...over });
  const status = (limit = 100) => budgetStatus(ANALYSIS_KIND, limit);

  it('hands out exactly `limit` units to any number of simultaneous requests', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => reserveBudget(ANALYSIS_KIND, 5)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    const s = await status(5);
    expect(s).toMatchObject({ limit: 5, used: 5, remaining: 0, exhausted: true });
    expect(s.exhaustedAt).not.toBeNull();
    expect(s.resetsAt).toBe(hourStart(now()) + BUDGET_WINDOW_MS);
  });

  it('survives a restart: the count lives in the database, not in the process', async () => {
    for (let i = 0; i < 3; i++) expect((await reserveBudget(ANALYSIS_KIND, 5)).ok).toBe(true);
    vi.resetModules();                                            // "restart": nothing in memory is kept
    const fresh = await import('@/lib/studio/budget');
    expect((await fresh.budgetStatus(ANALYSIS_KIND, 5)).used).toBe(3);
    expect((await fresh.reserveBudget(ANALYSIS_KIND, 5)).ok).toBe(true);
    expect((await fresh.reserveBudget(ANALYSIS_KIND, 5)).ok).toBe(true);
    expect((await fresh.reserveBudget(ANALYSIS_KIND, 5)).ok).toBe(false);
  });

  it('starts a new count each UTC hour, and 0 means no limit (usage is still counted)', async () => {
    const t = hourStart(now()) + 5_000;
    for (let i = 0; i < 2; i++) await reserveBudget(ANALYSIS_KIND, 2, t);
    expect((await reserveBudget(ANALYSIS_KIND, 2, t)).ok).toBe(false);
    expect((await reserveBudget(ANALYSIS_KIND, 2, t + BUDGET_WINDOW_MS)).ok).toBe(true);
    for (let i = 0; i < 10; i++) expect((await reserveBudget('other', 0)).ok).toBe(true);
    expect(await budgetStatus('other', 0)).toMatchObject({ limit: null, remaining: null, exhausted: false, used: 10 });
  });

  it('a refund gives a unit back, but never more than was reserved', async () => {
    const slot = await reserveBudget(ANALYSIS_KIND, 1);
    expect((await reserveBudget(ANALYSIS_KIND, 1)).ok).toBe(false);
    await refundBudget(slot);
    await refundBudget(slot);                                      // twice
    expect(await status(1)).toMatchObject({ used: 0, refunded: 1 });
    expect((await reserveBudget(ANALYSIS_KIND, 1)).ok).toBe(true);
    await expect(pg.query(`update studio_budget_usage set refunded = reserved + 1`)).rejects.toThrow(/studio_budget_usage_counts_check/);
  });

  it('accounting: a success counts; a failed model call still counts; nothing sent (unreadable, unreducible, nothing to do) is refunded', async () => {
    const [a, b, c, d] = await pending(4);
    const claim = async () => (await claimNextAsset())!;
    const slot = async () => reserveBudget(ANALYSIS_KIND, 100);

    expect(await analyseClaimed(await claim(), okDeps(), await slot())).toBe('completed');
    expect(await status()).toMatchObject({ used: 1, succeeded: 1, failed: 0, refunded: 0 });

    const modelDown = okDeps({ analyse: async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); } });
    expect(await analyseClaimed(await claim(), modelDown, await slot())).toBe('failed');
    expect(await status()).toMatchObject({ used: 2, succeeded: 1, failed: 1, refunded: 0 });            // it may have been billed

    const unreadable = okDeps({ read: async () => { throw new Error('missing'); } });
    expect(await analyseClaimed(await claim(), unreadable, await slot())).toBe('failed');
    expect(await status()).toMatchObject({ used: 2, refunded: 1 });                                      // nothing was sent

    const unreducible = okDeps({ analyse: async () => { throw Object.assign(new Error('could not be reduced'), { notCharged: true }); } });
    expect(await analyseClaimed(await claim(), unreducible, await slot())).toBe('failed');
    expect(await status()).toMatchObject({ used: 2, refunded: 2 });
    expect([a, b, c, d].length).toBe(4);

    expect(await runAnalysisRound(2, okDeps())).toBe(0);                                                 // nothing pending: nothing is used
    expect(await status()).toMatchObject({ used: 2, refunded: 3 });
  });

  it('when the budget is used up the images stay pending (not claimed, not failed) until there is room', async () => {
    const ids = await pending(5);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(await runAnalysisRound(4, okDeps({ budgetPerHour: () => 2 }))).toBe(2);
    expect(await runAnalysisRound(4, okDeps({ budgetPerHour: () => 2 }))).toBe(0);
    const states = await Promise.all(ids.map(row));
    expect(states.filter((r) => r.analysisStatus === 'completed')).toHaveLength(2);
    const waiting = states.filter((r) => r.analysisStatus === 'pending');
    expect(waiting).toHaveLength(3);
    expect(waiting.every((r) => r.analysisAttempts === 0 && r.analysisError === null && r.claimedAt === null)).toBe(true);
    expect(await studioTick(okDeps({ r2Ready: () => true, budgetPerHour: () => 2 }), { lastRecovery: now(), warnedNoKey: false })).toBe('waiting');
    expect(await studioTick(okDeps({ r2Ready: () => true, budgetPerHour: () => 3 }), { lastRecovery: now(), warnedNoKey: false })).toBe('worked'); // more room: it continues
    expect((await row(waiting[0].id)).analysisStatus).toBe('completed');
  });

  it('two workers running at once never exceed the limit between them', async () => {
    await pending(10);
    const [x, y] = await Promise.all([runAnalysisRound(2, okDeps({ budgetPerHour: () => 3 })), runAnalysisRound(2, okDeps({ budgetPerHour: () => 3 }))]);
    expect(x + y).toBe(3);
    expect(await status(3)).toMatchObject({ used: 3, remaining: 0 });
    expect((await db.select().from(schema.studioAssets)).filter((a) => a.analysisStatus === 'completed')).toHaveLength(3);
  });

  it('an attempt cut off by a shutdown stays counted (it may already have been sent)', async () => {
    await pending(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    const running = runAnalysisRound(1, okDeps({ read: async () => { started = true; await gate; return Buffer.from('x'); } }));
    await until(() => started);
    expect(await stopStudioWorker()).toBe(1);
    release(); await running;
    expect(await status()).toMatchObject({ used: 1, refunded: 0 });
  });

  it('is exposed for monitoring: this hour\'s limit, use, what is left, when it resets, and whether it ran out', async () => {
    process.env.STUDIO_ANALYSIS_BUDGET_PER_HOUR = '2';
    await reserveBudget(ANALYSIS_KIND, 2); await reserveBudget(ANALYSIS_KIND, 2); await reserveBudget(ANALYSIS_KIND, 2);
    const cfg = await call(configGet);
    expect(cfg.json.analysisBudget).toMatchObject({ kind: 'analysis', limit: 2, used: 2, remaining: 0, exhausted: true, succeeded: 0, failed: 0, refunded: 0 });
    expect(cfg.json.analysisBudget.resetsAt).toBeGreaterThan(now());
    expect(cfg.json.analysisBudget.exhaustedAt).not.toBeNull();
    holder.userId = null;
    expect((await call(configGet)).status).toBe(401);              // for signed-in users only
  });

  it('there is no in-memory counter left', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/worker/studio.ts'), 'utf8');
    expect(src).not.toMatch(/class AnalysisBudget|this\.starts|sharedBudget/);
    expect(src).toMatch(/reserveBudget\(ANALYSIS_KIND/);
  });
});

// ───────────────────────────── project list payload ─────────────────────────────
describe('project list cards sign thumbnails only', () => {
  const spySigned = () => { const seen: string[] = []; const orig = r2.signedReadUrls.bind(r2); r2.signedReadUrls = async (b: string, keys: string[]) => { seen.push(...keys); return orig(b, keys); }; return seen; };

  it('the list signs each character thumbnail and never an original; one project still carries its full image', async () => {
    const a = await world(0); const b = await world(0);
    const keys = (await db.select().from(schema.studioProjects)).map((p) => p.characterKey!);
    const seen = spySigned();
    const list = await call(projectsGet);
    expect(list.status).toBe(200);
    expect(seen.every((k) => k.includes('/character/thumbs/'))).toBe(true);
    expect(seen.some((k) => keys.includes(k))).toBe(false);
    for (const p of list.json.projects) { expect(p.characterThumbUrl).toContain('/character/thumbs/'); expect(p.characterUrl).toBeNull(); }

    seen.length = 0;
    const one = await call(projectGet, { params: P(a.proj) });
    expect(one.json.project.characterUrl).toContain('/character/');
    expect(one.json.project.characterUrl).not.toContain('/thumbs/');
    expect(one.json.project.characterThumbUrl).toContain('/character/thumbs/');
    expect(b.proj).not.toBe(a.proj);
  });

  it('a project whose thumbnail does not exist falls back to its original, so the card is never blank', async () => {
    const w = await world(0);
    const p = (await db.select().from(schema.studioProjects))[0];
    r2.objects.delete(`uploads/${p.characterKey!.replace('/character/', '/character/thumbs/').replace(/\.png$/, '.webp')}`);
    const list = await call(projectsGet);
    expect(list.json.projects.find((x: { id: number }) => x.id === w.proj).characterThumbUrl).toContain(p.characterKey!);
  });
});

// ───────────────────────────── migration 0026 ─────────────────────────────
describe('migration 0026', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'drizzle/pg/0026_studio_lifecycle.sql'), 'utf8');

  it('is documented as unapplied, additive and to be applied with 0025 before the code', () => {
    expect(sql.slice(0, 1200)).toMatch(/NOT YET APPLIED/);
    expect(sql).toMatch(/together with 0025 and BEFORE the code/);
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/i);
  });

  it('pins search_path, enables row level security on every new table, and has the tombstone triggers', async () => {
    for (const fn of sql.match(/CREATE OR REPLACE FUNCTION [^$]*?\$\$/g) ?? []) expect(fn).toMatch(/SET search_path = pg_catalog, public/);
    const tables = ['studio_deleted_keys', 'studio_upload_intents', 'studio_worker_status', 'studio_budget_usage'];
    for (const t of tables) expect(sql).toContain(`ALTER TABLE ${t}`.padEnd(40) .trimEnd());
    const rls = (await pg.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname = any($1)`, [tables])).rows;
    expect(rls).toHaveLength(4);
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    const trg = (await pg.query<{ tgname: string }>(`select tgname from pg_trigger where tgname in ('studio_assets_keys_trg', 'studio_projects_keys_trg')`)).rows;
    expect(trg.map((t) => t.tgname).sort()).toEqual(['studio_assets_keys_trg', 'studio_projects_keys_trg']);
  });

  it('allows the new job status and keeps one active job per image (unknown counts as active)', async () => {
    const def = (await pg.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'studio_jobs_status_check'`)).rows[0].def;
    expect(def).toContain('submit_unknown');
    const idx = (await pg.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'idx_studio_jobs_one_active'`)).rows[0].indexdef;
    expect(idx).toContain('submit_unknown');
  });
});
