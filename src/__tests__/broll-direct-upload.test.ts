/**
 * Browser-direct B-roll uploads: init (authorise) and complete (verify, register, create the clip), against a real
 * in-memory Postgres built from the repository's migrations. Storage, the registry and ffprobe are replaced by fakes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { brollClips } from '@/db/schema.pg';
import { createBrollTestDb, TEST_USER_ID, type BrollTestDb } from './helpers/broll-test-db';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: null as string | null,
  r2: new Map<string, { size: number; contentType: string | null }>(),
  registry: new Map<string, { size: number; contentType: string | null }>(),
  deleted: [] as string[],
  signed: [] as { key: string; contentType: string; size: number; ttl: number }[],
  available: true,
  headFails: false,
  registryFails: false,
  probe: { dims: null as { width: number; height: number } | null, durationSeconds: 7 as number | null },
}));

vi.mock('@/db', () => ({
  db: new Proxy({}, { get(_t, prop) { const real = h.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.userId ? { id: h.userId } : null } }) } }),
}));
vi.mock('@/lib/object-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/object-store')>()),
  getStorage: () => ({
    directUploadAvailable: () => h.available,
    signedDirectUpload: async (_b: string, key: string, contentType: string, size: number, ttl: number) => {
      h.signed.push({ key, contentType, size, ttl });
      return { url: `https://r2.example/${key}?X-Amz-Expires=${ttl}&sig=abc`, method: 'PUT', headers: { 'Content-Type': contentType } };
    },
    headR2: async (_b: string, key: string) => { if (h.headFails) throw new Error('R2 unreachable'); return h.r2.get(key) ?? null; },
    deleteFromR2: async (_b: string, key: string) => { h.deleted.push(key); h.r2.delete(key); },
    signedReadUrl: async (_b: string, key: string) => `https://r2.example/read/${key}`,
  }),
}));
vi.mock('@/lib/object-store/registry', () => ({
  locate: async (_b: string, keys: string[]) => new Map(keys.map((k) => [k, h.registry.has(k) ? 'r2' : 'supabase'])),
  registeredRows: async (_b: string, keys: string[]) => new Map(keys.filter((k) => h.registry.has(k)).map((k) => [k, { provider: 'r2', sha256: null, sizeBytes: h.registry.get(k)!.size }])),
  registerObjectIfAbsent: async (i: { key: string; sizeBytes: number; contentType: string }) => {
    if (h.registryFails) throw new Error('registry down');
    if (h.registry.has(i.key)) return false;
    h.registry.set(i.key, { size: i.sizeBytes, contentType: i.contentType }); return true;
  },
  clearLocationCache: () => {},
}));
vi.mock('@/lib/broll-probe', async (orig) => ({ ...(await orig<typeof import('@/lib/broll-probe')>()), probeVideo: () => h.probe }));

import { POST as init } from '@/app/api/v1/broll/upload/init/route';
import { POST as complete } from '@/app/api/v1/broll/upload/complete/route';
import { DIRECT_UPLOAD_MAX_BYTES, DIRECT_UPLOAD_TTL_S, isOwnBrollKey } from '@/lib/broll-direct-upload';

const OTHER = '00000000-0000-4000-8000-0000000000b2';
let t: BrollTestDb;
beforeAll(async () => { t = await createBrollTestDb('current'); h.db = t.db; }, 60_000);
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await t.reset();
  h.userId = TEST_USER_ID; h.r2.clear(); h.registry.clear(); h.deleted = []; h.signed = [];
  h.available = true; h.headFails = false; h.registryFails = false; h.probe = { dims: null, durationSeconds: 7 };
});

const post = (path: string, body: unknown) => new NextRequest(`http://localhost/api/v1/broll/upload/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const doInit = (body: unknown) => init(post('init', body));
const doComplete = (body: unknown) => complete(post('complete', body));
const clipRows = async () => t.db.select().from(brollClips);
const MB = 1024 * 1024;

async function authorise(size = 12 * MB, contentType = 'video/mp4') {
  const res = await doInit({ contentType, fileSize: size, fileName: 'a.mp4' });
  return { res, body: await res.json() as { storagePath: string; uploadUrl: string; headers: Record<string, string>; expiresInSeconds: number } };
}
/** What R2 would hold after the browser's PUT. */
const uploaded = (key: string, size: number, contentType: string | null = 'video/mp4') => h.r2.set(key, { size, contentType });

