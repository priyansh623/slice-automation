/**
 * GET (or send) JSON from our own API, treating anything that is not a successful JSON answer as an ERROR, never as data.
 * Every request has a time limit, so a screen can never sit on a loading state forever, and can be cancelled when the page goes away.
 */
export class RequestError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); this.name = 'RequestError'; }
}

/** Long enough for a cold function plus a slow database round trip; far below the platform's 300 s cut-off, after which nobody is still waiting. */
export const READ_TIMEOUT_MS = 30_000;

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = READ_TIMEOUT_MS, signal, ...rest } = init;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* an error page or an empty body */ }
    if (!res.ok) throw new RequestError((body as { error?: string } | null)?.error ?? `The server answered ${res.status}.`, res.status);
    if (body === null) throw new RequestError('The server sent an unreadable answer.', res.status);
    return body as T;
  } catch (err) {
    if (err instanceof RequestError) throw err;
    if (timedOut) throw new RequestError('The server took too long to answer.', null);
    if (signal?.aborted) throw err;
    throw new RequestError('Could not reach the server. Check your connection.', null);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
