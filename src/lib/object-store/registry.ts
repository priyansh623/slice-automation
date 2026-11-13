import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { storageObjects } from '@/db/schema.pg';
import type { BucketName, ProviderName } from './types';

/**
 * Which provider holds a file. No row (or no table, or a database that cannot be read) means 'supabase', so a problem
 * here can never make an existing file unreachable: it fails open to where everything started.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { provider: ProviderName; at: number }>();
let lastWarn = 0;

const cacheKey = (bucket: BucketName, key: string) => `${bucket}\u0000${key}`;

export function clearLocationCache(): void {
  cache.clear();
}

export async function locate(bucket: BucketName, keys: string[]): Promise<Map<string, ProviderName>> {
  const out = new Map<string, ProviderName>();
  const now = Date.now();
  const missing: string[] = [];
  for (const key of keys) {
    const hit = cache.get(cacheKey(bucket, key));
    if (hit && now - hit.at < TTL_MS) out.set(key, hit.provider);
    else missing.push(key);
  }
  if (missing.length === 0) return out;

  let rows: { key: string; provider: string }[] = [];
  try {
    rows = await db
      .select({ key: storageObjects.key, provider: storageObjects.provider })
      .from(storageObjects)
      .where(and(eq(storageObjects.bucket, bucket), inArray(storageObjects.key, missing)));
  } catch (err) {
    if (now - lastWarn > 60_000) {
      lastWarn = now;
      console.warn('[storage] location registry unavailable, treating files as Supabase:', (err as Error).message.slice(0, 120));
    }
    // Remember the answer briefly so a missing table or an unreadable database is not queried again for every file.
    for (const key of missing) { out.set(key, 'supabase'); cache.set(cacheKey(bucket, key), { provider: 'supabase', at: now - TTL_MS + 10_000 }); }
    return out;
  }
  const found = new Map(rows.map((r) => [r.key, r.provider === 'r2' ? ('r2' as const) : ('supabase' as const)]));
  for (const key of missing) {
    const provider = found.get(key) ?? 'supabase';
    cache.set(cacheKey(bucket, key), { provider, at: now });
    out.set(key, provider);
  }
  return out;
}

export interface RegisterInput {
  bucket: BucketName;
  key: string;
  provider: ProviderName;
  sizeBytes?: number | null;
  contentType?: string | null;
  sha256?: string | null;
  verifiedAt?: number | null;
}

/** Records (or changes) where a file lives. Throws if the registry cannot be written: callers must not ignore that. */
export async function registerObject(input: RegisterInput): Promise<void> {
  const now = Date.now();
  await db
    .insert(storageObjects)
    .values({
      bucket: input.bucket, key: input.key, provider: input.provider,
      sizeBytes: input.sizeBytes ?? null, contentType: input.contentType ?? null, sha256: input.sha256 ?? null,
      verifiedAt: input.verifiedAt ?? null, createdAt: now, updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [storageObjects.bucket, storageObjects.key],
      set: {
        provider: input.provider, sizeBytes: input.sizeBytes ?? null, contentType: input.contentType ?? null,
        sha256: input.sha256 ?? null, verifiedAt: input.verifiedAt ?? null, updatedAt: now,
      },
    });
  cache.set(cacheKey(input.bucket, input.key), { provider: input.provider, at: now });
}

/**
 * Records where a file lives only when it has no row yet. An existing row is never changed, so a copy tool built on this
 * cannot overwrite, downgrade or "repair" an entry someone else made. Returns true when a row was inserted.
 * Throws if the registry cannot be written: the caller must then treat the file as not migrated.
 */
export async function registerObjectIfAbsent(input: RegisterInput): Promise<boolean> {
  const now = Date.now();
  const inserted = await db
    .insert(storageObjects)
    .values({
      bucket: input.bucket, key: input.key, provider: input.provider,
      sizeBytes: input.sizeBytes ?? null, contentType: input.contentType ?? null, sha256: input.sha256 ?? null,
      verifiedAt: input.verifiedAt ?? null, createdAt: now, updatedAt: now,
    })
    .onConflictDoNothing({ target: [storageObjects.bucket, storageObjects.key] })
    .returning({ key: storageObjects.key });
  if (inserted.length > 0) cache.set(cacheKey(input.bucket, input.key), { provider: input.provider, at: now });
  return inserted.length > 0;
}

/**
 * Exact registry rows for some keys (provider and recorded checksum/size). Unlike locate() this does NOT fail open: if the
 * registry cannot be read it throws, because a copy run must not guess which files are already migrated.
 */
export async function registeredRows(
  bucket: BucketName, keys: string[],
): Promise<Map<string, { provider: ProviderName; sha256: string | null; sizeBytes: number | null }>> {
  const out = new Map<string, { provider: ProviderName; sha256: string | null; sizeBytes: number | null }>();
  if (keys.length === 0) return out;
  const rows = await db
    .select({ key: storageObjects.key, provider: storageObjects.provider, sha256: storageObjects.sha256, sizeBytes: storageObjects.sizeBytes })
    .from(storageObjects)
    .where(and(eq(storageObjects.bucket, bucket), inArray(storageObjects.key, keys)));
  for (const r of rows) out.set(r.key, { provider: r.provider === 'r2' ? 'r2' : 'supabase', sha256: r.sha256, sizeBytes: r.sizeBytes });
  return out;
}
