/**
 * A small, bounded retry with backoff for read-only calls that can fail for transient network reasons (for example the
 * Supabase Storage listing, which once failed with "fetch failed" in the middle of a long run).
 *
 * Only TRANSIENT errors are retried: network failures and HTTP 408, 425, 429 and 5xx. Anything else (a missing bucket, a bad
 * key, a rejected credential, a bug) fails at once on the first attempt, so a real problem is never hidden behind retries.
 * When an error carries more than one readable HTTP status, EVERY one of them must be transient for it to be retried: they
 * may differ (429 with 500 is retried), but a single non-transient status (400, 401, 403, 404...) makes it fail fast.
 *
 * Bounded: at most `attempts` tries in total. With the DEFAULT configuration (5 attempts, 0.5 s base delay doubling, 8 s cap)
 * that is 4 retries and at most 0.5 + 1 + 2 + 4 = 7.5 seconds of waiting. Other configurations scale accordingly.
 */

export interface RetryOptions {
  /** Total tries, including the first. Default 5. */
  attempts?: number;
  /** Delay before the first retry; doubles each time. Default 500 ms. */
  baseDelayMs?: number;
  /** No single delay is longer than this. Default 8000 ms. */
  maxDelayMs?: number;
  /** Replaced by tests so they do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** 0 <= random() < 1, used for jitter. Replaced by tests. */
  random?: () => number;
  /** Called before every retry (for example to print a line). */
  log?: (line: string) => void;
}

export const DEFAULT_RETRY = { attempts: 5, baseDelayMs: 500, maxDelayMs: 8000 } as const;

/** Thrown when every attempt failed with a transient error. The final underlying error is kept as `lastError` (there is no `cause`). */
export class RetryExhaustedError extends Error {
  constructor(readonly attempts: number, readonly lastError: unknown) {
    super(`${messageOf(lastError)} (gave up after ${attempts} attempts)`);
    this.name = 'RetryExhaustedError';
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : String(e));

const NETWORK_PATTERN = /fetch failed|network|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|other side closed|terminated|timed? ?out|UND_ERR_/i;

/** An HTTP status from a number or a numeric string ("503"), or null. Anything that is not a plausible status (100-599) is ignored. */
function httpCode(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d{3}\s*$/.test(value) ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
}

const isTransientCode = (code: number): boolean => code === 408 || code === 425 || code === 429 || code >= 500;

/**
 * True for errors worth retrying.
 *
 * The Supabase client (storage-js) reports an HTTP failure as a StorageApiError carrying BOTH `status` (a number, from the
 * HTTP response) and `statusCode` (a numeric string, usually the same but taken from the response body, and not always: a
 * 400 whose body says "404" is how Storage reports a missing object). A failure that never reached the server (the network)
 * has neither, and the original error attached.
 *
 * Rules, in order:
 *  1. Collect every readable HTTP status from `status` and `statusCode` (a number or numeric string; anything else is
 *     ignored). The error is transient only if EVERY one of them is transient (408, 425, 429, 5xx). Different transient
 *     statuses may coexist (429 with "500" is retried). If ANY readable status is not transient (400, 401, 403, 404, ...),
 *     the error fails fast, including when the fields disagree such as 503 with "404".
 *  2. With no readable HTTP status at all, it is transient only if it looks like a network failure.
 */
export function isTransientError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return NETWORK_PATTERN.test(String(err));
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown }; originalError?: { code?: unknown; message?: unknown; cause?: { code?: unknown } } };
  const codes = [httpCode(e.status), httpCode(e.statusCode)].filter((c): c is number => c !== null);
  if (codes.length > 0) return codes.every(isTransientCode);
  const text = [e.message, e.code, e.cause?.code, e.cause?.message, e.originalError?.code, e.originalError?.message, e.originalError?.cause?.code].filter((x) => x != null).join(' ');
  return NETWORK_PATTERN.test(text);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `op`, retrying transient failures with exponential backoff and jitter. Non-transient errors are thrown immediately. */
export async function retryTransient<T>(label: string, op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RETRY.attempts);
  const base = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const max = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (!isTransientError(err)) throw err;                         // a real problem: fail at once
      if (attempt >= attempts) throw new RetryExhaustedError(attempt, err);
      const cap = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.round(cap / 2 + (random() * cap) / 2);       // "equal jitter": between half and all of the cap
      options.log?.(`[retry] ${label}: attempt ${attempt}/${attempts} failed (${messageOf(err)}); retrying in ${(delay / 1000).toFixed(1)} s`);
      await sleep(delay);
    }
  }
}
