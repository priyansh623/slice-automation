export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// Temporary failure — worker schedules retry at retryAfterMs
export class TemporaryDownloadError extends DownloadError {
  constructor(message: string, public readonly retryAfterMs: number) {
    super(message);
  }
}

// Permanent asset failure — worker sets download_retry_after_at = NULL, marks failed
export class PermanentDownloadError extends DownloadError {}

// Signed URL expired and no outputMediaGenerationId available
export class OutputExpiredError extends DownloadError {}

// USEAPI_TOKEN is invalid — all downloads fail until credential is rotated
export class AuthenticationError extends DownloadError {}

// Operator action required: wrong account, unconfigured Google Flow, or expired Google session (596)
export class ConfigurationError extends DownloadError {}

// Provider rate-limited (429) — all accounts busy; worker resets to queued and retries next tick
export class RateLimitError extends DownloadError {
  constructor(message: string, public readonly retryAfterMs: number) {
    super(message);
  }
}

// Undocumented provider status — bounded retries (MAX_UNEXPECTED_ATTEMPTS), then permanent failure
export class UnexpectedProviderError extends DownloadError {
  constructor(message: string, public readonly httpStatus: number) {
    super(message);
  }
}
