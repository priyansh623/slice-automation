/**
 * The Higgsfield client and the Kling 3.0 Standard provider against a FAKE HTTP server that follows the public documentation
 * (paths, Key auth header, Idempotency-Key, statuses, error codes). Nothing here reaches Higgsfield and nothing is paid for: this
 * proves our side of the contract, not the live service.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HiggsfieldClient, HiggsfieldError, HiggsfieldUnknownError, configFromEnv, higgsfieldConfigured, parseCredentials } from '@/lib/higgsfield/client';
import { ClipProviderError, HiggsfieldKlingProvider, KLING_STANDARD_ENDPOINT } from '@/lib/overlays/clip-provider';

interface Seen { method: string; url: string; auth?: string; idem?: string; body: string }
let server: http.Server; let base: string; let seen: Seen[];
let script: (req: Seen) => { status: number; body?: unknown; headers?: Record<string, string>; hang?: boolean } | undefined;
const VIDEO = Buffer.from('fake-mp4-bytes');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const s: Seen = { method: req.method!, url: req.url!, auth: req.headers.authorization, idem: req.headers['idempotency-key'] as string | undefined, body: Buffer.concat(chunks).toString() };
      seen.push(s);
      if (s.url === '/upload-here' && s.method === 'PUT') { res.writeHead(200); res.end(); return; }
      if (s.url === '/files/public/img.png') { res.writeHead(200); res.end(); return; }
      if (s.url === '/result.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(VIDEO); return; }
      const r = script(s);
      if (r?.hang) return;
      const out = r ?? { status: 404, body: { detail: 'not scripted' } };
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { seen = []; script = () => undefined; });

const client = (over: Partial<ReturnType<typeof configFromEnv>> = {}) => new HiggsfieldClient({ ...configFromEnv({ HF_CREDENTIALS: 'kid:ksecret', HIGGSFIELD_BASE_URL: base } as unknown as NodeJS.ProcessEnv), ...over });
const input = { idempotencyKey: 'cbroll-1-1', image: Buffer.from('png-bytes'), imageMime: 'image/png', prompt: 'She turns and smiles', durationSeconds: 5 };

describe('credentials', () => {
  it('reads KEY_ID:KEY_SECRET and refuses anything else', () => {
    expect(parseCredentials('abc:def')).toEqual({ keyId: 'abc', keySecret: 'def' });
    expect(parseCredentials('abc:def:ghi')).toEqual({ keyId: 'abc', keySecret: 'def:ghi' });
    for (const bad of [undefined, '', 'nocolon', ':secret', 'id:']) expect(parseCredentials(bad)).toBeNull();
    expect(higgsfieldConfigured({ HF_CREDENTIALS: 'a:b' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(() => configFromEnv({} as unknown as NodeJS.ProcessEnv)).toThrow(/HF_CREDENTIALS/);
  });
});

describe('Kling 3.0 Standard submit and poll', () => {
  it('uploads the image, submits ONLY the documented parameters with sound off, and sends the credentials and idempotency key', async () => {
    script = (r) => {
      if (r.url === '/files/generate-upload-url') return { status: 200, body: { upload_url: `${base}/upload-here`, public_url: `${base}/files/public/img.png`, upload_headers: { 'Content-Type': 'image/png', 'x-amz-tagging': 'retention=temporary' } } };
      if (r.url === `/${KLING_STANDARD_ENDPOINT}`) return { status: 200, body: { request_id: 'req-1', status_url: `${base}/requests/req-1/status` } };
    };
    const p = new HiggsfieldKlingProvider(client());
    expect(p.model).toBe('kling-video/v3.0/std/image-to-video');
    expect(p.model).not.toMatch(/turbo/);
    expect(await p.submit(input)).toEqual({ providerRequestId: 'req-1' });
    const sub = seen.find((s) => s.url === `/${KLING_STANDARD_ENDPOINT}`)!;
    expect(sub.method).toBe('POST'); expect(sub.auth).toBe('Key kid:ksecret'); expect(sub.idem).toBe('cbroll-1-1');
    expect(JSON.parse(sub.body)).toEqual({ image_url: `${base}/files/public/img.png`, prompt: 'She turns and smiles', duration: 5, sound: 'off' });
    expect(seen.some((s) => s.url === '/upload-here' && s.method === 'PUT')).toBe(true);
  });

  it('maps statuses: processing while queued or in progress; downloads the file straight away when completed', async () => {
    const p = new HiggsfieldKlingProvider(client());
    for (const status of ['queued', 'in_progress']) { script = () => ({ status: 200, body: { status } }); expect(await p.poll('req-1')).toEqual({ status: 'processing' }); }
    script = () => ({ status: 200, body: { status: 'completed', video: { url: `${base}/result.mp4` } } });
    const done = await p.poll('req-1');
    expect(done).toMatchObject({ status: 'succeeded', mime: 'video/mp4' });
    expect((done as { video: Buffer }).video.equals(VIDEO)).toBe(true);
    script = () => ({ status: 200, body: { status: 'completed', images: [{ url: `${base}/result.mp4` }] } });
    expect((await p.poll('req-1')).status).toBe('succeeded');   // images[0].url is the documented shape for image models
  });

  it('reports failed, nsfw and canceled as not charged, and a completed job with no file as a failure', async () => {
    const p = new HiggsfieldKlingProvider(client());
    script = () => ({ status: 200, body: { status: 'nsfw' } });
    expect(await p.poll('r')).toMatchObject({ status: 'failed', code: 'nsfw', retryable: false });
    script = () => ({ status: 200, body: { status: 'failed', error: 'model error' } });
    expect(await p.poll('r')).toMatchObject({ status: 'failed', message: expect.stringContaining('model error') });
    script = () => ({ status: 200, body: { status: 'canceled' } });
    expect(await p.poll('r')).toMatchObject({ status: 'failed', code: 'canceled' });
    script = () => ({ status: 200, body: { status: 'completed' } });
    expect(await p.poll('r')).toMatchObject({ status: 'failed', code: 'no_result' });
    script = () => ({ status: 200, body: { status: 'weird' } });
    await expect(p.poll('r')).rejects.toBeInstanceOf(ClipProviderError);
  });
});

describe('what we do and do not guarantee', () => {
  it('neither provider claims idempotent submits: a lost answer is for a person, not for an automatic resend', async () => {
    const { HiggsfieldGrokProvider } = await import('@/lib/studio/higgsfield-provider');
    const grok = new HiggsfieldGrokProvider(client());
    const kling = new HiggsfieldKlingProvider(client());
    expect(grok.idempotentSubmit).toBe(false); expect(kling.idempotentSubmit).toBe(false);
    expect(grok.ambiguousHint).toMatch(/charged twice/); expect(kling.ambiguousHint).toMatch(/charged twice/);
  });
  it('deleting a request: 200 and 404 are fine, anything else is reported to the (best-effort) caller', async () => {
    const c = client();
    script = () => ({ status: 200, body: { request_id: 'r', status: 'deleted' } });
    await expect(c.deleteRequest('r')).resolves.toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', url: '/requests/r', auth: 'Key kid:ksecret' });
    script = () => ({ status: 404, body: { detail: 'Not found' } });
    await expect(c.deleteRequest('r')).resolves.toBeUndefined();
    script = () => ({ status: 409, body: { detail: 'still running' } });
    await expect(c.deleteRequest('r')).rejects.toBeInstanceOf(HiggsfieldError);
  });
  it('423 (model temporarily blocked) is a clean, retryable rejection', async () => {
    script = (r) => (r.url === '/files/generate-upload-url' ? { status: 200, body: { upload_url: `${base}/upload-here`, public_url: `${base}/files/public/img.png`, upload_headers: {} } } : { status: 423, body: { detail: 'Model is temporarily blocked' } });
    await expect(new HiggsfieldKlingProvider(client()).submit(input)).rejects.toMatchObject({ code: 'model_blocked', retryable: true, outcome: 'rejected' });
  });
});

describe('errors', () => {
  const submitWith = (status: number, body: unknown, headers?: Record<string, string>) => {
    script = (r) => (r.url === '/files/generate-upload-url' ? { status: 200, body: { upload_url: `${base}/upload-here`, public_url: `${base}/files/public/img.png`, upload_headers: { 'Content-Type': 'image/png', 'x-amz-tagging': 'retention=temporary' } } } : { status, body, headers });
    return new HiggsfieldKlingProvider(client()).submit(input);
  };
  it('401, 403 (balance) and 422 are clean rejections: no job was created', async () => {
    await expect(submitWith(401, { detail: 'no' })).rejects.toMatchObject({ code: 'unauthorized', outcome: 'rejected', retryable: false });
    await expect(submitWith(403, { detail: 'Not enough credits' })).rejects.toMatchObject({ code: 'forbidden_or_balance', outcome: 'rejected', message: expect.stringContaining('balance') });
    await expect(submitWith(422, { detail: 'bad param' })).rejects.toMatchObject({ code: 'invalid_request', outcome: 'rejected' });
  });
  it('429 carries Retry-After and is retryable without having created a job', async () => {
    await expect(submitWith(429, { detail: 'account_queue_full' }, { 'retry-after': '12' })).rejects.toMatchObject({ code: 'rate_limited', retryable: true, outcome: 'rejected', retryAfterMs: 12_000 });
  });
  it('a 5xx or no answer on a SUBMIT is "unknown": a job may exist', async () => {
    await expect(submitWith(503, { detail: 'down' })).rejects.toMatchObject({ outcome: 'unknown' });
    script = (r) => (r.url === '/files/generate-upload-url' ? { status: 200, body: { upload_url: `${base}/upload-here`, public_url: `${base}/files/public/img.png`, upload_headers: { 'Content-Type': 'image/png', 'x-amz-tagging': 'retention=temporary' } } } : { status: 200, hang: true });
    const slow = new HiggsfieldKlingProvider(client({ timeoutMs: 150 }));
    await expect(slow.submit(input)).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it('a failed upload happens before anything is submitted, so it is a clean rejection', async () => {
    script = (r) => (r.url === '/files/generate-upload-url' ? { status: 500, body: {} } : undefined);
    await expect(new HiggsfieldKlingProvider(client()).submit(input)).rejects.toMatchObject({ outcome: 'rejected' });
    expect(seen.some((s) => s.url === `/${KLING_STANDARD_ENDPOINT}`)).toBe(false);
  });
  it('a 5xx on a status read is a retryable read error, not an unknown submission', async () => {
    script = () => ({ status: 502, body: {} });
    const err = await new HiggsfieldKlingProvider(client()).poll('r').catch((e) => e);
    expect(err).toBeInstanceOf(ClipProviderError); expect(err.retryable).toBe(true); expect(err.outcome).toBe('rejected');
  });
  it('error classes', () => { expect(new HiggsfieldUnknownError('x')).toBeInstanceOf(HiggsfieldError); });
});
