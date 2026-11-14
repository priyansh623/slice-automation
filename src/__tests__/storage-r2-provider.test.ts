import { describe, it, expect } from 'vitest';
import { R2Provider, r2ConfigFromEnv, type R2Config } from '@/lib/object-store/r2-provider';
import { ObjectExistsError, ObjectNotFoundError } from '@/lib/object-store';

const config: R2Config = { accountId: 'acct123', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'super-secret-value', buckets: { videos: 'soma-videos', uploads: 'soma-uploads' } };

function fakeClient(handler: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = { send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => { sent.push({ name: cmd.constructor.name, input: cmd.input }); return handler(cmd); } };
  return { client: client as never, sent };
}
const httpError = (status: number, name = 'Error') => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('r2ConfigFromEnv', () => {
  it('is off unless every variable is set', () => {
    expect(r2ConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(r2ConfigFromEnv({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET_VIDEOS: 'v' } as never)).toBeNull();
    expect(r2ConfigFromEnv({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET_VIDEOS: 'v', R2_BUCKET_UPLOADS: 'u' } as never)).toMatchObject({ buckets: { videos: 'v', uploads: 'u' } });
  });
});

describe('R2Provider', () => {
  it('creates objects only if absent, with the real content type and length', async () => {
    const { client, sent } = fakeClient(() => ({}));
    await new R2Provider(config, client).put('videos', 'screen-1/a.mp4', Buffer.from('abc'), { contentType: 'video/webm' });
    expect(sent[0]).toMatchObject({ name: 'PutObjectCommand', input: { Bucket: 'soma-videos', Key: 'screen-1/a.mp4', ContentType: 'video/webm', ContentLength: 3, IfNoneMatch: '*' } });
  });

  it('overwrites only when asked to', async () => {
    const { client, sent } = fakeClient(() => ({}));
    await new R2Provider(config, client).put('uploads', 'k', Buffer.from('a'), { contentType: 'image/png', upsert: true });
    expect(sent[0].input).not.toHaveProperty('IfNoneMatch');
  });

  it('turns a precondition failure into ObjectExistsError and other failures into clear errors', async () => {
    await expect(new R2Provider(config, fakeClient(() => { throw httpError(412, 'PreconditionFailed'); }).client).put('videos', 'k', Buffer.from('a'), { contentType: 'video/mp4' })).rejects.toBeInstanceOf(ObjectExistsError);
    await expect(new R2Provider(config, fakeClient(() => { throw httpError(500, 'InternalError'); }).client).put('videos', 'k', Buffer.from('a'), { contentType: 'video/mp4' })).rejects.toThrow(/Failed to upload videos\/k to R2/);
  });

  it('reads back the bytes, and reports missing objects distinctly', async () => {
    const ok = new R2Provider(config, fakeClient(() => ({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } })).client);
    expect([...(await ok.download('videos', 'k'))]).toEqual([1, 2, 3]);
    const missing = new R2Provider(config, fakeClient(() => { throw httpError(404, 'NoSuchKey'); }).client);
    await expect(missing.download('videos', 'k')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('head returns size, type and ETag, or null when absent', async () => {
    const p = new R2Provider(config, fakeClient(() => ({ ContentLength: 42, ContentType: 'video/mp4', ETag: '"abc"' })).client);
    expect(await p.head('videos', 'k')).toEqual({ size: 42, contentType: 'video/mp4', etag: 'abc' });
    expect(await new R2Provider(config, fakeClient(() => { throw httpError(404, 'NotFound'); }).client).head('videos', 'k')).toBeNull();
  });

  it('presigns reads locally: right host, bucket, key, expiry, and no secret in the URL', async () => {
    const p = new R2Provider(config);
    const url = (await p.signedReadUrl('videos', 'screen-1/a b.mp4', 3600))!;
    const u = new URL(url);
    expect(u.host).toBe('soma-videos.acct123.r2.cloudflarestorage.com'); // virtual-hosted style bucket
    expect(u.pathname).toContain('screen-1/a%20b.mp4');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url).not.toContain('super-secret-value');
  });

  it('presigns uploads with the content type signed, so only that type can be sent', async () => {
    const up = await new R2Provider(config).signedUpload('uploads', 'user/pic.png', 'image/png', 900);
    const u = new URL(up.url);
    expect(up).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' } });
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(up.url).not.toContain('super-secret-value');
  });

  it('presigns many keys', async () => {
    const m = await new R2Provider(config).signedReadUrls('uploads', ['a.png', 'b.png'], 60);
    expect([...m.keys()]).toEqual(['a.png', 'b.png']);
  });
});

describe('R2Provider.ping', () => {
  it('checks both buckets, reports each, and never returns the credentials', async () => {
    const calls: string[] = [];
    const { client } = fakeClient((cmd) => {
      calls.push(`${cmd.constructor.name} ${(cmd.input as { Bucket: string }).Bucket}`);
      if ((cmd.input as { Bucket: string }).Bucket === 'soma-uploads') throw httpError(403, `AccessDenied for ${config.accessKeyId} using ${config.secretAccessKey}`);
      return {};
    });
    const res = await new R2Provider(config, client).ping();
    expect(calls.sort()).toEqual(['HeadBucketCommand soma-uploads', 'HeadBucketCommand soma-videos']);
    expect(res.find((r) => r.bucket === 'videos')).toMatchObject({ ok: true });
    const failed = res.find((r) => r.bucket === 'uploads')!;
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('super-secret-value');
    expect(JSON.stringify(res)).not.toContain('AKIDEXAMPLE');
  });
});

describe('R2Provider.signedSizedUpload (browser-direct uploads)', () => {
  it('signs the content type AND the exact length, never includes the secret, and expires', async () => {
    const up = await new R2Provider(config).signedSizedUpload('uploads', 'u/broll/a.mp4', 'video/mp4', 12_345_678, 900);
    const u = new URL(up.url);
    expect(u.host).toBe('soma-uploads.acct123.r2.cloudflarestorage.com');
    expect(u.pathname).toBe('/u/broll/a.mp4');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(up.method).toBe('PUT');
    expect(up.headers).toEqual({ 'Content-Type': 'video/mp4' });
    expect(up.url).not.toContain('super-secret-value');
  });

  it('a different size gives a different signature, so a larger file cannot reuse the URL', async () => {
    const r2 = new R2Provider(config);
    const a = new URL((await r2.signedSizedUpload('uploads', 'k.mp4', 'video/mp4', 1000, 900)).url).searchParams.get('X-Amz-Signature');
    const b = new URL((await r2.signedSizedUpload('uploads', 'k.mp4', 'video/mp4', 2000, 900)).url).searchParams.get('X-Amz-Signature');
    expect(a).not.toBe(b);
  });
});

describe('R2Provider.hashObject (streaming checksum for any file size)', () => {
  const { Readable } = require('node:stream') as typeof import('node:stream');
  const { createHash } = require('node:crypto') as typeof import('node:crypto');

  /** A body that produces `total` bytes lazily, one 1 MiB chunk at a time, and the digest of everything it produced. */
  function lazyBody(total: number) {
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const hash = createHash('sha256');
    let sent = 0;
    const stream = Readable.from((async function* () {
      while (sent < total) { const n = Math.min(chunk.length, total - sent); const piece = chunk.subarray(0, n); hash.update(piece); sent += n; yield piece; }
    })());
    return { stream, digest: () => hash.copy().digest('hex'), produced: () => sent };
  }

  it('hashes small and large objects correctly: 2 MB, just above 64 MB, and the full 500 MB limit', async () => {
    for (const size of [2 * 1024 * 1024, 64 * 1024 * 1024 + 1, 500 * 1024 * 1024]) {
      const body = lazyBody(size);
      const { client } = fakeClient(() => ({ Body: body.stream }));
      const res = await new R2Provider(config, client).hashObject('uploads', 'k.mp4');
      expect(res.size).toBe(size);
      expect(res.sha256).toBe(body.digest());
    }
  }, 120_000);

  it('uses constant memory: hashing 500 MB does not grow the heap or buffers by anything like the file size', async () => {
    if (global.gc) global.gc();
    const before = process.memoryUsage();
    const body = lazyBody(500 * 1024 * 1024);
    const { client } = fakeClient(() => ({ Body: body.stream }));
    await new R2Provider(config, client).hashObject('uploads', 'k.mp4');
    const after = process.memoryUsage();
    expect(after.heapUsed - before.heapUsed).toBeLessThan(120 * 1024 * 1024);
    expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(120 * 1024 * 1024);
  }, 120_000);

  it('reports a missing object, and a read error, without a partial result', async () => {
    await expect(new R2Provider(config, fakeClient(() => { throw httpError(404, 'NoSuchKey'); }).client).hashObject('uploads', 'k')).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(new R2Provider(config, fakeClient(() => { throw httpError(500, 'InternalError'); }).client).hashObject('uploads', 'k')).rejects.toThrow(/Failed to read uploads\/k from R2/);
    await expect(new R2Provider(config, fakeClient(() => ({})).client).hashObject('uploads', 'k')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('a stream that fails midway is an error, never a digest of the partial data', async () => {
    const broken = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('connection reset'); })());
    await expect(new R2Provider(config, fakeClient(() => ({ Body: broken })).client).hashObject('uploads', 'k')).rejects.toThrow('connection reset');
  });

  it('Storage.hashFromR2 gives up with HashTimeoutError when the read is too slow, and aborts the transfer', async () => {
    const { Storage } = await import('@/lib/object-store');
    let aborted = false;
    const slow = { name: 'r2', hashObject: (_b: string, _k: string, signal: AbortSignal) => new Promise((_res, rej) => signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); })) };
    const storage = new Storage({ supabase: {} as never, r2: slow as never, locate: async () => new Map(), register: async () => {}, writeProvider: () => 'r2', failover: () => true });
    await expect(storage.hashFromR2('uploads', 'k', 30)).rejects.toMatchObject({ name: 'HashTimeoutError' });
    expect(aborted).toBe(true);
    const none = new Storage({ supabase: {} as never, r2: null, locate: async () => new Map(), register: async () => {}, writeProvider: () => 'r2', failover: () => true });
    await expect(none.hashFromR2('uploads', 'k')).rejects.toThrow('R2 is not configured');
  });
});
