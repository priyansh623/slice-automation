/**
 * The Scene Pack Repository through its real routes: access, R2-only storage, verified uploads, immutable originals,
 * duplicates, pagination that never loses an image, metadata provenance and archival. Real sharp and routes; an
 * in-memory Postgres built from the repository's migrations; auth and storage are replaced.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';

class FakeR2 {
  objects = new Map<string, { buf: Buffer; contentType: string }>();
  puts: string[] = [];
  deletes: string[] = [];
  available = true;
  failPut = false;
  private k = (b: string, key: string) => `${b}/${key}`;
  r2Configured() { return this.available; }
  directUploadAvailable() { return this.available; }
  async signedDirectUpload(_b: string, key: string, contentType: string, size: number) {
    return { url: `https://r2.test/${key}?size=${size}`, method: 'PUT' as const, headers: { 'Content-Type': contentType } };
  }
  async headR2(b: string, key: string) { const o = this.objects.get(this.k(b, key)); return o ? { size: o.buf.length, contentType: o.contentType, etag: 'e' } : null; }
  async downloadR2Only(b: string, key: string) { const o = this.objects.get(this.k(b, key)); if (!o) throw new Error('missing'); return o.buf; }
  async putR2Only(b: string, key: string, buf: Buffer, opts: { contentType: string }) {
    if (!this.available || this.failPut) throw new Error('r2 down');
    if (this.objects.has(this.k(b, key))) { const { ObjectExistsError } = await import('@/lib/object-store/types'); throw new ObjectExistsError(b as 'uploads', key); }
    this.puts.push(key); this.objects.set(this.k(b, key), { buf, contentType: opts.contentType }); return { provider: 'r2' as const };
  }
  async deleteFromR2(b: string, key: string) { this.deletes.push(key); this.objects.delete(this.k(b, key)); }
  async signedReadUrls(b: string, keys: string[]) { return new Map(keys.filter((k) => this.objects.has(this.k(b, k))).map((k) => [k, `https://r2.test/${k}?sig=1`] as [string, string])); }
  /** What the browser's PUT to the presigned URL does. */
  browserPut(key: string, buf: Buffer, contentType: string) { this.objects.set(this.k('uploads', key), { buf, contentType }); }
  has(key: string) { return this.objects.has(this.k('uploads', key)); }
  get(key: string) { return this.objects.get(this.k('uploads', key))!.buf; }
}

const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown, userId: '00000000-0000-4000-8000-00000000000a' as string | null }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { GET as packsGet, POST as packsPost } from '@/app/api/v1/studio/packs/route';
import { GET as packGet, PUT as packPut } from '@/app/api/v1/studio/packs/[id]/route';
import { POST as packArchive } from '@/app/api/v1/studio/packs/[id]/archive/route';
import { GET as assetsGet } from '@/app/api/v1/studio/packs/[id]/assets/route';
import { POST as assetInit } from '@/app/api/v1/studio/packs/[id]/assets/init/route';
import { POST as assetComplete } from '@/app/api/v1/studio/packs/[id]/assets/complete/route';
import { GET as assetGet } from '@/app/api/v1/studio/assets/[id]/route';
import { PUT as metaPut } from '@/app/api/v1/studio/assets/[id]/metadata/route';
import { POST as reanalyze } from '@/app/api/v1/studio/assets/[id]/reanalyze/route';
import { POST as assetArchive } from '@/app/api/v1/studio/assets/[id]/archive/route';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const ROOT = path.resolve(__dirname, '../..');
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
let r2: FakeR2;

