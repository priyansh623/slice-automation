/**
 * Real multi-connection PostgreSQL tests of the Studio's concurrency design: advisory locks and tombstones around stored files,
 * the sweeper, atomic budget reservations, atomic job claims, and recovery of ambiguous submissions.
 *
 * The PGlite tests prove the logic, but PGlite has one connection, so they cannot show that the locks make genuinely concurrent
 * transactions take turns. This file uses a pool of separate PostgreSQL connections (some transactions are held open on purpose).
 *
 * Skipped unless TEST_POSTGRES_URL is set. It REFUSES to run unless the host is local (localhost, 127.0.0.1 or ::1), so it can
 * never touch a hosted or production database. The URL's database is only used to CREATE a brand-new throwaway database for the
 * run, which is dropped at the end (also when setup or a test fails).
 *
 *   TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres npx vitest run src/__tests__/studio-postgres.concurrency.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';
import { FakeR2 } from './helpers/studio-fakes';

const URL_ENV = process.env.TEST_POSTGRES_URL;
const isLocal = (() => { try { return URL_ENV ? ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(URL_ENV).hostname) : false; } catch { return false; } })();
if (URL_ENV && !isLocal) throw new Error('TEST_POSTGRES_URL must point at a local database (localhost / 127.0.0.1). Refusing to run.');
const suite = URL_ENV && isLocal ? describe : describe.skip;

const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { discardIfUnreferenced, isRemovedKeyError, recordUploadIntent, retryPendingRemovals, sweepAbandonedUploads, ABANDONED_UPLOAD_GRACE_MS } from '@/lib/studio/references';
import { registerAsset } from '@/lib/studio/repository';
import { completeUpload } from '@/lib/studio/ingest';
import { STUDIO_UPLOAD_TTL_S } from '@/lib/studio/keys';
import { ANALYSIS_KIND, budgetStatus, reserveBudget } from '@/lib/studio/budget';
import { adoptProviderJob, AMBIGUOUS_RESEND_AFTER_MS, claimQueuedJobs, generationRound, reconcileAmbiguousJobs, recoverStaleJobs, SUBMIT_LEASE_MS, type GenerationDeps } from '@/lib/studio/generation';
import { MockReplacementProvider } from '@/lib/studio/mock-provider';
import { claimNextAsset, recoverStaleAnalysis } from '@/lib/studio/analysis-queue';
import { runAnalysisRound, type AnalysisDeps } from '@/worker/studio';
import { ObjectExistsError } from '@/lib/object-store/types';
import type { ReplacementProvider } from '@/lib/studio/provider';

const ROOT = path.resolve(__dirname, '../..');
const USER = '00000000-0000-4000-8000-00000000000a';
let admin: ReturnType<typeof postgres>;
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let dbUrl = '';
let dbName = '';
let cleanedUp = false;
let r2: FakeR2;
/** Gates that hold a transaction open; always released after a test so a failing test cannot leave a lock behind. */
const releasers: Array<() => void> = [];

async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  const errors: unknown[] = [];
  try { if (client) await client.end({ timeout: 5 }); } catch (e) { errors.push(e); }
  try { if (admin && dbName) await admin.unsafe(`drop database if exists ${dbName} with (force)`); } catch (e) { errors.push(e); }
  try { if (admin) await admin.end({ timeout: 5 }); } catch (e) { errors.push(e); }
  if (errors.length > 0) console.warn('[postgres test] cleanup problems:', errors.map((e) => String((e as Error).message)).join('; '));
}

const migrationFiles = () => fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification')).sort();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const png = (color: string, w = 120, h = 90) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const now = () => Date.now();
let seq = 0;
/** Resolves true if `p` settles within `ms`, false if it is still pending (i.e. blocked). */
const settlesWithin = async (p: Promise<unknown>, ms: number): Promise<boolean> => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

