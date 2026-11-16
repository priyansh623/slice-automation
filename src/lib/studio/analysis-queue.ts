/**
 * The analysis queue: studio_assets rows whose analysis_status is pending. State lives on the asset row (like B-roll's
 * processing_status): pending -> processing (claimed, with a lease) -> completed | failed. Failed images stay visible and can
 * be retried by re-analysis. Writing a result only ever replaces the AI column of studio_asset_metadata, never `manual`.
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssetMetadata, studioAssets, studioPacks } from '@/db/schema.pg';
import { ANALYSIS_VERSION } from './analysis-schema';
import type { MetadataRecord } from './metadata';

export const ANALYSIS_LEASE_MS = 10 * 60 * 1000;
/** After this many interrupted attempts an image is marked failed instead of being queued again. */
export const MAX_ANALYSIS_ATTEMPTS = 3;

export type ClaimedAsset = typeof studioAssets.$inferSelect;

/**
 * Takes the oldest pending, non-archived image for analysis. One atomic statement: two callers can never get the same
 * image (SKIP LOCKED), and the lease starts now.
 */
export async function claimNextAsset(now = Date.now()): Promise<ClaimedAsset | null> {
  const rows = await db
    .update(studioAssets)
    .set({ analysisStatus: 'processing', claimedAt: now, analysisAttempts: sql`${studioAssets.analysisAttempts} + 1`, updatedAt: now })
    .where(and(
      eq(studioAssets.analysisStatus, 'pending'),
      isNull(studioAssets.archivedAt),
      eq(studioAssets.id, sql`(select id from studio_assets where analysis_status = 'pending' and archived_at is null order by id limit 1 for update skip locked)`),
    ))
    .returning();
  return rows[0] ?? null;
}

/** Keeps the lease alive while the model is working. */
export async function heartbeat(assetId: number, now = Date.now()): Promise<void> {
  await db.update(studioAssets).set({ claimedAt: now }).where(and(eq(studioAssets.id, assetId), eq(studioAssets.analysisStatus, 'processing')));
}

/** Stores the model's answer. Replaces `ai` (and its provenance columns) only; `manual` is never read or written here. */
export async function completeAnalysis(asset: ClaimedAsset, ai: MetadataRecord, model: string, now = Date.now()): Promise<void> {
  await db.insert(studioAssetMetadata)
    .values({ assetId: asset.id, ai, manual: {}, aiModel: model, aiVersion: ANALYSIS_VERSION, aiAnalyzedAt: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: studioAssetMetadata.assetId, set: { ai, aiModel: model, aiVersion: ANALYSIS_VERSION, aiAnalyzedAt: now, updatedAt: now } });
  // Only if nobody queued it again meanwhile (a new re-analysis request sets it back to pending and is handled next).
  await db.update(studioAssets).set({ analysisStatus: 'completed', analysisError: null, claimedAt: null, updatedAt: now })
    .where(and(eq(studioAssets.id, asset.id), eq(studioAssets.analysisStatus, 'processing')));
  await db.update(studioPacks).set({ profileStale: true, updatedAt: now }).where(eq(studioPacks.id, asset.packId));
}

export async function failAnalysis(asset: ClaimedAsset, message: string, now = Date.now()): Promise<void> {
  await db.update(studioAssets).set({ analysisStatus: 'failed', analysisError: message.slice(0, 300), claimedAt: null, updatedAt: now })
    .where(and(eq(studioAssets.id, asset.id), eq(studioAssets.analysisStatus, 'processing')));
}

/**
 * Images left 'processing' past their lease (the worker restarted or crashed) go back to pending, or to failed after too many
 * interrupted attempts. Re-analysing is safe: it only replaces the AI column.
 */
export async function recoverStaleAnalysis(now = Date.now(), leaseMs = ANALYSIS_LEASE_MS): Promise<{ requeued: number; failed: number }> {
  const stale = and(eq(studioAssets.analysisStatus, 'processing'), lt(studioAssets.claimedAt, now - leaseMs));
  const failed = await db.update(studioAssets)
    .set({ analysisStatus: 'failed', analysisError: 'Analysis was interrupted several times. Press re-analyse to try again.', claimedAt: null, updatedAt: now })
    .where(and(stale, sql`${studioAssets.analysisAttempts} >= ${MAX_ANALYSIS_ATTEMPTS}`)).returning({ id: studioAssets.id });
  const requeued = await db.update(studioAssets)
    .set({ analysisStatus: 'pending', claimedAt: null, updatedAt: now })
    .where(stale).returning({ id: studioAssets.id });
  return { requeued: requeued.length, failed: failed.length };
}

/**
 * Gives a claimed image back (the worker is shutting down): it returns to pending at once instead of waiting out its lease, and the
 * interrupted attempt is not counted against it because the image was not at fault.
 */
export async function releaseClaim(assetId: number, now = Date.now()): Promise<boolean> {
  const rows = await db.update(studioAssets)
    .set({ analysisStatus: 'pending', claimedAt: null, analysisAttempts: sql`greatest(${studioAssets.analysisAttempts} - 1, 0)`, updatedAt: now })
    .where(and(eq(studioAssets.id, assetId), eq(studioAssets.analysisStatus, 'processing'))).returning({ id: studioAssets.id });
  return rows.length > 0;
}
