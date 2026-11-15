/**
 * THE rule: once a project approves a Scene Pack, every non-archived image of that pack is visible and reachable. Nothing
 * about an image (its relevance, metadata, analysis state, who or what it shows) can hide it. These tests run the real
 * routes and library over an in-memory Postgres built from the repository's migrations.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate, call } from './helpers/studio-fakes';

const USER = '00000000-0000-4000-8000-00000000000a';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown, userId: '00000000-0000-4000-8000-00000000000a' as string | null }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { POST as projectsPost } from '@/app/api/v1/studio/projects/route';
import { PUT as projectPut } from '@/app/api/v1/studio/projects/[id]/route';
import { GET as projectPacksGet, POST as projectPacksPost } from '@/app/api/v1/studio/projects/[id]/packs/route';
import { DELETE as packRevoke } from '@/app/api/v1/studio/projects/[id]/packs/[packId]/route';
import { GET as approvedAssets } from '@/app/api/v1/studio/projects/[id]/packs/[packId]/assets/route';
import { POST as assetArchive } from '@/app/api/v1/studio/assets/[id]/archive/route';

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(() => { holder.store = new FakeR2(); holder.userId = USER; });

let seq = 0;
const now = () => Date.now();
const newProject = async () => (await call(projectsPost, { method: 'POST', body: { name: 'P' } })).json.project.id as number;
async function pack(name: string, archived = false) {
  return (await db.insert(schema.studioPacks).values({ name, createdBy: USER, createdAt: now(), updatedAt: now(), archivedAt: archived ? now() : null }).returning())[0].id;
}
async function asset(packId: number, over: { ai?: Record<string, unknown> | null; manual?: Record<string, unknown>; status?: string; createdAt?: number } = {}) {
  const t = over.createdAt ?? now();
  const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/v${++seq}.png`, mime: 'image/png', sizeBytes: 5, sha256: `v${seq}`, analysisStatus: over.status ?? 'completed', createdBy: USER, createdAt: t, updatedAt: t }).returning();
  await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, ai: over.ai ?? null, manual: over.manual ?? {}, createdAt: t, updatedAt: t });
  return a.id;
}
const approve = (projectId: number, packIds: number[]) => call(projectPacksPost, { method: 'POST', params: { id: String(projectId) }, body: { packIds } });
const listAll = async (projectId: number, packId: number, limit = 7) => {
  const seen: number[] = []; let cursor: number | null = null;
  do {
    const r = await call(approvedAssets, { params: { id: String(projectId), packId: String(packId) }, query: `limit=${limit}${cursor ? `&after=${cursor}` : ''}` });
    expect(r.status).toBe(200);
    seen.push(...r.json.assets.map((a: any) => a.id)); cursor = r.json.nextCursor;
  } while (cursor);
  return seen;
};

describe('every image of an approved pack is visible, whatever it looks like or how it was analysed', () => {
  it('returns all non-archived images, once each, across pages, including failed, unanalysed, oddly tagged and manually edited ones', async () => {
    const proj = await newProject(); const p = await pack('Everything');
    const ids = [
      await asset(p, { ai: { description: 'a man in his sixties', tags: ['male', 'elderly'] } }),
      await asset(p, { ai: { description: 'a young woman', tags: ['female', 'twenties'] } }),
      await asset(p, { ai: { description: 'a child at a table' } }),
      await asset(p, { ai: null, status: 'failed' }),
      await asset(p, { ai: null, status: 'pending' }),
      await asset(p, { ai: null, status: 'processing' }),
      await asset(p, { ai: null, status: 'skipped' }),
      await asset(p, { ai: { environment: 'office' }, manual: { environment: null, description: null, tags: [] } }), // every field cleared by a person
      await asset(p, { ai: { description: 'x'.repeat(2000) } }),
      await asset(p, { ai: { description: '' } }),
      await asset(p),
      await asset(p, { ai: { tags: Array.from({ length: 30 }, (_, i) => `t${i}`) } }),
    ];
    const archived = await asset(p);
    await call(assetArchive, { method: 'POST', params: { id: String(archived) }, body: {} });
    expect((await approve(proj, [p])).status).toBe(200);

    const seen = await listAll(proj, p, 5);
    expect(seen).toEqual(ids);                          // exactly the non-archived assets, in order, none missing, none repeated
    const total = (await call(approvedAssets, { params: { id: String(proj), packId: String(p) }, query: 'limit=200' })).json.totalActive;
    expect(total).toBe(ids.length);
    expect(await listAll(proj, p, 200)).toEqual(ids);    // page size does not matter
  });

  it('a recommendation score, a recommendation list, or the absence of one never changes what is visible', async () => {
    const proj = await newProject(); const recommended = await pack('Recommended'); const notRecommended = await pack('Other');
    const a = await asset(recommended); const b = await asset(notRecommended);
    await db.update(schema.studioProjects).set({ recommendations: [{ packId: recommended, score: 0.99, reasons: ['r'], moments: [] }], recommendationsScriptHash: 'h', scriptHash: 'h' }).where(eq(schema.studioProjects.id, proj));
    const r = await approve(proj, [recommended, notRecommended]);
    expect(r.json.packs.map((x: any) => [x.packId, x.source]).sort()).toEqual([[recommended, 'recommended'], [notRecommended, 'manual']].sort());
    expect(await listAll(proj, recommended)).toEqual([a]);
    expect(await listAll(proj, notRecommended)).toEqual([b]);     // a pack that was never recommended is just as visible
  });

  it('lists nothing from a pack the project has not approved (pack-first), even if it is recommended', async () => {
    const proj = await newProject(); const p = await pack('Recommended but not approved');
    await asset(p);
    await db.update(schema.studioProjects).set({ recommendations: [{ packId: p, score: 1, reasons: [], moments: [] }] }).where(eq(schema.studioProjects.id, proj));
    const r = await call(approvedAssets, { params: { id: String(proj), packId: String(p) } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('pack_not_approved');
    expect(r.json.assets).toBeUndefined();
    // approving one pack does not open another
    const other = await pack('Approved'); await approve(proj, [other]);
    expect((await call(approvedAssets, { params: { id: String(proj), packId: String(p) } })).status).toBe(403);
  });

  it('shows images added to a pack later, to a project that approved it earlier, and says how many are new', async () => {
    const proj = await newProject(); const p = await pack('Growing');
    const first = await asset(p, { createdAt: now() - 10_000 });
    await approve(proj, [p]);
    const initial = (await call(projectPacksGet, { params: { id: String(proj) } })).json.packs[0];
    expect(initial).toMatchObject({ activeAssetCount: 1, newSinceApproval: 0 });
    const second = await asset(p, { createdAt: now() + 5_000 });
    expect(await listAll(proj, p)).toEqual([first, second]);
    expect((await call(projectPacksGet, { params: { id: String(proj) } })).json.packs[0]).toMatchObject({ activeAssetCount: 2, newSinceApproval: 1 });
  });

  it('hides an image only when a person archives it, and shows it again when it is restored', async () => {
    const proj = await newProject(); const p = await pack('Curated');
    const a = await asset(p); const b = await asset(p);
    await approve(proj, [p]);
    await call(assetArchive, { method: 'POST', params: { id: String(b) }, body: {} });
    expect(await listAll(proj, p)).toEqual([a]);
    await call(assetArchive, { method: 'POST', params: { id: String(b) }, body: { archived: false } });
    expect(await listAll(proj, p)).toEqual([a, b]);
  });

  it('narrows the list only when a person types a search, and everything returns when it is cleared', async () => {
    const proj = await newProject(); const p = await pack('Searchable');
    const a = await asset(p, { ai: { environment: 'sunny kitchen' } }); const b = await asset(p, { ai: { environment: 'airport gate' } });
    await approve(proj, [p]);
    const ids = async (q?: string) => (await call(approvedAssets, { params: { id: String(proj), packId: String(p) }, query: q })).json.assets.map((x: any) => x.id);
    expect(await ids()).toEqual([a, b]);
    expect(await ids('q=kitchen')).toEqual([a]);
    expect(await ids()).toEqual([a, b]);
  });

  it('can only newly approve an active pack, and approving twice is harmless', async () => {
    const proj = await newProject(); const live = await pack('Live'); const gone = await pack('Retired', true);
    expect((await approve(proj, [gone])).status).toBe(409);
    expect((await approve(proj, [999999])).status).toBe(404);
    expect((await approve(proj, [])).status).toBe(400);
    expect((await approve(proj, [live])).json).toMatchObject({ approved: [live], already: [] });
    expect((await approve(proj, [live])).json).toMatchObject({ approved: [], already: [live] });
    // an approved pack that is archived later stays reachable for the projects that already approved it
    await db.update(schema.studioPacks).set({ archivedAt: now() }).where(eq(schema.studioPacks.id, live));
    expect((await call(approvedAssets, { params: { id: String(proj), packId: String(live) } })).status).toBe(200);
  });
});

describe('revoking an approval', () => {
  async function selected(proj: number, p: number, a: number) {
    await db.insert(schema.studioSelections).values({ projectId: proj, assetId: a, packId: p, addedBy: USER, addedAt: now() });
  }

  it('is blocked while images from the pack are selected, and allowed once they are removed; history is untouched', async () => {
    const proj = await newProject(); const p = await pack('Held'); const a = await asset(p);
    await approve(proj, [p]); await selected(proj, p, a);
    const blocked = await call(packRevoke, { method: 'DELETE', params: { id: String(proj), packId: String(p) } });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('pack_has_selections');
    expect(blocked.json.error).toContain('1 image is still selected');
    expect((await call(approvedAssets, { params: { id: String(proj), packId: String(p) } })).status).toBe(200);

    // a past generation for this image
    const batch = (await db.insert(schema.studioBatches).values({ projectId: proj, createdBy: USER, provider: 'mock', characterKey: 'c', totalJobs: 1, createdAt: now() }).returning())[0].id;
    const job = (await db.insert(schema.studioJobs).values({ batchId: batch, projectId: proj, assetId: a, packId: p, sourceKey: 's', characterKey: 'c', provider: 'mock', status: 'succeeded', createdBy: USER, createdAt: now(), updatedAt: now() }).returning())[0].id;
    await db.delete(schema.studioSelections).where(and(eq(schema.studioSelections.projectId, proj), eq(schema.studioSelections.assetId, a)));
    expect((await call(packRevoke, { method: 'DELETE', params: { id: String(proj), packId: String(p) } })).status).toBe(200);
    expect((await call(approvedAssets, { params: { id: String(proj), packId: String(p) } })).status).toBe(403);
    expect(await db.select().from(schema.studioJobs).where(eq(schema.studioJobs.id, job))).toHaveLength(1); // history preserved
    expect((await call(packRevoke, { method: 'DELETE', params: { id: String(proj), packId: String(p) } })).status).toBe(404);
  });
});

describe('guard against hidden filters', () => {
  it('listPackAssets filters only on the pack, archival, the cursor and a typed search', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../lib/studio/repository.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function listPackAssets'), src.indexOf('export async function getAssetView'));
    const conditions = body.slice(body.indexOf('const conditions'), body.indexOf('const rows'));
    expect(conditions).toMatch(/packId/);
    expect(conditions).toMatch(/archivedAt/);
    expect(conditions).not.toMatch(/score|relevan|gender|age\b|appearance|compatib|analysisStatus|analysis_status|\.ai\b|manual/i);
    const approvals = fs.readFileSync(path.resolve(__dirname, '../lib/studio/approvals.ts'), 'utf8');
    const listing = approvals.slice(approvals.indexOf('export async function listApprovedPackAssets'));
    expect(listing).not.toMatch(/score|relevan|recommend|gender|appearance|compatib/i);
  });
});
