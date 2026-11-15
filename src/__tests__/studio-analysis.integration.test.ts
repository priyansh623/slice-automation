/**
 * The analysis queue and the Studio worker's loop pieces, against an in-memory Postgres built from the repository's
 * migrations. The model and storage are replaced by fakes; the queue, leases, recovery and metadata writes are real.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema.pg';

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));

import { claimNextAsset, completeAnalysis, recoverStaleAnalysis, ANALYSIS_LEASE_MS, MAX_ANALYSIS_ATTEMPTS } from '@/lib/studio/analysis-queue';
import { requestReanalysis, getAssetView } from '@/lib/studio/repository';
import { analyseClaimed, describeFailure, runAnalysisRound, studioTick, studioWorkerEnabled, analysisConcurrency, type AnalysisDeps } from '@/worker/studio';

const ROOT = path.resolve(__dirname, '../..');
const USER = '00000000-0000-4000-8000-00000000a11c';
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

async function migrate(target: PGlite): Promise<void> {
  await target.exec(`create schema if not exists auth; create or replace function auth.uid() returns uuid language sql as 'select null::uuid'; create or replace function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const files = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification')).sort();
  for (const f of files.filter((m) => m < '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
  await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
  for (const f of files.filter((m) => m >= '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
}
beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => { await pg.exec('delete from studio_asset_metadata'); await pg.exec(`alter table studio_assets disable trigger studio_assets_no_delete; delete from studio_assets; alter table studio_assets enable trigger studio_assets_no_delete;`); });

let n = 0;
async function pack() {
  const now = Date.now();
  return (await db.insert(schema.studioPacks).values({ name: `p${++n}`, createdBy: USER, createdAt: now, updatedAt: now }).returning())[0].id;
}
async function asset(packId: number, over: Partial<typeof schema.studioAssets.$inferInsert> = {}) {
  const now = Date.now();
  const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/k${++n}.png`, mime: 'image/png', sizeBytes: 10, sha256: `h${n}`, createdBy: USER, createdAt: now, updatedAt: now, ...over }).returning();
  await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, manual: {}, createdAt: now, updatedAt: now });
  return a;
}
const statusOf = async (id: number) => (await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, id)))[0];
const okDeps = (over: Partial<AnalysisDeps> = {}): AnalysisDeps => ({
  read: async () => Buffer.from('bytes'),
  analyse: async () => ({ metadata: { environment: 'kitchen', description: 'A kitchen.', tags: ['kitchen'] }, model: 'm1' }),
  ...over,
});

describe('claiming', () => {
  it('takes the oldest pending, non-archived image, starts its lease and counts the attempt', async () => {
    const p = await pack();
    const archived = await asset(p, { archivedAt: Date.now() });
    const first = await asset(p);
    const second = await asset(p);
    const claimed = await claimNextAsset(1000);
    expect(claimed?.id).toBe(first.id);
    expect(claimed).toMatchObject({ analysisStatus: 'processing', claimedAt: 1000, analysisAttempts: 1 });
    expect((await claimNextAsset())?.id).toBe(second.id);   // the next call gets the next image, never the same one twice
    expect(await claimNextAsset()).toBeNull();
    expect((await statusOf(archived.id)).analysisStatus).toBe('pending'); // archived images are never analysed
  });

  it('does not claim images that are processing, completed or failed', async () => {
    const p = await pack();
    for (const s of ['processing', 'completed', 'failed', 'skipped']) await asset(p, { analysisStatus: s });
    expect(await claimNextAsset()).toBeNull();
  });
});

describe('one failed image never interrupts the rest of a bulk upload', () => {
  it('analyses every other image, records the failure on its own image, keeps it visible, and a retry then succeeds', async () => {
    const p = await pack();
    const imgs = [await asset(p), await asset(p), await asset(p), await asset(p), await asset(p)];
    const bad = imgs[2];
    const deps = okDeps({
      read: async (key) => { if (key === bad.storageKey) throw Object.assign(new Error('boom'), { status: 529 }); return Buffer.from('b'); },
    });
    let handled = 0;
    while (true) { const h = await runAnalysisRound(2, deps); if (!h) break; handled += h; }
    expect(handled).toBe(5);
    const states = await Promise.all(imgs.map(async (i) => (await statusOf(i.id)).analysisStatus));
    expect(states).toEqual(['completed', 'completed', 'failed', 'completed', 'completed']);
    const failed = await statusOf(bad.id);
    expect(failed.analysisError).toContain('Analysis failed (529)');
    expect(failed.archivedAt).toBeNull();                                   // still an active, visible image
    expect(((await getAssetView(bad.id)).asset.analysisStatus)).toBe('failed');

    await requestReanalysis(bad.id);                                         // the user's retry
    expect((await statusOf(bad.id)).analysisAttempts).toBe(0);
    expect(await runAnalysisRound(2, okDeps())).toBe(1);
    expect((await statusOf(bad.id)).analysisStatus).toBe('completed');
  });

  it('works on at most the configured number of images at once', async () => {
    const p = await pack();
    for (let i = 0; i < 5; i++) await asset(p);
    let running = 0; let peak = 0;
    const deps = okDeps({ analyse: async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running--; return { metadata: { description: 'x' }, model: 'm' }; } });
    expect(await runAnalysisRound(2, deps)).toBe(2);
    expect(peak).toBe(2);
    expect((await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.analysisStatus, 'pending')))).toHaveLength(3);
  });
});

describe('manual edits always win, and re-analysis never overwrites them', () => {
  it('writes the AI column only: manual is byte-for-byte the same after analysis and after re-analysis', async () => {
    const p = await pack();
    const a = await asset(p);
    const manual = { environment: 'my living room', lighting: null, tags: ['mine'] };
    await db.update(schema.studioAssetMetadata).set({ manual, manualUpdatedBy: USER, manualUpdatedAt: 5 }).where(eq(schema.studioAssetMetadata.assetId, a.id));

    await runAnalysisRound(1, okDeps());
    let meta = (await db.select().from(schema.studioAssetMetadata).where(eq(schema.studioAssetMetadata.assetId, a.id)))[0];
    expect(meta.manual).toEqual(manual);
    expect(meta).toMatchObject({ aiModel: 'm1', aiVersion: 1, manualUpdatedBy: USER, manualUpdatedAt: 5 });
    expect(meta.ai).toMatchObject({ environment: 'kitchen' });

    await requestReanalysis(a.id);
    await runAnalysisRound(1, okDeps({ analyse: async () => ({ metadata: { environment: 'garage', lighting: 'dim', description: 'A garage.' }, model: 'm2' }) }));
    meta = (await db.select().from(schema.studioAssetMetadata).where(eq(schema.studioAssetMetadata.assetId, a.id)))[0];
    expect(meta.manual).toEqual(manual);                                      // untouched
    expect(meta.ai).toMatchObject({ environment: 'garage' });                 // replaced
    const view = await getAssetView(a.id);
    expect(view.metadata.values).toMatchObject({ environment: 'my living room', lighting: null, description: 'A garage.', tags: ['mine'] });
    expect(view.metadata.provenance).toMatchObject({ environment: 'manual', lighting: 'manual', description: 'ai' });
  });

  it('keeps the original file record immutable through analysis', async () => {
    const p = await pack();
    const a = await asset(p);
    await runAnalysisRound(1, okDeps());
    const after = await statusOf(a.id);
    expect(after).toMatchObject({ storageKey: a.storageKey, sha256: a.sha256, sizeBytes: a.sizeBytes, mime: a.mime, packId: a.packId });
  });

  it('marks the pack profile out of date when an analysis completes', async () => {
    const p = await pack();
    await db.update(schema.studioPacks).set({ profileStale: false }).where(eq(schema.studioPacks.id, p));
    const a = await asset(p);
    const claimed = (await claimNextAsset())!;
    await completeAnalysis(claimed, { description: 'x' }, 'm');
    expect((await db.select().from(schema.studioPacks).where(eq(schema.studioPacks.id, p)))[0].profileStale).toBe(true);
    expect(a.id).toBe(claimed.id);
  });
});

describe('leases, heartbeat and stale-job recovery', () => {
  it('renews the lease while an analysis is slow', async () => {
    const p = await pack();
    const a = await asset(p);
    const claimed = (await claimNextAsset(1))!;
    const deps = okDeps({ heartbeatMs: 10, analyse: async () => { await new Promise((r) => setTimeout(r, 60)); return { metadata: { description: 'x' }, model: 'm' }; } });
    // the first heartbeat must move claimed_at forward while the work is still running
    const work = analyseClaimed(claimed, deps);
    await new Promise((r) => setTimeout(r, 35));
    expect((await statusOf(a.id)).claimedAt).toBeGreaterThan(1);
    expect(await work).toBe('completed');
  });

  it('puts an abandoned image back in the queue, but leaves a fresh lease alone', async () => {
    const p = await pack();
    const now = 10_000_000;
    const stale = await asset(p, { analysisStatus: 'processing', claimedAt: now - ANALYSIS_LEASE_MS - 1, analysisAttempts: 1 });
    const fresh = await asset(p, { analysisStatus: 'processing', claimedAt: now - 1000, analysisAttempts: 1 });
    expect(await recoverStaleAnalysis(now)).toEqual({ requeued: 1, failed: 0 });
    expect(await statusOf(stale.id)).toMatchObject({ analysisStatus: 'pending', claimedAt: null });
    expect((await statusOf(fresh.id)).analysisStatus).toBe('processing');
  });

  it('marks an image failed (visible, retryable) after too many interrupted attempts', async () => {
    const p = await pack();
    const now = 10_000_000;
    const a = await asset(p, { analysisStatus: 'processing', claimedAt: now - ANALYSIS_LEASE_MS - 1, analysisAttempts: MAX_ANALYSIS_ATTEMPTS });
    expect(await recoverStaleAnalysis(now)).toEqual({ requeued: 0, failed: 1 });
    const row = await statusOf(a.id);
    expect(row.analysisStatus).toBe('failed');
    expect(row.analysisError).toContain('re-analyse');
    expect(row.archivedAt).toBeNull();
  });

  it('a result that arrives after the image was queued again does not mark it completed', async () => {
    const p = await pack();
    const a = await asset(p);
    const claimed = (await claimNextAsset())!;
    await requestReanalysis(a.id);                       // user re-queues while the first analysis is still running
    await completeAnalysis(claimed, { description: 'old' }, 'm');
    expect((await statusOf(a.id)).analysisStatus).toBe('pending'); // it will be analysed again
  });
});

describe('failure messages and the loop', () => {
  it('never stores provider error text (it can quote request details)', () => {
    const msg = describeFailure(Object.assign(new Error('request body: sk-ant-secret-123 base64...'), { name: 'APIError', status: 500 }));
    expect(msg).toBe('Analysis failed (500). Press re-analyse to try again.');
    expect(msg).not.toContain('sk-ant');
    expect(describeFailure({ name: 'ObjectNotFoundError' })).toContain('not found in storage');
  });

  it('leaves images pending (not failed) when no API key is configured', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = await pack();
      const a = await asset(p);
      expect(await studioTick(okDeps(), { lastRecovery: Date.now(), warnedNoKey: false })).toBe('waiting');
      expect((await statusOf(a.id)).analysisStatus).toBe('pending');
    } finally { warn.mockRestore(); if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
  });

  it('works through the queue when configured, and recovers stale work first', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const p = await pack();
      const stale = await asset(p, { analysisStatus: 'processing', claimedAt: 1, analysisAttempts: 1 });
      const state = { lastRecovery: 0, warnedNoKey: false };
      expect(await studioTick(okDeps(), state)).toBe('worked');
      expect((await statusOf(stale.id)).analysisStatus).toBe('completed');
      expect(await studioTick(okDeps(), state)).toBe('idle');
    } finally { delete process.env.ANTHROPIC_API_KEY; }
  });

  it('can be switched off, and keeps its concurrency within the worker\'s memory budget', () => {
    process.env.STUDIO_WORKER = 'off';
    expect(studioWorkerEnabled()).toBe(false);
    delete process.env.STUDIO_WORKER;
    expect(studioWorkerEnabled()).toBe(true);
    for (const [v, want] of [[undefined, 1], ['1', 1], ['2', 2], ['99', 2], ['0', 1], ['abc', 1]] as const) {
      if (v === undefined) delete process.env.STUDIO_ANALYSIS_CONCURRENCY; else process.env.STUDIO_ANALYSIS_CONCURRENCY = v;
      expect(analysisConcurrency()).toBe(want);
    }
    delete process.env.STUDIO_ANALYSIS_CONCURRENCY;
  });

  it('is independent of the video loop: it starts outside tick() and the video tick never runs Studio work', () => {
    const index = fs.readFileSync(path.join(ROOT, 'src/worker/index.ts'), 'utf8');
    const tick = index.slice(index.indexOf('async function tick()'), index.indexOf('export async function processPromptTasks'));
    expect(tick).not.toMatch(/studio/i);
    expect(index).toMatch(/startStudioWorker\(\);\s*\n\s*await runLoop\(\)/);
    const studio = fs.readFileSync(path.join(ROOT, 'src/worker/studio.ts'), 'utf8');
    expect(studio).not.toMatch(/from '\.\/index'|from '\.\/compilation'/);
  });
});
