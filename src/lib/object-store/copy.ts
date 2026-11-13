/**
 * Copies files from Supabase Storage to R2 and records each one as living on R2 only after the copy has been checked.
 * Pure logic with injected dependencies: scripts/storage-copy.ts supplies the real ones, tests supply fakes.
 *
 * Guarantees:
 *  - Dry run unless `execute` is true. A dry run never writes to R2 or the registry and never downloads from Supabase.
 *    (With `verifyRegistered` a dry run also downloads already-registered objects from R2, read-only.)
 *  - Supabase is only ever read. Nothing is deleted or changed there.
 *  - R2 writes are create-only (an existing R2 object is never overwritten).
 *  - A file is registered as 'r2' only after its size and SHA-256, read back from R2, equal the Supabase original.
 *  - The registry is insert-only here: an existing row is never changed, and a failed registry write leaves the file
 *    unregistered (reads keep going to Supabase). Re-running finishes whatever a failed or interrupted run left.
 */
import { createHash } from 'node:crypto';
import { ObjectExistsError, ObjectNotFoundError, type BucketName, type ObjectInfo, type PutOptions, type ProviderName } from './types';
import { retryTransient, RetryExhaustedError, type RetryOptions } from './retry';

export interface SourceObject { key: string; size: number | null; contentType: string | null }

/** What the registry knows about a file. sha256 is null for rows that were written without a checksum. */
export interface RegistryRow { provider: ProviderName; sha256: string | null; sizeBytes: number | null }

export type CopyStage = 'download' | 'size' | 'lookup' | 'put' | 'existing-mismatch' | 'verify' | 'checksum' | 'register' | 'registry-check';
export type CopyOutcome =
  | 'copied'              // written to R2, read back, checksum-verified against the Supabase original, registered
  | 'registered-existing' // already in R2 with identical bytes (earlier interrupted run): checksum-verified, registered now
  | 'skipped-registered'  // has a registry row already: left exactly as it is (existence and size checked only)
  | 'verified-registered' // --verify-registered: R2 object's SHA-256 equals the checksum stored in the registry
  | 'unverifiable'        // --verify-registered: the registry row has no checksum, so the contents could not be verified
  | 'would-copy'          // dry run
  | 'would-register'      // dry run: already in R2 with the same size. NOT verified: checksum comparison is pending and only happens when executing
  | 'would-conflict'      // dry run: already in R2 with a different size than the Supabase original; would fail
  | 'failed';

export interface ObjectResult {
  bucket: BucketName;
  key: string;
  outcome: CopyOutcome;
  bytes: number | null;
  stage?: CopyStage;
  reason?: string;
}

