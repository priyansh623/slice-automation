/**
 * The timing rules of the background jobs, with why each number is what it is. All can be changed here in one place.
 */
export const RULES = {
  /** The provider's synchronous submit gives up by itself after 10 minutes (HTTP 408, documented); we wait one minute longer than that. */
  submitTimeoutMs: 11 * 60_000,
  /** A row claimed for submission and not heard from for this long belongs to a call that can no longer be running. */
  submitStaleMs: 12 * 60_000,
  /** A status check is a small read. */
  pollTimeoutMs: 30_000,
  /** Clips are a few MB; generous for a slow link. */
  downloadTimeoutMs: 5 * 60_000,
  referenceUploadTimeoutMs: 60_000,
  /** How long one worker owns an in-flight job while checking / downloading it. Longer than poll + download timeouts together. */
  pollLeaseMs: 6 * 60_000,
  /** Observed: 90% of clips finish within about 4 minutes. A job still unfinished after 2 hours (the previous lease) will not finish. */
  jobMaxAgeMs: 2 * 60 * 60_000,
  /** A provider that keeps refusing (busy) is given up on after this long. */
  busyGiveUpMs: 30 * 60_000,
  submitConcurrency: () => clampInt(process.env.VIDEO_SUBMIT_CONCURRENCY, 3, 1, 6),
  pollConcurrency: () => clampInt(process.env.VIDEO_POLL_CONCURRENCY, 4, 1, 8),
} as const;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export const UNCONFIRMED_MESSAGE = 'We could not confirm whether the video provider accepted this request, so it was not sent again (that could charge twice). Check Google Flow before generating again.';

/** Runs `fn` over items with at most `limit` at once. One item failing never stops the others. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (err) { console.error('[worker] job error (others continue):', (err as Error).message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Oldest first within a project, projects taking turns, so one large project cannot occupy every slot. */
export function roundRobin<T>(rows: T[], projectOf: (row: T) => number): T[] {
  const groups = new Map<number, T[]>();
  for (const r of rows) { const k = projectOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  const out: T[] = [];
  for (let i = 0; out.length < rows.length; i++) for (const g of groups.values()) if (i < g.length) out.push(g[i]);
  return out;
}
