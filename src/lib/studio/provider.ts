/**
 * The character-replacement provider, as the Studio sees it. Provider-independent on purpose: nothing here assumes any
 * particular vendor's API. A real provider (Higgsfield is intended) will implement this interface once its API is researched;
 * until then only the mock exists (see mock-provider.ts). Credentials belong to the implementation and never reach the browser.
 *
 * Contract:
 *  - submit() is called at most once per job UNLESS the provider declares `idempotentSubmit` (see below). If it returns a
 *    providerJobId the job keeps it forever and is only polled, never submitted again. The idempotencyKey is stable for a job so a
 *    provider that supports idempotent submits can use it.
 *  - What an error from submit() means is explicit. A ProviderError with outcome 'rejected' (the default) says the provider
 *    answered that it did NOT create a job: the job fails. A ProviderError with outcome 'unknown', any other exception, and a local
 *    timeout all mean the request MAY have reached the provider: the job becomes 'submit_unknown'. It is never resent blindly (that
 *    could pay for the same image twice); it is resolved by a late answer, by findSubmission(), by an idempotent resubmission
 *    (only if the provider declares it), or by a person who accepts the risk of a duplicate.
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

/** What a failed submit() tells us: 'rejected' = no job was created; 'unknown' = a job may or may not have been created. */
export type SubmitOutcome = 'rejected' | 'unknown';

export class ProviderError extends Error {
  /** `retryAfterMs`: for code 'rate_limited' only: the provider said when to try again. */
  constructor(message: string, public readonly code: string, public readonly retryable: boolean, public readonly outcome: SubmitOutcome = 'rejected', public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ReplacementProvider {
  readonly id: string;
  /**
   * True only if sending the SAME idempotencyKey again can never create a second job (the provider returns the first one). Only then
   * may an unknown submission be re-sent automatically. Leave it unset when unsure: the safe default is never to resend.
   */
  readonly idempotentSubmit?: boolean;
  /** Optional: asks the provider whether it already has a job for this idempotency key. null means it has no record. */
  findSubmission?(idempotencyKey: string): Promise<{ providerJobId: string } | null>;
  /** Said to the person when a submission's outcome is unknown (what they can check before choosing to generate again). */
  readonly ambiguousHint?: string;
  /** Called, best effort, once a finished output is safely stored. A failure here never affects the job. */
  afterStored?(providerJobId: string): Promise<void>;
  submit(input: ReplacementInput): Promise<SubmitResult>;
  poll(providerJobId: string): Promise<PollResult>;
  /** Fetches an output that came back as a URL. Only called when ProviderOutput.url is set. */
  fetchOutput?(url: string): Promise<Buffer>;
}
