import { describe, it, expect } from 'vitest';
import { Storage, ObjectExistsError, ObjectNotFoundError, type StorageProvider, type ProviderName, type BucketName } from '@/lib/object-store';

function fakeProvider(name: ProviderName) {
  const calls: string[] = [];
  const store = new Map<string, Buffer>();
  const p: StorageProvider & { calls: string[]; store: Map<string, Buffer>; failPut?: boolean } = {
    name, calls, store,
    async put(bucket, key, body) { calls.push(`put ${bucket}/${key}`); if (p.failPut) throw new Error('provider down'); if (store.has(`${bucket}/${key}`)) throw new ObjectExistsError(bucket, key); store.set(`${bucket}/${key}`, body); },
    async download(bucket, key) { const b = store.get(`${bucket}/${key}`); if (!b) throw new ObjectNotFoundError(bucket, key); return b; },
    async head() { return null },
    async signedReadUrl() { return null },
    async signedReadUrls() { return new Map() },
    async signedUpload(bucket, key, ct) { return { url: 'u', method: 'PUT', headers: { 'Content-Type': ct } }; },
    async delete() {},
  };
  return p;
}

function setup(opts: { r2?: boolean; write?: ProviderName; failover?: boolean } = {}) {
  const supabase = fakeProvider('supabase');
  const r2 = opts.r2 === false ? null : fakeProvider('r2');
  const registered: string[] = [];
  const storage = new Storage({
    supabase, r2,
    locate: async (_b: BucketName, keys: string[]) => new Map(keys.map((k) => [k, 'supabase'] as [string, ProviderName])),
    register: async (i) => { registered.push(`${i.provider} ${i.bucket}/${i.key}`); },
    writeProvider: () => opts.write ?? 'supabase',
    failover: () => opts.failover ?? true,
  });
  return { storage, supabase, r2, registered };
}

describe('putR2Only: Studio originals are stored in R2 or not at all', () => {
  it('writes to R2 and registers it, whatever the global write provider says', async () => {
    const { storage, supabase, r2, registered } = setup({ write: 'supabase' });
    expect(await storage.putR2Only('uploads', 'studio/assets/a.png', Buffer.from('x'), { contentType: 'image/png' })).toEqual({ provider: 'r2' });
    expect(r2!.store.has('uploads/studio/assets/a.png')).toBe(true);
    expect(registered).toEqual(['r2 uploads/studio/assets/a.png']);
    expect(supabase.calls).toEqual([]);
  });

  it('never falls back to Supabase when R2 fails, even with failover on', async () => {
    const { storage, supabase, r2, registered } = setup({ failover: true });
    r2!.failPut = true;
    await expect(storage.putR2Only('uploads', 'studio/assets/a.png', Buffer.from('x'), { contentType: 'image/png' })).rejects.toThrow('provider down');
    expect(supabase.calls).toEqual([]);
    expect(supabase.store.size).toBe(0);
    expect(registered).toEqual([]);
  });

  it('refuses when R2 is not configured instead of using Supabase', async () => {
    const { storage, supabase } = setup({ r2: false });
    expect(storage.r2Configured()).toBe(false);
    await expect(storage.putR2Only('uploads', 'studio/assets/a.png', Buffer.from('x'), { contentType: 'image/png' })).rejects.toThrow('R2 is not configured');
    expect(supabase.calls).toEqual([]);
  });

  it('is create-only: an existing key is never overwritten', async () => {
    const { storage, r2 } = setup();
    await storage.putR2Only('uploads', 'k.png', Buffer.from('one'), { contentType: 'image/png' });
    await expect(storage.putR2Only('uploads', 'k.png', Buffer.from('two'), { contentType: 'image/png' })).rejects.toBeInstanceOf(ObjectExistsError);
    expect(r2!.store.get('uploads/k.png')!.toString()).toBe('one');
  });

  it('reads from R2 only', async () => {
    const { storage, supabase } = setup();
    await storage.putR2Only('uploads', 'k.png', Buffer.from('one'), { contentType: 'image/png' });
    expect((await storage.downloadR2Only('uploads', 'k.png')).toString()).toBe('one');
    await expect(storage.downloadR2Only('uploads', 'missing.png')).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect(supabase.calls).toEqual([]);
  });
});