async function migrate(target: PGlite): Promise<void> {
  await target.exec(`create schema if not exists auth; create or replace function auth.uid() returns uuid language sql as 'select null::uuid'; create or replace function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const files = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification')).sort();
  for (const f of files.filter((m) => m < '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
  await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
  for (const f of files.filter((m) => m >= '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
}

beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(() => { r2 = new FakeR2(); holder.store = r2; holder.userId = USER_A; });

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (color: string, w = 1200, h = 800) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const jpg = (color: string) => sharp({ create: { width: 900, height: 600, channels: 3, background: color } }).jpeg().toBuffer();

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, opts: { method?: string; body?: unknown; query?: string; params?: Record<string, string> } = {}) {
  const url = `http://localhost/api${opts.query ? `?${opts.query}` : ''}`;
  const req = new NextRequest(url, { method: opts.method ?? 'GET', ...(opts.body !== undefined ? { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } } : {}) });
  const res = await (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const newPack = async (name = 'Kitchen') => { const r = await call(packsPost, { method: 'POST', body: { name, description: 'Home kitchens' } }); if (r.status !== 201) throw new Error(`create pack failed: ${r.status} ${JSON.stringify(r.json)}`); return r.json.pack.id as number; };

/** The full browser flow: init, PUT to R2, complete. */
async function upload(packId: number, buf: Buffer, contentType = 'image/png', fileName = 'a.png', ingestGroup?: string) {
  const init = await call(assetInit, { method: 'POST', params: { id: String(packId) }, body: { contentType, fileSize: buf.length, fileName } });
  if (init.status !== 200) return { init, done: null as null };
  r2.browserPut(init.json.storageKey, buf, contentType);
  const done = await call(assetComplete, { method: 'POST', params: { id: String(packId) }, body: { storageKey: init.json.storageKey, contentType, fileSize: buf.length, fileName, ingestGroup } });
  return { init, done };
}

describe('access: signed-in users only, and then everything is shared', () => {
  it('rejects every Studio repository route without a signed-in user, and writes nothing', async () => {
    holder.userId = null;
    const id = { id: '1' };
    const calls: Array<[unknown, Parameters<typeof call>[1]]> = [
      [packsGet, {}], [packsPost, { method: 'POST', body: { name: 'x' } }], [packGet, { params: id }], [packPut, { method: 'PUT', params: id, body: { name: 'x' } }],
      [packArchive, { method: 'POST', params: id, body: {} }], [assetsGet, { params: id }], [assetInit, { method: 'POST', params: id, body: {} }],
      [assetComplete, { method: 'POST', params: id, body: {} }], [assetGet, { params: id }], [metaPut, { method: 'PUT', params: id, body: { fields: { environment: 'x' } } }],
      [reanalyze, { method: 'POST', params: id }], [assetArchive, { method: 'POST', params: id, body: {} }],
    ];
    for (const [h, o] of calls) expect((await call(h, o)).status).toBe(401);
    expect(await db.select().from(schema.studioPacks)).toHaveLength(0);
    expect(r2.puts).toHaveLength(0);
  });

  it('lets any signed-in user manage packs and images created by someone else (shared workspace)', async () => {
    holder.userId = USER_A;
    const packId = await newPack('Shared');
    const up = await upload(packId, await png('#c0392b'));
    const assetId = up.done!.json.asset.id as number;
    holder.userId = USER_B;
    expect((await call(packPut, { method: 'PUT', params: { id: String(packId) }, body: { name: 'Renamed by B' } })).status).toBe(200);
    expect((await call(metaPut, { method: 'PUT', params: { id: String(assetId) }, body: { fields: { environment: 'edited by B' } } })).status).toBe(200);
    expect((await call(assetArchive, { method: 'POST', params: { id: String(assetId) }, body: {} })).status).toBe(200);
    expect((await call(packArchive, { method: 'POST', params: { id: String(packId) }, body: {} })).status).toBe(200);
  });
});

describe('packs', () => {
  it('creates, edits, lists with counts, archives and restores a pack', async () => {
    const id = await newPack('Cafe');
    expect((await call(packsPost, { method: 'POST', body: { name: '  ' } })).status).toBe(400);
    const edited = await call(packPut, { method: 'PUT', params: { id: String(id) }, body: { name: 'Cafe & bar', description: 'New' } });
    expect(edited.json.pack).toMatchObject({ name: 'Cafe & bar', description: 'New' });
    await upload(id, await png('#2980b9'));
    const list = (await call(packsGet)).json.packs.find((p: any) => p.id === id);
    expect(list).toMatchObject({ assetCount: 1, analysisPending: 1, analysisFailed: 0 });
    await call(packArchive, { method: 'POST', params: { id: String(id) }, body: {} });
    expect((await call(packsGet)).json.packs.some((p: any) => p.id === id)).toBe(false);
    expect((await call(packsGet, { query: 'includeArchived=1' })).json.packs.some((p: any) => p.id === id)).toBe(true);
    await call(packArchive, { method: 'POST', params: { id: String(id) }, body: { archived: false } });
    expect((await call(packsGet)).json.packs.some((p: any) => p.id === id)).toBe(true);
    expect((await call(packGet, { params: { id: '999999' } })).status).toBe(404);
  });
});

describe('uploads go to R2 only and are verified', () => {
  it('chooses the key on the server, never stores in Supabase, and refuses (503) when R2 is unavailable', async () => {
    const id = await newPack();
    const buf = await png('#27ae60');
    const init = await call(assetInit, { method: 'POST', params: { id: String(id) }, body: { contentType: 'image/png', fileSize: buf.length, fileName: 'x.png' } });
    expect(init.status).toBe(200);
    expect(init.json.storageKey).toMatch(/^studio\/assets\/[0-9a-f-]{36}\.png$/);
    expect(init.json.uploadUrl).toContain('r2.test');

    r2.available = false;
    const down = await call(assetInit, { method: 'POST', params: { id: String(id) }, body: { contentType: 'image/png', fileSize: buf.length } });
    expect(down.status).toBe(503);
    expect(down.json.code).toBe('r2_unavailable');
    r2.available = true;
  });

  it('validates the request: type, size, extension and an archived pack', async () => {
    const id = await newPack();
    const bad = (body: unknown) => call(assetInit, { method: 'POST', params: { id: String(id) }, body });
    expect((await bad({ contentType: 'image/gif', fileSize: 10 })).status).toBe(415);
    expect((await bad({ contentType: 'image/png', fileSize: 0 })).status).toBe(400);
    expect((await bad({ contentType: 'image/png', fileSize: 26 * 1024 * 1024 })).status).toBe(413);
    expect((await bad({ contentType: 'image/png', fileSize: 10, fileName: 'a.exe' })).status).toBe(415);
    await call(packArchive, { method: 'POST', params: { id: String(id) }, body: {} });
    expect((await bad({ contentType: 'image/png', fileSize: 10 })).status).toBe(409);
  });

  it('records the original untouched, with its hash and size, a thumbnail beside it, and queues analysis', async () => {
    const id = await newPack();
    const buf = await png('#8e44ad', 3000, 2000);
    const before = sha(buf);
    const { done } = await upload(id, buf, 'image/png', 'big.png', 'group-1234');
    expect(done!.status).toBe(201);
    const a = done!.json.asset;
    expect(a).toMatchObject({ packId: id, mime: 'image/png', sizeBytes: buf.length, sha256: before, width: 3000, height: 2000, analysisStatus: 'pending', originalFilename: 'big.png', archived: false });
    const row = (await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, a.id)))[0];
    expect(sha(r2.get(row.storageKey))).toBe(before);                       // the original is byte-for-byte what was uploaded
    expect(r2.puts).toEqual([row.thumbKey]);                                // the server's only write was the thumbnail
    expect(row.ingestGroup).toBe('group-1234');
    const thumb = await sharp(r2.get(row.thumbKey!)).metadata();
    expect(thumb.format).toBe('webp');
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(480);
    const reg = await db.select().from(schema.storageObjects).where(eq(schema.storageObjects.key, row.storageKey));
    expect(reg[0]).toMatchObject({ bucket: 'uploads', provider: 'r2', sizeBytes: buf.length, sha256: before });
    expect(a.thumbUrl).toContain('thumbs');
    const meta = await db.select().from(schema.studioAssetMetadata).where(eq(schema.studioAssetMetadata.assetId, a.id));
    expect(meta[0]).toMatchObject({ ai: null, manual: {} });
  });

  it('keeps the asset (without a thumbnail) when the thumbnail cannot be made', async () => {
    const id = await newPack();
    const buf = await png('#16a085');
    const init = await call(assetInit, { method: 'POST', params: { id: String(id) }, body: { contentType: 'image/png', fileSize: buf.length } });
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    r2.failPut = true; // writing the thumbnail fails; the original is already in R2
    const done = await call(assetComplete, { method: 'POST', params: { id: String(id) }, body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } });
    expect(done.status).toBe(201);
    expect(done.json.asset.thumbUrl).toContain(init.json.storageKey); // the grid falls back to the original
  });

  it('rejects a key it did not issue, a missing upload, a wrong size, and bytes that are not an image', async () => {
    const id = await newPack();
    const p = { id: String(id) };
    const ok = await png('#d35400');
    const complete = (body: unknown) => call(assetComplete, { method: 'POST', params: p, body });
    expect((await complete({ storageKey: '../../etc/passwd', contentType: 'image/png', fileSize: 10 })).status).toBe(403);
    expect((await complete({ storageKey: 'studio/projects/1/character/x.png', contentType: 'image/png', fileSize: 10 })).status).toBe(403);

    const init = await call(assetInit, { method: 'POST', params: p, body: { contentType: 'image/png', fileSize: ok.length } });
    expect((await complete({ storageKey: init.json.storageKey, contentType: 'image/png', fileSize: ok.length })).status).toBe(409); // never uploaded

    r2.browserPut(init.json.storageKey, ok, 'image/png');
    expect((await complete({ storageKey: init.json.storageKey, contentType: 'image/png', fileSize: ok.length + 1 })).status).toBe(422);
    expect(r2.deletes).toContain(init.json.storageKey); // an unusable, unreferenced upload is removed

    const junk = Buffer.from('this is not an image at all');
    const init2 = await call(assetInit, { method: 'POST', params: p, body: { contentType: 'image/png', fileSize: junk.length } });
    r2.browserPut(init2.json.storageKey, junk, 'image/png');
    const bad = await complete({ storageKey: init2.json.storageKey, contentType: 'image/png', fileSize: junk.length });
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('not_an_image');

    const jpeg = await jpg('#34495e');
    const init3 = await call(assetInit, { method: 'POST', params: p, body: { contentType: 'image/png', fileSize: jpeg.length } });
    r2.browserPut(init3.json.storageKey, jpeg, 'image/png'); // declared PNG, really JPEG
    expect((await complete({ storageKey: init3.json.storageKey, contentType: 'image/png', fileSize: jpeg.length })).json.code).toBe('type_mismatch');
    expect(await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.packId, id))).toHaveLength(0);
  });

  it('is idempotent: completing the same upload twice returns the same image', async () => {
    const id = await newPack();
    const buf = await png('#f39c12');
    const init = await call(assetInit, { method: 'POST', params: { id: String(id) }, body: { contentType: 'image/png', fileSize: buf.length } });
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    const body = { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length };
    const a = await call(assetComplete, { method: 'POST', params: { id: String(id) }, body });
    const b = await call(assetComplete, { method: 'POST', params: { id: String(id) }, body });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.json.asset.id).toBe(a.json.asset.id);
    expect(await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.packId, id))).toHaveLength(1);
  });
});