describe('init: authorising a direct upload', () => {
  it('is closed to signed-out callers', async () => {
    h.userId = null;
    expect((await doInit({ contentType: 'video/mp4', fileSize: 10 })).status).toBe(401);
    expect(h.signed).toEqual([]);
  });

  it('returns a short-lived PUT URL for a key the SERVER chose inside the caller\'s own B-roll folder', async () => {
    const { res, body } = await authorise(12 * MB);
    expect(res.status).toBe(200);
    expect(isOwnBrollKey(TEST_USER_ID, body.storagePath)).toBe(true);
    expect(body.storagePath).toMatch(new RegExp(`^${TEST_USER_ID}/broll/[0-9a-f-]{36}\\.mp4$`));
    expect(body.uploadUrl).toContain(body.storagePath);
    expect(body.expiresInSeconds).toBe(DIRECT_UPLOAD_TTL_S);
    expect(h.signed[0]).toEqual({ key: body.storagePath, contentType: 'video/mp4', size: 12 * MB, ttl: DIRECT_UPLOAD_TTL_S });
    expect(DIRECT_UPLOAD_TTL_S).toBeLessThanOrEqual(900);
    expect(await clipRows()).toEqual([]); // authorising records nothing
  });

  it('issues a different key every time, so nothing can be overwritten', async () => {
    const a = (await authorise()).body.storagePath; const b = (await authorise()).body.storagePath;
    expect(a).not.toBe(b);
  });

  it('ignores any bucket or key the browser tries to choose', async () => {
    const res = await doInit({ contentType: 'video/mp4', fileSize: 5 * MB, storagePath: '../../victim/x.mp4', bucket: 'videos', key: 'evil.mp4' });
    const { storagePath } = await res.json();
    expect(storagePath.startsWith(`${TEST_USER_ID}/broll/`)).toBe(true);
    expect(storagePath).not.toContain('evil');
    expect(h.signed[0].key).toBe(storagePath);
  });

  it.each([['application/pdf', 415], ['image/png', 415], ['', 415], [undefined, 415], ['text/html', 415]])('rejects type %s with %i', async (ct, status) => {
    expect((await doInit({ contentType: ct, fileSize: 1000 })).status).toBe(status);
    expect(h.signed).toEqual([]);
  });

  it('rejects an extension that is not a video extension', async () => {
    expect((await doInit({ contentType: 'video/mp4', fileSize: 1000, fileName: 'evil.exe' })).status).toBe(415);
  });

  it.each([[DIRECT_UPLOAD_MAX_BYTES + 1, 413], [0, 400], [-5, 400], [1.5, 400], ['12', 400], [null, 400]])('rejects size %s with %i', async (size, status) => {
    expect((await doInit({ contentType: 'video/mp4', fileSize: size })).status).toBe(status);
    expect(h.signed).toEqual([]);
  });

  it('accepts exactly the maximum size, and sizes of 5 MB, 10 MB and 12 MB', async () => {
    for (const size of [5 * MB, 10 * MB, 12 * MB, DIRECT_UPLOAD_MAX_BYTES]) expect((await doInit({ contentType: 'video/mp4', fileSize: size })).status).toBe(200);
  });

  it('answers 503 with a code the page uses to fall back, when R2 is not available', async () => {
    h.available = false;
    const res = await doInit({ contentType: 'video/mp4', fileSize: 1000 });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('direct_upload_unavailable');
  });

  it('rejects a body that is not JSON', async () => {
    expect((await init(new NextRequest('http://localhost/x', { method: 'POST', body: 'nope' }))).status).toBe(400);
  });
});

