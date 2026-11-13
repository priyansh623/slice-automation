import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Storage, brollWriteProvider, toLogicalBucket, ObjectExistsError, ObjectNotFoundError, type StorageProvider, type ProviderName, type BucketName } from '@/lib/object-store';

/** A provider backed by a map, recording every call. */
function fakeProvider(name: ProviderName, files: Record<string, Buffer> = {}) {
  const calls: string[] = [];
  const store = new Map(Object.entries(files));
  const p: StorageProvider & { calls: string[]; store: Map<string, Buffer>; failPut?: boolean; failSign?: boolean } = {
    name, calls, store,
    async put(bucket, key, body) { calls.push(`put ${bucket}/${key}`); if (p.failPut) throw new Error('provider down'); if (store.has(`${bucket}/${key}`)) throw new ObjectExistsError(bucket, key); store.set(`${bucket}/${key}`, body); },
    async download(bucket, key) { calls.push(`download ${bucket}/${key}`); const b = store.get(`${bucket}/${key}`); if (!b) throw new ObjectNotFoundError(bucket, key); return b; },
    async head(bucket, key) { calls.push(`head ${bucket}/${key}`); const b = store.get(`${bucket}/${key}`); return b ? { size: b.length, contentType: 'video/mp4', etag: 'e' } : null; },
    async signedReadUrl(bucket, key, ttl) { calls.push(`sign ${bucket}/${key} ${ttl}`); if (p.failSign) throw new Error('sign failed'); return name === 'supabase' && !store.has(`${bucket}/${key}`) ? null : `https://${name}.example/${bucket}/${key}?ttl=${ttl}`; },
    async signedReadUrls(bucket, keys, ttl) { const m = new Map<string, string>(); for (const k of keys) { const u = await p.signedReadUrl(bucket, k, ttl); if (u) m.set(k, u); } return m; },
    async signedUpload(bucket, key, contentType) { calls.push(`signedUpload ${bucket}/${key}`); return { url: `https://${name}.example/up/${bucket}/${key}`, method: 'PUT', headers: { 'Content-Type': contentType } }; },
    async delete(bucket, key) { calls.push(`delete ${bucket}/${key}`); store.delete(`${bucket}/${key}`); },
  };
  return p;
}

function setup(opts: { registry?: Record<string, ProviderName>; r2?: boolean; write?: ProviderName; failover?: boolean; sb?: Record<string, Buffer>; r2files?: Record<string, Buffer>; registerFails?: boolean } = {}) {
  const supabase = fakeProvider('supabase', opts.sb ?? {});
  const r2 = opts.r2 === false ? null : fakeProvider('r2', opts.r2files ?? {});
  const registered: { bucket: string; key: string; provider: string }[] = [];
  const registry = new Map(Object.entries(opts.registry ?? {}));
  const storage = new Storage({
    supabase, r2,
    locate: async (bucket: BucketName, keys: string[]) => new Map(keys.map((k) => [k, registry.get(`${bucket}/${k}`) ?? 'supabase'] as [string, ProviderName])),
    register: async (i) => { if (opts.registerFails) throw new Error('registry down'); registered.push({ bucket: i.bucket, key: i.key, provider: i.provider }); registry.set(`${i.bucket}/${i.key}`, i.provider); },
    writeProvider: () => opts.write ?? 'supabase',
    failover: () => opts.failover ?? true,
  });
  return { storage, supabase, r2, registered };
}
const B = (s: string) => Buffer.from(s);

