/**
 * The Supabase -> R2 copy logic with fake providers: no network, no database, no real storage.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { runCopy, listSupabaseObjects, CopyInterrupted, type CopyDeps, type CopyOptions, type RegistryRow, type SourceObject, type SupabaseListClient } from '@/lib/object-store/copy';
import { ObjectExistsError, ObjectNotFoundError, type BucketName, type ProviderName } from '@/lib/object-store/types';
import { parseArgs } from '../../scripts/storage-copy';

const B = (s: string) => Buffer.from(s);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Rig {
  deps: CopyDeps;
  sb: Map<string, Buffer>;            // Supabase contents, "bucket/key"
  r2: Map<string, Buffer>;            // R2 contents
  registry: Map<string, { provider: ProviderName; sha256?: string; sizeBytes?: number }>;
  calls: string[];
  hooks: {
    sbDownload?: (k: string) => void;
    r2Put?: (k: string) => void;
    r2Download?: (k: string, real: Buffer) => Buffer;
    register?: (k: string) => void;
    list?: SourceObject[];
  };
}

function rig(init: { sb?: Record<string, string>; r2?: Record<string, string>; registry?: Record<string, ProviderName> } = {}): Rig {
  const sb = new Map<string, Buffer>(Object.entries(init.sb ?? {}).map(([k, v]) => [k, B(v)] as [string, Buffer]));
  const r2 = new Map<string, Buffer>(Object.entries(init.r2 ?? {}).map(([k, v]) => [k, B(v)] as [string, Buffer]));
  const registry = new Map<string, { provider: ProviderName; sha256?: string; sizeBytes?: number }>(Object.entries(init.registry ?? {}).map(([k, p]) => [k, { provider: p }] as [string, { provider: ProviderName }]));
  const calls: string[] = [];
  const hooks: Rig['hooks'] = {};
  const id = (bucket: BucketName, key: string) => `${bucket}/${key}`;
  const deps: CopyDeps = {
    source: {
      async download(bucket, key) {
        calls.push(`sb.download ${id(bucket, key)}`);
        hooks.sbDownload?.(key);
        const b = sb.get(id(bucket, key));
        if (!b) throw new ObjectNotFoundError(bucket, key);
        return b;
      },
    },
    target: {
      async put(bucket, key, body, opts) {
        calls.push(`r2.put ${id(bucket, key)} upsert=${opts.upsert ?? false}`);
        hooks.r2Put?.(key);
        if (r2.has(id(bucket, key))) throw new ObjectExistsError(bucket, key);
        r2.set(id(bucket, key), body);
      },
      async download(bucket, key) {
        calls.push(`r2.download ${id(bucket, key)}`);
        const b = r2.get(id(bucket, key));
        if (!b) throw new ObjectNotFoundError(bucket, key);
        return hooks.r2Download ? hooks.r2Download(key, b) : b;
      },
      async head(bucket, key) {
        calls.push(`r2.head ${id(bucket, key)}`);
        const b = r2.get(id(bucket, key));
        return b ? { size: b.length, contentType: null, etag: null } : null;
      },
    },
    async *listSource(bucket, prefix) {
      const items: SourceObject[] = hooks.list ?? [...sb.entries()].filter(([k]) => k.startsWith(`${bucket}/`)).map(([k, v]) => ({ key: k.slice(bucket.length + 1), size: v.length, contentType: 'video/mp4' }));
      for (const o of items.filter((o) => o.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key))) yield o;
    },
    async registeredRows(bucket, keys) {
      return new Map(keys.flatMap((k) => {
        const row = registry.get(id(bucket, k));
        return row ? [[k, { provider: row.provider, sha256: row.sha256 ?? null, sizeBytes: row.sizeBytes ?? null }] as [string, RegistryRow]] : [];
      }));
    },
    async registerIfAbsent(row) {
      calls.push(`register ${id(row.bucket, row.key)}`);
      hooks.register?.(row.key);
      if (registry.has(id(row.bucket, row.key))) return false;
      registry.set(id(row.bucket, row.key), { provider: row.provider, sha256: row.sha256, sizeBytes: row.sizeBytes });
      return true;
    },
  };
  return { deps, sb, r2, registry, calls, hooks };
}

const EXEC: CopyOptions = { buckets: ['videos'], prefix: '', limit: null, execute: true };
const DRY: CopyOptions = { ...EXEC, execute: false };
const writes = (calls: string[]) => calls.filter((c) => /^(r2\.put|register)/.test(c));

describe('dry run', () => {
  it('is the default behaviour of the options and changes nothing', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa', 'videos/b.mp4': 'bbbb' }, r2: { 'videos/b.mp4': 'bbbb' } });
    const report = await runCopy(r.deps, DRY);
    expect(report.dryRun).toBe(true);
    expect(report.counts).toMatchObject({ 'would-copy': 1, 'would-register': 1, copied: 0, failed: 0 });
    expect(report.bytesPlanned).toBe(7);
    expect(r.calls.filter((c) => /download|put|register/.test(c))).toEqual([]);
    expect(r.registry.size).toBe(0);
    expect(r.r2.size).toBe(1);
  });

  it('works without R2 configured, but a real copy refuses to start without it', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    const noR2 = { ...r.deps, target: null };
    expect((await runCopy(noR2, DRY)).counts['would-copy']).toBe(1);
    await expect(runCopy(noR2, EXEC)).rejects.toThrow(/R2 is not configured/);
  });
});

describe('a successful copy', () => {
  it('writes create-only, verifies by reading back, then registers with size and checksum; Supabase is untouched', async () => {
    const r = rig({ sb: { 'videos/screen-1/a.mp4': 'hello video' } });
    const report = await runCopy(r.deps, EXEC);
    expect(report.counts.copied).toBe(1);
    expect(r.calls).toEqual([
      'sb.download videos/screen-1/a.mp4',
      'r2.put videos/screen-1/a.mp4 upsert=false',
      'r2.download videos/screen-1/a.mp4',
      'register videos/screen-1/a.mp4',
    ]);
    expect(r.registry.get('videos/screen-1/a.mp4')).toEqual({ provider: 'r2', sha256: sha(B('hello video')), sizeBytes: 11 });
    expect(r.sb.get('videos/screen-1/a.mp4')?.toString()).toBe('hello video');
    expect(report.bytesCopied).toBe(11);
  });

  it('registers only after the read-back check, never before', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'x' } });
    await runCopy(r.deps, EXEC);
    expect(r.calls.indexOf('register videos/a.mp4')).toBeGreaterThan(r.calls.indexOf('r2.download videos/a.mp4'));
  });
});

const httpErr = (status: number, msg = 'error') => Object.assign(new Error(msg), { status, statusCode: String(status) });
const noWait = { sleep: async () => {}, random: () => 0.5 };

describe('transient download failures are retried; permanent ones are not', () => {
  it('retries a 503 and a 429 and then copies the file once, registering it only after the checked read-back', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    r.deps.retry = noWait;
    let n = 0;
    r.hooks.sbDownload = () => { n++; if (n === 1) throw httpErr(503); if (n === 2) throw httpErr(429); };
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'copied' });
    expect(r.calls.filter((c) => c.startsWith('sb.download'))).toHaveLength(3);
    expect(r.calls.filter((c) => c.startsWith('r2.put'))).toHaveLength(1);        // written once, create-only
    expect(r.calls.filter((c) => c.startsWith('register'))).toHaveLength(1);
    expect(r.registry.get('videos/a.mp4')?.sha256).toBe(sha(B('aaa')));
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('retries HTTP %i', async (status) => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    r.deps.retry = noWait;
    let n = 0;
    r.hooks.sbDownload = () => { if (n++ === 0) throw httpErr(status); };
    expect((await runCopy(r.deps, EXEC)).results[0].outcome).toBe('copied');
    expect(n).toBe(2);
  });

  it('retries a network failure that has no HTTP status ("fetch failed")', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    r.deps.retry = noWait;
    let n = 0;
    r.hooks.sbDownload = () => { if (n++ < 2) throw new Error('Failed to download a.mp4 from bucket videos: fetch failed'); };
    expect((await runCopy(r.deps, EXEC)).results[0].outcome).toBe('copied');
    expect(n).toBe(3);
  });

  it('gives up after 5 attempts, reports the key and the error, writes nothing, and carries on with the next file', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa', 'videos/b.mp4': 'bbb' } });
    r.deps.retry = noWait;
    r.hooks.sbDownload = (k) => { if (k === 'a.mp4') throw httpErr(503, 'Service Unavailable'); };
    const report = await runCopy(r.deps, EXEC);
    const a = report.results.find((x) => x.key === 'a.mp4')!;
    expect(a).toMatchObject({ outcome: 'failed', stage: 'download' });
    expect(a.reason).toContain('Service Unavailable');
    expect(a.reason).toContain('gave up after 5 attempts');
    expect(r.calls.filter((c) => c === 'sb.download videos/a.mp4')).toHaveLength(5);
    expect(r.r2.has('videos/a.mp4')).toBe(false);
    expect(r.registry.has('videos/a.mp4')).toBe(false);                           // a failed download never creates a registry entry
    expect(report.results.find((x) => x.key === 'b.mp4')?.outcome).toBe('copied');
  });

  it.each([400, 401, 403, 404, 413])('does not retry permanent HTTP %i: exactly one attempt', async (status) => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    r.deps.retry = noWait;
    r.hooks.sbDownload = () => { throw httpErr(status, 'denied'); };
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'download' });
    expect(r.calls.filter((c) => c.startsWith('sb.download'))).toHaveLength(1);
    expect(writes(r.calls)).toEqual([]);
  });

  it('does not retry a conflicting status pair when either one is permanent (503 with "404")', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    r.deps.retry = noWait;
    r.hooks.sbDownload = () => { throw Object.assign(new Error('x'), { status: 503, statusCode: '404' }); };
    await runCopy(r.deps, EXEC);
    expect(r.calls.filter((c) => c.startsWith('sb.download'))).toHaveLength(1);
  });

  it('does not retry a file Supabase lists but cannot find (not found is permanent)', async () => {
    const r = rig();
    r.deps.retry = noWait;
    r.hooks.list = [{ key: 'ghost.mp4', size: 3, contentType: 'video/mp4' }];
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'download' });
    expect(r.calls.filter((c) => c.startsWith('sb.download'))).toHaveLength(1);
  });

  it('waits with growing, jittered delays between attempts and logs each retry', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    const waits: number[] = []; const lines: string[] = [];
    r.deps.retry = { sleep: async (ms) => { waits.push(ms); }, random: () => 0, log: (l) => lines.push(l) };
    let n = 0;
    r.hooks.sbDownload = () => { if (n++ < 3) throw httpErr(502); };
    await runCopy(r.deps, EXEC);
    expect(waits).toEqual([250, 500, 1000]);                                       // equal jitter, random()=0: half of 0.5 s, 1 s, 2 s
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('download videos/a.mp4');
  });

  it('an interruption is never retried', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    r.deps.retry = noWait;
    r.hooks.sbDownload = () => { throw new CopyInterrupted(); };
    await expect(runCopy(r.deps, EXEC)).rejects.toBeInstanceOf(CopyInterrupted);
    expect(r.calls.filter((c) => c.startsWith('sb.download'))).toHaveLength(1);
  });

  it('the real Supabase provider keeps the HTTP status of a failed download so it can be classified', async () => {
    const { SupabaseProvider } = await import('@/lib/object-store/supabase-provider');
    const mk = (error: unknown) => new SupabaseProvider({ storage: { from: () => ({ download: async () => ({ data: null, error }) }) } } as never);
    const err = await mk({ message: 'Service Unavailable', status: 503, statusCode: '503' }).download('videos', 'a.mp4').catch((e) => e);
    expect(err.message).toContain('Failed to download a.mp4');
    expect(err).toMatchObject({ status: 503, statusCode: '503' });
    const { isTransientError } = await import('@/lib/object-store/retry');
    expect(isTransientError(err)).toBe(true);
    const perm = await mk({ message: 'Forbidden', status: 403, statusCode: '403' }).download('videos', 'a.mp4').catch((e) => e);
    expect(isTransientError(perm)).toBe(false);
    const net = await mk({ message: 'fetch failed', name: 'StorageUnknownError', originalError: new TypeError('fetch failed') }).download('videos', 'a.mp4').catch((e) => e);
    expect(isTransientError(net)).toBe(true);
  });
});

describe('failures never register the file', () => {
  it('download failure: nothing written to R2, nothing registered, the run continues', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa', 'videos/b.mp4': 'bbb' } });
    r.hooks.sbDownload = (k) => { if (k === 'a.mp4') throw new Error('Supabase 503'); };
    const report = await runCopy(r.deps, EXEC);
    expect(report.results.find((x) => x.key === 'a.mp4')).toMatchObject({ outcome: 'failed', stage: 'download' });
    expect(report.results.find((x) => x.key === 'b.mp4')?.outcome).toBe('copied');
    expect(r.r2.has('videos/a.mp4')).toBe(false);
    expect(r.registry.has('videos/a.mp4')).toBe(false);
  });

  it('a file Supabase lists but cannot serve fails without touching R2', async () => {
    const r = rig();
    r.hooks.list = [{ key: 'ghost.mp4', size: 3, contentType: 'video/mp4' }];
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'download' });
    expect(writes(r.calls)).toEqual([]);
  });

  it('size different from the Supabase listing: not copied', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'abc' } });
    r.hooks.list = [{ key: 'a.mp4', size: 99, contentType: 'video/mp4' }];
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'size' });
    expect(writes(r.calls)).toEqual([]);
  });

  it('R2 write failure: not registered, no read-back attempted, a later run succeeds', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    r.hooks.r2Put = () => { throw new Error('R2 500'); };
    const first = await runCopy(r.deps, EXEC);
    expect(first.results[0]).toMatchObject({ outcome: 'failed', stage: 'put' });
    expect(r.registry.size).toBe(0);
    expect(r.calls).not.toContain('r2.download videos/a.mp4');
    r.hooks.r2Put = undefined;
    const second = await runCopy(r.deps, EXEC);
    expect(second.counts.copied).toBe(1);
    expect(r.registry.get('videos/a.mp4')?.provider).toBe('r2');
  });

  it('checksum mismatch (same size, different bytes read back): not registered', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaaa' } });
    r.hooks.r2Download = () => B('aaab');
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'checksum' });
    expect(r.registry.size).toBe(0);
    expect(report.counts.copied).toBe(0);
  });

  it('size mismatch on read-back (truncated copy): not registered', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaaa' } });
    r.hooks.r2Download = (_k, real) => real.subarray(0, 2);
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'checksum' });
    expect(r.registry.size).toBe(0);
  });

  it('read-back failure: not registered', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaaa' } });
    r.hooks.r2Download = () => { throw new Error('R2 timeout'); };
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'verify' });
    expect(r.registry.size).toBe(0);
  });

  it('registry write failure: the file is reported failed, never as migrated, and reads would stay on Supabase', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaaa' } });
    r.hooks.register = () => { throw new Error('database unavailable'); };
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'register' });
    expect(report.counts.copied).toBe(0);
    expect(report.bytesCopied).toBe(0);
    expect(r.registry.size).toBe(0);
  });

  it('after a registry failure a re-run reuses the verified R2 object (no second write) and registers it', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaaa' } });
    r.hooks.register = () => { throw new Error('database unavailable'); };
    await runCopy(r.deps, EXEC);
    r.hooks.register = undefined;
    r.calls.length = 0;
    const second = await runCopy(r.deps, EXEC);
    expect(second.counts['registered-existing']).toBe(1);
    expect(r.calls.filter((c) => c.startsWith('r2.put')).length).toBe(1); // attempted create-only, rejected as existing
    expect(r.r2.get('videos/a.mp4')?.toString()).toBe('aaaa');
    expect(r.registry.get('videos/a.mp4')?.provider).toBe('r2');
  });

  it('an unreadable registry aborts the whole run before any work', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaaa' } });
    r.deps.registeredRows = async () => { throw new Error('registry down'); };
    await expect(runCopy(r.deps, EXEC)).rejects.toThrow('registry down');
    expect(writes(r.calls)).toEqual([]);
  });
});

describe('existing objects', () => {
  it('an object already in R2 with identical bytes is verified and registered, never overwritten', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'same' }, r2: { 'videos/a.mp4': 'same' } });
    const report = await runCopy(r.deps, EXEC);
    expect(report.counts['registered-existing']).toBe(1);
    expect(r.calls.find((c) => c.startsWith('r2.put'))).toBe('r2.put videos/a.mp4 upsert=false');
    expect(r.r2.get('videos/a.mp4')?.toString()).toBe('same');
    expect(r.registry.get('videos/a.mp4')?.provider).toBe('r2');
  });

  it('an object already in R2 with different bytes is left untouched and not registered', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'original' }, r2: { 'videos/a.mp4': 'DIFFERENT' } });
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'existing-mismatch' });
    expect(r.r2.get('videos/a.mp4')?.toString()).toBe('DIFFERENT');
    expect(r.registry.size).toBe(0);
  });

  it('files that already have a registry row are skipped and the row is not modified', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa', 'videos/b.mp4': 'bbb' }, r2: { 'videos/a.mp4': 'aaa' }, registry: { 'videos/a.mp4': 'r2', 'videos/b.mp4': 'supabase' } });
    const before = JSON.stringify([...r.registry]);
    const report = await runCopy(r.deps, EXEC);
    expect(report.counts['skipped-registered']).toBe(2);
    expect(report.results.find((x) => x.key === 'a.mp4')?.reason).toMatch(/checksum NOT compared \(size-checked only\)/);
    expect(r.calls).toEqual(['r2.head videos/a.mp4']); // only a read-only check of the row that claims R2; no download, write or register
    expect(JSON.stringify([...r.registry])).toBe(before);
  });

  it('a registry row that appears while copying is left alone', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    r.hooks.register = (k) => { r.registry.set(`videos/${k}`, { provider: 'r2' }); };
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0].outcome).toBe('skipped-registered');
    expect(report.counts.copied).toBe(0);
  });
});

describe('dry run reports conflicts before anything is executed', () => {
  it('flags an R2 object whose size differs from the Supabase original, and says contents are compared on execute otherwise', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'original', 'videos/b.mp4': 'same-size', 'videos/c.mp4': 'new' }, r2: { 'videos/a.mp4': 'DIFFERENT-LENGTH', 'videos/b.mp4': 'SAME-SIZE' } });
    const report = await runCopy(r.deps, DRY);
    expect(report.counts).toMatchObject({ 'would-conflict': 1, 'would-register': 1, 'would-copy': 1, failed: 0 });
    const conflict = report.results.find((x) => x.outcome === 'would-conflict')!;
    expect(conflict).toMatchObject({ key: 'a.mp4', stage: 'existing-mismatch' });
    expect(conflict.reason).toMatch(/different size.*left untouched/);
    expect(report.results.find((x) => x.key === 'b.mp4')?.reason).toMatch(/NOT verified.*checksum comparison is pending/);
    expect(r.calls.filter((c) => /download|put|register/.test(c))).toEqual([]);
  });

  it('a same-size object with different bytes is only caught when executing, and is then left untouched', async () => {
    const r = rig({ sb: { 'videos/b.mp4': 'same-size' }, r2: { 'videos/b.mp4': 'SAME-SIZE' } });
    expect((await runCopy(r.deps, DRY)).counts['would-register']).toBe(1);
    const real = await runCopy(r.deps, EXEC);
    expect(real.results[0]).toMatchObject({ outcome: 'failed', stage: 'existing-mismatch' });
    expect(r.r2.get('videos/b.mp4')?.toString()).toBe('SAME-SIZE');
    expect(r.registry.size).toBe(0);
  });
});

describe('existing registry rows are checked, never changed', () => {
  it("a row saying r2 whose object is missing from R2 is reported as a problem and left as it is", async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' }, registry: { 'videos/a.mp4': 'r2' } });
    for (const opts of [DRY, EXEC]) {
      const report = await runCopy(r.deps, opts);
      expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'registry-check' });
    }
    expect(r.registry.get('videos/a.mp4')).toEqual({ provider: 'r2' });
    expect(writes(r.calls)).toEqual([]);
  });

  it('a row saying r2 whose R2 object has a different size than the Supabase original is reported, not repaired', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' }, r2: { 'videos/a.mp4': 'aaaaaa' }, registry: { 'videos/a.mp4': 'r2' } });
    const report = await runCopy(r.deps, EXEC);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'registry-check' });
    expect(r.r2.get('videos/a.mp4')?.toString()).toBe('aaaaaa');
    expect(writes(r.calls)).toEqual([]);
  });
});

describe('--verify-registered', () => {
  const VERIFY: CopyOptions = { ...DRY, verifyRegistered: true };
  const withRow = (r: Rig, key: string, content: string | null, sha256: string | null) => {
    r.registry.set(`videos/${key}`, { provider: 'r2', sha256: sha256 ?? undefined, sizeBytes: content ? content.length : undefined });
  };

  it('downloads the R2 object, compares SHA-256 with the stored checksum, and never reads Supabase', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' }, r2: { 'videos/a.mp4': 'aaa' } });
    withRow(r, 'a.mp4', 'aaa', sha(B('aaa')));
    const report = await runCopy(r.deps, VERIFY);
    expect(report.results[0]).toMatchObject({ outcome: 'verified-registered' });
    expect(r.calls).toEqual(['r2.head videos/a.mp4', 'r2.download videos/a.mp4']);
    expect(r.calls.some((c) => c.startsWith('sb.download'))).toBe(false);
  });

  it('a row without a stored checksum is unverifiable, never verified, and the object is not downloaded', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' }, r2: { 'videos/a.mp4': 'aaa' } });
    withRow(r, 'a.mp4', 'aaa', null);
    const report = await runCopy(r.deps, VERIFY);
    expect(report.results[0]).toMatchObject({ outcome: 'unverifiable' });
    expect(report.results[0].reason).toMatch(/could NOT be verified/);
    expect(report.counts['verified-registered']).toBe(0);
    expect(r.calls.some((c) => c.startsWith('r2.download'))).toBe(false);
  });

  it('a same-size object with different contents is a failure, reported without changing the object or the row', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' }, r2: { 'videos/a.mp4': 'aaX' } });
    withRow(r, 'a.mp4', 'aaa', sha(B('aaa')));
    const rowBefore = JSON.stringify(r.registry.get('videos/a.mp4'));
    for (const opts of [VERIFY, { ...VERIFY, execute: true }]) {
      const report = await runCopy(r.deps, opts);
      expect(report.results[0]).toMatchObject({ outcome: 'failed', stage: 'registry-check' });
      expect(report.results[0].reason).toMatch(/SHA-256.*differs.*not changed/);
    }
    expect(r.r2.get('videos/a.mp4')?.toString()).toBe('aaX');
    expect(JSON.stringify(r.registry.get('videos/a.mp4'))).toBe(rowBefore);
    expect(writes(r.calls)).toEqual([]);
  });

  it('a missing R2 object and a download error are failures too', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' } });
    withRow(r, 'a.mp4', 'aaa', sha(B('aaa')));
    expect((await runCopy(r.deps, VERIFY)).results[0]).toMatchObject({ outcome: 'failed', stage: 'registry-check' });
    r.r2.set('videos/a.mp4', B('aaa'));
    r.hooks.r2Download = () => { throw new Error('R2 timeout'); };
    expect((await runCopy(r.deps, VERIFY)).results[0]).toMatchObject({ outcome: 'failed', stage: 'registry-check' });
  });

  it('is off by default (size-checked only) and needs R2 to be configured', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa' }, r2: { 'videos/a.mp4': 'aaa' } });
    withRow(r, 'a.mp4', 'aaa', sha(B('aaa')));
    expect((await runCopy(r.deps, DRY)).results[0].outcome).toBe('skipped-registered');
    expect(r.calls.some((c) => c.startsWith('r2.download'))).toBe(false);
    await expect(runCopy({ ...r.deps, target: null }, VERIFY)).rejects.toThrow(/R2 is not configured/);
  });

  it('does not use up --limit and leaves rows that say supabase alone', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa', 'videos/b.mp4': 'bbb' }, r2: { 'videos/a.mp4': 'aaa' }, registry: { 'videos/b.mp4': 'supabase' } });
    withRow(r, 'a.mp4', 'aaa', sha(B('aaa')));
    const report = await runCopy(r.deps, { ...VERIFY, limit: 1 });
    expect(report.counts).toMatchObject({ 'verified-registered': 1, 'skipped-registered': 1 });
  });
});

describe('listing cross-check', () => {
  const countOf = (n: number | null) => async () => n;

  it('passes when an independent count equals the distinct objects listed', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'a', 'videos/b.mp4': 'b' } });
    const report = await runCopy({ ...r.deps, countSource: countOf(2) }, DRY);
    expect(report.listingChecks.videos).toMatchObject({ listed: 2, expected: 2, match: true });
  });

  it('flags a MISMATCH when the listing is shorter than the independent count', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'a', 'videos/b.mp4': 'b' } });
    const report = await runCopy({ ...r.deps, countSource: countOf(3) }, DRY);
    expect(report.listingChecks.videos).toMatchObject({ listed: 2, expected: 3, match: false });
  });

  it('says it was not cross-checked when no count is available, rather than implying success', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'a' } });
    expect((await runCopy({ ...r.deps, countSource: countOf(null) }, DRY)).listingChecks.videos).toMatchObject({ match: null });
    expect((await runCopy(r.deps, DRY)).listingChecks.videos).toMatchObject({ match: null });
  });

  it('is skipped when the run stops before the end of the bucket (limit)', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'a', 'videos/b.mp4': 'b' } });
    const report = await runCopy({ ...r.deps, countSource: countOf(2) }, { ...DRY, limit: 1 });
    expect(report.listingChecks.videos).toBeUndefined();
  });

  it('processes an object that is listed twice only once and counts the duplicate', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'a' } });
    r.hooks.list = [{ key: 'a.mp4', size: 1, contentType: 'video/mp4' }, { key: 'a.mp4', size: 1, contentType: 'video/mp4' }];
    const report = await runCopy({ ...r.deps, countSource: countOf(1) }, EXEC);
    expect(report.counts.copied).toBe(1);
    expect(report.listingChecks.videos).toMatchObject({ listed: 1, expected: 1, match: true, duplicates: 1 });
  });
});

describe('interruption and retries', () => {
  it('killed after the R2 write but before registering: nothing is registered, and the re-run finishes without a second copy', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaaa', 'videos/b.mp4': 'bbbb' } });
    r.hooks.register = (k) => { if (k === 'a.mp4') throw new CopyInterrupted(); };
    await expect(runCopy(r.deps, EXEC)).rejects.toBeInstanceOf(CopyInterrupted);
    expect(r.r2.has('videos/a.mp4')).toBe(true);     // atomic create-only write finished
    expect(r.registry.size).toBe(0);                  // so the file still reads from Supabase
    expect(r.r2.has('videos/b.mp4')).toBe(false);     // run really stopped

    r.hooks.register = undefined;
    const rerun = await runCopy(r.deps, EXEC);
    expect(rerun.counts).toMatchObject({ 'registered-existing': 1, copied: 1, failed: 0 });
    expect([...r.registry.keys()].sort()).toEqual(['videos/a.mp4', 'videos/b.mp4']);
  });

  it('killed during the R2 write: no registry row, the re-run copies normally', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaaa' } });
    r.hooks.r2Put = () => { throw new CopyInterrupted(); };
    await expect(runCopy(r.deps, EXEC)).rejects.toBeInstanceOf(CopyInterrupted);
    expect(r.registry.size).toBe(0);
    r.hooks.r2Put = undefined;
    expect((await runCopy(r.deps, EXEC)).counts.copied).toBe(1);
  });

  it('a stop request (Ctrl-C) finishes the current file and does not start the next', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa', 'videos/b.mp4': 'bbb', 'videos/c.mp4': 'ccc' } });
    let stop = false;
    r.hooks.register = () => { stop = true; };
    const report = await runCopy({ ...r.deps, shouldStop: () => stop }, EXEC);
    expect(report.stoppedEarly).toBe(true);
    expect(report.counts.copied).toBe(1);
    expect([...r.registry.keys()]).toEqual(['videos/a.mp4']);
  });

  it('running twice in a row copies each file once', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa', 'videos/b.mp4': 'bbb' } });
    await runCopy(r.deps, EXEC);
    const puts = r.calls.filter((c) => c.startsWith('r2.put')).length;
    const second = await runCopy(r.deps, EXEC);
    expect(second.counts['skipped-registered']).toBe(2);
    expect(r.calls.filter((c) => c.startsWith('r2.put')).length).toBe(puts);
  });
});

describe('--bucket, --prefix, --limit', () => {
  const many = { 'videos/screen-1/a.mp4': 'a', 'videos/screen-1/b.mp4': 'b', 'videos/screen-2/c.mp4': 'c', 'uploads/u/p.png': 'p' };

  it('prefix selects only matching keys', async () => {
    const r = rig({ sb: many });
    const report = await runCopy(r.deps, { ...EXEC, prefix: 'screen-1/' });
    expect(report.results.map((x) => x.key)).toEqual(['screen-1/a.mp4', 'screen-1/b.mp4']);
  });

  it('limit counts files that need work, in order, and skips registered files without using the limit', async () => {
    const r = rig({ sb: many, r2: { 'videos/screen-1/a.mp4': 'a' }, registry: { 'videos/screen-1/a.mp4': 'r2' } });
    const report = await runCopy(r.deps, { ...EXEC, limit: 1 });
    expect(report.counts).toMatchObject({ copied: 1, 'skipped-registered': 1 });
    expect([...r.registry.keys()].sort()).toEqual(['videos/screen-1/a.mp4', 'videos/screen-1/b.mp4']);
    expect(r.r2.size).toBe(2);
  });

  it('limit also bounds a dry run', async () => {
    const r = rig({ sb: many });
    const report = await runCopy(r.deps, { ...DRY, limit: 2 });
    expect(report.counts['would-copy']).toBe(2);
  });

  it('bucket selects which logical buckets are walked', async () => {
    const r = rig({ sb: many });
    const report = await runCopy(r.deps, { ...EXEC, buckets: ['uploads'] });
    expect(report.results.map((x) => `${x.bucket}/${x.key}`)).toEqual(['uploads/u/p.png']);
  });
});

describe('listSupabaseObjects', () => {
  const tree: Record<string, { name: string; id: string | null; metadata?: { size: number; mimetype: string } }[]> = {
    '': [{ name: 'screen-1', id: null }, { name: 'top.mp4', id: 'x', metadata: { size: 5, mimetype: 'video/mp4' } }],
    'screen-1': [{ name: 'a.mp4', id: 'y', metadata: { size: 3, mimetype: 'video/mp4' } }, { name: 'deep', id: null }],
    'screen-1/deep': [{ name: 'z.mp4', id: 'z', metadata: { size: 1, mimetype: 'video/mp4' } }],
  };
  const client: SupabaseListClient & { dirs: string[] } = {
    dirs: [],
    storage: { from() { return { async list(dir: string, o: { limit: number; offset: number }) { client.dirs.push(dir); return { data: (tree[dir] ?? []).slice(o.offset, o.offset + o.limit), error: null }; } }; } },
  };

  it('walks folders recursively and returns size and type', async () => {
    const out: SourceObject[] = [];
    for await (const o of listSupabaseObjects(client, 'videos')) out.push(o);
    expect(out.map((o) => o.key)).toEqual(['screen-1/a.mp4', 'screen-1/deep/z.mp4', 'top.mp4']);
    expect(out[0]).toEqual({ key: 'screen-1/a.mp4', size: 3, contentType: 'video/mp4' });
  });

  it('starts at the prefix folder instead of listing the whole bucket', async () => {
    client.dirs.length = 0;
    const out: string[] = [];
    for await (const o of listSupabaseObjects(client, 'videos', 'screen-1/')) out.push(o.key);
    expect(out).toEqual(['screen-1/a.mp4', 'screen-1/deep/z.mp4']);
    expect(client.dirs).not.toContain('');
  });

  it('turns a listing error into an error rather than an empty bucket', async () => {
    const bad: SupabaseListClient = { storage: { from: () => ({ list: async () => ({ data: null, error: { message: 'boom' } }) }) } };
    await expect((async () => { for await (const _ of listSupabaseObjects(bad, 'videos')) { /* drain */ } })()).rejects.toThrow('boom');
  });
});

