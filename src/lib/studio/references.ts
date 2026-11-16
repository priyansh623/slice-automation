/**
 * Whether anything in the Studio still points at a stored file, and the ONE way a stored file may be removed from R2.
 *
 * Removal is race-safe by construction, not by checking twice:
 *   1. one short transaction takes the key's EXCLUSIVE advisory lock, checks every reference, and (only if there is none) writes a
 *      permanent tombstone for the key (studio_deleted_keys), then commits;
 *   2. only after that commit is the object deleted from R2;
 *   3. a database trigger (migration 0026) refuses to register any key that has a tombstone, and takes the same lock in SHARED
 *      mode for the life of the registering transaction.
 * So a registration either commits before the check (the check sees it and nothing is removed) or comes after the tombstone (the
 * registration fails). There is no window in which a registered file can be deleted. Repeating a removal is harmless: the tombstone
 * is kept, the R2 delete is idempotent.
 */
import { eq, isNull, lt, and, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssets, studioBatches, studioDeletedKeys, studioJobs, studioOutputs, studioProjects, studioUploadIntents } from '@/db/schema.pg';
import { getStorage } from '@/lib/object-store';
import { assetThumbKey, characterThumbKey, STUDIO_UPLOAD_TTL_S } from './keys';

/** Anything we can run a select on: the database or a transaction. */
type Exec = Pick<typeof db, 'select'>;

/** How long after an upload link expires an unused upload is left alone before it is swept. */
export const ABANDONED_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;

/** True if the error came from the database refusing to register a key that was already removed. */
export function isRemovedKeyError(err: unknown): boolean {
  for (let e = err as { message?: string; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (typeof e.message === 'string' && e.message.includes('studio_key_removed')) return true;
  }
  return false;
}

/**
 * The original(s) a thumbnail key belongs to. A thumbnail is derived from its original's key and is not always stored in a table
 * (a character's is not), so a thumbnail is protected whenever its original is.
 */
export function originalsOfThumb(key: string): string[] {
  const m = /^(studio\/assets|studio\/projects\/\d+\/character|studio\/projects\/\d+\/outputs)\/thumbs\/([^/]+)\.webp$/.exec(key);
  return m ? ['jpg', 'png', 'webp'].map((ext) => `${m[1]}/${m[2]}.${ext}`) : [];
}

/**
 * True if the key is registered or used anywhere: an asset (original or thumbnail), a project's character, a batch or job snapshot,
 * an output, or a key the server issued and that was registered at any time (a character image that was later replaced is
 * history, not an orphan).
 */
export async function isKeyReferenced(key: string, exec: Exec = db): Promise<boolean> {
  if (await isDirectlyReferenced(key, exec)) return true;
  for (const original of originalsOfThumb(key)) if (await isDirectlyReferenced(original, exec)) return true;
  return false;
}

async function isDirectlyReferenced(key: string, exec: Exec): Promise<boolean> {
  const checks = [
    exec.select({ id: studioAssets.id }).from(studioAssets).where(or(eq(studioAssets.storageKey, key), eq(studioAssets.thumbKey, key))).limit(1),
    exec.select({ id: studioProjects.id }).from(studioProjects).where(eq(studioProjects.characterKey, key)).limit(1),
    exec.select({ id: studioBatches.id }).from(studioBatches).where(eq(studioBatches.characterKey, key)).limit(1),
    exec.select({ id: studioJobs.id }).from(studioJobs).where(or(eq(studioJobs.sourceKey, key), eq(studioJobs.characterKey, key))).limit(1),
    exec.select({ id: studioOutputs.id }).from(studioOutputs).where(or(eq(studioOutputs.storageKey, key), eq(studioOutputs.thumbKey, key))).limit(1),
    exec.select({ key: studioUploadIntents.key }).from(studioUploadIntents).where(and(eq(studioUploadIntents.key, key), eq(studioUploadIntents.state, 'registered'))).limit(1),
  ];
  for (const rows of await Promise.all(checks)) if (rows.length > 0) return true;
  return false;
}

export interface DiscardHooks {
  /** Tests only: runs after the tombstone is committed and before R2 is touched (the old race window). */
  afterTombstone?: () => Promise<void>;
}

/**
 * Removes a file from R2 only if nothing references it. Returns true if it is (now) gone, false if it was kept (referenced) or the
 * R2 delete did not succeed yet (it is retried by retryPendingRemovals). A referenced file is never touched.
 */
export async function discardIfUnreferenced(key: string, reason = 'rejected upload', hooks: DiscardHooks = {}): Promise<boolean> {
  const approved = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    if (await isKeyReferenced(key, tx as unknown as Exec)) return false;
    await tx.insert(studioDeletedKeys).values({ key, reason: reason.slice(0, 100), requestedAt: Date.now() }).onConflictDoNothing();
    return true;
  });
  if (!approved) return false;
  await hooks.afterTombstone?.();
  return removeTombstoned(key);
}

