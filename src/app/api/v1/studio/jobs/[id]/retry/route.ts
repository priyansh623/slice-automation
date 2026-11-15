import { NextResponse } from 'next/server';
import { studioRoute, parseId, serializeJobs } from '@/lib/studio/api';
import { getBatchView, retryJob } from '@/lib/studio/batches';

// Retries ONE failed job: a new job for that image only, linked to the failed one. The rest of the batch is untouched.
export const POST = studioRoute<{ id: string }>(async ({ params, user }) => {
  const created = await retryJob(parseId(params.id), user.id);
  const view = await getBatchView(created.projectId, created.batchId);
  const job = view.jobs.find((j) => j.job.id === created.id)!;
  return NextResponse.json({ job: (await serializeJobs([job]))[0], summary: view.summary }, { status: 201 });
});
