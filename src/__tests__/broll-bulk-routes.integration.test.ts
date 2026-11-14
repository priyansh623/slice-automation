/**
 * The bulk upload on the server: taxonomy, AI analysis, duplicate check and the extended "complete" step, plus the whole
 * workflow (analyse -> review -> explicit category approval -> approve -> upload -> retry) against a real in-memory
 * Postgres built from the repository's migrations. Anthropic, R2 and ffprobe are replaced by fakes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as crypto from 'node:crypto';
import { brollCategories, brollClipBrands, brollClipCategories, brollClips, storageObjects } from '@/db/schema.pg';
import { addClip, createBrollTestDb, seedCategories, TEST_USER_ID, type BrollTestDb } from './helpers/broll-test-db';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: null as string | null,
  r2: new Map<string, { size: number; contentType: string | null }>(),
  bytes: new Map<string, Buffer>(),
  deleted: [] as string[],
  hashCalls: 0,
  hashes: new Map<string, string>(),
  hashTimeout: false,
  headFails: false,
  ai: { calls: [] as unknown[], result: undefined as unknown, fail: false, noTool: false },
  probe: { dims: null as { width: number; height: number } | null, durationSeconds: 5 as number | null },
}));

vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = h.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.userId ? { id: h.userId } : null } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/object-store')>()),
  getStorage: () => ({
    directUploadAvailable: () => true,
    signedDirectUpload: async (_b: string, key: string, contentType: string) => ({ url: `https://r2.example/${key}?sig=1`, method: 'PUT', headers: { 'Content-Type': contentType } }),
    headR2: async (_b: string, key: string) => { if (h.headFails) throw new Error('R2 unreachable'); return h.r2.get(key) ?? null; },
    // Streams the object's bytes through SHA-256 in the real thing. A test can supply the digest of a huge file directly (h.hashes)
    // instead of materialising it, and can simulate a read that takes too long.
    hashFromR2: async (_b: string, key: string) => {
      h.hashCalls++;
      if (h.hashTimeout) throw Object.assign(new Error('Reading uploads/x took longer than 45 s'), { name: 'HashTimeoutError' });
      const o = h.r2.get(key); if (!o) throw new Error('missing');
      const given = h.hashes.get(key);
      if (given) return { sha256: given, size: o.size };
      const b = h.bytes.get(key); if (!b) throw new Error('missing bytes');
      return { sha256: crypto.createHash('sha256').update(b).digest('hex'), size: o.size };
    },
    deleteFromR2: async (_b: string, key: string) => { h.deleted.push(key); h.r2.delete(key); },
    signedReadUrl: async (_b: string, key: string) => `https://r2.example/read/${key}`,
  }),
}));
vi.mock('@/lib/broll-probe', async (orig) => ({ ...(await orig<typeof import('@/lib/broll-probe')>()), probeVideo: () => h.probe }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: async (args: unknown) => {
    h.ai.calls.push(args);
    if (h.ai.fail) throw new Error('upstream 500');
    return { content: h.ai.noTool ? [{ type: 'text', text: 'hello' }] : [{ type: 'tool_use', name: 'record_clip_metadata', input: h.ai.result }] };
  } }; },
}));

import { GET as getTaxonomy } from '@/app/api/v1/broll/bulk/taxonomy/route';
import { POST as analyse } from '@/app/api/v1/broll/bulk/analyze/route';
import { POST as checkDuplicates } from '@/app/api/v1/broll/bulk/check-duplicates/route';
import { POST as init } from '@/app/api/v1/broll/upload/init/route';
import { POST as complete } from '@/app/api/v1/broll/upload/complete/route';
import { POST as createCategory } from '@/app/api/v1/broll/categories/route';
import { GET as listLibrary } from '@/app/api/v1/broll/route';
import { buildCompletePayload, initialEdit, newItem, uploadApproved, type BulkItem, type UploadDeps } from '@/lib/broll-bulk/batch';
import { sanitiseAnalysis } from '@/lib/broll-bulk/analysis-schema';
import { loadTaxonomy } from '@/lib/broll-bulk/taxonomy-server';

let t: BrollTestDb;
const MB = 1024 * 1024;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64'); // starts with /9j/

beforeAll(async () => {
  t = await createBrollTestDb('current');
  await t.pg.exec(`create table if not exists storage_objects (bucket text not null, key text not null, provider text not null, size_bytes bigint, content_type text, sha256 text, verified_at bigint, created_at bigint not null, updated_at bigint not null, primary key (bucket, key))`);
  h.db = t.db;
}, 60_000);
afterAll(async () => { await t.close(); });

const seedTaxonomy = async () => {
  await seedCategories(t, [
    { id: 1, name: 'Payments', slug: 'payments', parentId: null },
    { id: 22, name: 'Mobile payment', slug: 'mobile-payment', parentId: 1 },
    { id: 8, name: 'Travel', slug: 'travel', parentId: null },
    { id: 50, name: 'Cab & ride hailing', slug: 'cab-ride-hailing', parentId: 8 },
  ]);
  await addClip(t, { title: 'Existing payment clip', userId: TEST_USER_ID, storagePath: 'old/1.mp4', activity: 'Payment ', setting: 'Cafe', brand: 'Paytm', userTags: JSON.stringify(['qr code', 'payment']), fileSizeBytes: 4_000_000 });
  await addClip(t, { title: 'Existing ride clip', userId: TEST_USER_ID, storagePath: 'old/2.mp4', activity: 'Riding in a vehicle', setting: 'Cab or auto', userTags: JSON.stringify(['travel']), fileSizeBytes: 5_000_000 });
};
beforeEach(async () => {
  await t.reset(); await t.pg.exec('truncate storage_objects');
  await seedTaxonomy();
  h.userId = TEST_USER_ID; h.r2.clear(); h.bytes.clear(); h.deleted = []; h.hashCalls = 0; h.hashes.clear(); h.hashTimeout = false; h.headFails = false;
  h.ai = { calls: [], result: undefined, fail: false, noTool: false };
  h.probe = { dims: null, durationSeconds: 5 };
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

const json = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const counts = async () => ({
  categories: (await t.db.select().from(brollCategories)).length, clips: (await t.db.select().from(brollClips)).length,
  links: (await t.db.select().from(brollClipCategories)).length, brands: (await t.db.select().from(brollClipBrands)).length, registry: (await t.db.select().from(storageObjects)).length,
});
const modelAnswer = (over: Record<string, unknown> = {}) => ({
  title: 'Scanning a QR code at a cafe counter', subject: 'Phone scanning a QR', summary: 'A phone scans a QR code.', description: 'A phone scans a QR code at a cafe counter.',
  category_id: 22, category_confidence: 'high', category_reason: 'Payment by phone.', activity: 'Payment', setting: 'Cafe',
  brands: [{ name: 'paytm', role: 'hero', evidence: 'Paytm logo on the stand' }], tags: ['QR Code', 'payment'], privacy: [], visible_text: ['Paytm'], unresolved: [], overall_confidence: 'high', ...over,
});

describe('GET /api/v1/broll/bulk/taxonomy', () => {
  it('returns the approved vocabulary that already exists, and needs a signed-in user', async () => {
    h.userId = null;
    expect((await getTaxonomy()).status).toBe(401);
    h.userId = TEST_USER_ID;
    const tax = await (await getTaxonomy()).json();
    expect(tax.categories.map((c: { id: number; path: string }) => [c.id, c.path])).toEqual([[1, 'Payments'], [22, 'Payments > Mobile payment'], [8, 'Travel'], [50, 'Travel > Cab & ride hailing']]);
    expect(tax.activities).toEqual(['Payment ', 'Riding in a vehicle']);
    expect(tax.settings).toEqual(['Cab or auto', 'Cafe']);
    expect(tax.brands).toEqual(['Paytm']);
    expect(tax.tags).toEqual(expect.arrayContaining([{ tag: 'qr code', count: 1 }, { tag: 'travel', count: 1 }]));
  });
});

describe('POST /api/v1/broll/bulk/analyze', () => {
  it('is closed to signed-out callers and rejects bad input before calling the model', async () => {
    h.userId = null;
    expect((await analyse(json('/x', { frames: [JPEG] }))).status).toBe(401);
    h.userId = TEST_USER_ID;
    for (const body of [{}, { frames: [] }, { frames: Array(7).fill(JPEG) }, { frames: ['not base64!'] }, { frames: [Buffer.from('plain text').toString('base64')] }, { frames: [JPEG.padEnd(1_200_000, 'A')] }]) {
      expect([400, 413]).toContain((await analyse(json('/x', body))).status);
    }
    expect(h.ai.calls).toHaveLength(0);
    delete process.env.ANTHROPIC_API_KEY;
    const res = await analyse(json('/x', { frames: [JPEG] }));
    expect(res.status).toBe(503); expect((await res.json()).code).toBe('ai_not_configured');
  });

  it('returns a suggestion built only from approved values, reusing the existing brand and tag spellings', async () => {
    h.ai.result = modelAnswer();
    const res = await analyse(json('/x', { frames: [JPEG, JPEG], durationSeconds: 5, width: 720, height: 1280 }));
    expect(res.status).toBe(200);
    const { suggestion: s } = await res.json();
    expect(s).toMatchObject({ categoryId: 22, activity: 'Payment ', setting: 'Cafe', needsCategoryReview: false });
    expect(s.brands).toEqual([{ name: 'Paytm', role: 'hero', existing: true, evidence: 'Paytm logo on the stand' }]);
    expect(s.tags).toEqual([{ tag: 'qr code', known: true }, { tag: 'payment', known: true }]);
  });

  it('sends the model the real taxonomy and the frames, asks for a structured answer, and never sends a file name', async () => {
    h.ai.result = modelAnswer();
    await analyse(json('/x', { frames: [JPEG, JPEG, JPEG], durationSeconds: 5, width: 720, height: 1280, fileName: 'secret-name.mp4' }));
    const call = h.ai.calls[0] as { system: string; tools: { name: string }[]; tool_choice: { type: string; name: string }; messages: { content: { type: string }[] }[]; model: string };
    expect(call.tool_choice).toEqual({ type: 'auto' });
    expect(call.system).toContain('22: Payments > Mobile payment');
    expect(call.system).toContain('"Payment "');
    expect(call.system).toContain('Never invent');
    expect(call.messages[0].content.filter((c) => c.type === 'image')).toHaveLength(3);
    expect(JSON.stringify(call)).not.toContain('secret-name');
    expect(call.model).toBe(process.env.BROLL_ANALYSIS_MODEL || 'claude-sonnet-5-5');
  });

  it('flags an invented category, an unapproved activity and a new category proposal instead of accepting them', async () => {
    h.ai.result = modelAnswer({ category_id: 999, activity: 'Sprinting', setting: 'Spaceship', proposed_category: { name: 'Fuel stations', parent_id: 8, reason: 'No refuelling category.' } });
    const { suggestion: s } = await (await analyse(json('/x', { frames: [JPEG] }))).json();
    expect(s.categoryId).toBeNull(); expect(s.needsCategoryReview).toBe(true);
    expect(s.proposedCategory).toEqual({ name: 'Fuel stations', parentId: 8, reason: 'No refuelling category.' });
    expect(s.activity).toBeNull(); expect(s.setting).toBeNull();
    expect(s.unresolved).toEqual(expect.arrayContaining(['category', 'activity', 'setting']));
  });

  it('writes NOTHING: no category created, renamed or deleted, no clip, no registry row, even when a category is proposed', async () => {
    const before = await counts();
    const cats = await t.db.select().from(brollCategories);
    h.ai.result = modelAnswer({ category_id: null, proposed_category: { name: 'Fuel stations', parent_id: 8, reason: 'x' } });
    for (let i = 0; i < 3; i++) expect((await analyse(json('/x', { frames: [JPEG] }))).status).toBe(200);
    expect(await counts()).toEqual(before);
    expect(await t.db.select().from(brollCategories)).toEqual(cats);
  });

  it('reports a model failure or an unstructured answer as an error the page can retry', async () => {
    h.ai.fail = true;
    expect((await analyse(json('/x', { frames: [JPEG] }))).status).toBe(502);
    h.ai.fail = false; h.ai.noTool = true;
    const res = await analyse(json('/x', { frames: [JPEG] }));
    expect(res.status).toBe(502); expect((await res.json()).code).toBe('analysis_failed');
  });
});

describe('POST /api/v1/broll/bulk/check-duplicates', () => {
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  it('finds an exact match by SHA-256 and a same-size warning when no checksum was ever recorded', async () => {
    const now = Date.now();
    await t.db.insert(storageObjects).values({ bucket: 'uploads', key: 'old/1.mp4', provider: 'r2', sizeBytes: 4_000_000, sha256: sha('known'), createdAt: now, updatedAt: now });
    const res = await checkDuplicates(json('/x', { items: [{ sha256: sha('known'), size: 4_000_000 }, { sha256: sha('other'), size: 5_000_000 }, { sha256: sha('none'), size: 7 }] }));
    const { results } = await res.json();
    expect(results[0].matches).toEqual([{ kind: 'library_exact', clipId: expect.any(Number), title: 'Existing payment clip' }]);
    expect(results[1].matches).toEqual([{ kind: 'library_same_size', clipId: expect.any(Number), title: 'Existing ride clip' }]);
    expect(results[2].matches).toEqual([]);
  });
  it('does not call a same-size clip a duplicate when its checksum is known and different', async () => {
    const now = Date.now();
    await t.db.insert(storageObjects).values({ bucket: 'uploads', key: 'old/1.mp4', provider: 'r2', sizeBytes: 4_000_000, sha256: sha('known'), createdAt: now, updatedAt: now });
    const { results } = await (await checkDuplicates(json('/x', { items: [{ sha256: sha('different'), size: 4_000_000 }] }))).json();
    expect(results[0].matches).toEqual([]);
  });
  it('validates input, needs a signed-in user, and changes nothing', async () => {
    h.userId = null; expect((await checkDuplicates(json('/x', { items: [{ sha256: 'a', size: 1 }] }))).status).toBe(401);
    h.userId = TEST_USER_ID;
    expect((await checkDuplicates(json('/x', { items: [] }))).status).toBe(400);
    expect((await checkDuplicates(json('/x', { items: Array(201).fill({ sha256: null, size: 1 }) }))).status).toBe(400);
    const before = await counts();
    await checkDuplicates(json('/x', { items: [{ sha256: 'zz', size: -1 }] }));
    expect(await counts()).toEqual(before);
  });
});

/** Authorises and "uploads" one file through the real init route; returns its key. */
async function authorise(size = 2 * MB, bytes?: Buffer, type = 'video/mp4') {
  const res = await init(json('/api/v1/broll/upload/init', { contentType: type, fileSize: size, fileName: 'a.mp4' }));
  const body = await res.json() as { storagePath: string };
  h.r2.set(body.storagePath, { size, contentType: type });
  if (bytes) h.bytes.set(body.storagePath, bytes);
  return body.storagePath;
}
const shaOf = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
/** Authorise an upload whose bytes are known, so its checksum can be supplied. */
async function authoriseWithBytes(content: string, size?: number) {
  const bytes = Buffer.from(content);
  const key = await authorise(size ?? bytes.length, bytes);
  return { key, sha256: shaOf(bytes) };
}
const completeBody = (storagePath: string, over: Record<string, unknown> = {}) => ({
  storagePath, title: 'Scanning a QR', userTags: ['qr code'], activity: 'Payment ', setting: 'Cafe', brand: 'Paytm',
  categoryIds: [22], brands: [{ name: 'Paytm', role: 'hero' }, { name: 'BHIM UPI', role: 'incidental' }],
  classification: { confidence: 'high', flags: ['brand', 'text'], review: 'AI-assisted bulk upload.' }, ...over,
});

