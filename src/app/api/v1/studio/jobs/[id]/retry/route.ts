import { NextResponse } from 'next/server';
import { studioRoute, parseId, serializeJobs } from '@/lib/studio/api';
import { getBatchView, retryJob } from '@/lib/studio/batches';

// Retries ONE failed job: a new job for that image only, linked to the failed one. The rest of the batch is untouched.
// A job whose submission outcome is unknown ("submit_unknown") is only retried with { "confirmDuplicate": true }, because the
// provider may already be generating it and the image could be paid for twice.
export const POST = studioRoute<{ id: string }>(async ({ req, params, user }) => {
  let body: Record<string, unknown> = {};
  try { const raw = await req.json(); if (raw && typeof raw === 'object' && !Array.isArray(raw)) body = raw as Record<string, unknown>; } catch { /* no body */ }
  const created = await retryJob(parseId(params.id), user.id, { confirmDuplicate: body.confirmDuplicate === true });
  const view = await getBatchView(created.projectId, created.batchId);
  const job = view.jobs.find((j) => j.job.id === created.id)!;
  return NextResponse.json({ job: (await serializeJobs([job]))[0], summary: view.summary }, { status: 201 });
});
