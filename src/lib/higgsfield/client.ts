/**
 * A thin client for the Higgsfield platform API (https://api.higgsfield.ai), as documented at docs.higgsfield.ai. It only does HTTP:
 * no business rules, no database. Credentials come from HF_CREDENTIALS ("KEY_ID:KEY_SECRET") and exist only in the worker's
 * environment; nothing here is ever sent to a browser or written to a log.
 *
 *   POST /files/generate-upload-url        presigned upload for an input image  -> { upload_url, public_url }
 *   POST /{model endpoint}                 submit a generation                  -> { request_id, status_url }   (Idempotency-Key header)
 *   GET  /requests/{request_id}/status     poll                                 -> { status, ... }
 *   POST /requests/{request_id}/cancel     only while queued
 *
 * Statuses: queued | in_progress | completed | failed | nsfw | canceled. Failed, nsfw and canceled jobs are not charged.
 * Errors are { detail }: 401 bad credentials, 403 insufficient balance, 422 invalid request, 429 account_queue_full (Retry-After), 5xx.
 *
 * FIELD NAMES: verified against docs.higgsfield.ai (concepts/file-uploads, concepts/requests, concepts/idempotency, concepts/rate-limits,
 * concepts/errors and the Grok Image 2.0 / Kling 3.0 model pages). NOT verified against the live service: no live call has been made.
 *   upload response    { public_url, upload_url, content_type, upload_headers }  (the PUT must send every header in upload_headers)
 *   submit response    { status, request_id, status_url, cancel_url, expires_after }
 *   completed result   images: [{ url }]  for image models, video: { url } for video models, plus expires_at
 *   failed             { status: "failed", error: string | null }
 *   429                detail { code: "account_queue_full", retryable, retry_after_seconds } and a Retry-After header
 *   Idempotency-Key    replay returns the ORIGINAL request_id; the same key with a different body is a 422
 */

export const HIGGSFIELD_BASE_URL = 'https://api.higgsfield.ai';

export class HiggsfieldError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string, public readonly retryable: boolean, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'HiggsfieldError';
  }
}
/** The request may or may not have reached Higgsfield (a timeout, a dropped connection, a 5xx on submit). */
export class HiggsfieldUnknownError extends HiggsfieldError {
  constructor(message: string) { super(message, 0, 'unknown', true); this.name = 'HiggsfieldUnknownError'; }
}

export interface HiggsfieldConfig { baseUrl: string; keyId: string; keySecret: string; fetchImpl: typeof fetch; timeoutMs: number }

export function higgsfieldConfigured(env: NodeJS.ProcessEnv = process.env): boolean { return parseCredentials(env.HF_CREDENTIALS) !== null; }
export function parseCredentials(raw: string | undefined): { keyId: string; keySecret: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(':');
  if (i <= 0 || i === raw.length - 1) return null;
  return { keyId: raw.slice(0, i).trim(), keySecret: raw.slice(i + 1).trim() };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): HiggsfieldConfig {
  const c = parseCredentials(env.HF_CREDENTIALS);
  if (!c) throw new HiggsfieldError('Higgsfield is not configured: set HF_CREDENTIALS on the worker.', 0, 'not_configured', false);
  return { baseUrl: (env.HIGGSFIELD_BASE_URL || HIGGSFIELD_BASE_URL).replace(/\/+$/, ''), ...c, fetchImpl, timeoutMs: Number(env.HIGGSFIELD_TIMEOUT_MS) || 30_000 };
}

/** After a result is safely in our own storage its copy at Higgsfield is deleted (HIGGSFIELD_DELETE_AFTER_STORE=off keeps it for the documented 7 days). */
export const deleteAfterStore = (env: NodeJS.ProcessEnv = process.env): boolean => (env.HIGGSFIELD_DELETE_AFTER_STORE ?? '').toLowerCase() !== 'off';