describe('POST /api/v1/broll/upload/complete with bulk fields', () => {
  it('creates the clip, links the existing category, records brand associations and notes, all together', async () => {
    const { key, sha256 } = await authoriseWithBytes('clip one');
    const res = await complete(json('/x', completeBody(key, { sha256 })));
    expect(res.status).toBe(201);
    const [clip] = await t.db.select().from(brollClips).where(await import('drizzle-orm').then(({ eq }) => eq(brollClips.storagePath, key)));
    expect(clip).toMatchObject({ title: 'Scanning a QR', activity: 'Payment ', setting: 'Cafe', brand: 'Paytm', reviewStatus: 'unreviewed' });
    expect(JSON.parse(clip.notes!)).toMatchObject({ schema: 'broll-classification/v1', confidence: 'high', flags: ['brand', 'text'] });
    expect((await t.db.select().from(brollClipCategories)).filter((l) => l.clipId === clip.id).map((l) => l.categoryId)).toEqual([22]);
    expect((await t.db.select().from(brollClipBrands)).filter((b) => b.clipId === clip.id).map((b) => [b.brandName, b.role]).sort()).toEqual([['BHIM UPI', 'incidental'], ['Paytm', 'hero']]);
  });

  it('REFUSES an unknown category: no clip, no registry row, and no category is created', async () => {
    const before = await counts();
    const { key, sha256 } = await authoriseWithBytes('clip two');
    const res = await complete(json('/x', completeBody(key, { sha256, categoryIds: [22, 424242] })));
    expect(res.status).toBe(422);
    expect(await counts()).toEqual(before);
    expect(h.deleted).toEqual([]);
  });

  it('rejects malformed category ids and brands', async () => {
    const { key, sha256 } = await authoriseWithBytes('clip three');
    for (const over of [{ categoryIds: ['22'] }, { categoryIds: [-1] }, { categoryIds: Array.from({ length: 11 }, (_, i) => i + 1) }, { brands: [{ name: '', role: 'hero' }] }, { brands: [{ name: 'X', role: 'boss' }] }, { brands: 'Paytm' }]) {
      expect((await complete(json('/x', completeBody(key, { sha256, ...over })))).status).toBe(400);
    }
    expect((await counts()).clips).toBe(2);
  });

  it('a repeated completion returns the same clip and creates no second clip, link or brand row', async () => {
    const { key, sha256 } = await authoriseWithBytes('clip four');
    const first = await (await complete(json('/x', completeBody(key, { sha256 })))).json();
    const again = await complete(json('/x', completeBody(key, { sha256 })));
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(first.id);
    const c = await counts();
    expect(c).toMatchObject({ clips: 3, links: 1, brands: 2, registry: 1 });
    const parallel = await Promise.all([1, 2, 3].map(() => complete(json('/x', completeBody(key, { sha256 })))));
    expect(parallel.every((r) => r.status === 200)).toBe(true);
    expect((await counts())).toEqual(c);
  });

  it('keeps working exactly as before for a caller that sends none of the bulk fields (the one-video form)', async () => {
    const key = await authorise();
    const res = await complete(json('/x', { storagePath: key, title: 'Plain', userTags: ['a'] }));
    expect(res.status).toBe(201);
    const [clip] = await t.db.select().from(brollClips).where(await import('drizzle-orm').then(({ eq }) => eq(brollClips.storagePath, key)));
    expect(clip.notes).toBeNull();
    expect((await counts())).toMatchObject({ links: 0, brands: 0 });
    expect(h.hashCalls).toBe(0); // the one-video form has no checksum to verify and is unchanged
  });
});