describe('complete: verifying and recording an upload', () => {
  it('after a real upload: verifies size and type in R2, registers it, and creates exactly one clip', async () => {
    const { body } = await authorise(12 * MB);
    uploaded(body.storagePath, 12 * MB);
    const res = await doComplete({ storagePath: body.storagePath, title: 'Beach', userTags: ['sea'], subject: 'Waves' });
    expect(res.status).toBe(201);
    const rows = await clipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ storagePath: body.storagePath, title: 'Beach', fileSizeBytes: 12 * MB, mimeType: 'video/mp4', durationSeconds: 7, userId: TEST_USER_ID, subject: 'Waves', processingStatus: 'completed' });
    expect(h.registry.get(body.storagePath)).toEqual({ size: 12 * MB, contentType: 'video/mp4' });
    expect(h.deleted).toEqual([]);
  });

  it('records the size R2 reports, not anything the browser claims', async () => {
    const { body } = await authorise(5 * MB);
    uploaded(body.storagePath, 3 * MB); // R2 holds a different size than was announced
    const res = await doComplete({ storagePath: body.storagePath, title: 'x', fileSizeBytes: 999, fileSize: 999 });
    expect(res.status).toBe(201);
    expect((await clipRows())[0].fileSizeBytes).toBe(3 * MB);
  });

  it('a duplicate completion returns the same clip and creates no second record', async () => {
    const { body } = await authorise();
    uploaded(body.storagePath, 4 * MB);
    const first = await (await doComplete({ storagePath: body.storagePath, title: 'x' })).json();
    const secondRes = await doComplete({ storagePath: body.storagePath, title: 'x again' });
    expect(secondRes.status).toBe(200);
    expect((await secondRes.json()).id).toBe(first.id);
    expect(await clipRows()).toHaveLength(1);
  });

  it('simultaneous completions of the same upload still make exactly one clip', async () => {
    const { body } = await authorise();
    uploaded(body.storagePath, 4 * MB);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => doComplete({ storagePath: body.storagePath, title: 'x' })));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await clipRows()).toHaveLength(1);
    expect(new Set(await Promise.all(results.map(async (r) => (await r.json()).id))).size).toBe(1);
  });

  it('an upload that never arrived (interrupted or expired link): 409, no clip, no registry row', async () => {
    const { body } = await authorise();
    const res = await doComplete({ storagePath: body.storagePath, title: 'x' });
    expect(res.status).toBe(409);
    expect(await clipRows()).toEqual([]);
    expect(h.registry.size).toBe(0);
  });

  it.each([
    ['empty file', 0, 'video/mp4', 422],
    ['over the size limit', DIRECT_UPLOAD_MAX_BYTES + 1, 'video/mp4', 413],
    ['wrong content type', 5 * MB, 'text/html', 415],
    ['missing content type', 5 * MB, null, 415],
    ['type that does not match the extension', 5 * MB, 'video/webm', 415],
  ])('failed verification (%s): rejected, no clip, no registry row, the bad object is removed', async (_name, size, ct, status) => {
    const { body } = await authorise();
    uploaded(body.storagePath, size, ct);
    const res = await doComplete({ storagePath: body.storagePath, title: 'x' });
    expect(res.status).toBe(status);
    expect(await clipRows()).toEqual([]);
    expect(h.registry.size).toBe(0);
    expect(h.deleted).toEqual([body.storagePath]);
  });

  it('a video that is not 9:16 is rejected and removed; no clip and no registry row', async () => {
    const { body } = await authorise();
    uploaded(body.storagePath, 5 * MB);
    h.probe = { dims: { width: 1920, height: 1080 }, durationSeconds: 3 };
    const res = await doComplete({ storagePath: body.storagePath, title: 'x' });
    expect(res.status).toBe(422);
    expect(await clipRows()).toEqual([]);
    expect(h.registry.size).toBe(0);
    expect(h.deleted).toEqual([body.storagePath]);
  });

  it('accepts a 9:16 video and keeps its duration', async () => {
    const { body } = await authorise();
    uploaded(body.storagePath, 5 * MB);
    h.probe = { dims: { width: 720, height: 1280 }, durationSeconds: 11 };
    expect((await doComplete({ storagePath: body.storagePath, title: 'x' })).status).toBe(201);
    expect((await clipRows())[0].durationSeconds).toBe(11);
  });

  it('never removes an object that a clip or the registry already refers to', async () => {
    // an existing, registered object in the caller\'s folder that now fails the checks
    const key = `${TEST_USER_ID}/broll/11111111-1111-4111-8111-111111111111.mp4`;
    uploaded(key, 5 * MB, 'text/html'); h.registry.set(key, { size: 5 * MB, contentType: 'video/mp4' });
    expect((await doComplete({ storagePath: key, title: 'x' })).status).toBe(415);
    expect(h.deleted).toEqual([]);
    expect(h.registry.get(key)).toEqual({ size: 5 * MB, contentType: 'video/mp4' }); // the existing row is untouched
  });

  it('an existing clip is returned as it is, even if its file would fail the checks now', async () => {
    const key = `${TEST_USER_ID}/broll/22222222-2222-4222-8222-222222222222.mp4`;
    const now = Date.now();
    await t.db.insert(brollClips).values({ userId: TEST_USER_ID, title: 'Old', storagePath: key, mimeType: 'video/mp4', processingStatus: 'completed', reviewStatus: 'unreviewed', createdAt: now, updatedAt: now });
    const res = await doComplete({ storagePath: key, title: 'Different' });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe('Old');
    expect(await clipRows()).toHaveLength(1);
    expect(h.deleted).toEqual([]);
  });

  it('is closed to signed-out callers', async () => {
    h.userId = null;
    expect((await doComplete({ storagePath: `${TEST_USER_ID}/broll/x.mp4`, title: 'x' })).status).toBe(401);
  });

  it('refuses a key in another user\'s folder, outside the B-roll folder, or in a bad format', async () => {
    for (const storagePath of [
      `${OTHER}/broll/33333333-3333-4333-8333-333333333333.mp4`,
      `${TEST_USER_ID}/other/33333333-3333-4333-8333-333333333333.mp4`,
      `${TEST_USER_ID}/broll/../${OTHER}/broll/33333333-3333-4333-8333-333333333333.mp4`,
      `${TEST_USER_ID}/broll/not-a-uuid.mp4`,
      `${TEST_USER_ID}/broll/33333333-3333-4333-8333-333333333333.exe`,
    ]) {
      uploaded(storagePath, 5 * MB);
      expect((await doComplete({ storagePath, title: 'x' })).status).toBe(403);
    }
    for (const storagePath of [42, null]) expect((await doComplete({ storagePath, title: 'x' })).status).toBe(400);
    expect(await clipRows()).toEqual([]);
    expect(h.registry.size).toBe(0);
    expect(h.deleted).toEqual([]);
  });

  it('requires a title and a storagePath', async () => {
    expect((await doComplete({ storagePath: `${TEST_USER_ID}/broll/33333333-3333-4333-8333-333333333333.mp4` })).status).toBe(400);
    expect((await doComplete({ title: 'x' })).status).toBe(400);
  });

  it('if R2 cannot be reached, nothing is recorded and the caller can retry', async () => {
    const { body } = await authorise();
    uploaded(body.storagePath, 5 * MB);
    h.headFails = true;
    expect((await doComplete({ storagePath: body.storagePath, title: 'x' })).status).toBe(502);
    expect(await clipRows()).toEqual([]);
    expect(h.deleted).toEqual([]);
    h.headFails = false;
    expect((await doComplete({ storagePath: body.storagePath, title: 'x' })).status).toBe(201);
  });

  it('if the registry cannot be written, no clip is created and the upload can be completed later', async () => {
    const { body } = await authorise();
    uploaded(body.storagePath, 5 * MB);
    h.registryFails = true;
    expect((await doComplete({ storagePath: body.storagePath, title: 'x' })).status).toBe(500);
    expect(await clipRows()).toEqual([]);
    h.registryFails = false;
    expect((await doComplete({ storagePath: body.storagePath, title: 'x' })).status).toBe(201);
    expect(await clipRows()).toHaveLength(1);
  });
});
