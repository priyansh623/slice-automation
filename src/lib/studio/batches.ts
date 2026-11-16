/**
 * A batch turns the selected images into independent jobs: ONE job per image, each with its own status, provider job id, error
 * and output. Jobs are never edited into a new attempt; a retry is a NEW job row linked to the failed one, so history is kept
 * and retrying one image never touches the others.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssets, studioBatches, studioJobs, studioOutputs, studioProjects, studioSelections } from '@/db/schema.pg';
import { getProject } from './projects';
import { assertGenerationReady } from './readiness';
import { StudioError } from './repository';

export const maxBatchJobs = (): number => { const n = parseInt(process.env.STUDIO_MAX_BATCH ?? '50', 10); return Number.isFinite(n) && n > 0 ? n : 50; };
/** 'submit_unknown' counts as active: the provider may be running (and charging for) that job, so no second job is queued for the image. */
export const ACTIVE_JOB_STATUSES = ['queued', 'submitting', 'submit_unknown', 'processing'] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Creates a batch from the project's selection (or from a chosen part of it) and queues one job per image. */
export async function createBatch(projectId: number, userId: string, opts: { assetIds?: unknown } = {}) {
  await getProject(projectId);
  // No provider, no worker, or a worker that uses a different provider: no batch. Nothing is queued that could only sit waiting.
  const providerId: string = (await assertGenerationReady()).config.provider;
  return db.transaction(async (tx: Tx) => {
    // One batch is created at a time per project, so a double click cannot queue the same images twice.
    const project = (await tx.select().from(studioProjects).where(eq(studioProjects.id, projectId)).for('update'))[0];
    if (!project) throw new StudioError('Project not found.', 404, 'project_not_found');
    if (!project.characterKey) throw new StudioError('Upload the base character image first.', 400, 'character_required');

    let rows = await tx.select({ sel: studioSelections, asset: studioAssets }).from(studioSelections).innerJoin(studioAssets, eq(studioAssets.id, studioSelections.assetId)).where(eq(studioSelections.projectId, projectId)).orderBy(asc(studioSelections.addedAt), asc(studioSelections.assetId));
    if (opts.assetIds !== undefined) {
      const ids = opts.assetIds;
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'number' && Number.isInteger(x))) throw new StudioError('assetIds must be a list of image ids.', 400, 'invalid_ids');
      const wanted = new Set(ids as number[]);
      const missing = [...wanted].filter((id) => !rows.some((r) => r.sel.assetId === id));
      if (missing.length) throw new StudioError('Some of those images are not in the selection.', 409, 'not_selected');
      rows = rows.filter((r) => wanted.has(r.sel.assetId));
    }
    if (rows.length === 0) throw new StudioError('Select at least one image first.', 400, 'empty_selection');
    if (rows.length > maxBatchJobs()) throw new StudioError(`A batch can hold at most ${maxBatchJobs()} images. Select fewer, or submit in parts.`, 409, 'batch_too_large');
    const archived = rows.filter((r) => r.asset.archivedAt !== null);
    if (archived.length > 0) {
      throw Object.assign(new StudioError(`${archived.length} selected image${archived.length === 1 ? ' is' : 's are'} archived and cannot be generated. Remove ${archived.length === 1 ? 'it' : 'them'} from the selection first.`, 409, 'archived_in_selection'), { archivedIds: archived.map((r) => r.sel.assetId) });
    }

    // An image that already has a job running in this project is not queued a second time (a double click, or submitting again too soon).
    const running = await tx.select({ assetId: studioJobs.assetId }).from(studioJobs).where(and(eq(studioJobs.projectId, projectId), inArray(studioJobs.assetId, rows.map((r) => r.sel.assetId)), inArray(studioJobs.status, [...ACTIVE_JOB_STATUSES])));
    if (running.length > 0) {
      throw Object.assign(new StudioError(`${new Set(running.map((r) => r.assetId)).size} of these images ${new Set(running.map((r) => r.assetId)).size === 1 ? 'is' : 'are'} already being generated. Wait for ${new Set(running.map((r) => r.assetId)).size === 1 ? 'it' : 'them'} to finish, or select other images.`, 409, 'already_running'), { archivedIds: undefined });
    }

    const now = Date.now();
    const provider = providerId;
    const [batch] = await tx.insert(studioBatches).values({ projectId, createdBy: userId, provider, providerConfig: {}, characterKey: project.characterKey, totalJobs: rows.length, createdAt: now }).returning();
    const jobs = await tx.insert(studioJobs).values(rows.map((r) => ({
      batchId: batch.id, projectId, assetId: r.sel.assetId, packId: r.sel.packId, sourceKey: r.asset.storageKey, characterKey: project.characterKey!,
      provider, status: 'queued', attempt: 1, createdBy: userId, createdAt: now, updatedAt: now,
    }))).returning();
    return { batch, jobs };
  });
}