describe('duplicates', () => {
  it('returns the existing asset for the same image in the same pack, but keeps the same image in another pack', async () => {
    const p1 = await newPack('One'); const p2 = await newPack('Two');
    const buf = await png('#1abc9c');
    const first = await upload(p1, buf);
    const again = await upload(p1, buf);
    expect(again.done!.status).toBe(200);
    expect(again.done!.json).toMatchObject({ duplicate: true, created: false });
    expect(again.done!.json.asset.id).toBe(first.done!.json.asset.id);
    expect(await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.packId, p1))).toHaveLength(1);
    const elsewhere = await upload(p2, buf);
    expect(elsewhere.done!.status).toBe(201);
    expect(elsewhere.done!.json.asset.id).not.toBe(first.done!.json.asset.id);
  });

  it('restoring an archived copy is refused while an active copy exists, and allowed otherwise', async () => {
    const p = await newPack();
    const buf = await png('#e67e22');
    const first = (await upload(p, buf)).done!.json.asset.id as number;
    await call(assetArchive, { method: 'POST', params: { id: String(first) }, body: {} });
    const second = (await upload(p, buf)).done!.json.asset.id as number; // allowed: the archived copy does not count
    expect(second).not.toBe(first);
    const restore = await call(assetArchive, { method: 'POST', params: { id: String(first) }, body: { archived: false } });
    expect(restore.status).toBe(409);
    await call(assetArchive, { method: 'POST', params: { id: String(second) }, body: {} });
    expect((await call(assetArchive, { method: 'POST', params: { id: String(first) }, body: { archived: false } })).status).toBe(200);
  });
});

