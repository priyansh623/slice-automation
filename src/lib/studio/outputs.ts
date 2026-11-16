/**
 * Generated images and their review. An output is never deleted or overwritten. "Saved" means kept permanently in the project,
 * with everything that produced it linked: the source image and its pack, the character image used, the job (and the attempt it
 * was) and the batch. "Rejected" just records the decision; the file and its history stay. A saved or rejected output can be set
 * back to pending.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssets, studioBatches, studioJobs, studioOutputs, studioPacks } from '@/db/schema.pg';
import { getProject } from './projects';
import { StudioError } from './repository';

export type ReviewStatus = 'pending' | 'saved' | 'rejected';
export const REVIEW_STATUSES: readonly ReviewStatus[] = ['pending', 'saved', 'rejected'];

export interface OutputView {
  output: typeof studioOutputs.$inferSelect;
  job: typeof studioJobs.$inferSelect;
  batch: typeof studioBatches.$inferSelect;
  asset: typeof studioAssets.$inferSelect;
  packName: string;
}

const outputSelect = () => db
  .select({ output: studioOutputs, job: studioJobs, batch: studioBatches, asset: studioAssets, packName: studioPacks.name })
  .from(studioOutputs)
  .innerJoin(studioJobs, eq(studioJobs.id, studioOutputs.jobId))
  .innerJoin(studioBatches, eq(studioBatches.id, studioJobs.batchId))
  .innerJoin(studioAssets, eq(studioAssets.id, studioOutputs.assetId))
  .innerJoin(studioPacks, eq(studioPacks.id, studioAssets.packId));

export async function listOutputs(projectId: number, opts: { status?: string } = {}): Promise<OutputView[]> {
  await getProject(projectId);
  if (opts.status !== undefined && !REVIEW_STATUSES.includes(opts.status as ReviewStatus)) throw new StudioError('Unknown status filter.', 400, 'invalid_status');
  return outputSelect()
    .where(opts.status ? and(eq(studioOutputs.projectId, projectId), eq(studioOutputs.reviewStatus, opts.status)) : eq(studioOutputs.projectId, projectId))
    .orderBy(desc(studioOutputs.id));
}

/** One output with everything linked to it, in a single query (never by loading the whole project's outputs). */
export async function getOutputView(outputId: number): Promise<OutputView> {
  const row = (await outputSelect().where(eq(studioOutputs.id, outputId)).limit(1))[0];
  if (!row) throw new StudioError('Output not found.', 404, 'output_not_found');
  return row;
}

export async function reviewOutput(outputId: number, status: unknown, userId: string): Promise<OutputView> {
  if (typeof status !== 'string' || !REVIEW_STATUSES.includes(status as ReviewStatus)) throw new StudioError('status must be pending, saved or rejected.', 400, 'invalid_status');
  await getOutputView(outputId); // 404 if it does not exist
  const now = Date.now();
  await db.update(studioOutputs).set({ reviewStatus: status, reviewedBy: status === 'pending' ? null : userId, reviewedAt: status === 'pending' ? null : now }).where(eq(studioOutputs.id, outputId));
  return getOutputView(outputId);
}

/** Counts per review status for a project (for the tab badges). */
export async function reviewCounts(projectId: number): Promise<Record<ReviewStatus, number>> {
  const rows = await db.select({ s: studioOutputs.reviewStatus }).from(studioOutputs).where(eq(studioOutputs.projectId, projectId));
  const out: Record<ReviewStatus, number> = { pending: 0, saved: 0, rejected: 0 };
  for (const r of rows) out[r.s as ReviewStatus]++;
  return out;
}