/** Deletes the R2 object of a key that already has a tombstone (the tombstone is what makes this safe) and records it. */
async function removeTombstoned(key: string): Promise<boolean> {
  try {
    await getStorage().deleteFromR2('uploads', key);
    await db.update(studioDeletedKeys).set({ removedAt: Date.now() }).where(and(eq(studioDeletedKeys.key, key), isNull(studioDeletedKeys.removedAt)));
    return true;
  } catch (err) {
    console.warn('[studio] could not remove a file yet (it will be retried):', (err as Error).message.slice(0, 120));
    return false;
  }
}

/** Retries removals whose tombstone is committed but whose R2 delete did not complete. Safe to run any time, any number of times. */
export async function retryPendingRemovals(limit = 50): Promise<number> {
  const rows = await db.select({ key: studioDeletedKeys.key }).from(studioDeletedKeys).where(isNull(studioDeletedKeys.removedAt)).limit(limit);
  let done = 0;
  for (const r of rows) if (await removeTombstoned(r.key)) done++;
  return done;
}

/**
 * Records that the server is about to hand out an upload link for this key. Done BEFORE the link is signed, so every key that can
 * exist in R2 has an intent. A trigger flips it to 'registered' in the transaction that registers it.
 */
export async function recordUploadIntent(key: string, kind: 'asset' | 'character', ids: { projectId?: number; packId?: number; userId?: string | null }): Promise<void> {
  await db.insert(studioUploadIntents).values({ key, kind, projectId: ids.projectId ?? null, packId: ids.packId ?? null, createdBy: ids.userId ?? null, issuedAt: Date.now() }).onConflictDoNothing();
}

/**
 * Removes uploads that were handed out and never used. Only keys whose intent is still 'issued' and whose upload link expired more
 * than a day ago are considered, and each one goes through discardIfUnreferenced, so a registered original, a replaced character,
 * a job input or an output can never be removed. Nothing is listed in R2: only keys this server issued are ever touched.
 */
export async function sweepAbandonedUploads(now = Date.now(), opts: { limit?: number; graceMs?: number } = {}): Promise<{ removed: number; kept: number }> {
  const cutoff = now - STUDIO_UPLOAD_TTL_S * 1000 - (opts.graceMs ?? ABANDONED_UPLOAD_GRACE_MS);
  const open = await db.select({ key: studioUploadIntents.key, kind: studioUploadIntents.kind }).from(studioUploadIntents)
    .where(and(eq(studioUploadIntents.state, 'issued'), lt(studioUploadIntents.issuedAt, cutoff))).orderBy(studioUploadIntents.issuedAt).limit(opts.limit ?? 100);
  let removed = 0; let kept = 0;
  for (const intent of open) {
    const thumb = intent.kind === 'asset' ? assetThumbKey(intent.key) : characterThumbKey(intent.key);
    const original = await discardIfUnreferenced(intent.key, 'abandoned upload');
    // The thumbnail goes only with its original: a kept original (it is referenced) keeps whatever thumbnail belongs to it.
    if (original && thumb) await discardIfUnreferenced(thumb, 'abandoned upload thumbnail');
    if (original) { removed++; await db.delete(studioUploadIntents).where(and(eq(studioUploadIntents.key, intent.key), eq(studioUploadIntents.state, 'issued'))); } else kept++;
  }
  return { removed, kept };
}