describe('listing: every image, once, whatever its metadata or analysis state', () => {
  it('pages through all assets without losing or repeating one, including failed and unanalysed ones', async () => {
    const p = await newPack('Big');
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push((await upload(p, await png(`#${(i * 20 + 16).toString(16).padStart(2, '0')}4488`, 200 + i, 300))).done!.json.asset.id);
    await db.update(schema.studioAssets).set({ analysisStatus: 'failed', analysisError: 'x' }).where(eq(schema.studioAssets.id, ids[3]));
    await db.update(schema.studioAssets).set({ analysisStatus: 'completed' }).where(eq(schema.studioAssets.id, ids[5]));
    // metadata that a relevance or "compatibility" rule might have hidden
    await db.update(schema.studioAssetMetadata).set({ ai: { description: 'a man in his sixties', environment: 'office' } }).where(eq(schema.studioAssetMetadata.assetId, ids[1]));
    await db.update(schema.studioAssetMetadata).set({ ai: { description: 'a young woman', tags: ['female', 'twenties'] } }).where(eq(schema.studioAssetMetadata.assetId, ids[2]));

    const seen: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const res = await call(assetsGet, { params: { id: String(p) }, query: `limit=5${cursor ? `&after=${cursor}` : ''}` });
      expect(res.status).toBe(200);
      expect(res.json.totalActive).toBe(12);
      seen.push(...res.json.assets.map((a: any) => a.id));
      cursor = res.json.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(12);
  });

  it('leaves out archived images by default, shows them when asked, and filters only by a search the person typed', async () => {
    const p = await newPack();
    const a = (await upload(p, await png('#111111'))).done!.json.asset.id as number;
    const b = (await upload(p, await png('#222222'))).done!.json.asset.id as number;
    await call(metaPut, { method: 'PUT', params: { id: String(a) }, body: { fields: { environment: 'sunny kitchen' } } });
    await call(assetArchive, { method: 'POST', params: { id: String(b) }, body: {} });
    const idsOf = async (q?: string) => (await call(assetsGet, { params: { id: String(p) }, query: q })).json.assets.map((x: any) => x.id);
    expect(await idsOf()).toEqual([a]);
    expect(await idsOf('includeArchived=1')).toEqual([a, b]);
    expect(await idsOf('q=kitchen')).toEqual([a]);
    expect(await idsOf('q=airport')).toEqual([]);
    expect(await idsOf()).toEqual([a]); // no search: back to everything
  });

  it('shows new images added to a pack the next time it is listed', async () => {
    const p = await newPack();
    await upload(p, await png('#333333'));
    expect((await call(assetsGet, { params: { id: String(p) } })).json.assets).toHaveLength(1);
    await upload(p, await png('#444444'));
    expect((await call(assetsGet, { params: { id: String(p) } })).json.assets).toHaveLength(2);
  });
});