describe('integrity: the checksum is verified for every file size, up to the 500 MB limit', () => {
  const MAX = 500 * MB;

  it('a bulk completion without a checksum is refused: integrity cannot be skipped', async () => {
    const key = await authorise();
    const before = await counts();
    for (const sha256 of [undefined, '', 'nothex', 'A'.repeat(64), 12]) {
      expect((await complete(json('/x', completeBody(key, { sha256 })))).status).toBe(400);
    }
    expect(await counts()).toEqual(before);
    expect(h.hashCalls).toBe(0);
  });

  it('below 64 MB: R2\'s bytes are hashed, the checksum is recorded in the registry', async () => {
    const { key, sha256 } = await authoriseWithBytes('small file');
    expect((await complete(json('/x', completeBody(key, { sha256 })))).status).toBe(201);
    expect(h.hashCalls).toBe(1);
    expect((await t.db.select().from(storageObjects))[0]).toMatchObject({ key, provider: 'r2', sha256, sizeBytes: Buffer.byteLength('small file') });
  });

  it.each([[64 * MB + 1, 'just above 64 MB'], [200 * MB, '200 MB'], [MAX, 'the 500 MB limit']])('%i bytes (%s): still verified, never skipped', async (size) => {
    const key = await authorise(size);
    const real = 'f'.repeat(64);                          // the digest R2's stream would produce
    h.hashes.set(key, real);
    const res = await complete(json('/x', completeBody(key, { sha256: real })));
    expect(res.status).toBe(201);
    expect(h.hashCalls).toBe(1);
    expect((await t.db.select().from(storageObjects))[0]).toMatchObject({ key, sha256: real, sizeBytes: size });
    expect((await t.db.select().from(brollClips).where(await import('drizzle-orm').then(({ eq }) => eq(brollClips.storagePath, key))))[0].fileSizeBytes).toBe(size);
  });

  it.each([[2 * MB], [64 * MB + 1], [MAX]])('a checksum mismatch at %i bytes prevents completion: no clip, no registry row, the bad object is removed', async (size) => {
    const key = await authorise(size);
    h.hashes.set(key, 'a'.repeat(64));
    const before = await counts();
    const res = await complete(json('/x', completeBody(key, { sha256: 'b'.repeat(64) })));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('checksum differs');
    expect(await counts()).toEqual(before);
    expect(h.deleted).toEqual([key]);
  });

  it('a read that takes too long fails clearly (504) with nothing recorded and the file kept; retrying then succeeds with ONE clip', async () => {
    const { key, sha256 } = await authoriseWithBytes('slow file', 300 * MB);
    h.hashes.set(key, sha256);
    h.hashTimeout = true;
    const before = await counts();
    const res = await complete(json('/x', completeBody(key, { sha256 })));
    expect(res.status).toBe(504);
    expect((await res.json()).code).toBe('verification_timeout');
    expect(await counts()).toEqual(before);
    expect(h.deleted).toEqual([]);                        // the upload is kept so the retry does not re-upload
    h.hashTimeout = false;
    expect((await complete(json('/x', completeBody(key, { sha256 })))).status).toBe(201);
    expect((await complete(json('/x', completeBody(key, { sha256 })))).status).toBe(200);
    expect(await counts()).toMatchObject({ clips: before.clips + 1, registry: 1 });
  });

  it('a failure to read from R2 is a retryable 502, never a skipped check', async () => {
    const { key, sha256 } = await authoriseWithBytes('x');
    h.bytes.delete(key);                                  // the fake then fails to produce a digest
    const res = await complete(json('/x', completeBody(key, { sha256 })));
    expect(res.status).toBe(502);
    expect(await counts()).toMatchObject({ clips: 2, registry: 0 });
  });
});

