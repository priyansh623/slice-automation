import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_RETRY, isTransientError, retryTransient, RetryExhaustedError } from '@/lib/object-store/retry';
import { listSupabaseObjects, runCopy, type CopyDeps, type SourceObject, type SupabaseListClient } from '@/lib/object-store/copy';

// What the Supabase client really returns: HTTP failures as StorageApiError (numeric status), network failures as
// StorageUnknownError (no status, the original error attached).
const apiError = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { __isStorageError: true, status, statusCode: String(status) });
const networkError = (message = 'fetch failed') => Object.assign(new Error(message), { __isStorageError: true, originalError: Object.assign(new TypeError(message), { cause: { code: 'ECONNRESET' } }) });

describe('isTransientError', () => {
  it('treats network failures as transient', () => {
    expect(isTransientError(networkError())).toBe(true);
    expect(isTransientError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientError(Object.assign(new Error('x'), { cause: { code: 'ETIMEDOUT' } }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }))).toBe(true);
    expect(isTransientError('fetch failed')).toBe(true);
  });
  it('treats HTTP 408, 425, 429 and every 5xx as transient', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504, 599]) expect(isTransientError(apiError(s)), `status ${s}`).toBe(true);
  });
  it('does NOT treat real problems as transient: bad request, auth, missing, conflict, or an unknown error', () => {
    for (const s of [400, 401, 403, 404, 409, 422]) expect(isTransientError(apiError(s)), `status ${s}`).toBe(false);
    expect(isTransientError(apiError(404, 'Bucket not found'))).toBe(false);
    expect(isTransientError(new Error('boom'))).toBe(false);
    expect(isTransientError(apiError(403, 'fetch failed in the message but a 403'))).toBe(false); // the status decides
  });
});

