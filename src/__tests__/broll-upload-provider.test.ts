/**
 * The B-roll upload route and where it writes. The real Storage class is used with in-memory providers; only the
 * Supabase login is replaced. The route never touches the database, which is asserted by giving it none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Storage, ObjectExistsError, type ProviderName, type StorageProvider } from '@/lib/object-store';

const h = vi.hoisted(() => ({ storage: undefined as unknown }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }),
}));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => h.storage }));
vi.mock('@/worker/ffmpeg-utils', () => ({ probeVideoDuration: () => 7 }));
// Any use of the database by the upload route would be a bug: it must write no clip record.
vi.mock('@/db', () => ({ db: new Proxy({}, { get() { throw new Error('the upload route must not use the database'); } }) }));

import { POST as upload } from '@/app/api/v1/broll/upload/route';

function provider(name: ProviderName) {
  const store = new Map<string, Buffer>();
  const p: StorageProvider & { store: Map<string, Buffer>; failPut: boolean } = {
    name, store, failPut: false,
    async put(b, k, body) { if (p.failPut) throw new Error('down'); if (store.has(`${b}/${k}`)) throw new ObjectExistsError(b, k); store.set(`${b}/${k}`, body); },
    async download() { throw new Error('unused'); },
    async head(b, k) { const x = store.get(`${b}/${k}`); return x ? { size: x.length, contentType: 'video/mp4', etag: 'e' } : null; },
    async signedReadUrl(b, k) { return store.has(`${b}/${k}`) ? `https://${name}.example/${b}/${k}` : null; },
    async signedReadUrls() { return new Map(); },
    async signedUpload() { throw new Error('unused'); },
    async delete() {},
  };
  return p;
}

let sb: ReturnType<typeof provider>;
let r2: ReturnType<typeof provider>;
let registered: { bucket: string; key: string; provider: string }[];

function build(opts: { r2?: boolean; failover?: boolean } = {}) {
  sb = provider('supabase'); r2 = provider('r2'); registered = [];
  h.storage = new Storage({
    supabase: sb, r2: opts.r2 === false ? null : r2,
    locate: async (_b, keys) => new Map(keys.map((k) => [k, 'supabase'] as [string, ProviderName])),
    register: async (i) => { registered.push({ bucket: i.bucket, key: i.key, provider: i.provider }); },
    writeProvider: () => 'supabase',
    failover: () => opts.failover ?? true,
  });
}

function req() {
  const fd = new FormData();
  fd.set('video', new File([Buffer.from('not-really-a-video')], 'clip.mp4', { type: 'video/mp4' }));
  return new NextRequest('http://localhost/api/v1/broll/upload', { method: 'POST', body: fd });
}

const old = { broll: process.env.STORAGE_WRITE_PROVIDER_BROLL };
beforeEach(() => { delete process.env.STORAGE_WRITE_PROVIDER_BROLL; vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  if (old.broll === undefined) delete process.env.STORAGE_WRITE_PROVIDER_BROLL; else process.env.STORAGE_WRITE_PROVIDER_BROLL = old.broll;
  vi.restoreAllMocks();
});

describe('POST /api/v1/broll/upload: where the file is written', () => {
  it('writes to Supabase by default, exactly as before (even with R2 configured)', async () => {
    build();
    const res = await upload(req());
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.storageProvider).toBe('supabase');
    expect(body.storagePath).toMatch(/^user-1\/broll\/[0-9a-f-]+\.mp4$/);
    expect(sb.store.size).toBe(1);
    expect(r2.store.size).toBe(0);
    expect(registered).toEqual([]);
    expect(body.signedUrl).toContain('supabase.example');
  });

  it('writes to R2 and registers it when STORAGE_WRITE_PROVIDER_BROLL=r2', async () => {
    process.env.STORAGE_WRITE_PROVIDER_BROLL = 'r2';
    build();
    const res = await upload(req());
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.storageProvider).toBe('r2');
    expect(r2.store.has(`uploads/${body.storagePath}`)).toBe(true);
    expect(sb.store.size).toBe(0);
    expect(registered).toEqual([{ bucket: 'uploads', key: body.storagePath, provider: 'r2' }]);
    expect(body.fileSizeBytes).toBe(Buffer.from('not-really-a-video').length);
    expect(body.durationSeconds).toBe(7);
  });

  it('falls back to Supabase, with no registry row, when the R2 write fails', async () => {
    process.env.STORAGE_WRITE_PROVIDER_BROLL = 'r2';
    build();
    r2.failPut = true;
    const res = await upload(req());
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.storageProvider).toBe('supabase');
    expect(sb.store.has(`uploads/${body.storagePath}`)).toBe(true);
    expect(registered).toEqual([]);
  });

  it('uses Supabase when R2 is requested but not configured', async () => {
    process.env.STORAGE_WRITE_PROVIDER_BROLL = 'r2';
    build({ r2: false });
    const body = await (await upload(req())).json();
    expect(body.storageProvider).toBe('supabase');
    expect(sb.store.size).toBe(1);
  });

  it('returns 500 and stores nothing anywhere when every provider fails (the clip row is a separate request, so none is created)', async () => {
    process.env.STORAGE_WRITE_PROVIDER_BROLL = 'r2';
    build();
    r2.failPut = true; sb.failPut = true;
    const res = await upload(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to upload video' });
    expect(sb.store.size + r2.store.size).toBe(0);
    expect(registered).toEqual([]);
  });

  it('with failover off, an R2 failure is a 500 and nothing lands in Supabase', async () => {
    process.env.STORAGE_WRITE_PROVIDER_BROLL = 'r2';
    build({ failover: false });
    r2.failPut = true;
    expect((await upload(req())).status).toBe(500);
    expect(sb.store.size).toBe(0);
  });
});