describe('exact duplicates are refused on the server (SHA-256), not just warned about in the page', () => {
  it('a second upload of identical content is refused with the existing clip named; its new object and registry row are removed', async () => {
    const a = await authoriseWithBytes('same content');
    const first = await (await complete(json('/x', completeBody(a.key, { sha256: a.sha256, title: 'First' })))).json();
    const b = await authoriseWithBytes('same content');
    const before = await counts();
    const res = await complete(json('/x', completeBody(b.key, { sha256: b.sha256, title: 'Second' })));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'duplicate', clipId: first.id });
    expect((await counts()).clips).toBe(before.clips);
    expect((await t.db.select().from(storageObjects)).map((r) => r.key)).toEqual([a.key]);    // the duplicate's registry row is gone
    expect(h.deleted).toEqual([b.key]);                                                      // only the new duplicate object was removed
    expect(h.r2.has(a.key)).toBe(true);                                                       // the original is untouched
  });

  it('"upload anyway" (allowDuplicate) creates a second clip on purpose', async () => {
    const a = await authoriseWithBytes('same again');
    await complete(json('/x', completeBody(a.key, { sha256: a.sha256 })));
    const b = await authoriseWithBytes('same again');
    expect((await complete(json('/x', completeBody(b.key, { sha256: b.sha256, allowDuplicate: true })))).status).toBe(201);
    expect((await counts()).clips).toBe(4);
  });

  it('two identical files completing at the same moment still produce exactly one clip', async () => {
    const a = await authoriseWithBytes('race content');
    const b = await authoriseWithBytes('race content');
    const [ra, rb] = await Promise.all([
      complete(json('/x', completeBody(a.key, { sha256: a.sha256 }))), complete(json('/x', completeBody(b.key, { sha256: b.sha256 }))),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    expect((await counts()).clips).toBe(3);
  });

  it('recognises an existing clip once its checksum is recorded (the backfilled previous imports)', async () => {
    const bytes = Buffer.from('previously imported video');
    const now = Date.now();
    // An older import: the clip exists, its registry row has no checksum yet.
    const id = await addClip(t, { title: 'Imported earlier', userId: TEST_USER_ID, storagePath: `${TEST_USER_ID}/broll/11111111-1111-4111-8111-111111111111.mp4`, fileSizeBytes: bytes.length });
    await t.db.insert(storageObjects).values({ bucket: 'uploads', key: `${TEST_USER_ID}/broll/11111111-1111-4111-8111-111111111111.mp4`, provider: 'r2', sizeBytes: bytes.length, createdAt: now, updatedAt: now });
    const dup = await authoriseWithBytes('previously imported video');
    // Before backfill: unknown, so a new clip is created (this is the gap the backfill closes).
    expect((await complete(json('/x', completeBody(dup.key, { sha256: dup.sha256 })))).status).toBe(201);
    // After backfill: the checksum is recorded and the same content is recognised.
    await t.db.delete(brollClips).where(await import('drizzle-orm').then(({ eq }) => eq(brollClips.storagePath, dup.key)));
    await t.db.delete(storageObjects).where(await import('drizzle-orm').then(({ eq }) => eq(storageObjects.key, dup.key)));
    await t.db.update(storageObjects).set({ sha256: dup.sha256 }).where(await import('drizzle-orm').then(({ eq }) => eq(storageObjects.key, `${TEST_USER_ID}/broll/11111111-1111-4111-8111-111111111111.mp4`)));
    const again = await authoriseWithBytes('previously imported video');
    const res = await complete(json('/x', completeBody(again.key, { sha256: again.sha256 })));
    expect(res.status).toBe(409);
    expect((await res.json()).clipId).toBe(id);
    const { results } = await (await checkDuplicates(json('/x', { items: [{ sha256: dup.sha256, size: bytes.length }] }))).json();
    expect(results[0].matches).toEqual([{ kind: 'library_exact', clipId: id, title: 'Imported earlier' }]);
  });
});