/**
 * Retries ONE failed job, or (with `allowSucceeded`) generates one image again from a job that succeeded: a new job for the
 * same image in the same batch, linked to the earlier one. The earlier job and its outputs are kept, saved ones included.
 * Nothing else is touched.
 */
export async function retryJob(jobId: number, userId: string, opts: { allowSucceeded?: boolean; confirmDuplicate?: boolean } = {}) {
  // Checked BEFORE the transaction opens (it reads other tables, and a transaction should not wait on a second connection).
  const ready = await assertGenerationReady();
  return db.transaction(async (tx: Tx) => {
    const job = (await tx.select().from(studioJobs).where(eq(studioJobs.id, jobId)).for('update'))[0];
    if (!job) throw new StudioError('Job not found.', 404, 'job_not_found');
    // A job whose submission outcome is unknown may already be running at the provider. A new job for the same image can only be
    // created if the person explicitly accepts that it may be paid for twice; the unknown job is then closed (it is never deleted).
    if (job.status === 'submit_unknown' && !opts.allowSucceeded) {
      if (opts.confirmDuplicate !== true) {
        throw new StudioError('The provider may already be generating this image (the answer to the request was never received). Generating it again could be charged twice. Wait for it, or confirm to generate it again anyway.', 409, 'submit_unknown');
      }
      const closed = await tx.update(studioJobs).set({ status: 'failed', errorCode: 'submit_unknown_abandoned', errorMessage: 'Closed by a person who chose to generate this image again. The provider may still have run it.', errorRetryable: true, claimedAt: null, nextPollAt: null, finishedAt: Date.now(), updatedAt: Date.now() })
        .where(and(eq(studioJobs.id, job.id), eq(studioJobs.status, 'submit_unknown'))).returning({ id: studioJobs.id });
      if (closed.length === 0) throw new StudioError('This job changed while you were deciding. Reload and look again.', 409, 'job_changed');
      job.status = 'failed'; job.errorRetryable = true;
    }
    if (job.status !== 'failed' && !(opts.allowSucceeded && job.status === 'succeeded')) {
      throw new StudioError(opts.allowSucceeded ? 'Only a finished job can be generated again.' : 'Only a failed job can be retried.', 409, 'not_failed');
    }
    // A failure that retrying cannot fix (a bad input, a provider that rejects the image) is not retried automatically or by hand:
    // the person is told to change the input instead. Regenerating a SUCCEEDED job is a different, deliberate action.
    if (job.status === 'failed' && job.errorRetryable === false) {
      throw new StudioError(`This job failed in a way that retrying cannot fix${job.errorMessage ? ` (${job.errorMessage})` : ''}. Change the image or the character and generate it again from the selection.`, 409, 'not_retryable');
    }
    // A retry goes to the provider the batch was created with, and only if that provider is the one the server runs now and a
    // worker that uses it is ready.
    if (job.provider !== ready.config.provider) throw new StudioError(`This job was made with the "${job.provider}" provider, but the server now uses "${ready.config.provider}". Select the image again and generate it as a new job.`, 409, 'provider_changed');
    const asset = (await tx.select().from(studioAssets).where(eq(studioAssets.id, job.assetId)))[0];
    if (asset?.archivedAt) throw new StudioError('This image is archived, so it cannot be generated again. Restore it first.', 409, 'asset_archived');
    const latest = (await tx.select({ attempt: sql<number>`max(${studioJobs.attempt})`.mapWith(Number) }).from(studioJobs).where(and(eq(studioJobs.batchId, job.batchId), eq(studioJobs.assetId, job.assetId))))[0];
    const active = await tx.select({ id: studioJobs.id }).from(studioJobs).where(and(eq(studioJobs.batchId, job.batchId), eq(studioJobs.assetId, job.assetId), inArray(studioJobs.status, [...ACTIVE_JOB_STATUSES])));
    if (active.length > 0) throw new StudioError('This image already has a job running.', 409, 'already_active');
    if ((latest?.attempt ?? 1) !== job.attempt) throw new StudioError('This job was already retried.', 409, 'already_retried');
    const now = Date.now();
    const [created] = await tx.insert(studioJobs).values({
      batchId: job.batchId, projectId: job.projectId, assetId: job.assetId, packId: job.packId, sourceKey: job.sourceKey, characterKey: job.characterKey,
      provider: job.provider, status: 'queued', attempt: job.attempt + 1, retryOfJobId: job.id, createdBy: userId, createdAt: now, updatedAt: now,
    }).returning();
    return created;
  });
}

