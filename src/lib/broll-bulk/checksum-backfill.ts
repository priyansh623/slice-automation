import { and, asc, eq, isNull } from 'drizzle-orm';
import { brollClips, storageObjects } from '@/db/schema.pg';
import type { BrollDb } from '@/lib/broll-db';

/**
 * Records the SHA-256 of existing B-roll objects that never had one, so exact-duplicate detection can recognise them.
 *
 * Safety rules, enforced here and tested:
 *  - Reading only: each object is streamed from R2 through SHA-256 and discarded. Nothing is downloaded to disk.
 *  - The ONLY write is filling an empty `storage_objects.sha256` (plus verified_at / updated_at). An existing checksum is never
 *    replaced, and clip rows, R2 objects and Supabase objects are never touched.
 *  - A checksum is only recorded when the streamed byte count equals both the registry size and the clip's recorded size.
 *  - Without `execute` nothing is written at all. Safe to re-run: finished rows are no longer candidates.
 */
export interface BackfillCandidate {
  clipId: number; title: string; key: string; provider: string;
  registrySize: number | null; clipSize: number | null;
}

export async function findBackfillCandidates(db: BrollDb): Promise<BackfillCandidate[]> {
  const rows = await db
    .select({ clipId: brollClips.id, title: brollClips.title, key: brollClips.storagePath, provider: storageObjects.provider, registrySize: storageObjects.sizeBytes, clipSize: brollClips.fileSizeBytes })
    .from(brollClips)
    .innerJoin(storageObjects, and(eq(storageObjects.bucket, 'uploads'), eq(storageObjects.key, brollClips.storagePath)))
    .where(isNull(storageObjects.sha256))
    .orderBy(asc(brollClips.id));
  return rows;
}

export type BackfillOutcome = 'recorded' | 'verified' | 'would-hash' | 'size-mismatch' | 'not-on-r2' | 'hash-failed' | 'already-set';
export interface BackfillResult { candidate: BackfillCandidate; outcome: BackfillOutcome; sha256?: string; bytes?: number; detail?: string }

export interface BackfillDeps {
  /** Streams the object through SHA-256. Must throw if it cannot be read completely. */
  hash(key: string): Promise<{ sha256: string; size: number }>;
  /** Fills the checksum only where it is still empty. Returns false if nothing was updated (someone else filled it first). */
  record(key: string, sha256: string, now: number): Promise<boolean>;
  log?: (line: string) => void;
}

export interface BackfillOptions {
  /** Read each object and compare, but write nothing (default for the script). */
  hash: boolean;
  /** Also write the checksums. Implies hashing. */
  execute: boolean;
}

export async function runBackfill(candidates: BackfillCandidate[], deps: BackfillDeps, opts: BackfillOptions, now = Date.now()): Promise<BackfillResult[]> {
  const out: BackfillResult[] = [];
  for (const c of candidates) {
    const push = (r: Omit<BackfillResult, 'candidate'>) => { out.push({ candidate: c, ...r }); deps.log?.(`${r.outcome.padEnd(13)} clip ${c.clipId} ${c.key}${r.detail ? ` - ${r.detail}` : ''}`); };
    if (c.provider !== 'r2') { push({ outcome: 'not-on-r2', detail: `registry says ${c.provider}` }); continue; }
    if (!opts.hash && !opts.execute) { push({ outcome: 'would-hash', bytes: c.registrySize ?? c.clipSize ?? undefined }); continue; }
    let h: { sha256: string; size: number };
    try { h = await deps.hash(c.key); }
    catch (e) { push({ outcome: 'hash-failed', detail: (e as Error).message.slice(0, 120) }); continue; }
    const expectedSizes = [c.registrySize, c.clipSize].filter((x): x is number => x !== null);
    if (expectedSizes.some((s) => s !== h.size)) { push({ outcome: 'size-mismatch', bytes: h.size, detail: `read ${h.size} B, recorded ${expectedSizes.join(' / ')} B` }); continue; }
    if (!opts.execute) { push({ outcome: 'verified', sha256: h.sha256, bytes: h.size }); continue; }
    const wrote = await deps.record(c.key, h.sha256, now);
    push({ outcome: wrote ? 'recorded' : 'already-set', sha256: h.sha256, bytes: h.size });
  }
  return out;
}

/** The one write the backfill ever makes. */
export async function recordChecksum(db: BrollDb, key: string, sha256: string, now = Date.now()): Promise<boolean> {
  const rows = await db.update(storageObjects)
    .set({ sha256, verifiedAt: now, updatedAt: now })
    .where(and(eq(storageObjects.bucket, 'uploads'), eq(storageObjects.key, key), isNull(storageObjects.sha256)))
    .returning({ key: storageObjects.key });
  return rows.length > 0;
}
