/**
 * A local HTTP server that behaves like the Higgsfield API as documented (docs.higgsfield.ai): Key auth, upload urls with
 * upload_headers, model endpoints, Idempotency-Key (replay returns the ORIGINAL request; the same key with a different body is a 422),
 * request status, result files. It records every call. Nothing leaves the machine and nothing is paid for.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { makeMockVideo } from '@/lib/overlays/mock-clip-provider';

/** A recognisable 1504x2752 picture: red frame at the very edge, grid, a circle (so stretching and cropping are visible), and corner labels. */
export async function testPattern(w: number, h: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b5876"/><stop offset="1" stop-color="#c0843c"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    ${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${(i + 1) * h / 13}" x2="${w}" y2="${(i + 1) * h / 13}" stroke="#ffffff55" stroke-width="3"/>`).join('')}
    ${Array.from({ length: 6 }, (_, i) => `<line x1="${(i + 1) * w / 7}" y1="0" x2="${(i + 1) * w / 7}" y2="${h}" stroke="#ffffff55" stroke-width="3"/>`).join('')}
    <circle cx="${w / 2}" cy="${h / 2}" r="${w * 0.3}" fill="none" stroke="#fff" stroke-width="14"/>
    <rect x="4" y="4" width="${w - 8}" height="${h - 8}" fill="none" stroke="#e11d48" stroke-width="8"/>
    <text x="40" y="110" font-size="90" fill="#fff" font-family="sans-serif">TOP-LEFT</text>
    <text x="${w - 40}" y="${h - 40}" font-size="90" fill="#fff" text-anchor="end" font-family="sans-serif">BOTTOM-RIGHT ${w}x${h}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export interface Call { method: string; path: string; auth?: string; idem?: string; body: string; headers: http.IncomingHttpHeaders }
interface Req { id: string; endpoint: string; body: Record<string, unknown>; polls: number; status: string; error?: string }

export class FakeHiggsfield {
  server!: http.Server; base = '';
  calls: Call[] = [];
  uploads = new Map<string, Buffer>();           // public path -> bytes
  requests = new Map<string, Req>();             // request_id -> request
  private byKey = new Map<string, { body: string; id: string }>();
  /** Polls that answer in_progress before completing. */
  pollsBeforeDone = 1;
  /** Scripted behaviour for the next model submissions: 'ok' | '429' | '503' | 'hang' | '403' | '422' | 'lose' (accepted, answer lost). */
  submitScript: string[] = [];
  /** Final status for new requests. */
  finalStatus: 'completed' | 'failed' | 'nsfw' | 'canceled' = 'completed';
  retryAfter = 7;
  /** Make DELETE /requests/{id} fail with this status (to prove cleanup never affects a job). */
  deleteStatus = 200;
  deleted = new Set<string>();
  private n = 0;

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks)));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop() { this.server.close(); }
  reset() { this.deleteStatus = 200; this.deleted.clear(); this.calls = []; this.uploads.clear(); this.requests.clear(); this.byKey.clear(); this.submitScript = []; this.finalStatus = 'completed'; this.pollsBeforeDone = 1; }
  submits(endpoint?: string) { return this.calls.filter((c) => c.method === 'POST' && !c.path.startsWith('/files') && !c.path.startsWith('/requests') && (!endpoint || c.path === `/${endpoint}`)); }

  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer) {
    const path = req.url!.split('?')[0];
    const call: Call = { method: req.method!, path, auth: req.headers.authorization, idem: req.headers['idempotency-key'] as string | undefined, body: raw.toString(), headers: req.headers };
    this.calls.push(call);
    // presigned storage and CDN: no API credentials
    if (req.method === 'PUT' && path.startsWith('/storage/')) { this.uploads.set(path.replace('/storage', '/public'), raw); res.writeHead(200); res.end(); return; }
    if (req.method === 'GET' && path.startsWith('/public/')) { const b = this.uploads.get(path); if (!b) { res.writeHead(404); res.end(); return; } res.writeHead(200); res.end(b); return; }
    if (req.method === 'GET' && path.startsWith('/cdn/')) {
      const out = path.endsWith('.mp4') ? makeMockVideo(5) : await testPattern(1504, 2752);
      res.writeHead(200, { 'content-type': path.endsWith('.mp4') ? 'video/mp4' : 'image/png' }); res.end(out); return;
    }
    if (!/^Key [^:]+:.+/.test(call.auth ?? '')) return this.json(res, 401, { detail: 'Invalid credentials' });

    if (path === '/files/generate-upload-url' && req.method === 'POST') {
      const ct = JSON.parse(call.body).content_type as string; const id = `f${++this.n}`;
      return this.json(res, 200, { public_url: `${this.base}/public/${id}`, upload_url: `${this.base}/storage/${id}`, content_type: ct, upload_headers: { 'Content-Type': ct, 'x-amz-tagging': 'retention=temporary' } });
    }
    const del = /^\/requests\/([^/]+)$/.exec(path);
    if (del && req.method === 'DELETE') {
      if (this.deleteStatus !== 200) return this.json(res, this.deleteStatus, { detail: 'nope' });
      if (!this.requests.has(del[1])) return this.json(res, 404, { detail: 'Not found' });
      this.deleted.add(del[1]); return this.json(res, 200, { request_id: del[1], status: 'deleted' });
    }
    const status = /^\/requests\/([^/]+)\/status$/.exec(path);
    if (status && req.method === 'GET') {
      const r = this.requests.get(status[1]); if (!r) return this.json(res, 404, { detail: 'Not found' });
      r.polls += 1;
      if (r.polls <= this.pollsBeforeDone) return this.json(res, 200, { status: r.polls === 1 ? 'queued' : 'in_progress', request_id: r.id });
      if (this.finalStatus === 'failed') return this.json(res, 200, { status: 'failed', request_id: r.id, error: 'Generation failed' });
      if (this.finalStatus !== 'completed') return this.json(res, 200, { status: this.finalStatus, request_id: r.id });
      const video = r.endpoint.startsWith('kling');
      return this.json(res, 200, { status: 'completed', request_id: r.id, expires_at: '2099-01-01T00:00:00.000Z', ...(video ? { video: { url: `${this.base}/cdn/${r.id}.mp4` } } : { images: [{ url: `${this.base}/cdn/${r.id}.png` }] }) });
    }
    if (req.method === 'POST' && /^\/(xai|kling-video)\//.test(path)) {
      const step = this.submitScript.shift() ?? 'ok';
      if (step === 'hang') return;                                   // never answers: the caller times out
      if (step === '429') return this.json(res, 429, { detail: { code: 'account_queue_full', message: 'Too many queued generations for this account', retryable: true, limit: 40, retry_after_seconds: this.retryAfter } }, { 'retry-after': String(this.retryAfter) });
      if (step === '423') return this.json(res, 423, { detail: 'Model is temporarily blocked' });
      if (step === '503') return this.json(res, 503, { detail: { code: 'admission_control_unavailable', retryable: true } });
      if (step === '403') return this.json(res, 403, { detail: 'Insufficient balance' });
      if (step === '422') return this.json(res, 422, { detail: 'bad param' });
      const key = call.idem;
      if (key) {
        const seen = this.byKey.get(key);
        if (seen) {
          if (seen.body !== call.body) return this.json(res, 422, { detail: 'Idempotency-Key was already used with different request parameters' });
          return this.json(res, 200, { status: 'queued', request_id: seen.id, status_url: `${this.base}/requests/${seen.id}/status`, cancel_url: `${this.base}/requests/${seen.id}/cancel`, expires_after: 604800 });
        }
      }
      const id = `req-${++this.n}`;
      this.requests.set(id, { id, endpoint: path.slice(1), body: JSON.parse(call.body), polls: 0, status: 'queued' });
      if (key) this.byKey.set(key, { body: call.body, id });
      if (step === 'lose') { req.socket.destroy(); return; }      // the request WAS accepted and recorded, but the answer never arrives
      return this.json(res, 200, { status: 'queued', request_id: id, status_url: `${this.base}/requests/${id}/status`, cancel_url: `${this.base}/requests/${id}/cancel`, expires_after: 604800 });
    }
    return this.json(res, 404, { detail: 'not found' });
  }
}
