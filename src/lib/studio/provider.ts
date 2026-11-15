/**
 * The character-replacement provider, as the Studio sees it. Provider-independent on purpose: nothing here assumes any
 * particular vendor's API. A real provider (Higgsfield is intended) will implement this interface once its API is researched;
 * until then only the mock exists (see mock-provider.ts). Credentials belong to the implementation and never reach the browser.
 *
 * Contract:
 *  - submit() is called at most once per job. If it returns a providerJobId the job keeps it forever and is only polled, never
 *    submitted again. The idempotencyKey is stable for a job so a provider that supports idempotent submits can use it.
 *  - poll() may be called repeatedly and must be safe to repeat.
 *  - Errors are ProviderError with a short code, a message safe to show, and whether trying again could help.
 */

export interface ReplacementInput {
  /** The Studio job id, for logging and for correlating on the provider side. */
  jobId: number;
  idempotencyKey: string;
  /** The project's base character image, exactly as uploaded. */
  characterImage: Buffer;
  characterMime: string;
  /** The Scene Pack source image, exactly as uploaded. */
  sourceImage: Buffer;
  sourceMime: string;
}

export interface ProviderOutput {
  /** The finished image, if the provider returned it directly. */
  bytes?: Buffer;
  /** Or where to fetch it from. */
  url?: string;
  mime: string;
}

export type SubmitResult =
  | { kind: 'accepted'; providerJobId: string }
  | { kind: 'completed'; providerJobId: string | null; output: ProviderOutput };

export type PollResult =
  | { status: 'processing' }
  | { status: 'succeeded'; output: ProviderOutput }
  | { status: 'failed'; code: string; message: string; retryable: boolean };

export class ProviderError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ReplacementProvider {
  readonly id: string;
  submit(input: ReplacementInput): Promise<SubmitResult>;
  poll(providerJobId: string): Promise<PollResult>;
  /** Fetches an output that came back as a URL. Only called when ProviderOutput.url is set. */
  fetchOutput?(url: string): Promise<Buffer>;
}