describe('metadata: AI and manual stay apart, and manual wins', () => {
  it('stores edits in the manual column only, shows where each value came from, and survives re-analysis', async () => {
    const p = await newPack();
    const id = (await upload(p, await png('#555555'))).done!.json.asset.id as number;
    await db.update(schema.studioAssetMetadata).set({ ai: { environment: 'office', lighting: 'fluorescent', description: 'A desk.' }, aiModel: 'm', aiVersion: 1, aiAnalyzedAt: Date.now() }).where(eq(schema.studioAssetMetadata.assetId, id));

    const edit = await call(metaPut, { method: 'PUT', params: { id: String(id) }, body: { fields: { environment: 'home study', lighting: null } } });
    expect(edit.status).toBe(200);
    expect(edit.json.asset.metadata).toMatchObject({ environment: 'home study', lighting: null, description: 'A desk.' });
    expect(edit.json.asset.provenance).toMatchObject({ environment: 'manual', lighting: 'manual', description: 'ai' });
    expect(edit.json.asset.ai).toMatchObject({ environment: 'office', lighting: 'fluorescent' }); // the AI's own answer is still there to compare or revert to

    // re-analysis is queued, then the worker writes the AI column only
    const re = await call(reanalyze, { method: 'POST', params: { id: String(id) } });
    expect(re.json.asset.analysisStatus).toBe('pending');
    await db.update(schema.studioAssetMetadata).set({ ai: { environment: 'warehouse', lighting: 'bright', description: 'Boxes.' } }).where(eq(schema.studioAssetMetadata.assetId, id));
    const after = (await call(assetGet, { params: { id: String(id) } })).json.asset;
    expect(after.metadata).toMatchObject({ environment: 'home study', lighting: null, description: 'Boxes.' });
    expect(after.manual).toEqual({ environment: 'home study', lighting: null });

    const revert = await call(metaPut, { method: 'PUT', params: { id: String(id) }, body: { revert: ['environment'] } });
    expect(revert.json.asset.metadata.environment).toBe('warehouse');
    expect(revert.json.asset.provenance.environment).toBe('ai');
    expect((await call(metaPut, { method: 'PUT', params: { id: String(id) }, body: { fields: { gender: 'x' } } })).status).toBe(400);
  });

  it('refuses to re-analyse an archived image, and does not touch the file when metadata changes', async () => {
    const p = await newPack();
    const buf = await png('#666666');
    const id = (await upload(p, buf)).done!.json.asset.id as number;
    const key = (await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.id, id)))[0].storageKey;
    await call(metaPut, { method: 'PUT', params: { id: String(id) }, body: { fields: { description: 'edited' } } });
    expect(sha(r2.get(key))).toBe(sha(buf));
    await call(assetArchive, { method: 'POST', params: { id: String(id) }, body: {} });
    expect((await call(reanalyze, { method: 'POST', params: { id: String(id) } })).status).toBe(409);
  });
});
