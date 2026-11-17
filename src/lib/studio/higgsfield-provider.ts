/**
 * Personalised image generation with Grok Imagine 2.0 through the Higgsfield platform API, as a Studio ReplacementProvider. The Studio
 * already owns the job lifecycle (queued -> submitting -> processing -> succeeded|failed, unknown submissions, restart recovery,
 * idempotent resends, storing the result in R2), so this class only translates one job into one Higgsfield request.
 *
 * Request (docs.higgsfield.ai/docs/models/grok-image-2/generate-and-edit):
 *   POST /xai/grok-imagine-image-2.0   { prompt, image_urls: [<scene>, <character>], resolution: "2k", aspect_ratio: "auto", quality: "medium" }
 *   image_urls are ORDERED public URLs: image 1 = the Scene Pack image, image 2 = the master character, matching the prompt below.
 *   Result (completed): images[0].url. Not documented: base64 input, reference size limits, a seed.
 *
 * Idempotency: Higgsfield replays the original request for the same Idempotency-Key, but refuses (422) the same key with a different
 * body. The input images are uploaded to Higgsfield first, which gives a NEW public URL each time, so the uploaded URLs are persisted
 * (studio_jobs.request) before submitting and reused on every resend of the same job.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { studioJobs } from '@/db/schema.pg';
import * as crypto from 'node:crypto';
import { HiggsfieldClient, HiggsfieldError, HiggsfieldUnknownError, deleteAfterStore, readResultUrl } from '../higgsfield/client';
import { ProviderError, type PollResult, type ReplacementInput, type ReplacementProvider, type SubmitResult } from './provider';

export const GROK_IMAGE_ENDPOINT = 'xai/grok-imagine-image-2.0';
/** The exact prompt used in the model evaluation. Not extended: no instructions about lighting, composition or quality. */
export const PERSONALISE_PROMPT = 'Image 1 is the master image.\nImage 2 is the master model.\nReplace the model in the master image with the master model.';
export const GROK_SETTINGS = { resolution: '2k', aspect_ratio: 'auto', quality: 'medium' } as const;

/** Where the uploaded input URLs of a job are remembered between sends. */
export interface UploadStore {
  get(jobId: number): Promise<string[] | null>;
  /** `audit` is what was prepared for this job, kept for the person who has to resolve an unknown outcome. */
  set(jobId: number, urls: string[], audit: { bodySha256: string; preparedAt: number }): Promise<void>;
}

/** Persists them on the Studio job itself (studio_jobs.request, an existing, otherwise unused column): no migration needed. */
export const dbUploadStore: UploadStore = {
  async get(jobId) {
    const [row] = await db.select({ request: studioJobs.request }).from(studioJobs).where(eq(studioJobs.id, jobId)).limit(1);
    const urls = (row?.request as { higgsfield?: { imageUrls?: unknown } } | null)?.higgsfield?.imageUrls;
    return Array.isArray(urls) && urls.length === 2 && urls.every((u) => typeof u === 'string') ? (urls as string[]) : null;
  },
  async set(jobId, urls, audit) {
    await db.update(studioJobs).set({ request: { higgsfield: { imageUrls: urls, endpoint: GROK_IMAGE_ENDPOINT, ...audit } } }).where(eq(studioJobs.id, jobId));
  },
};

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof HiggsfieldUnknownError) return new ProviderError(err.message, 'unknown', true, 'unknown');
  if (err instanceof HiggsfieldError) return new ProviderError(err.message, err.code, err.retryable, 'rejected', err.retryAfterMs);
  return new ProviderError((err as Error).message ?? 'Unexpected error', 'error', true, 'unknown');
}

export class HiggsfieldGrokProvider implements ReplacementProvider {
  readonly id = 'higgsfield';
  /**
   * FALSE on purpose. Higgsfield documents that the same Idempotency-Key returns the original request, but not how long a key is remembered
   * and offers no way to look a request up by key. So a lost answer is never repeated automatically: the job waits as "outcome unknown"
   * for a person, who is told what to check (see ambiguousHint). The key is still sent, which only ever helps.
   */
  readonly idempotentSubmit = false;
  readonly ambiguousHint = 'Check the Higgsfield generation history for an image made around this time before generating again; generating again could be charged twice.';
  constructor(private readonly client: HiggsfieldClient, private readonly uploads: UploadStore = dbUploadStore, private readonly endpoint: string = GROK_IMAGE_ENDPOINT) {}

  async submit(input: ReplacementInput): Promise<SubmitResult> {
    let urls = await this.uploads.get(input.jobId).catch(() => null);
    const bodyFor = (u: string[]) => ({ prompt: PERSONALISE_PROMPT, image_urls: u, ...GROK_SETTINGS });
    if (!urls) {
      try {
        // Order matters: image 1 is the scene, image 2 the character.
        const scene = await this.client.uploadImage(input.sourceImage, input.sourceMime);
        const character = await this.client.uploadImage(input.characterImage, input.characterMime);
        urls = [scene, character];
      } catch (err) { throw toProviderError(err); }   // an upload failure happens before anything is submitted: a clean rejection
      // Saved BEFORE anything is submitted: from here on every send of this job carries the identical body.
      await this.uploads.set(input.jobId, urls, { bodySha256: crypto.createHash('sha256').update(JSON.stringify(bodyFor(urls))).digest('hex'), preparedAt: Date.now() });
    }
    try {
      const res = await this.client.submit(this.endpoint, bodyFor(urls), input.idempotencyKey);
      return { kind: 'accepted', providerJobId: res.requestId };
    } catch (err) { throw toProviderError(err); }
  }

  async poll(requestId: string): Promise<PollResult> {
    let s;
    try { s = await this.client.status(requestId); } catch (err) { throw toProviderError(err); }
    if (s.status === 'queued' || s.status === 'in_progress') return { status: 'processing' };
    if (s.status === 'nsfw') return { status: 'failed', code: 'nsfw', message: 'Higgsfield blocked this image (content check). You are not charged. Try a different Scene Pack image.', retryable: false };
    if (s.status === 'canceled') return { status: 'failed', code: 'canceled', message: 'The image request was canceled. You are not charged.', retryable: true };
    if (s.status === 'failed') return { status: 'failed', code: 'failed', message: `${String(s.raw.error || 'Higgsfield could not make this image.').slice(0, 250)} You are not charged.`, retryable: true };
    const url = readResultUrl(s.raw);
    if (!url) return { status: 'failed', code: 'no_result', message: 'Higgsfield reported the image as complete but returned no file.', retryable: true };
    return { status: 'succeeded', output: { url, mime: 'image/png' } };   // the real type is read from the downloaded file
  }

  /** Removes Higgsfield's copy of the request (inputs it stored, output, prompt). Uploaded files are not covered; Higgsfield deletes those itself within 7 days. */
  async afterStored(requestId: string): Promise<void> {
    if (deleteAfterStore()) await this.client.deleteRequest(requestId);
  }

  /** The result link expires (7 days by default), so the Studio downloads it as soon as the job completes. */
  async fetchOutput(url: string): Promise<Buffer> {
    try { return await this.client.download(url); } catch (err) { throw toProviderError(err); }
  }
}
