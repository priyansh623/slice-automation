import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId, serializeJobs } from '@/lib/studio/api';
import { createBatch, getBatchView, listBatches } from '@/lib/studio/batches';
import { StudioError } from '@/lib/studio/repository';

export const GET = studioRoute<{ id: string }>(async ({ params }) => {
  const batches = await listBatches(parseId(params.id));
  return NextResponse.json({ batches: batches.map((b) => ({ id: b.batch.id, provider: b.batch.provider, totalJobs: b.batch.totalJobs, createdAt: b.batch.createdAt, createdBy: b.batch.createdBy, summary: b.summary })) });
});

// Submits the selection (or { assetIds: [...] }, a part of it) as a batch: ONE independent job per image, queued for the worker.
export const POST = studioRoute<{ id: string }>(async ({ req, params, user }) => {
  const projectId = parseId(params.id);
  const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
  try {
    const { batch } = await createBatch(projectId, user.id, { assetIds: body.assetIds });
    const view = await getBatchView(projectId, batch.id);
    return NextResponse.json({ batch: { id: batch.id, provider: batch.provider, totalJobs: batch.totalJobs, createdAt: batch.createdAt }, summary: view.summary, jobs: await serializeJobs(view.jobs) }, { status: 201 });
  } catch (err) {
    if (err instanceof StudioError && (err as StudioError & { archivedIds?: number[] }).archivedIds) {
      return NextResponse.json({ error: err.message, code: err.code, archivedIds: (err as StudioError & { archivedIds?: number[] }).archivedIds }, { status: err.status });
    }
    throw err;
  }
});