describe('the whole workflow', () => {
  const frames = [JPEG, JPEG, JPEG, JPEG];

  /** What the page does for one video: analyse, then make the editable copy. */
  async function analyseVideo(id: string, answer: Record<string, unknown>, sha: string): Promise<BulkItem> {
    h.ai.result = answer;
    const { suggestion } = await (await analyse(json('/x', { frames, durationSeconds: 5, width: 720, height: 1280 }))).json();
    const s = sanitiseAnalysis({ ...answer }, await loadTaxonomy(t.db));
    expect(suggestion.categoryId).toBe(s.categoryId); // what the API returned is what the page would compute
    return { ...newItem(id, { name: `${id}.mp4`, size: 2 * MB }, 'video/mp4'), analysis: 'analysed', suggestion, edit: initialEdit(suggestion, `${id}.mp4`), included: true, sha256: sha, durationSeconds: 5, width: 720, height: 1280 };
  }

  it('analysis alone uploads nothing; a proposed category needs its own approval; approving the batch uploads, retries safely, and keeps the library intact', async () => {
    const baseline = await counts();
    const libraryBefore = await (await listLibrary()).json();

    // 1-2. Analyse a batch of three videos.
    const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
    const bytesOf = (id: string) => Buffer.from(`video-bytes-${id}`);
    let items = [
      await analyseVideo('v1', modelAnswer(), sha(`video-bytes-v1`)),
      await analyseVideo('v2', modelAnswer({ title: 'Riding in an auto rickshaw', category_id: 50, activity: 'Riding in a vehicle', setting: 'Cab or auto', brands: [], tags: ['travel'] }), sha(`video-bytes-v2`)),
      await analyseVideo('v3', modelAnswer({ title: 'Filling a car at a fuel station', category_id: null, proposed_category: { name: 'Fuel stations', parent_id: 8, reason: 'No refuelling category exists.' }, activity: null, setting: null, brands: [], tags: ['travel', 'fuel'], privacy: [{ type: 'face', detail: 'An attendant\'s face is visible.', severity: 'high' }] }), sha(`video-bytes-v3`)),
    ];
    expect(items[2].suggestion!.needsCategoryReview).toBe(true);
    expect(items[2].suggestion!.privacy[0].type).toBe('face');
    // Selecting and analysing created no clips, no registry rows and no categories.
    expect(await counts()).toEqual(baseline);
    expect(h.r2.size).toBe(0);

    // 3. The proposal is only a proposal: v3 is still uncategorised and no category exists yet.
    expect(items[2].edit!.categoryId).toBeNull();
    expect((await t.db.select().from(brollCategories)).some((c) => c.name === 'Fuel stations')).toBe(false);

    // 4. The reviewer explicitly approves the proposal: the EXISTING authorised category endpoint creates it, then it is assigned.
    const created = await createCategory(json('/api/v1/broll/categories', { name: 'Fuel stations', parentId: 8, scope: 'soma' }));
    expect(created.status).toBe(201);
    const newCat = await created.json();
    items = items.map((i) => (i.id === 'v3' ? { ...i, edit: { ...i.edit!, categoryId: newCat.id } } : i));
    expect((await t.db.select().from(brollCategories)).filter((c) => c.name === 'Fuel stations')).toHaveLength(1);
    // Creating it was separate: still no clips.
    expect((await counts()).clips).toBe(baseline.clips);

    // 5. The reviewer corrects v1 and sets v3's activity, then approves the batch.
    items = items.map((i) => (i.id === 'v1' ? { ...i, edit: { ...i.edit!, title: 'Scanning a Paytm QR at a counter' } } : i));
    items = items.map((i) => (i.id === 'v3' ? { ...i, edit: { ...i.edit!, activity: 'Riding in a vehicle' } } : i));

    // 6. Upload through the real init and complete routes with a fake R2. v2's first save fails once.
    let v2Failures = 1;
    const deps = (it: BulkItem): UploadDeps => ({
      init: async (ct, size, name) => (await init(json('/x', { contentType: ct, fileSize: size, fileName: name }))).json(),
      put: async (url) => { const key = new URL(url).pathname.slice(1); const b = bytesOf(it.id); h.bytes.set(key, b); h.r2.set(key, { size: b.length, contentType: 'video/mp4' }); },
      complete: async (payload) => {
        if (it.id === 'v2' && v2Failures-- > 0) throw Object.assign(new Error('Could not verify the upload. Please try again.'), { status: 502 });
        const res = await complete(json('/x', payload));
        if (!res.ok) throw Object.assign(new Error((await res.json()).error), { status: res.status });
        return res.json();
      },
    });
    const results = new Map<string, Partial<BulkItem>>();
    for (const it of items) results.set(it.id, await uploadApproved(it, 'video/mp4', `${it.id}.mp4`, deps(it), () => {}));
    expect(results.get('v1')!.upload).toBe('uploaded');
    expect(results.get('v3')!.upload).toBe('uploaded');
    expect(results.get('v2')).toMatchObject({ upload: 'failed' });
    const puts = h.r2.size;

    // 7. Retry only the failed one: the file already in R2 is NOT uploaded again, and no duplicate clip appears.
    const v2 = { ...items[1], ...results.get('v2')! };
    const retried = await uploadApproved(v2, 'video/mp4', 'v2.mp4', deps(v2), () => {});
    expect(retried.upload).toBe('uploaded');
    expect(h.r2.size).toBe(puts);

    // 8. The database: exactly one clip per video, right relationships, registry rows on R2.
    const clips = await t.db.select().from(brollClips);
    expect(clips).toHaveLength(baseline.clips + 3);
    const byTitle = (title: string) => clips.find((c) => c.title === title)!;
    const v1c = byTitle('Scanning a Paytm QR at a counter'), v2c = byTitle('Riding in an auto rickshaw'), v3c = byTitle('Filling a car at a fuel station');
    const links = await t.db.select().from(brollClipCategories);
    expect(links.filter((l) => l.clipId === v1c.id).map((l) => l.categoryId)).toEqual([22]);
    expect(links.filter((l) => l.clipId === v2c.id).map((l) => l.categoryId)).toEqual([50]);
    expect(links.filter((l) => l.clipId === v3c.id).map((l) => l.categoryId)).toEqual([newCat.id]);
    expect(JSON.parse(v3c.notes!).flags).toContain('person (face visible)');
    expect(v1c.brand).toBe('Paytm');
    const reg = await t.db.select().from(storageObjects);
    expect(reg).toHaveLength(3);
    expect(reg.every((r) => r.provider === 'r2' && r.bucket === 'uploads')).toBe(true);
    expect(clips.filter((c) => [v1c.id, v2c.id, v3c.id].includes(c.id)).every((c) => c.storagePath.startsWith(`${TEST_USER_ID}/broll/`))).toBe(true);

    // 9. The existing library is unchanged and the new clips appear in it.
    const libraryAfter = await (await listLibrary()).json() as { id: number; title: string }[];
    const old = (libraryBefore as { id: number; title: string }[]).map((c) => c.id).sort();
    expect(libraryAfter.filter((c) => old.includes(c.id)).map((c) => c.id).sort()).toEqual(old);
    expect(libraryAfter.map((c) => c.title)).toEqual(expect.arrayContaining(['Scanning a Paytm QR at a counter', 'Riding in an auto rickshaw', 'Filling a car at a fuel station']));
    // And the pre-existing clips were not modified.
    const existing = clips.filter((c) => c.storagePath.startsWith('old/'));
    expect(existing).toHaveLength(2);
    expect(existing.every((c) => c.reviewStatus === 'unreviewed' && c.notes === null)).toBe(true);
  });

  it('a video that fails its technical check at completion (not 9:16) creates nothing and stays retryable', async () => {
    const { key, sha256 } = await authoriseWithBytes('wide video');
    h.probe = { dims: { width: 1920, height: 1080 }, durationSeconds: 5 };
    const before = await counts();
    expect((await complete(json('/x', completeBody(key, { sha256 })))).status).toBe(422);
    expect(await counts()).toEqual(before);
  });
});

describe('what the server logs and stores while analysing', () => {
  it('logs no image data, no provider message text and no filename when the model call fails, and persists nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      h.ai.fail = true;
      const secretFrame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54]).toString('base64'); // "…SECRET" bytes
      const before = await counts();
      const res = await analyse(json('/x', { frames: [secretFrame], durationSeconds: 5, width: 720, height: 1280, fileName: 'passenger-jane-doe.mp4' }));
      expect(res.status).toBe(502);
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      expect(logged).not.toContain(secretFrame);
      expect(logged).not.toContain('/9j/');
      expect(logged).not.toContain('passenger-jane-doe');
      expect(logged).not.toContain('upstream 500');            // the provider's message text is not logged either
      expect(await counts()).toEqual(before);                   // nothing stored in any table
      expect(h.r2.size).toBe(0);                                // nothing written to R2
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
});
