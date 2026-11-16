import { NextResponse } from 'next/server';
import { studioRoute, parseId, serializeJobs } from '@/lib/studio/api';
import { getBatchView } from '@/lib/studio/batches';

// A batch with every job (all attempts), each with its own status, error, provider job id and outputs.
export const GET = studioRoute<{ id: string; batchId: string }>(async ({ params }) => {
  const view = await getBatchView(parseId(params.id), parseId(params.batchId));
  return NextResponse.json({
    batch: { id: view.batch.id, provider: view.batch.provider, totalJobs: view.batch.totalJobs, createdAt: view.batch.createdAt, createdBy: view.batch.createdBy },
    summary: view.summary, jobs: await serializeJobs(view.jobs),
  });
});