describe('listSupabaseObjects pagination', () => {
  const all = Array.from({ length: 2500 }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}.mp4`, id: `id${i}`, metadata: { size: 1, mimetype: 'video/mp4' } }));
  const pagedClient = (serverCap: number): SupabaseListClient => ({
    storage: { from: () => ({ async list(_dir: string, o: { limit: number; offset: number }) {
      return { data: all.slice(o.offset, o.offset + Math.min(o.limit, serverCap)), error: null };
    } }) },
  });
  const drain = async (c: SupabaseListClient) => { const keys: string[] = []; for await (const o of listSupabaseObjects(c, 'videos')) keys.push(o.key); return keys; };

  it('returns every object across several pages (2500 objects, 1000 per page)', async () => {
    const keys = await drain(pagedClient(1000));
    expect(keys.length).toBe(2500);
    expect(new Set(keys).size).toBe(2500);
  });

  it('still returns everything if the server returns fewer rows than asked for (cap of 100 per page)', async () => {
    expect((await drain(pagedClient(100))).length).toBe(2500);
  });

  it('handles folders and files interleaved in one name-ordered sequence, paged by offset (the deployed storage.search order)', async () => {
    // storage.search merges folders (common prefixes) and files in one lower-cased name order and applies the offset to that
    // merged sequence; it is NOT "all folders first". Page size 2 forces folder/file boundaries to straddle pages.
    const merged = [
      { name: 'a.png', id: 'i1', metadata: { size: 1, mimetype: 'image/png' } },
      { name: 'b-folder', id: null },
      { name: 'c.png', id: 'i2', metadata: { size: 1, mimetype: 'image/png' } },
      { name: 'd-folder', id: null },
      { name: 'e-folder', id: null },
      { name: 'f.png', id: 'i3', metadata: { size: 1, mimetype: 'image/png' } },
    ];
    const inner: Record<string, typeof merged> = { 'b-folder': [{ name: 'x.png', id: 'j1', metadata: { size: 1, mimetype: 'image/png' } }], 'd-folder': [{ name: 'y.png', id: 'j2', metadata: { size: 1, mimetype: 'image/png' } }], 'e-folder': [] };
    const client: SupabaseListClient = { storage: { from: () => ({ async list(dir: string, o: { offset: number; limit: number }) {
      const rows = dir === '' ? merged : inner[dir] ?? [];
      return { data: rows.slice(o.offset, o.offset + Math.min(o.limit, 2)), error: null };
    } }) } };
    expect((await drain(client)).sort()).toEqual(['a.png', 'b-folder/x.png', 'c.png', 'd-folder/y.png', 'f.png']);
  });

  it('does not stop at an exactly-full final page', async () => {
    const exact = { storage: { from: () => ({ async list(_d: string, o: { limit: number; offset: number }) { return { data: all.slice(0, 1000).slice(o.offset, o.offset + o.limit), error: null }; } }) } } as SupabaseListClient;
    expect((await drain(exact)).length).toBe(1000);
  });

  it('the run report states how many objects and bytes were listed per bucket, for an independent count', async () => {
    const r = rig({ sb: { 'videos/a.mp4': 'aaa', 'videos/b.mp4': 'bbbb', 'uploads/p.png': 'pp' } });
    const report = await runCopy(r.deps, { ...DRY, buckets: ['videos', 'uploads'] });
    expect(report.listed).toEqual({ videos: { objects: 2, bytes: 7 }, uploads: { objects: 1, bytes: 2 } });
  });
});

describe('command line', () => {
  it('is a dry run unless --execute is given, and --verify-registered never implies --execute', () => {
    expect(parseArgs([]).execute).toBe(false);
    expect(parseArgs(['--verify-registered'])).toMatchObject({ verifyRegistered: true, execute: false });
    expect(parseArgs([]).verifyRegistered).toBe(false);
    expect(parseArgs(['--bucket', 'videos', '--limit', '1']).execute).toBe(false);
    expect(parseArgs(['--execute']).execute).toBe(true);
  });
  it('parses bucket, prefix and limit', () => {
    expect(parseArgs(['--bucket', 'uploads', '--prefix', 'abc/', '--limit', '5'])).toMatchObject({ buckets: ['uploads'], prefix: 'abc/', limit: 5 });
    expect(parseArgs([]).buckets).toEqual(['videos', 'uploads']);
  });
  it('rejects bad input instead of guessing', () => {
    expect(() => parseArgs(['--bucket', 'other'])).toThrow();
    expect(() => parseArgs(['--limit', '0'])).toThrow();
    expect(() => parseArgs(['--limit', '1.5'])).toThrow();
    expect(() => parseArgs(['--limit'])).toThrow();
    expect(() => parseArgs(['--prefix', '--execute'])).toThrow();
    expect(() => parseArgs(['--run'])).toThrow(/Unknown argument/);
  });
});
