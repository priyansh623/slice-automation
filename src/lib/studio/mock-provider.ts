import sharp from 'sharp';
import { ProviderError, type PollResult, type ReplacementInput, type ReplacementProvider, type SubmitResult } from './provider';

/**
 * A stand-in provider for development and tests. It does not call any external service. It checks that both input images are
 * real images, then "generates" a small PNG that is a pure function of the job (so polling again after a worker restart gives
 * the same picture): the state a real provider would keep is encoded in the provider job id.
 */
export interface MockOptions {
  /** How many polls report "processing" before success. Default 1. */
  pollsBeforeDone?: number;
  /** Return a failure for this input instead of accepting it (throws a ProviderError from submit). */
  failSubmit?: (input: ReplacementInput) => { code: string; message: string; retryable: boolean } | null;
  /** Report a failure when polling this provider job id. */
  failPoll?: (providerJobId: string) => { code: string; message: string; retryable: boolean } | null;
}

export class MockReplacementProvider implements ReplacementProvider {
  readonly id = 'mock';
  /** Every submit this instance received (tests use it to prove what was sent, and how many times). */
  readonly submitted: Array<{ jobId: number; idempotencyKey: string; characterBytes: number; sourceBytes: number; characterBuf: Buffer; sourceBuf: Buffer }> = [];
  private polls = new Map<string, number>();
  constructor(private readonly opts: MockOptions = {}) {}

  async submit(input: ReplacementInput): Promise<SubmitResult> {
    this.submitted.push({ jobId: input.jobId, idempotencyKey: input.idempotencyKey, characterBytes: input.characterImage.length, sourceBytes: input.sourceImage.length, characterBuf: input.characterImage, sourceBuf: input.sourceImage });
    try {
      await sharp(input.characterImage, { failOn: 'error' }).metadata();
      await sharp(input.sourceImage, { failOn: 'error' }).metadata();
    } catch {
      throw new ProviderError('One of the images could not be read.', 'bad_input', false);
    }
    const fail = this.opts.failSubmit?.(input);
    if (fail) throw new ProviderError(fail.message, fail.code, fail.retryable);
    return { kind: 'accepted', providerJobId: `mock-${input.jobId}` };
  }

  async poll(providerJobId: string): Promise<PollResult> {
    const fail = this.opts.failPoll?.(providerJobId);
    if (fail) return { status: 'failed', ...fail };
    const n = (this.polls.get(providerJobId) ?? 0) + 1;
    this.polls.set(providerJobId, n);
    // A job this instance submitted reports "processing" for the first polls; one it never saw (after a restart) is simply done.
    if (this.seen(providerJobId) && n <= (this.opts.pollsBeforeDone ?? 1)) return { status: 'processing' };
    const jobId = Number(providerJobId.replace('mock-', '')) || 0;
    const hue = (jobId * 47) % 255;
    const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: hue, g: 120, b: 255 - hue } } })
      .composite([{ input: Buffer.from(`<svg width="512" height="512"><text x="256" y="268" font-size="44" text-anchor="middle" fill="white" font-family="sans-serif">MOCK ${jobId}</text></svg>`) }])
      .png().toBuffer();
    return { status: 'succeeded', output: { bytes, mime: 'image/png' } };
  }

  private seen(id: string): boolean { return this.submitted.some((s) => `mock-${s.jobId}` === id); }
}

const instances = new Map<string, ReplacementProvider>();

/**
 * The mock produces fake pictures, so it must never be what runs by accident. It exists only when STUDIO_PROVIDER=mock is set
 * on purpose (development, tests, demos). With nothing set, no provider exists and Studio generation is switched off.
 */
export const mockEnabled = (): boolean => (process.env.STUDIO_PROVIDER ?? '').trim().toLowerCase() === 'mock';

/** One provider instance per id for the life of the process. */
export function getProvider(id: string): ReplacementProvider {
  if (id === 'mock') {
    if (!mockEnabled()) throw new ProviderError('The test provider is not enabled on this server, so this job was not generated.', 'provider_unavailable', false);
    const known = instances.get(id);
    if (known) return known;
    const p = new MockReplacementProvider(); instances.set(id, p); return p;
  }
  throw new ProviderError(`The "${id}" provider is not available yet.`, 'provider_unavailable', false);
}

/** The provider id new batches use, or null when none is configured (there is no default). */
export const configuredProvider = (): string | null => (process.env.STUDIO_PROVIDER ?? '').trim().toLowerCase() || null;

export interface GenerationConfig {
  /** Whether new batches can be created right now. */
  enabled: boolean;
  /** The provider id in use, if any. */
  provider: string | null;
  /** True when pictures are fake test output (the mock provider). Shown clearly in the UI. */
  testMode: boolean;
  /** Why generation is off, in words a person can read. */
  reason: string | null;
}

export function generationConfig(): GenerationConfig {
  const id = configuredProvider();
  if (!id) return { enabled: false, provider: null, testMode: false, reason: 'Image generation is not switched on yet: no provider is configured on the server. Nothing can be generated until one is.' };
  if (id === 'mock') return { enabled: true, provider: 'mock', testMode: true, reason: null };
  return { enabled: false, provider: id, testMode: false, reason: `The "${id}" provider is not available yet, so nothing can be generated.` };
}