suite('Studio concurrency on a real PostgreSQL (separate connections)', () => {
  beforeAll(async () => {
    try {
      cleanedUp = false;
      admin = postgres(URL_ENV!, { max: 1, onnotice: () => {} });
      dbName = `soma_studio_${process.pid}_${Date.now()}`;
      await admin.unsafe(`create database ${dbName}`);
      const url = new URL(URL_ENV!);
      url.pathname = `/${dbName}`;
      dbUrl = url.toString();
      client = postgres(dbUrl, { max: 30, onnotice: () => {} });
      db = drizzle(client, { schema });
      holder.db = db;
      await client.unsafe(`create schema auth; create function auth.uid() returns uuid language sql as 'select null::uuid'; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
      const files = migrationFiles();
      for (const f of files.filter((m) => m < '0022_')) await client.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
      await client.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
      for (const f of files.filter((m) => m >= '0022_')) await client.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
    } catch (err) {
      await cleanup();
      throw err;
    }
  }, 180_000);
  afterAll(async () => { await cleanup(); });
  beforeEach(async () => {
    r2 = new FakeR2(); holder.store = r2;
    await client.unsafe('truncate studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects, studio_deleted_keys, studio_upload_intents, studio_worker_status, studio_budget_usage restart identity cascade');
  });
  afterEach(() => { while (releasers.length) releasers.pop()!(); vi.restoreAllMocks(); });

  // ── helpers ──
  const newPack = async () => (await db.insert(schema.studioPacks).values({ name: `P${++seq}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
  async function issuedKey(packId: number, opts: { thumb?: boolean } = {}) {
    const id = crypto.randomUUID();
    const key = `studio/assets/${id}.png`; const thumbKey = `studio/assets/thumbs/${id}.webp`;
    await recordUploadIntent(key, 'asset', { packId, userId: USER });
    r2.browserPut(key, await png('#335577', 80, 60), 'image/png');
    if (opts.thumb) r2.browserPut(thumbKey, await png('#223344', 20, 15), 'image/webp');
    return { key, thumbKey };
  }
  const assetInput = (packId: number, key: string, thumbKey: string | null = null) => ({ packId, storageKey: key, thumbKey, originalFilename: null, mime: 'image/png', sizeBytes: 10, sha256: sha(`${key}${++seq}`), width: 80, height: 60, ingestGroup: null });
  const tombstoned = async () => new Set((await db.select().from(schema.studioDeletedKeys)).map((t) => t.key));
  const insertAssetSql = (packId: number, key: string, thumb: string | null = null) => ({ packId, key, thumb, sha: sha(`${key}${++seq}`) });

  /** The invariant of the whole design, checked after any storm of removals and registrations. */
  async function assertConsistent(keys: string[]) {
    const assets = await db.select().from(schema.studioAssets);
    const dead = await tombstoned();
    for (const key of keys) {
      const registered = assets.some((a) => a.storageKey === key);
      if (registered) { expect(dead.has(key), `registered but tombstoned: ${key}`).toBe(false); expect(r2.has(key), `registered but its file is gone: ${key}`).toBe(true); }
      else if (dead.has(key)) expect(r2.has(key), `tombstoned but the file is still there: ${key}`).toBe(false);
    }
    for (const a of assets) { expect(r2.has(a.storageKey), `an asset points at a missing file: ${a.storageKey}`).toBe(true); expect(dead.has(a.storageKey)).toBe(false); }
  }

  it('uses genuinely separate connections, on PostgreSQL 17', async () => {
    const t0 = Date.now();
    const pids = await Promise.all(Array.from({ length: 6 }, () => client`select pg_backend_pid() as pid, pg_sleep(0.3)`));
    expect(Date.now() - t0).toBeLessThan(1500);                          // six 0.3 s sleeps overlapped
    expect(new Set(pids.map((r) => r[0].pid)).size).toBeGreaterThanOrEqual(4);
    const [{ version }] = await client`show server_version_num`.then((r) => [{ version: Number(r[0].server_version_num) }]);
    expect(version).toBeGreaterThanOrEqual(160000);
  });

  // ── 1. registration racing with deletion ──
  describe('1. registration racing with deletion', () => {
    it('a registration that is still uncommitted holds the key: the deletion WAITS for it, then sees the reference and keeps the file', async () => {
      const packId = await newPack();
      const { key } = await issuedKey(packId);
      let commit!: () => void;
      const gate = new Promise<void>((r) => { commit = r; releasers.push(r); });
      let inserted!: () => void;
      const insertedP = new Promise<void>((r) => { inserted = r; });
      const t1 = client.begin(async (tx) => {
        await tx`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values (${packId}, ${key}, 'image/png', 10, ${sha(key)}, ${USER}, 1, 1)`;
        inserted();
        await gate;                                                      // the registration stays open
      });
      await insertedP;
      const removal = discardIfUnreferenced(key, 'race');
      expect(await settlesWithin(removal, 400)).toBe(false);             // blocked on the registration's lock
      expect(r2.has(key)).toBe(true);
      commit();
      await t1;
      expect(await removal).toBe(false);                                 // it then saw the committed reference
      expect(r2.has(key)).toBe(true);
      expect(await tombstoned()).toEqual(new Set());
      expect(r2.deletes).toEqual([]);
    });

    it('a removal that has committed its tombstone makes a concurrent registration fail, even one already waiting on the lock', async () => {
      const packId = await newPack();
      const { key } = await issuedKey(packId);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; releasers.push(r); });
      let locked!: () => void;
      const lockedP = new Promise<void>((r) => { locked = r; });
      // the removal's own transaction, held open right after it wrote the tombstone
      const t1 = client.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        await tx`insert into studio_deleted_keys (key, reason, requested_at) values (${key}, 'held', 1)`;
        locked();
        await gate;
      });
      await lockedP;
      const registration = registerAsset(assetInput(packId, key), USER).then(() => 'registered', (e) => (isRemovedKeyError(e) ? 'refused' : `error: ${(e as Error).message}`));
      expect(await settlesWithin(registration, 400)).toBe(false);        // waiting for the exclusive lock
      release();
      await t1;
      expect(await registration).toBe('refused');
      expect(await db.select().from(schema.studioAssets)).toHaveLength(0);
    });

    it('under a storm of simultaneous removals and registrations on the same keys the end state is always consistent', async () => {
      const packId = await newPack();
      const keys: string[] = [];
      for (let i = 0; i < 40; i++) keys.push((await issuedKey(packId)).key);
      const jobs: Array<Promise<unknown>> = [];
      for (const key of keys) {
        for (const n of [0, 1, 2, 3, 4, 5].sort(() => Math.random() - 0.5)) {
          jobs.push((async () => {
            await sleep(Math.floor(Math.random() * 15));
            return n < 3 ? discardIfUnreferenced(key, 'storm').catch(() => false) : registerAsset(assetInput(packId, key), USER).catch((e) => { if (!isRemovedKeyError(e)) throw e; return null; });
          })());
        }
      }
      await Promise.all(jobs);
      await assertConsistent(keys);
      const assets = await db.select().from(schema.studioAssets);
      const dead = await tombstoned();
      expect(assets.length + dead.size).toBe(keys.length);               // every key ended as exactly one of: registered or removed
    });

    it('the error a removed key produces is recognised through the real driver', async () => {
      const packId = await newPack();
      const { key } = await issuedKey(packId);
      await discardIfUnreferenced(key, 'x');
      const err = await registerAsset(assetInput(packId, key), USER).then(() => null, (e) => e);
      expect(err).not.toBeNull();
      expect(isRemovedKeyError(err)).toBe(true);
    });
  });

  // ── 2. two simultaneous deletion requests ──
  describe('2. simultaneous deletion requests', () => {
    it('many removals of the same unreferenced key all succeed, leave one tombstone, and delete the object', async () => {
      const packId = await newPack();
      const { key } = await issuedKey(packId);
      const results = await Promise.all(Array.from({ length: 12 }, () => discardIfUnreferenced(key, 'dup')));
      expect(results.every((r) => r === true)).toBe(true);
      expect(await db.select().from(schema.studioDeletedKeys)).toHaveLength(1);
      expect(r2.has(key)).toBe(false);
      expect((await db.select().from(schema.studioDeletedKeys))[0].removedAt).not.toBeNull();
    });

    it('two removals of different keys do not block each other', async () => {
      const packId = await newPack();
      const a = await issuedKey(packId); const b = await issuedKey(packId);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; releasers.push(r); });
      let held!: () => void;
      const heldP = new Promise<void>((r) => { held = r; });
      const t1 = client.begin(async (tx) => { await tx`select pg_advisory_xact_lock(hashtextextended(${a.key}, 0))`; held(); await gate; });
      await heldP;
      expect(await settlesWithin(discardIfUnreferenced(b.key, 'other'), 1000)).toBe(true);   // a different key: not blocked
      expect(await settlesWithin(discardIfUnreferenced(a.key, 'same'), 300)).toBe(false);    // the same key: waits
      release(); await t1;
    });
  });

  // ── 3. registration after a tombstone exists ──
  describe('3. registration after a tombstone exists', () => {
    it('the database refuses the key through every path (original, thumbnail, character), from any connection', async () => {
      const packId = await newPack();
      const { key, thumbKey } = await issuedKey(packId, { thumb: true });
      await discardIfUnreferenced(key, 'x'); await discardIfUnreferenced(thumbKey, 'x');
      const sqlInsert = (k: string, th: string | null) => client`insert into studio_assets (pack_id, storage_key, thumb_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values (${packId}, ${k}, ${th}, 'image/png', 1, ${sha(k + 'h')}, ${USER}, 1, 1)`;
      await expect(sqlInsert(key, null)).rejects.toThrow(/studio_key_removed/);
      await expect(sqlInsert(`studio/assets/${crypto.randomUUID()}.png`, thumbKey)).rejects.toThrow(/studio_key_removed/);
      const [proj] = await db.insert(schema.studioProjects).values({ name: 'X', createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
      const ckey = `studio/projects/${proj.id}/character/${crypto.randomUUID()}.png`;
      await recordUploadIntent(ckey, 'character', { projectId: proj.id });
      await discardIfUnreferenced(ckey, 'x');
      await expect(client`update studio_projects set character_key = ${ckey} where id = ${proj.id}`).rejects.toThrow(/studio_key_removed/);
    });

    it('a tombstone can never be deleted or reversed', async () => {
      const packId = await newPack();
      const { key } = await issuedKey(packId);
      await discardIfUnreferenced(key, 'x');
      await expect(client`delete from studio_deleted_keys where key = ${key}`).rejects.toThrow(/never deleted/);
      expect(await tombstoned()).toEqual(new Set([key]));
    });

    it('a registered key is protected: no tombstone can be written for it, from many connections at once', async () => {
      const packId = await newPack();
      const { key, thumbKey } = await issuedKey(packId, { thumb: true });
      await registerAsset(assetInput(packId, key, thumbKey), USER);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => discardIfUnreferenced(i % 2 ? key : thumbKey, 'try')));
      expect(results.every((r) => r === false)).toBe(true);
      expect(await tombstoned()).toEqual(new Set());
      expect(r2.has(key) && r2.has(thumbKey)).toBe(true);
    });

    it('a derived thumbnail (a character\'s is stored nowhere) is protected whenever its original is', async () => {
      const [proj] = await db.insert(schema.studioProjects).values({ name: 'X', createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
      const id = crypto.randomUUID();
      const ckey = `studio/projects/${proj.id}/character/${id}.png`; const cthumb = `studio/projects/${proj.id}/character/thumbs/${id}.webp`;
      await recordUploadIntent(ckey, 'character', { projectId: proj.id });
      r2.browserPut(ckey, await png('#884422'), 'image/png'); r2.browserPut(cthumb, await png('#884422', 20, 15), 'image/webp');
      await db.update(schema.studioProjects).set({ characterKey: ckey }).where(eq(schema.studioProjects.id, proj.id));   // registers (trigger marks the intent)
      expect(await discardIfUnreferenced(cthumb, 'try')).toBe(false);
      expect(r2.has(cthumb)).toBe(true);
    });
  });

  // ── 4. sweeper racing with upload completion ──
  describe('4. the sweeper racing with upload completion', () => {
    const OLD = () => now() - STUDIO_UPLOAD_TTL_S * 1000 - ABANDONED_UPLOAD_GRACE_MS - 60_000;

    it('completions racing the sweeper end consistently: an asset is only ever registered with its file present', async () => {
      const packId = await newPack();
      const keys: string[] = [];
      const bufs = new Map<string, Buffer>();
      for (let i = 0; i < 24; i++) {
        const id = crypto.randomUUID(); const key = `studio/assets/${id}.png`; const buf = await png(`#${((i * 9 + 30) % 255).toString(16).padStart(2, '0')}5588`, 90 + i, 70);
        await recordUploadIntent(key, 'asset', { packId, userId: USER });
        r2.browserPut(key, buf, 'image/png'); bufs.set(key, buf); keys.push(key);
        await client`update studio_upload_intents set issued_at = ${OLD()} where key = ${key}`;
      }
      const completions = keys.map((key) => (async () => {
        await sleep(Math.floor(Math.random() * 20));
        return completeUpload({ packId, storageKey: key, contentType: 'image/png', fileSize: bufs.get(key)!.length }, USER).then((r) => ({ ok: true as const, id: r.asset.id }), (e) => ({ ok: false as const, code: (e as { code?: string }).code }));
      })());
      const sweeps = [0, 1, 2].map(async () => { await sleep(Math.floor(Math.random() * 25)); return sweepAbandonedUploads(now()); });
      const [results] = await Promise.all([Promise.all(completions), Promise.all(sweeps)]);
      await assertConsistent(keys);
      for (const r of results) if (!r.ok) expect(['upload_removed', 'upload_rejected']).toContain(r.code);   // a clean refusal, never a crash
      for (const a of await db.select().from(schema.studioAssets)) expect((await client`select state from studio_upload_intents where key = ${a.storageKey}`)[0].state).toBe('registered');
      expect((await db.select().from(schema.studioAssets)).length + (await tombstoned()).size).toBeGreaterThanOrEqual(keys.length);
    });

    it('a sweep waits for a registration in flight, then keeps the registered file', async () => {
      const packId = await newPack();
      const { key } = await issuedKey(packId);
      await client`update studio_upload_intents set issued_at = ${OLD()} where key = ${key}`;
      let commit!: () => void;
      const gate = new Promise<void>((r) => { commit = r; releasers.push(r); });
      let inserted!: () => void;
      const insertedP = new Promise<void>((r) => { inserted = r; });
      const t1 = client.begin(async (tx) => {
        await tx`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values (${packId}, ${key}, 'image/png', 10, ${sha(key)}, ${USER}, 1, 1)`;
        inserted(); await gate;
      });
      await insertedP;
      const sweep = sweepAbandonedUploads(now());
      expect(await settlesWithin(sweep, 400)).toBe(false);
      commit(); await t1;
      expect(await sweep).toEqual({ removed: 0, kept: 1 });
      expect(r2.has(key)).toBe(true);
      expect((await client`select state from studio_upload_intents where key = ${key}`)[0].state).toBe('registered');   // flipped by the same transaction
    });

    it('simultaneous sweepers are idempotent and each key is removed once', async () => {
      const packId = await newPack();
      const keys: string[] = [];
      for (let i = 0; i < 15; i++) { const k = await issuedKey(packId, { thumb: true }); keys.push(k.key, k.thumbKey); await client`update studio_upload_intents set issued_at = ${OLD()} where key = ${k.key}`; }
      const results = await Promise.all(Array.from({ length: 5 }, () => sweepAbandonedUploads(now())));
      expect(results.reduce((n, r) => n + r.removed, 0)).toBeGreaterThanOrEqual(15);
      for (const k of keys) expect(r2.has(k)).toBe(false);
      expect(await db.select().from(schema.studioDeletedKeys)).toHaveLength(30);
      expect(await sweepAbandonedUploads(now())).toEqual({ removed: 0, kept: 0 });
    });

    it('a delete that fails in R2 is recovered later by retryPendingRemovals, from any worker', async () => {
      const packId = await newPack();
      const { key } = await issuedKey(packId);
      const real = r2.deleteFromR2.bind(r2);
      r2.deleteFromR2 = async () => { throw new Error('r2 down'); };
      expect(await discardIfUnreferenced(key, 'x')).toBe(false);
      r2.deleteFromR2 = real;
      const done = await Promise.all([retryPendingRemovals(), retryPendingRemovals(), retryPendingRemovals()]);
      expect(done.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
      expect(r2.has(key)).toBe(false);
      expect((await db.select().from(schema.studioDeletedKeys))[0].removedAt).not.toBeNull();
    });
  });

  // ── 5. concurrent budget reservations ──
  describe('5. concurrent hourly budget reservations', () => {
    let n = 0;
    async function pending(count: number) {
      const packId = await newPack();
      for (let i = 0; i < count; i++) {
        const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/${crypto.randomUUID()}.png`, mime: 'image/png', sizeBytes: 1, sha256: `bb${++n}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
        await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, manual: {}, createdAt: now(), updatedAt: now() });
      }
    }
    const okDeps = (limit: number): AnalysisDeps => ({ read: async () => { await sleep(5); return Buffer.from('x'); }, analyse: async () => ({ metadata: { description: 'A room.' }, model: 'm' }), budgetPerHour: () => limit });

    it('100 simultaneous reservations against a limit of 10 give out exactly 10', async () => {
      const results = await Promise.all(Array.from({ length: 100 }, () => reserveBudget(ANALYSIS_KIND, 10)));
      expect(results.filter((r) => r.ok)).toHaveLength(10);
      expect(await budgetStatus(ANALYSIS_KIND, 10)).toMatchObject({ used: 10, remaining: 0, exhausted: true });
    });

    it('several workers analysing at once never exceed the limit between them, and never analyse an image twice', async () => {
      await pending(30);
      const rounds = await Promise.all(Array.from({ length: 6 }, () => runAnalysisRound(2, okDeps(7))));
      expect(rounds.reduce((a, b) => a + b, 0)).toBe(7);
      const assets = await db.select().from(schema.studioAssets);
      expect(assets.filter((a) => a.analysisStatus === 'completed')).toHaveLength(7);
      expect(assets.filter((a) => a.analysisStatus === 'pending')).toHaveLength(23);          // the rest wait, unclaimed
      expect(assets.every((a) => a.analysisAttempts <= 1)).toBe(true);
      expect(await budgetStatus(ANALYSIS_KIND, 7)).toMatchObject({ used: 7, succeeded: 7, remaining: 0 });
    });

    it('concurrent claims (SKIP LOCKED) never hand one image to two workers', async () => {
      await pending(20);
      const claims = await Promise.all(Array.from({ length: 12 }, () => claimNextAsset()));
      const ids = claims.filter(Boolean).map((a) => a!.id);
      expect(ids).toHaveLength(12);
      expect(new Set(ids).size).toBe(12);
    });

    it('the count survives a restart: a brand-new process (new connections) sees the same hour\'s usage', async () => {
      for (let i = 0; i < 4; i++) await reserveBudget(ANALYSIS_KIND, 6);
      const restarted = postgres(dbUrl, { max: 4, onnotice: () => {} });
      const previous = holder.db;
      try {
        holder.db = drizzle(restarted, { schema });
        expect(await budgetStatus(ANALYSIS_KIND, 6)).toMatchObject({ used: 4, remaining: 2 });
        const more = await Promise.all(Array.from({ length: 5 }, () => reserveBudget(ANALYSIS_KIND, 6)));
        expect(more.filter((r) => r.ok)).toHaveLength(2);
      } finally { holder.db = previous; await restarted.end({ timeout: 5 }); }
      expect(await budgetStatus(ANALYSIS_KIND, 6)).toMatchObject({ used: 6, exhausted: true });
    });
  });

  // ── 6 & 7. restart recovery, ambiguous jobs ──
  describe('6/7. recovery after a restart, and ambiguous submissions', () => {
    async function jobsWorld(count: number, status = 'queued') {
      const [proj] = await db.insert(schema.studioProjects).values({ name: 'W', characterKey: `studio/projects/1/character/${crypto.randomUUID()}.png`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
      const packId = await newPack();
      await db.insert(schema.studioProjectPacks).values({ projectId: proj.id, packId, source: 'manual', approvedBy: USER, approvedAt: now() });
      const [batch] = await db.insert(schema.studioBatches).values({ projectId: proj.id, createdBy: USER, provider: 'mock', providerConfig: {}, characterKey: proj.characterKey!, totalJobs: count, createdAt: now() }).returning();
      r2.browserPut(proj.characterKey!, await png('#aa6633', 60, 80), 'image/png');
      const ids: number[] = [];
      for (let i = 0; i < count; i++) {
        const key = `studio/assets/${crypto.randomUUID()}.png`;
        r2.browserPut(key, await png('#336699', 60 + i, 50), 'image/png');
        const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: key, mime: 'image/png', sizeBytes: 1, sha256: `jj${++seq}`, createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
        const [j] = await db.insert(schema.studioJobs).values({ batchId: batch.id, projectId: proj.id, assetId: a.id, packId, sourceKey: key, characterKey: proj.characterKey!, provider: 'mock', status, createdBy: USER, createdAt: now(), updatedAt: now() }).returning();
        ids.push(j.id);
      }
      return { batchId: batch.id, ids };
    }
    const depsFor = (provider: ReplacementProvider, over: Partial<GenerationDeps> = {}): GenerationDeps => ({
      provider: () => provider,
      read: (key) => r2.downloadR2Only('uploads', key),
      put: async (key, body, mime) => { try { await r2.putR2Only('uploads', key, body, { contentType: mime }); return 'created'; } catch (e) { if (e instanceof ObjectExistsError) return 'exists'; throw e; } },
      ...over,
    });
    const jobRows = (batchId: number) => db.select().from(schema.studioJobs).where(eq(schema.studioJobs.batchId, batchId)).orderBy(schema.studioJobs.id);

    it('concurrent job claims are disjoint and complete (no job is claimed twice, none is missed)', async () => {
      const { ids } = await jobsWorld(40);
      const claims = await Promise.all(Array.from({ length: 8 }, () => claimQueuedJobs(6)));
      const got = claims.flat().map((j) => j.id);
      expect(new Set(got).size).toBe(got.length);
      const rest = await claimQueuedJobs(100);
      expect(got.length + rest.length).toBe(ids.length);
    });

    it('two workers running rounds at once send each job to the provider exactly once', async () => {
      const { batchId } = await jobsWorld(24);
      const provider = new MockReplacementProvider({ pollsBeforeDone: 99 });
      await Promise.all([0, 1, 2].map(async () => { for (let i = 0; i < 4; i++) await generationRound(depsFor(provider), { submit: 5, poll: 0 }); }));
      const sent = provider.submitted.map((s) => s.jobId);
      expect(new Set(sent).size).toBe(sent.length);
      expect(sent).toHaveLength(24);
      expect((await jobRows(batchId)).every((j) => j.status === 'processing' && j.submitAttempts === 1)).toBe(true);
    });

    it('after a restart, concurrent recoveries turn each interrupted job into "unknown" exactly once, and never resend it', async () => {
      const { batchId, ids } = await jobsWorld(30);
      const old = now() - SUBMIT_LEASE_MS - 10_000;
      await client`update studio_jobs set status = 'submitting', claimed_at = ${old}, started_at = ${old} where batch_id = ${batchId}`;
      await client`update studio_assets set analysis_status = 'processing', claimed_at = ${now() - 3_600_000}, analysis_attempts = 1`;
      const results = await Promise.all(Array.from({ length: 6 }, () => recoverStaleJobs(now())));
      expect(results.reduce((n, r) => n + r.interrupted, 0)).toBe(30);        // each job was moved by exactly one recoverer
      const analysis = await Promise.all(Array.from({ length: 4 }, () => recoverStaleAnalysis(now())));
      expect(analysis.reduce((n, r) => n + r.requeued, 0)).toBe(30);
      const provider = new MockReplacementProvider();
      await generationRound(depsFor(provider), { submit: 50, poll: 50 });
      expect(provider.submitted).toHaveLength(0);
      const rows = await jobRows(batchId);
      expect(rows.every((j) => j.status === 'submit_unknown' && j.errorCode === 'submit_interrupted' && j.ambiguousAt !== null)).toBe(true);
      expect(rows.map((j) => j.id)).toEqual(ids);
    });

    it('simultaneous reconcilers with a NON-idempotent provider resend nothing, however many run', async () => {
      const { batchId } = await jobsWorld(20, 'submit_unknown');
      await client`update studio_jobs set ambiguous_at = ${now() - 10 * AMBIGUOUS_RESEND_AFTER_MS} where batch_id = ${batchId}`;
      const provider = new MockReplacementProvider();
      await Promise.all(Array.from({ length: 6 }, async () => { await reconcileAmbiguousJobs(depsFor(provider)); await generationRound(depsFor(provider), { submit: 10, poll: 10 }); }));
      expect(provider.submitted).toHaveLength(0);
      expect((await jobRows(batchId)).every((j) => j.status === 'submit_unknown')).toBe(true);
    });

    it('simultaneous reconcilers with an idempotent provider resend each job once, with its own stable key', async () => {
      const { batchId } = await jobsWorld(20, 'submit_unknown');
      await client`update studio_jobs set ambiguous_at = ${now() - 10 * AMBIGUOUS_RESEND_AFTER_MS}, submit_attempts = 1 where batch_id = ${batchId}`;
      const provider = new MockReplacementProvider({ idempotent: true, pollsBeforeDone: 99 });
      await Promise.all(Array.from({ length: 6 }, async () => { await reconcileAmbiguousJobs(depsFor(provider)); await generationRound(depsFor(provider), { submit: 10, poll: 0 }); }));
      await generationRound(depsFor(provider), { submit: 50, poll: 0 });
      const rows = await jobRows(batchId);
      expect(rows.every((j) => j.status === 'processing' && j.submitAttempts === 2)).toBe(true);
      const keys = provider.submitted.map((s) => s.idempotencyKey);
      expect(new Set(keys).size).toBe(20);
      expect(keys.every((k) => /^studio-job-\d+$/.test(k))).toBe(true);
    });

    it('a late answer racing a reconciler and a person: the first provider id wins, it can never change, the job is polled once', async () => {
      const { batchId, ids } = await jobsWorld(1, 'submit_unknown');
      const results = await Promise.all([
        adoptProviderJob(ids[0], 'id-A', now()), adoptProviderJob(ids[0], 'id-B', now()),
        adoptProviderJob(ids[0], 'id-A', now()), adoptProviderJob(ids[0], 'id-B', now()),
      ]);
      const [job] = await jobRows(batchId);
      expect(['id-A', 'id-B']).toContain(job.providerJobId);
      expect(job.status).toBe('processing');
      expect(results.filter(Boolean)).toHaveLength(results.filter((r, i) => r && [`id-A`, 'id-B'][i % 2] === job.providerJobId).length);
      await expect(client`update studio_jobs set provider_job_id = 'other' where id = ${ids[0]}`).rejects.toThrow(/keeps it/);
    });

    it('an unknown job still blocks a second job for the same image on a real database', async () => {
      const { batchId } = await jobsWorld(1, 'submit_unknown');
      await expect(client`insert into studio_jobs (batch_id, project_id, asset_id, pack_id, source_key, character_key, provider, attempt, created_by, created_at, updated_at)
        select batch_id, project_id, asset_id, pack_id, source_key, character_key, provider, 2, created_by, 1, 1 from studio_jobs where batch_id = ${batchId}`).rejects.toThrow(/idx_studio_jobs_one_active/);
    });
  });

  // ── migration validation ──
  describe('migrations 0025 and 0026 on a real PostgreSQL', () => {
    const studioObjects = async () => ({
      tables: (await client`select relname from pg_class where relname like 'studio\\_%' and relkind = 'r' order by 1`).map((r) => r.relname as string),
      indexes: (await client`select indexname from pg_indexes where tablename like 'studio\\_%' order by 1`).map((r) => r.indexname as string),
      triggers: (await client`select tgname from pg_trigger where not tgisinternal and tgname like 'studio\\_%' order by 1`).map((r) => r.tgname as string),
      functions: (await client`select proname, prosecdef, proconfig from pg_proc where proname like 'studio\\_%' order by 1`),
    });

    it('creates every table with row level security and no policy, every trigger, and pinned function search paths', async () => {
      const o = await studioObjects();
      expect(o.tables).toEqual(['studio_asset_metadata', 'studio_assets', 'studio_batches', 'studio_budget_usage', 'studio_deleted_keys', 'studio_jobs', 'studio_outputs', 'studio_packs', 'studio_project_packs', 'studio_projects', 'studio_selections', 'studio_upload_intents', 'studio_worker_status']);
      const rls = await client`select relname, relrowsecurity from pg_class where relname like 'studio\\_%' and relkind = 'r'`;
      expect(rls.every((r) => r.relrowsecurity)).toBe(true);
      expect(await client`select 1 from pg_policies where tablename like 'studio\\_%'`).toHaveLength(0);
      expect(o.triggers).toEqual(expect.arrayContaining(['studio_assets_keys_trg', 'studio_projects_keys_trg', 'studio_deleted_keys_no_delete', 'studio_jobs_guard_trg', 'studio_assets_immutable_trg', 'studio_assets_no_delete']));
      for (const f of o.functions) { expect(f.proconfig, String(f.proname)).toEqual(expect.arrayContaining(['search_path=pg_catalog, public'])); expect(f.prosecdef).toBe(false); }
      expect(o.indexes).toContain('idx_studio_jobs_one_active');
      const idx = (await client`select indexdef from pg_indexes where indexname = 'idx_studio_jobs_one_active'`)[0].indexdef as string;
      expect(idx).toContain('submit_unknown');
    });

    it('can be applied again without error and without changing anything (both files are idempotent)', async () => {
      const before = await studioObjects();
      for (const f of migrationFiles().filter((m) => m.startsWith('0025_') || m.startsWith('0026_'))) await client.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
      expect(await studioObjects()).toEqual(before);
    });

    it('touches no table that existed before: their columns, constraints, indexes and triggers are identical with and without the Studio migrations', async () => {
      const probeName = `soma_probe_${process.pid}_${Date.now()}`;
      await admin.unsafe(`create database ${probeName}`);
      const probeUrl = new URL(URL_ENV!); probeUrl.pathname = `/${probeName}`;
      const probe = postgres(probeUrl.toString(), { max: 2, onnotice: () => {} });
      try {
        await probe.unsafe(`create schema auth; create function auth.uid() returns uuid language sql as 'select null::uuid'; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
        const files = migrationFiles().filter((m) => !m.startsWith('0025_') && !m.startsWith('0026_'));
        for (const f of files.filter((m) => m < '0022_')) await probe.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
        await probe.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
        for (const f of files.filter((m) => m >= '0022_')) await probe.unsafe(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
        const fingerprint = async (c: ReturnType<typeof postgres>) => ({
          columns: await c`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name not like 'studio\\_%' order by 1, 2`,
          constraints: await c`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text not like 'studio\\_%' order by 1, 2`,
          indexes: await c`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename not like 'studio\\_%' order by 1, 2`,
          triggers: await c`select tgrelid::regclass::text t, tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'studio\\_%' order by 1, 2`,
          policies: await c`select tablename, policyname, cmd, qual from pg_policies where tablename not like 'studio\\_%' order by 1, 2`,
          functions: await c`select proname from pg_proc where pronamespace = 'public'::regnamespace and proname not like 'studio\\_%' order by 1`,
        });
        expect(JSON.stringify(await fingerprint(client))).toBe(JSON.stringify(await fingerprint(probe)));
      } finally { await probe.end({ timeout: 5 }); await admin.unsafe(`drop database if exists ${probeName} with (force)`); }
    });

    it('contains nothing destructive: no drop of anything that is not a Studio object, no truncate, no row deletes', () => {
      for (const f of ['0025_studio.sql', '0026_studio_lifecycle.sql']) {
        const sql = fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8').replace(/--.*$/gm, '');
        expect(sql, f).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bDROP\s+(TABLE|SCHEMA|COLUMN|DATABASE)\b|\bALTER\s+TABLE\s+(?!studio_)\w+/i);
        for (const m of sql.matchAll(/DROP\s+(TRIGGER|INDEX|CONSTRAINT)\s+(IF EXISTS\s+)?(\w+)/gi)) expect(m[3], `${f}: ${m[0]}`).toMatch(/^(studio_|idx_studio_)/);
        for (const m of sql.matchAll(/DROP\s+TRIGGER\s+IF EXISTS\s+\w+\s+ON\s+(\w+)/gi)) expect(m[1]).toMatch(/^studio_/);
      }
    });
  });
});