describe('with R2 switched off (today)', () => {
  it('reads, signs, writes and uploads exactly like the old direct Supabase calls', async () => {
    const { storage, supabase, registered } = setup({ r2: false, sb: { 'videos/a.mp4': B('x') } });
    expect(await storage.signedReadUrl('videos', 'a.mp4', 3600)).toBe('https://supabase.example/videos/a.mp4?ttl=3600');
    expect((await storage.download('videos', 'a.mp4')).toString()).toBe('x');
    expect(await storage.put('videos', 'b.mp4', B('y'), { contentType: 'video/mp4' })).toEqual({ provider: 'supabase' });
    expect((await storage.signedUpload('uploads', 'u/p.png', 'image/png')).provider).toBe('supabase');
    expect(registered).toEqual([]); // Supabase needs no registry row
    expect(supabase.calls.some((c) => c.startsWith('head'))).toBe(false);
  });

  it('returns null for a missing file instead of throwing on signing', async () => {
    const { storage } = setup({ r2: false });
    expect(await storage.signedReadUrl('videos', 'missing.mp4', 60)).toBeNull();
    await expect(storage.download('videos', 'missing.mp4')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('ignores a registry row that says R2 when R2 is not configured', async () => {
    const { storage } = setup({ r2: false, registry: { 'videos/a.mp4': 'r2' }, sb: { 'videos/a.mp4': B('x') } });
    expect(await storage.signedReadUrl('videos', 'a.mp4', 60)).toContain('supabase.example');
  });
});

describe('reading a file registered on R2', () => {
  const reg = { 'videos/a.mp4': 'r2' as const };

  it('uses R2 when the object is there', async () => {
    const { storage, r2, supabase } = setup({ registry: reg, r2files: { 'videos/a.mp4': B('r') }, sb: { 'videos/a.mp4': B('s') } });
    expect(await storage.signedReadUrl('videos', 'a.mp4', 3600)).toContain('r2.example');
    expect((await storage.download('videos', 'a.mp4')).toString()).toBe('r');
    expect(supabase.calls).toEqual([]);
    expect(r2!.calls[0]).toBe('head videos/a.mp4'); // checked before signing while a fallback exists
  });

  it('falls back to the Supabase copy when the R2 object is missing', async () => {
    const { storage } = setup({ registry: reg, sb: { 'videos/a.mp4': B('s') } });
    expect(await storage.signedReadUrl('videos', 'a.mp4', 3600)).toContain('supabase.example');
    expect((await storage.download('videos', 'a.mp4')).toString()).toBe('s');
  });

  it('falls back when R2 errors', async () => {
    const { storage, r2 } = setup({ registry: reg, r2files: { 'videos/a.mp4': B('r') }, sb: { 'videos/a.mp4': B('s') } });
    r2!.failSign = true;
    r2!.download = async () => { throw new Error('R2 outage'); };
    expect(await storage.signedReadUrl('videos', 'a.mp4', 60)).toContain('supabase.example');
    expect((await storage.download('videos', 'a.mp4')).toString()).toBe('s');
  });

  it('with failover off, uses only R2 and signs without checking the object', async () => {
    const { storage, r2, supabase } = setup({ registry: reg, failover: false, sb: { 'videos/a.mp4': B('s') } });
    expect(await storage.signedReadUrl('videos', 'a.mp4', 60)).toContain('r2.example');
    expect(r2!.calls).toEqual(['sign videos/a.mp4 60']);
    expect(supabase.calls).toEqual([]);
  });

  it('finds an R2 file that has no registry row yet (browser upload finished before registration)', async () => {
    const { storage } = setup({ r2files: { 'uploads/u/p.png': B('r') } });
    expect(await storage.signedReadUrl('uploads', 'u/p.png', 60)).toContain('r2.example');
  });

  it('signs many keys, mixing providers', async () => {
    const { storage } = setup({ registry: { 'uploads/r.png': 'r2' }, r2files: { 'uploads/r.png': B('r') }, sb: { 'uploads/s.png': B('s') } });
    const urls = await storage.signedReadUrls('uploads', ['r.png', 's.png', 'gone.png'], 100);
    expect(urls.get('r.png')).toContain('r2.example');
    expect(urls.get('s.png')).toContain('supabase.example');
    expect(urls.has('gone.png')).toBe(false);
  });
});

describe('writing new files', () => {
  it('stores in R2 and records where it is when the write provider is R2', async () => {
    const { storage, r2, supabase, registered } = setup({ write: 'r2' });
    expect(await storage.put('videos', 'n.mp4', B('n'), { contentType: 'video/mp4' })).toEqual({ provider: 'r2' });
    expect(r2!.store.has('videos/n.mp4')).toBe(true);
    expect(supabase.store.size).toBe(0);
    expect(registered).toEqual([{ bucket: 'videos', key: 'n.mp4', provider: 'r2' }]);
  });

  it('never overwrites: an existing key is an error, not a fallback', async () => {
    const { storage, supabase } = setup({ write: 'r2', r2files: { 'videos/n.mp4': B('old') } });
    await expect(storage.put('videos', 'n.mp4', B('n'), { contentType: 'video/mp4' })).rejects.toBeInstanceOf(ObjectExistsError);
    expect(supabase.store.size).toBe(0);
  });

  it('falls back to Supabase when R2 is down and failover is on', async () => {
    const { storage, r2, supabase, registered } = setup({ write: 'r2' });
    r2!.failPut = true;
    expect(await storage.put('videos', 'n.mp4', B('n'), { contentType: 'video/mp4' })).toEqual({ provider: 'supabase' });
    expect(supabase.store.has('videos/n.mp4')).toBe(true);
    expect(registered).toEqual([]);
  });

  it('fails when R2 is down and failover is off', async () => {
    const { storage, r2 } = setup({ write: 'r2', failover: false });
    r2!.failPut = true;
    await expect(storage.put('videos', 'n.mp4', B('n'), { contentType: 'video/mp4' })).rejects.toThrow('provider down');
  });

  it('fails loudly if R2 stored the file but the registry could not record it (no unreadable path is returned)', async () => {
    const { storage, r2, supabase } = setup({ write: 'r2', registerFails: true, failover: false });
    await expect(storage.put('videos', 'n.mp4', B('n'), { contentType: 'video/mp4' })).rejects.toThrow('registry down');
    expect(r2!.store.has('videos/n.mp4')).toBe(true); // an orphan for the reconciliation report
    expect(supabase.store.size).toBe(0);
  });

  it('writes to Supabase by default even when R2 is configured', async () => {
    const { storage, r2 } = setup({});
    expect(await storage.put('videos', 'n.mp4', B('n'), { contentType: 'video/mp4' })).toEqual({ provider: 'supabase' });
    expect(r2!.calls).toEqual([]);
  });

  describe('a per-write provider preference (used for B-roll)', () => {
    const opts = { contentType: 'video/mp4', preferProvider: 'r2' as const };

    it('sends this one write to R2 and registers it while the global provider stays Supabase', async () => {
      const { storage, r2, supabase, registered } = setup({ write: 'supabase' });
      expect(await storage.put('uploads', 'u/broll/a.mp4', B('n'), opts)).toEqual({ provider: 'r2' });
      expect(r2!.store.has('uploads/u/broll/a.mp4')).toBe(true);
      expect(supabase.store.size).toBe(0);
      expect(registered).toEqual([{ bucket: 'uploads', key: 'u/broll/a.mp4', provider: 'r2' }]);
      // a write without the preference still goes to Supabase
      expect(await storage.put('uploads', 'u/b.png', B('i'), { contentType: 'image/png' })).toEqual({ provider: 'supabase' });
    });

    it('is ignored when R2 is not configured: the write goes to Supabase', async () => {
      const { storage, supabase } = setup({ r2: false });
      expect(await storage.put('uploads', 'u/broll/a.mp4', B('n'), opts)).toEqual({ provider: 'supabase' });
      expect(supabase.store.has('uploads/u/broll/a.mp4')).toBe(true);
    });

    it('falls back to Supabase, with no registry row, when R2 fails and failover is on', async () => {
      const { storage, r2, supabase, registered } = setup({});
      r2!.failPut = true;
      expect(await storage.put('uploads', 'u/broll/a.mp4', B('n'), opts)).toEqual({ provider: 'supabase' });
      expect(supabase.store.has('uploads/u/broll/a.mp4')).toBe(true);
      expect(registered).toEqual([]);
    });

    it('fails (and writes nothing to Supabase) when R2 fails and failover is off', async () => {
      const { storage, r2, supabase } = setup({ failover: false });
      r2!.failPut = true;
      await expect(storage.put('uploads', 'u/broll/a.mp4', B('n'), opts)).rejects.toThrow('provider down');
      expect(supabase.store.size).toBe(0);
    });

    it("'supabase' as the preference overrides an R2 global setting", async () => {
      const { storage, r2 } = setup({ write: 'r2' });
      expect(await storage.put('uploads', 'k.mp4', B('n'), { contentType: 'video/mp4', preferProvider: 'supabase' })).toEqual({ provider: 'supabase' });
      expect(r2!.calls).toEqual([]);
    });
  });

  it('brollWriteProvider follows STORAGE_WRITE_PROVIDER_BROLL only', () => {
    const old = process.env.STORAGE_WRITE_PROVIDER_BROLL;
    try {
      delete process.env.STORAGE_WRITE_PROVIDER_BROLL;
      expect(brollWriteProvider()).toBeUndefined();
      process.env.STORAGE_WRITE_PROVIDER_BROLL = 'r2';
      expect(brollWriteProvider()).toBe('r2');
      process.env.STORAGE_WRITE_PROVIDER_BROLL = 'anything-else';
      expect(brollWriteProvider()).toBeUndefined();
    } finally {
      if (old === undefined) delete process.env.STORAGE_WRITE_PROVIDER_BROLL; else process.env.STORAGE_WRITE_PROVIDER_BROLL = old;
    }
  });

  it('keeps browser-direct upload URLs on Supabase even when R2 is the write provider', async () => {
    const { storage, registered, r2 } = setup({ write: 'r2' });
    const up = await storage.signedUpload('uploads', 'u/p.png', 'image/png');
    expect(up).toMatchObject({ provider: 'supabase', method: 'PUT', headers: { 'Content-Type': 'image/png' } });
    expect(up.url).toContain('supabase.example');
    expect(registered).toEqual([]);
    expect(r2!.calls).toEqual([]);
  });
});

describe('existence and metadata', () => {
  it('finds a file in either provider', async () => {
    const { storage } = setup({ registry: { 'videos/a.mp4': 'r2' }, sb: { 'videos/a.mp4': B('s') } });
    expect(await storage.exists('videos', 'a.mp4')).toBe(true);
    expect(await storage.head('videos', 'a.mp4')).toMatchObject({ size: 1 });
    expect(await storage.exists('videos', 'zzz.mp4')).toBe(false);
  });
});

describe('toLogicalBucket', () => {
  it('maps configured Supabase bucket names to the logical ones and rejects strangers', () => {
    expect(toLogicalBucket('videos')).toBe('videos');
    expect(toLogicalBucket('uploads')).toBe('uploads');
    expect(() => toLogicalBucket('something-else')).toThrow();
    const old = process.env.SUPABASE_BUCKET_UPLOADS;
    process.env.SUPABASE_BUCKET_UPLOADS = 'uploads-prod';
    try { expect(toLogicalBucket('uploads-prod')).toBe('uploads'); } finally { if (old === undefined) delete process.env.SUPABASE_BUCKET_UPLOADS; else process.env.SUPABASE_BUCKET_UPLOADS = old; }
  });
});

describe('empty bucket environment variables', () => {
  it('are treated as unset, so the default bucket names are used', async () => {
    const { SupabaseProvider } = await import('@/lib/object-store/supabase-provider');
    const used: string[] = [];
    const client = { storage: { from: (name: string) => { used.push(name); return { createSignedUrl: async () => ({ data: { signedUrl: 'https://x/y' }, error: null }) }; } } };
    const saved = { v: process.env.SUPABASE_BUCKET_VIDEOS, u: process.env.SUPABASE_BUCKET_UPLOADS };
    process.env.SUPABASE_BUCKET_VIDEOS = ''; process.env.SUPABASE_BUCKET_UPLOADS = '';
    try {
      const p = new SupabaseProvider(client as never);
      await p.signedReadUrl('videos', 'k', 60);
      await p.signedReadUrl('uploads', 'k', 60);
      expect(used).toEqual(['videos', 'uploads']);
      expect(toLogicalBucket('videos')).toBe('videos');
    } finally {
      if (saved.v === undefined) delete process.env.SUPABASE_BUCKET_VIDEOS; else process.env.SUPABASE_BUCKET_VIDEOS = saved.v;
      if (saved.u === undefined) delete process.env.SUPABASE_BUCKET_UPLOADS; else process.env.SUPABASE_BUCKET_UPLOADS = saved.u;
    }
  });
});

beforeEach(() => vi.restoreAllMocks());