describe('retryTransient', () => {
  const noWait = () => { const waits: number[] = []; return { waits, sleep: async (ms: number) => { waits.push(ms); } }; };

  it('returns at once when the first attempt works, without waiting', async () => {
    const w = noWait();
    expect(await retryTransient('x', async () => 7, { sleep: w.sleep })).toBe(7);
    expect(w.waits).toEqual([]);
  });

  it('retries transient failures with doubling backoff and returns the eventual result; each retry is logged', async () => {
    const w = noWait();
    const log: string[] = [];
    let calls = 0;
    const result = await retryTransient('list videos/a', async () => { if (++calls < 4) throw networkError(); return 'ok'; }, { sleep: w.sleep, random: () => 1, log: (l) => log.push(l) });
    expect(result).toBe('ok');
    expect(calls).toBe(4);
    expect(w.waits).toEqual([500, 1000, 2000]);
    expect(log).toHaveLength(3);
    expect(log[0]).toContain('[retry] list videos/a: attempt 1/5 failed (fetch failed); retrying in 0.5 s');
  });

  it('adds jitter: every delay is between half of its cap and the cap', async () => {
    const low = noWait(); const high = noWait();
    for (const [w, r] of [[low, 0], [high, 0.999999]] as const) {
      let n = 0;
      await retryTransient('x', async () => { if (++n < 5) throw networkError(); return 1; }, { sleep: w.sleep, random: () => r });
    }
    expect(low.waits).toEqual([250, 500, 1000, 2000]);
    expect(high.waits.map((x) => x)).toEqual([500, 1000, 2000, 4000]);
  });

  it('is bounded: with the default configuration it gives up after 5 attempts in total, waiting at most 7.5 s, and says how many attempts it made', async () => {
    const w = noWait();
    let calls = 0;
    await expect(retryTransient('x', async () => { calls++; throw networkError('fetch failed'); }, { sleep: w.sleep, random: () => 1 }))
      .rejects.toSatisfy((e: unknown) => e instanceof RetryExhaustedError && e.attempts === 5 && /gave up after 5 attempts/.test(e.message) && /fetch failed/.test(e.message)
        && (e.lastError as Error).message === 'fetch failed' && !('cause' in e)); // the original is kept as lastError; there is no `cause`
    expect(calls).toBe(DEFAULT_RETRY.attempts);
    expect(w.waits).toHaveLength(4);
    expect(w.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(7500);
  });

  it('never waits longer than the maximum delay, however many attempts are allowed', async () => {
    const w = noWait();
    await retryTransient('x', async () => { if (w.waits.length < 9) throw networkError(); return 1; }, { attempts: 10, sleep: w.sleep, random: () => 1 });
    expect(Math.max(...w.waits)).toBeLessThanOrEqual(8000);
    expect(w.waits.slice(-3)).toEqual([8000, 8000, 8000]);
  });

  it('does NOT retry a real problem: it is thrown at once, unchanged, after exactly one attempt', async () => {
    const w = noWait();
    const err = apiError(403, 'Invalid JWT');
    let calls = 0;
    await expect(retryTransient('x', async () => { calls++; throw err; }, { sleep: w.sleep })).rejects.toBe(err);
    expect(calls).toBe(1);
    expect(w.waits).toEqual([]);
  });

  it('attempts: 1 means no retry at all', async () => {
    let calls = 0;
    await expect(retryTransient('x', async () => { calls++; throw networkError(); }, { attempts: 1, sleep: async () => {} })).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(calls).toBe(1);
  });
});


// Errors as other code paths or library versions might shape them: only one of the two fields, a numeric string, or both.
const withFields = (fields: Record<string, unknown>, message = 'storage error') => Object.assign(new Error(message), { __isStorageError: true }, fields);

describe('isTransientError: status and statusCode', () => {
  const TRANSIENT = [408, 425, 429, 500, 502, 503, 504];
  const FAIL_FAST = [400, 401, 403, 404, 409, 422];

  it('reads a numeric-string statusCode on its own (no status field at all)', () => {
    for (const c of TRANSIENT) expect(isTransientError(withFields({ statusCode: String(c) })), `statusCode "${c}"`).toBe(true);
    for (const c of FAIL_FAST) expect(isTransientError(withFields({ statusCode: String(c) })), `statusCode "${c}"`).toBe(false);
  });

  it('reads a numeric-string status, and a numeric statusCode, too', () => {
    expect(isTransientError(withFields({ status: '503' }))).toBe(true);
    expect(isTransientError(withFields({ status: ' 429 ' }))).toBe(true);
    expect(isTransientError(withFields({ status: '404' }))).toBe(false);
    expect(isTransientError(withFields({ statusCode: 503 }))).toBe(true);
    expect(isTransientError(withFields({ statusCode: 403 }))).toBe(false);
  });

  it('FAILS FAST for 400, 401, 403 and 404 however they are reported: status only, statusCode only, or both', () => {
    for (const c of [400, 401, 403, 404]) {
      expect(isTransientError(withFields({ status: c })), `status ${c}`).toBe(false);
      expect(isTransientError(withFields({ statusCode: String(c) })), `statusCode "${c}"`).toBe(false);
      expect(isTransientError(withFields({ status: c, statusCode: String(c) })), `both ${c}`).toBe(false);
      expect(isTransientError(withFields({ status: String(c), statusCode: c })), `both (swapped types) ${c}`).toBe(false);
      expect(isTransientError(withFields({ status: c }, 'fetch failed ECONNRESET timeout')), `status ${c} even with a network-looking message`).toBe(false);
    }
  });

  it('when the status fields disagree and any readable status is non-transient, the error is not retried (it fails fast)', () => {
    expect(isTransientError(withFields({ status: 503, statusCode: '404' }))).toBe(false);   // server error, but the body says not found
    expect(isTransientError(withFields({ status: 404, statusCode: '503' }))).toBe(false);
    expect(isTransientError(withFields({ status: 400, statusCode: '404' }))).toBe(false);   // how Storage reports a missing object
    expect(isTransientError(withFields({ status: 500, statusCode: '400' }))).toBe(false);
    expect(isTransientError(withFields({ status: 429, statusCode: '403' }))).toBe(false);
    expect(isTransientError(withFields({ status: '503', statusCode: 401 }))).toBe(false);
  });

  it('when both fields say transient they may differ in value: 429 with "500", 503 with "429" is still retried', () => {
    expect(isTransientError(withFields({ status: 429, statusCode: '500' }))).toBe(true);
    expect(isTransientError(withFields({ status: 503, statusCode: '429' }))).toBe(true);
    expect(isTransientError(withFields({ status: 408, statusCode: '504' }))).toBe(true);
  });

  it('ignores a statusCode that is not a number (the client can put a code string there) and decides from the rest', () => {
    expect(isTransientError(withFields({ status: 503, statusCode: 'DatabaseTimeout' }))).toBe(true);
    expect(isTransientError(withFields({ status: 404, statusCode: 'DatabaseTimeout' }))).toBe(false);
    expect(isTransientError(withFields({ statusCode: 'DatabaseTimeout' }, 'boom'))).toBe(false);               // nothing numeric, not a network error
    expect(isTransientError(withFields({ statusCode: 'DatabaseTimeout' }, 'fetch failed'))).toBe(true);        // nothing numeric, but a network error
  });

  it('ignores values that are not a plausible HTTP status, instead of mis-reading them as one', () => {
    for (const junk of ['', ' ', 'abc', '50', '5003', '99', '600', '0', 0, 99, 600, 1.5, NaN, null, undefined, {}, []]) {
      expect(isTransientError(withFields({ status: junk }, 'boom')), `status ${String(junk)}`).toBe(false);          // unreadable, no network signal: not retried
      expect(isTransientError(withFields({ status: junk, statusCode: '503' })), `status ${String(junk)} + statusCode "503"`).toBe(true);   // the readable field decides
      expect(isTransientError(withFields({ status: junk, statusCode: '404' })), `status ${String(junk)} + statusCode "404"`).toBe(false);
    }
  });
});

describe('the REAL Supabase client: genuine error objects are classified correctly', () => {
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const text = (status: number, body: string, type = 'text/plain') => () => new Response(body, { status, headers: { 'content-type': type } });
  const network = () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); };
  const clientWith = (responder: () => Response | Promise<Response>, calls: { n: number } = { n: 0 }) =>
    createClient('https://example.supabase.co', 'service-role-key', { auth: { persistSession: false }, global: { fetch: (async () => { calls.n++; return responder(); }) as unknown as typeof fetch } });
  const errorOf = async (responder: () => Response | Promise<Response>) => (await clientWith(responder).storage.from('videos').list('', { limit: 1 })).error;

  it('429 and 503, whatever the body (JSON, plain text, an HTML gateway page, empty), are transient', async () => {
    const cases = [
      json(429, { statusCode: '429', error: 'Too Many Requests', message: 'rate limit exceeded' }),
      json(429, { message: 'rate limit exceeded' }),
      text(429, 'Too Many Requests'),
      json(503, { statusCode: '503', error: 'Service Unavailable', message: 'temporarily unavailable' }),
      text(503, '<html>503</html>', 'text/html'),
      text(503, ''),
    ];
    for (const c of cases) {
      const err = await errorOf(c);
      expect(err, 'the client returns an error result').toBeTruthy();
      expect(isTransientError(err)).toBe(true);
    }
  });

  it('the real shapes carry a numeric `status` AND a numeric-string `statusCode` (what this classification relies on)', async () => {
    const e429 = (await errorOf(json(429, { statusCode: '429', message: 'x' }))) as unknown as { name: string; status: unknown; statusCode: unknown };
    expect(e429).toMatchObject({ name: 'StorageApiError', status: 429, statusCode: '429' });
    const e503 = (await errorOf(text(503, '<html/>', 'text/html'))) as unknown as { status: unknown; statusCode: unknown };
    expect(e503).toMatchObject({ status: 503, statusCode: '503' });
  });

  it('401, 403 and 404 fail fast, and so does the 400 whose body says "404" (status and statusCode disagree)', async () => {
    for (const c of [
      json(401, { statusCode: '401', error: 'Unauthorized', message: 'Invalid JWT' }),
      json(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }),
      json(404, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' }),
      json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }),
      json(400, { statusCode: '400', error: 'Bad Request', message: 'bad' }),
    ]) {
      expect(isTransientError(await errorOf(c))).toBe(false);
    }
  });

  it('a network failure (the client returns it with no status) is transient', async () => {
    const err = (await errorOf(network)) as unknown as { name: string; status: unknown; statusCode: unknown };
    expect(err.name).toBe('StorageUnknownError');
    expect(err.status).toBeUndefined();
    expect(isTransientError(err)).toBe(true);
  });

  it('listSupabaseObjects with the real client: 429 then 503 then success lists the object after exactly four requests (429, 503, the page, the empty page)', async () => {
    const script: (() => Response)[] = [
      json(429, { statusCode: '429', message: 'rate limit exceeded' }),
      text(503, '<html>503</html>', 'text/html'),
      () => new Response(JSON.stringify([{ name: 'a.mp4', id: '1', metadata: { size: 5, mimetype: 'video/mp4' } }]), { status: 200, headers: { 'content-type': 'application/json' } }),
      () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),   // the empty page that ends paging
    ];
    const calls = { n: 0 };
    const client = clientWith(() => script[calls.n - 1](), calls);
    const keys: string[] = [];
    for await (const o of listSupabaseObjects(client as unknown as SupabaseListClient, 'videos', '', { retry: { sleep: async () => {}, random: () => 0 } })) keys.push(o.key);
    expect(keys).toEqual(['a.mp4']);
    expect(calls.n).toBe(4); // 429, 503, the real page, then the empty page
  });

  it('listSupabaseObjects with the real client: 404, 403 and the 400-with-"404"-body stop after ONE request, with the real message', async () => {
    for (const [responder, message] of [
      [json(404, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' }), 'Bucket not found'],
      [json(403, { statusCode: '403', error: 'Unauthorized', message: 'Invalid key' }), 'Invalid key'],
      [json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }), 'Object not found'],
    ] as const) {
      const calls = { n: 0 };
      const client = clientWith(responder, calls);
      await expect((async () => { for await (const _ of listSupabaseObjects(client as unknown as SupabaseListClient, 'videos', '', { retry: { sleep: async () => {} } })) { /* drain */ } })())
        .rejects.toThrow(`Could not list videos/: ${message}`);
      expect(calls.n).toBe(1);
    }
  });

  it('a persistent 503 from the real client gives up after 5 requests and says so', async () => {
    const calls = { n: 0 };
    const client = clientWith(text(503, 'Service Unavailable'), calls);
    await expect((async () => { for await (const _ of listSupabaseObjects(client as unknown as SupabaseListClient, 'videos', '', { retry: { sleep: async () => {} } })) { /* drain */ } })())
      .rejects.toThrow(/Could not list videos\/: HTTP 503 error \(gave up after 5 attempts\)/);
    expect(calls.n).toBe(5);
  });
});