export type HiggsfieldStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';
export interface SubmitResponse { requestId: string; statusUrl: string | null }
export interface StatusResponse { status: HiggsfieldStatus; raw: Record<string, unknown> }

const KNOWN: readonly string[] = ['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled'];

export class HiggsfieldClient {
  constructor(private readonly cfg: HiggsfieldConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Key ${this.cfg.keyId}:${this.cfg.keySecret}`, 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
  }

  private async request(method: string, pathOrUrl: string, opts: { body?: unknown; headers?: Record<string, string>; mutating?: boolean } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.cfg.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.cfg.fetchImpl(url, { method, headers: this.headers(opts.headers), body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: ctl.signal });
    } catch (err) {
      // For a submit, "no answer" means the job may exist. For a read it is just a failed read.
      if (opts.mutating) throw new HiggsfieldUnknownError(`No answer from Higgsfield (${(err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message}).`);
      throw new HiggsfieldError(`Could not reach Higgsfield: ${(err as Error).message}`, 0, 'network', true);
    } finally { clearTimeout(timer); }
    let json: Record<string, unknown> = {};
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* an empty or non-JSON body */ }
    if (res.ok) return { status: res.status, json };
    const detail = typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail ?? json).slice(0, 300);
    if (res.status === 422 && /Idempotency-Key was already used/i.test(detail)) throw new HiggsfieldError('Higgsfield refused the request: its idempotency key was already used with different parameters.', 422, 'idempotency_conflict', false);
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
    if (res.status === 401) throw new HiggsfieldError('Higgsfield rejected the credentials (401). Check HF_CREDENTIALS on the worker.', 401, 'unauthorized', false);
    if (res.status === 403) throw new HiggsfieldError(`Higgsfield refused the request (403): ${detail}. This usually means the account balance is too low.`, 403, 'forbidden_or_balance', false);
    if (res.status === 422) throw new HiggsfieldError(`Higgsfield rejected the request as invalid: ${detail}`, 422, 'invalid_request', false);
    if (res.status === 423) throw new HiggsfieldError('Higgsfield has temporarily blocked this model. Try again later.', 423, 'model_blocked', true, retryAfterMs ?? 60_000);
    if (res.status === 429) {
      const d = (json.detail && typeof json.detail === 'object' ? json.detail : {}) as { message?: string; retry_after_seconds?: number };
      const fromBody = typeof d.retry_after_seconds === 'number' && d.retry_after_seconds > 0 ? d.retry_after_seconds * 1000 : undefined;
      throw new HiggsfieldError(`Higgsfield is busy (${d.message ?? detail}). Waiting before trying again.`, 429, 'rate_limited', true, retryAfterMs ?? fromBody ?? 30_000);
    }
    if (res.status >= 500) {
      if (opts.mutating) throw new HiggsfieldUnknownError(`Higgsfield answered ${res.status} to a submission; it may or may not have been accepted.`);
      throw new HiggsfieldError(`Higgsfield had a problem (${res.status}).`, res.status, 'server_error', true);
    }
    throw new HiggsfieldError(`Higgsfield answered ${res.status}: ${detail}`, res.status, 'http_error', false);
  }

  /** Uploads an input image and returns a public HTTPS URL a model can read. */
  async uploadImage(bytes: Buffer, contentType: string): Promise<string> {
    const { json } = await this.request('POST', '/files/generate-upload-url', { body: { content_type: contentType }, mutating: false });
    const up = readUpload(json);
    if (!up) throw new HiggsfieldError('Higgsfield did not return an upload address.', 0, 'bad_response', false);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), Math.max(this.cfg.timeoutMs, 60_000));
    try {
      // Every header Higgsfield lists must be sent, and no credentials (this is a presigned storage URL, not the API).
      const put = await this.cfg.fetchImpl(up.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType, ...up.uploadHeaders }, body: new Uint8Array(bytes), signal: ctl.signal });
      if (!put.ok) throw new HiggsfieldError(`Uploading the image to Higgsfield failed (${put.status}).`, put.status, 'upload_failed', true);
    } catch (err) {
      if (err instanceof HiggsfieldError) throw err;
      throw new HiggsfieldError(`Uploading the image to Higgsfield failed: ${(err as Error).message}`, 0, 'upload_failed', true);
    } finally { clearTimeout(timer); }
    return up.publicUrl;
  }

  /** Submits a generation. A failure that leaves the outcome open throws HiggsfieldUnknownError. */
  async submit(endpoint: string, body: Record<string, unknown>, idempotencyKey: string): Promise<SubmitResponse> {
    const { json } = await this.request('POST', `/${endpoint.replace(/^\/+/, '')}`, { body, headers: { 'Idempotency-Key': idempotencyKey }, mutating: true });
    const requestId = typeof json.request_id === 'string' ? json.request_id : typeof json.id === 'string' ? json.id : null;
    if (!requestId) throw new HiggsfieldUnknownError('Higgsfield accepted the request but returned no request id.');
    return { requestId, statusUrl: typeof json.status_url === 'string' ? json.status_url : null };
  }

  async status(requestId: string): Promise<StatusResponse> {
    const { json } = await this.request('GET', `/requests/${encodeURIComponent(requestId)}/status`);
    const status = String(json.status ?? '');
    if (!KNOWN.includes(status)) throw new HiggsfieldError(`Higgsfield reported an unknown status "${status}".`, 0, 'bad_response', true);
    return { status: status as HiggsfieldStatus, raw: json };
  }

  async cancel(requestId: string): Promise<void> {
    await this.request('POST', `/requests/${encodeURIComponent(requestId)}/cancel`, { mutating: false });
  }

  /**
   * DELETE /requests/{id}: removes what Higgsfield stored for the request (its input copies, its outputs, the prompt and parameters). It keeps
   * the request id, model, status, timestamps and billing records. Standalone uploads are "stored independently of a single request" and
   * are NOT covered (they are deleted by Higgsfield within seven days; there is no documented per-file delete). 404 = already gone.
   */
  async deleteRequest(requestId: string): Promise<void> {
    try { await this.request('DELETE', `/requests/${encodeURIComponent(requestId)}`); }
    catch (err) { if (err instanceof HiggsfieldError && err.status === 404) return; throw err; }
  }

  /** Downloads a result file by URL (results expire, so this is done as soon as a job completes). */
  async download(url: string): Promise<Buffer> {
    const res = await this.cfg.fetchImpl(url);
    if (!res.ok) throw new HiggsfieldError(`Downloading the result failed (${res.status}). The link may have expired.`, res.status, 'download_failed', res.status >= 500);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** The documented upload response: { public_url, upload_url, content_type, upload_headers }. */
export function readUpload(json: Record<string, unknown>): { uploadUrl: string; publicUrl: string; uploadHeaders: Record<string, string> } | null {
  const uploadUrl = typeof json.upload_url === 'string' ? json.upload_url : null;
  const publicUrl = typeof json.public_url === 'string' ? json.public_url : null;
  if (!uploadUrl || !publicUrl) return null;
  const uploadHeaders: Record<string, string> = {};
  if (json.upload_headers && typeof json.upload_headers === 'object') for (const [k, v] of Object.entries(json.upload_headers as Record<string, unknown>)) if (typeof v === 'string') uploadHeaders[k] = v;
  return { uploadUrl, publicUrl, uploadHeaders };
}

/** The result file URL of a completed request: `images[0].url` (image models) or `video.url` (video models), as documented. */
export function readResultUrl(raw: Record<string, unknown>): string | null {
  const url = (v: unknown): string | null => (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string' ? (v as { url: string }).url : null);
  const first = Array.isArray(raw.images) ? url(raw.images[0]) : null;
  return url(raw.video) ?? first;
}