export interface JobView {
  job: typeof studioJobs.$inferSelect;
  asset: typeof studioAssets.$inferSelect;
  outputs: Array<typeof studioOutputs.$inferSelect>;
}

export async function getBatchView(projectId: number, batchId: number) {
  const batch = (await db.select().from(studioBatches).where(and(eq(studioBatches.id, batchId), eq(studioBatches.projectId, projectId))).limit(1))[0];
  if (!batch) throw new StudioError('Batch not found.', 404, 'batch_not_found');
  const jobs = await db.select({ job: studioJobs, asset: studioAssets }).from(studioJobs).innerJoin(studioAssets, eq(studioAssets.id, studioJobs.assetId)).where(eq(studioJobs.batchId, batchId)).orderBy(asc(studioJobs.assetId), asc(studioJobs.attempt));
  const outputs = jobs.length ? await db.select().from(studioOutputs).where(inArray(studioOutputs.jobId, jobs.map((j) => j.job.id))).orderBy(asc(studioOutputs.id)) : [];
  const views: JobView[] = jobs.map((j) => ({ job: j.job, asset: j.asset, outputs: outputs.filter((o) => o.jobId === j.job.id) }));
  return { batch, jobs: views, summary: summarise(views.map((v) => v.job)) };
}

/** Counts per status of the LATEST attempt of each image (an old failed attempt that was retried does not count as failed). */
export function summarise(jobs: Array<Pick<typeof studioJobs.$inferSelect, 'assetId' | 'attempt' | 'status'>>) {
  const latest = new Map<number, (typeof jobs)[number]>();
  for (const j of jobs) { const cur = latest.get(j.assetId); if (!cur || j.attempt > cur.attempt) latest.set(j.assetId, j); }
  const out = { total: latest.size, queued: 0, submitting: 0, submit_unknown: 0, processing: 0, succeeded: 0, failed: 0, canceled: 0 };
  for (const j of latest.values()) out[j.status as keyof typeof out] = ((out[j.status as keyof typeof out] as number) ?? 0) + 1;
  return out;
}

export async function listBatches(projectId: number) {
  await getProject(projectId);
  const batches = await db.select().from(studioBatches).where(eq(studioBatches.projectId, projectId)).orderBy(desc(studioBatches.id));
  if (batches.length === 0) return [];
  const jobs = await db.select({ batchId: studioJobs.batchId, assetId: studioJobs.assetId, attempt: studioJobs.attempt, status: studioJobs.status }).from(studioJobs).where(inArray(studioJobs.batchId, batches.map((b) => b.id)));
  return batches.map((b) => ({ batch: b, summary: summarise(jobs.filter((j) => j.batchId === b.id)) }));
}
