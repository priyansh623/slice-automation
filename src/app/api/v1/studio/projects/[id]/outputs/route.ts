import { NextResponse } from 'next/server';
import { studioRoute, parseId, serializeOutputs } from '@/lib/studio/api';
import { listOutputs, reviewCounts } from '@/lib/studio/outputs';

// Every generated image of the project (?status=pending|saved|rejected to filter), newest first, each linked to its source
// image and pack, the character used, its job and its batch.
export const GET = studioRoute<{ id: string }>(async ({ req, params }) => {
  const projectId = parseId(params.id);
  const outputs = await listOutputs(projectId, { status: req.nextUrl.searchParams.get('status') ?? undefined });
  return NextResponse.json({ outputs: await serializeOutputs(outputs), counts: await reviewCounts(projectId) });
});
