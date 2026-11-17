/**
 * The image-to-video provider for Character B-roll, as the pipeline sees it. Vendor-independent: the worker only knows this interface.
 * Credentials belong to the implementation. The contract mirrors the Studio's ReplacementProvider rules for the paid step:
 *  - submit() is called at most once per clip attempt unless `idempotentSubmit` is declared. A ProviderError-like failure with
 *    outcome 'unknown' means the request MAY have created a paid job; it is only ever resolved by replaying the SAME idempotency key
 *    (only if declared idempotent) or by a person.
 *  - poll() is safe to repeat. A finished video is downloaded straight away (provider links expire).
 */
import { HiggsfieldClient, HiggsfieldError, HiggsfieldUnknownError, deleteAfterStore, readResultUrl } from '../higgsfield/client';

export interface ClipInput {
  idempotencyKey: string;
  /** The APPROVED personalised image, used as the first frame. */
  image: Buffer;
  imageMime: string;
  /** The image already uploaded to the provider (from an earlier send of this same request). Reused so a resend has an identical body. */
  imageUrl?: string;
  /** The editable motion prompt. */
  prompt: string;
  durationSeconds: number;
}
export type ClipSubmit = { providerRequestId: string };
export type ClipPoll =
  | { status: 'processing' }
  | { status: 'succeeded'; video: Buffer; mime: string }
  | { status: 'failed'; code: string; message: string; retryable: boolean };

export class ClipProviderError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean, public readonly outcome: 'rejected' | 'unknown' = 'rejected', public readonly retryAfterMs?: number) { super(message); this.name = 'ClipProviderError'; }
}

export interface ClipProvider {
  readonly id: string;
  /** The model/endpoint used, recorded on the item for the audit trail. */
  readonly model: string;
  readonly idempotentSubmit: boolean;
  /** Uploads the input image and returns the URL the model reads it from. Optional: a provider that takes bytes directly has none. */
  uploadImage?(bytes: Buffer, mime: string): Promise<string>;
  submit(input: ClipInput): Promise<ClipSubmit>;
  poll(providerRequestId: string): Promise<ClipPoll>;
  /** Said to the person when a submission's outcome is unknown. */
  readonly ambiguousHint?: string;
  /** Called, best effort, once the finished video is in our storage. */
  afterStored?(providerRequestId: string): Promise<void>;
  /** Cancels a request that has not started (only meaningful while queued). Best effort. */
  cancel?(providerRequestId: string): Promise<void>;
}

/** Kling 3.0 Standard image-to-video through the Higgsfield API. Sound is always off: B-roll is silent. Never substitutes another model. */
export const KLING_STANDARD_ENDPOINT = 'kling-video/v3.0/std/image-to-video';

export class HiggsfieldKlingProvider implements ClipProvider {
  readonly id = 'higgsfield';
  /** FALSE on purpose: Higgsfield does not document how long an idempotency key is remembered, so a lost answer is never repeated automatically. */
  readonly idempotentSubmit = false;
  readonly ambiguousHint = 'Check the Higgsfield generation history for a video made around this time before trying again; trying again could be charged twice.';
  readonly model: string;
  constructor(private readonly client: HiggsfieldClient, endpoint: string = KLING_STANDARD_ENDPOINT) { this.model = endpoint; }

  async uploadImage(bytes: Buffer, mime: string): Promise<string> {
    try { return await this.client.uploadImage(bytes, mime); } catch (err) { throw toProviderError(err); }
  }

  async submit(input: ClipInput): Promise<ClipSubmit> {
    try {
      const imageUrl = input.imageUrl ?? await this.client.uploadImage(input.image, input.imageMime);
      const res = await this.client.submit(this.model, { image_url: imageUrl, prompt: input.prompt, duration: input.durationSeconds, sound: 'off' }, input.idempotencyKey);
      return { providerRequestId: res.requestId };
    } catch (err) { throw toProviderError(err); }
  }

  async poll(requestId: string): Promise<ClipPoll> {
    let s;
    try { s = await this.client.status(requestId); } catch (err) { throw toProviderError(err); }
    if (s.status === 'queued' || s.status === 'in_progress') return { status: 'processing' };
    if (s.status === 'nsfw') return { status: 'failed', code: 'nsfw', message: 'Higgsfield blocked this video (content check). You are not charged. Edit the prompt or the image and try again.', retryable: false };
    if (s.status === 'canceled') return { status: 'failed', code: 'canceled', message: 'The video request was canceled. You are not charged.', retryable: true };
    if (s.status === 'failed') return { status: 'failed', code: 'failed', message: `${String(s.raw.error || 'Higgsfield could not make this video.').slice(0, 250)} You are not charged.`, retryable: true };
    const url = readResultUrl(s.raw);
    if (!url) return { status: 'failed', code: 'no_result', message: 'Higgsfield reported the video as complete but returned no file.', retryable: true };
    try { return { status: 'succeeded', video: await this.client.download(url), mime: 'video/mp4' }; } catch (err) { throw toProviderError(err); }
  }

  async afterStored(requestId: string): Promise<void> { if (deleteAfterStore()) await this.client.deleteRequest(requestId); }

  async cancel(requestId: string): Promise<void> { await this.client.cancel(requestId).catch(() => {}); }
}

function toProviderError(err: unknown): ClipProviderError {
  if (err instanceof HiggsfieldUnknownError) return new ClipProviderError(err.message, 'unknown', true, 'unknown');
  if (err instanceof HiggsfieldError) return new ClipProviderError(err.message, err.code, err.retryable, 'rejected', err.retryAfterMs);
  return new ClipProviderError((err as Error).message, 'error', true, 'unknown');
}