export interface CopyDeps {
  /** Supabase side. Only read operations are ever called on it. */
  source: { download(bucket: BucketName, key: string): Promise<Buffer> };
  /** R2 side. null is allowed in a dry run only (R2 not configured): existence in R2 is then not checked. */
  target: {
    put(bucket: BucketName, key: string, body: Buffer, opts: PutOptions): Promise<void>;
    download(bucket: BucketName, key: string): Promise<Buffer>;
    head(bucket: BucketName, key: string): Promise<ObjectInfo | null>;
  } | null;
  /** Every Supabase object under the prefix, in a stable order. */
  listSource(bucket: BucketName, prefix: string): AsyncIterable<SourceObject>;
  /** Exact registry rows. Must throw when the registry cannot be read (never guess). */
  registeredRows(bucket: BucketName, keys: string[]): Promise<Map<string, RegistryRow>>;
  /** Insert-only. Returns false when a row already existed. Must throw when the write fails. */
  registerIfAbsent(row: { bucket: BucketName; key: string; provider: 'r2'; sizeBytes: number; contentType: string; sha256: string; verifiedAt: number }): Promise<boolean>;
  /**
   * Optional independent count of the current objects in the bucket under the prefix (not through the listing API).
   * Returns null when it cannot be determined. Used to detect a listing that silently missed objects.
   */
  countSource?(bucket: BucketName, prefix: string): Promise<number | null>;
  shouldStop?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface CopyOptions {
  buckets: BucketName[];
  prefix: string;
  /** Maximum number of files that need work (already-registered files do not count). null = no limit. */
  limit: number | null;
  /** false (default everywhere) = dry run. */
  execute: boolean;
  /**
   * Download every already-registered R2 object and compare its SHA-256 with the checksum stored in the registry. Never
   * reads the Supabase original and never changes R2 or the registry. Rows without a checksum are reported as unverifiable.
   */
  verifyRegistered?: boolean;
}

export interface ListingCheck {
  /** Distinct objects the listing returned. */
  listed: number;
  /** Objects the independent count found, or null if it could not be counted. */
  expected: number | null;
  /** true = equal, false = MISMATCH (the listing missed or invented objects), null = not checked. */
  match: boolean | null;
  /** Objects the listing returned more than once (harmless: they are processed once). */
  duplicates: number;
  note?: string;
}

export interface CopyReport {
  dryRun: boolean;
  stoppedEarly: boolean;
  results: ObjectResult[];
  counts: Record<CopyOutcome, number>;
  /** Distinct Supabase objects the listing returned (until the run stopped), per bucket. */
  listed: Partial<Record<BucketName, { objects: number; bytes: number }>>;
  /** Listing versus an independent count, per bucket. Only checked when the whole bucket was walked. */
  listingChecks: Partial<Record<BucketName, ListingCheck>>;
  bytesCopied: number;
  bytesPlanned: number;
}

/** Throw this from a dependency to abort the whole run at once (it simulates the process being killed). */
export class CopyInterrupted extends Error {
  constructor(message = 'copy interrupted') { super(message); this.name = 'CopyInterrupted'; }
}

const BATCH = 100;
const PAGE = 1000;
const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function runCopy(deps: CopyDeps, opts: CopyOptions): Promise<CopyReport> {
  if (opts.execute && !deps.target) throw new Error('R2 is not configured: a real copy needs the R2 environment variables');
  if (opts.verifyRegistered && !deps.target) throw new Error('R2 is not configured: --verify-registered needs the R2 environment variables');
  const log = deps.log ?? (() => {});
  const results: ObjectResult[] = [];
  const counts: Record<CopyOutcome, number> = {
    copied: 0, 'registered-existing': 0, 'skipped-registered': 0, 'verified-registered': 0, unverifiable: 0,
    'would-copy': 0, 'would-register': 0, 'would-conflict': 0, failed: 0,
  };
  const listed: CopyReport['listed'] = {};
  const listingChecks: CopyReport['listingChecks'] = {};
  let stoppedEarly = false;
  let worked = 0;

  const record = (r: ObjectResult) => {
    results.push(r);
    counts[r.outcome]++;
    log(`${r.outcome.padEnd(19)} ${r.bucket}/${r.key}${r.bytes != null ? ` (${r.bytes} B)` : ''}${r.reason ? ` - ${r.stage ? `${r.stage}: ` : ''}${r.reason}` : ''}`);
  };
  const limitReached = () => opts.limit !== null && worked >= opts.limit;

  outer: for (const bucket of opts.buckets) {
    let batch: SourceObject[] = [];
    const seenKeys = new Set<string>();
    let duplicates = 0;
    const flush = async (): Promise<boolean> => {
      if (batch.length === 0) return true;
      const current = batch;
      batch = [];
      // A registry that cannot be read aborts the run: we must not guess which files are already migrated.
      const registered = await deps.registeredRows(bucket, current.map((o) => o.key));
      for (const obj of current) {
        if (deps.shouldStop?.()) { stoppedEarly = true; return false; }
        const existing = registered.get(obj.key);
        if (existing) {
          record(await checkRegistered(deps, bucket, obj, existing, opts.verifyRegistered === true));
          continue;
        }
        if (limitReached()) return false;
        worked++;
        record(opts.execute ? await copyOne(deps, bucket, obj) : await planOne(deps, bucket, obj));
      }
      return true;
    };

    for await (const obj of deps.listSource(bucket, opts.prefix)) {
      // Offset paging can return an object twice if new files appear while listing; process each key once.
      if (seenKeys.has(obj.key)) { duplicates++; continue; }
      seenKeys.add(obj.key);
      const seen = (listed[bucket] ??= { objects: 0, bytes: 0 });
      seen.objects++;
      seen.bytes += obj.size ?? 0;
      batch.push(obj);
      if (batch.length >= BATCH && !(await flush())) break outer;
    }
    if (!(await flush())) break outer;

    // The whole bucket was walked: compare with an independent count so a listing that missed objects cannot go unnoticed.
    if (deps.countSource) {
      const expected = await deps.countSource(bucket, opts.prefix);
      const count = seenKeys.size;
      listingChecks[bucket] = expected === null
        ? { listed: count, expected, match: null, duplicates, note: 'the independent count could not be obtained; listing completeness was NOT cross-checked' }
        : { listed: count, expected, match: expected === count, duplicates };
    } else {
      listingChecks[bucket] = { listed: seenKeys.size, expected: null, match: null, duplicates, note: 'no independent count available; listing completeness was NOT cross-checked' };
    }
  }

  const sum = (outcomes: CopyOutcome[]) => results.filter((r) => outcomes.includes(r.outcome)).reduce((n, r) => n + (r.bytes ?? 0), 0);
  return { dryRun: !opts.execute, stoppedEarly, results, counts, listed, listingChecks, bytesCopied: sum(['copied', 'registered-existing']), bytesPlanned: sum(['would-copy', 'would-register']) };
}

/**
 * A file that already has a registry row is never changed.
 *
 * Default check for a row that says 'r2': a HEAD request (read-only). If R2 does not hold the object, or holds one of a
 * different size than the Supabase original, that is a failure. LIMITATION: only existence and size are compared, so a
 * passing row is "size-checked", not "verified"; the result says so.
 *
 * With verifyRegistered: the R2 object is downloaded and its SHA-256 compared with the checksum stored in the registry.
 * A match is 'verified-registered'. A row without a checksum is 'unverifiable' (contents NOT verified). A mismatch or a
 * missing object is a failure. The Supabase original is never read, and nothing in R2 or the registry is modified.
 * "Verified" here means R2 still holds what was recorded when the row was written; it does not re-read Supabase.
 */
async function checkRegistered(deps: CopyDeps, bucket: BucketName, obj: SourceObject, row: RegistryRow, verify: boolean): Promise<ObjectResult> {
  const base = { bucket, key: obj.key, bytes: obj.size };
  if (row.provider !== 'r2' || !deps.target) return { ...base, outcome: 'skipped-registered', reason: `already registered as ${row.provider}` };
  const failed = (reason: string): ObjectResult => ({ ...base, outcome: 'failed', stage: 'registry-check', reason: `${reason}; the row and the object were not changed` });
  try {
    const there = await deps.target.head(bucket, obj.key);
    if (!there) return failed('the registry says this file is in R2 but R2 does not have it');
    if (obj.size !== null && there.size !== obj.size) {
      return failed(`the registry says this file is in R2 but R2 holds ${there.size} B and Supabase holds ${obj.size} B`);
    }
    if (!verify) return { ...base, outcome: 'skipped-registered', reason: 'already registered as r2; present in R2 with the same size; checksum NOT compared (size-checked only)' };

    if (!row.sha256) {
      return { ...base, outcome: 'unverifiable', reason: 'the registry row has no checksum, so the contents of the R2 object could NOT be verified (size matches)' };
    }
    const stored = await deps.target.download(bucket, obj.key);
    const actual = sha256Hex(stored);
    if (actual !== row.sha256.toLowerCase()) {
      return failed('the SHA-256 of the R2 object differs from the checksum stored in the registry');
    }
    return { ...base, outcome: 'verified-registered', reason: 'the R2 object matches the checksum stored in the registry (Supabase was not read)' };
  } catch (e) {
    if (e instanceof CopyInterrupted) throw e;
    if (e instanceof ObjectNotFoundError) return failed('the registry says this file is in R2 but R2 does not have it');
    return failed(msg(e));
  }
}

/** Dry run: metadata only. */
async function planOne(deps: CopyDeps, bucket: BucketName, obj: SourceObject): Promise<ObjectResult> {
  if (!deps.target) return { bucket, key: obj.key, outcome: 'would-copy', bytes: obj.size };
  try {
    const there = await deps.target.head(bucket, obj.key);
    if (!there) return { bucket, key: obj.key, outcome: 'would-copy', bytes: obj.size };
    // Contents are only compared when executing (that needs a download), but a different size is already a conflict.
    if (obj.size !== null && there.size !== obj.size) {
      return { bucket, key: obj.key, outcome: 'would-conflict', bytes: obj.size, stage: 'existing-mismatch', reason: `R2 already has an object with this key and a different size (${there.size} B in R2, ${obj.size} B in Supabase); it would be left untouched and not registered` };
    }
    return { bucket, key: obj.key, outcome: 'would-register', bytes: obj.size, reason: 'same size as the Supabase original; NOT verified, checksum comparison is pending (only done with --execute)' };
  } catch (e) {
    if (e instanceof CopyInterrupted) throw e;
    return { bucket, key: obj.key, outcome: 'failed', bytes: obj.size, stage: 'lookup', reason: msg(e) };
  }
}

async function copyOne(deps: CopyDeps, bucket: BucketName, obj: SourceObject): Promise<ObjectResult> {
  const target = deps.target!;
  const fail = (stage: CopyStage, e: unknown, bytes: number | null = obj.size): ObjectResult =>
    ({ bucket, key: obj.key, outcome: 'failed', bytes, stage, reason: typeof e === 'string' ? e : msg(e) });
  const rethrowIfInterrupted = (e: unknown) => { if (e instanceof CopyInterrupted) throw e; };

  // 1. Read the original (read-only on Supabase).
  let original: Buffer;
  try {
    original = await deps.source.download(bucket, obj.key);
  } catch (e) {
    rethrowIfInterrupted(e);
    return fail('download', e instanceof ObjectNotFoundError ? 'object is listed but could not be downloaded from Supabase' : e);
  }
  if (obj.size !== null && original.length !== obj.size) {
    return fail('size', `downloaded ${original.length} bytes but Supabase lists ${obj.size}`, original.length);
  }
  const sha256 = sha256Hex(original);
  const contentType = obj.contentType || 'application/octet-stream';

  // 2. Create-only write. An object that is already there (earlier interrupted run) is never overwritten.
  let wroteNow = false;
  try {
    await target.put(bucket, obj.key, original, { contentType });
    wroteNow = true;
  } catch (e) {
    rethrowIfInterrupted(e);
    if (!(e instanceof ObjectExistsError)) return fail('put', e, original.length);
  }

  // 3. Read it back from R2 and compare size and checksum with the Supabase original.
  let copy: Buffer;
  try {
    copy = await target.download(bucket, obj.key);
  } catch (e) {
    rethrowIfInterrupted(e);
    return fail('verify', e, original.length);
  }
  if (copy.length !== original.length || sha256Hex(copy) !== sha256) {
    return fail(wroteNow ? 'checksum' : 'existing-mismatch',
      wroteNow ? 'the copy read back from R2 differs from the Supabase original; not registered'
               : 'an object with this key already exists in R2 with different content; left untouched, not registered',
      original.length);
  }

  // 4. Register as 'r2' (insert-only). If this fails the file stays unregistered and keeps being served from Supabase.
  try {
    const inserted = await deps.registerIfAbsent({
      bucket, key: obj.key, provider: 'r2', sizeBytes: original.length, contentType, sha256, verifiedAt: (deps.now ?? Date.now)(),
    });
    if (!inserted) return { bucket, key: obj.key, outcome: 'skipped-registered', bytes: original.length, reason: 'a registry row appeared while copying; left as it is' };
  } catch (e) {
    rethrowIfInterrupted(e);
    return fail('register', e, original.length);
  }
  return { bucket, key: obj.key, outcome: wroteNow ? 'copied' : 'registered-existing', bytes: original.length };
}

/** Minimal shape of the supabase-js storage list API used to enumerate a bucket. */
export interface SupabaseListClient {
  storage: { from(bucketId: string): {
    list(path: string, opts: { limit: number; offset: number; sortBy: { column: string; order: string } }):
      Promise<{ data: { name: string; id: string | null; metadata?: { size?: number; mimetype?: string } | null }[] | null; error: { message: string } | null }>;
  } };
}

export interface ListOptions {
  /**
   * Retry policy for each listing call. A transient failure (network, HTTP 408/425/429/5xx) is retried a few times with
   * backoff; anything else fails at once. Each page is retried on its own, so a retry never repeats or skips objects.
   */
  retry?: RetryOptions;
}

/** Lists every object of a Supabase bucket under `prefix`, folders first-class, sorted by name. Read-only. */
export async function* listSupabaseObjects(client: SupabaseListClient, bucketId: string, prefix = '', options: ListOptions = {}): AsyncGenerator<SourceObject> {
  const startDir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
  async function* walk(dir: string): AsyncGenerator<SourceObject> {
    // Page until the server returns an EMPTY page, advancing by the number of items actually received. Stopping at the
    // first short page would silently drop objects if the server ever returned fewer rows than the limit we asked for.
    for (let offset = 0; ; ) {
      let items: NonNullable<Awaited<ReturnType<ReturnType<SupabaseListClient['storage']['from']>['list']>>['data']>;
      try {
        items = await retryTransient(`list ${bucketId}/${dir || '.'} offset ${offset}`, async () => {
          const { data, error } = await client.storage.from(bucketId).list(dir, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
          if (error) throw error; // keep the client's error object so it can be classified (HTTP status, or a network failure)
          return data ?? [];
        }, options.retry);
      } catch (err) {
        const detail = err instanceof RetryExhaustedError ? err.message : err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
        throw new Error(`Could not list ${bucketId}/${dir}: ${detail}`);
      }
      if (items.length === 0) return;
      for (const item of items) {
        const key = dir ? `${dir}/${item.name}` : item.name;
        if (item.id === null) yield* walk(key); // a folder
        else if (key.startsWith(prefix)) yield { key, size: item.metadata?.size ?? null, contentType: item.metadata?.mimetype ?? null };
      }
      offset += items.length;
    }
  }
  yield* walk(startDir);
}