describe('listSupabaseObjects with a flaky connection', () => {
  const retry = { sleep: async () => {}, random: () => 0 };
  type Page = { name: string; id: string | null; metadata?: { size: number; mimetype: string } };
  const file = (name: string): Page => ({ name, id: `id-${name}`, metadata: { size: 1, mimetype: 'video/mp4' } });

  /** A bucket whose list calls fail in a scripted way. `failures` maps "dir@offset" to the errors to return before succeeding. */
  function flakyBucket(tree: Record<string, Page[]>, failures: Record<string, unknown[]> = {}, pageCap = 1000) {
    const calls: string[] = [];
    const pending = new Map(Object.entries(failures).map(([k, v]) => [k, [...v]]));
    const client: SupabaseListClient = { storage: { from: () => ({ async list(dir: string, o: { limit: number; offset: number }) {
      const key = `${dir}@${o.offset}`;
      calls.push(key);
      const queue = pending.get(key);
      if (queue && queue.length > 0) {
        const next = queue.shift();
        if (next instanceof Error && (next as { __thrown?: boolean }).__thrown) throw next;
        return { data: null, error: next as { message: string } };
      }
      return { data: (tree[dir] ?? []).slice(o.offset, o.offset + Math.min(o.limit, pageCap)), error: null };
    } }) } };
    return { client, calls };
  }
  const drain = async (it: AsyncIterable<SourceObject>) => { const keys: string[] = []; for await (const o of it) keys.push(o.key); return keys; };

  it('a transient error result is retried and the listing is complete, in order, with nothing repeated', async () => {
    const tree = { '': [file('a.mp4'), file('b.mp4'), file('c.mp4')] };
    const { client, calls } = flakyBucket(tree, { '@0': [networkError(), apiError(503)] });
    expect(await drain(listSupabaseObjects(client, 'videos', '', { retry }))).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
    expect(calls.filter((c) => c === '@0')).toHaveLength(3); // two failures, then the page; the next call (offset 3) comes back empty
  });

  it('a thrown exception (rather than an error result) is retried too', async () => {
    const thrown = Object.assign(new TypeError('fetch failed'), { __thrown: true });
    const { client } = flakyBucket({ '': [file('a.mp4')] }, { '@0': [thrown] });
    expect(await drain(listSupabaseObjects(client, 'videos', '', { retry }))).toEqual(['a.mp4']);
  });

  it('a failure in the MIDDLE of paging retries only that page: no object is repeated or skipped (2500 objects, pages of 1000)', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => file(`f${String(i).padStart(5, '0')}.mp4`));
    const { client } = flakyBucket({ '': all }, { '@1000': [networkError(), networkError()], '@2000': [apiError(502)] });
    const keys = await drain(listSupabaseObjects(client, 'videos', '', { retry }));
    expect(keys).toHaveLength(2500);
    expect(new Set(keys).size).toBe(2500);
    expect(keys).toEqual(all.map((o) => o.name));
  });

  it('a failure inside a nested folder retries there and the walk carries on correctly', async () => {
    const tree = { '': [{ name: 'screen-1', id: null }, file('top.mp4'), { name: 'screen-2', id: null }], 'screen-1': [file('a.mp4')], 'screen-2': [file('b.mp4'), file('c.mp4')] };
    const { client } = flakyBucket(tree, { 'screen-2@0': [networkError()] });
    expect(await drain(listSupabaseObjects(client, 'videos', '', { retry }))).toEqual(['screen-1/a.mp4', 'top.mp4', 'screen-2/b.mp4', 'screen-2/c.mp4']);
  });

  it('a persistent transient failure stops the run after the bounded attempts, naming the folder and the attempts', async () => {
    const { client, calls } = flakyBucket({ '': [file('a.mp4')] }, { '@0': Array.from({ length: 20 }, () => networkError('fetch failed')) });
    await expect(drain(listSupabaseObjects(client, 'videos', '', { retry }))).rejects.toThrow(/Could not list videos\/: fetch failed \(gave up after 5 attempts\)/);
    expect(calls.filter((c) => c === '@0')).toHaveLength(5);
  });

  it('a real problem (rejected credential, missing bucket) is NOT retried: it stops at once with the same message as before', async () => {
    const forbidden = flakyBucket({ '': [file('a.mp4')] }, { '@0': [apiError(403, 'Invalid JWT')] });
    await expect(drain(listSupabaseObjects(forbidden.client, 'videos', '', { retry }))).rejects.toThrow('Could not list videos/: Invalid JWT');
    expect(forbidden.calls).toHaveLength(1);
    const missing = flakyBucket({}, { '@0': [apiError(404, 'Bucket not found')] });
    await expect(drain(listSupabaseObjects(missing.client, 'nope', '', { retry }))).rejects.toThrow('Bucket not found');
    expect(missing.calls).toHaveLength(1);
  });

  it('retries are printed through the log hook so a run shows them', async () => {
    const lines: string[] = [];
    const { client } = flakyBucket({ '': [file('a.mp4')] }, { '@0': [networkError()] });
    await drain(listSupabaseObjects(client, 'videos', '', { retry: { ...retry, log: (l) => lines.push(l) } }));
    expect(lines).toEqual([expect.stringContaining('[retry] list videos/. offset 0: attempt 1/5 failed (fetch failed)')]);
  });

  it('the dry run now COMPLETES through a flaky listing, with the same counts as a clean listing (the failure that aborted the real run)', async () => {
    const tree = { '': [{ name: 'screen-1', id: null }, { name: 'screen-2', id: null }], 'screen-1': [file('a.mp4'), file('b.mp4')], 'screen-2': [file('c.mp4')] };
    const run = async (failures: Record<string, unknown[]>) => {
      const { client } = flakyBucket(tree, failures);
      const deps: CopyDeps = {
        source: { download: async () => { throw new Error('a dry run must not download'); } },
        target: null,
        listSource: (_bucket, prefix) => listSupabaseObjects(client, 'videos', prefix, { retry }),
        registeredRows: async () => new Map(),
        registerIfAbsent: async () => { throw new Error('a dry run must not register'); },
      };
      return runCopy(deps, { buckets: ['videos'], prefix: '', limit: null, execute: false });
    };
    const clean = await run({});
    const flaky = await run({ '@0': [networkError()], 'screen-2@0': [apiError(503), networkError()] });
    expect(clean.counts['would-copy']).toBe(3);
    expect(flaky.counts['would-copy']).toBe(3);
    expect(flaky.results.map((r) => r.key)).toEqual(clean.results.map((r) => r.key));
    expect(flaky.counts.failed).toBe(0);
  });
});
