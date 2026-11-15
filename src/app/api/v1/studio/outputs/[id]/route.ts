import { NextResponse } from 'next/server';
import { studioRoute, parseId, serializeOutputs } from '@/lib/studio/api';
import { getOutputView } from '@/lib/studio/outputs';

// One output with its full-size image (the list only carries thumbnails). Used when a result is opened.
export const GET = studioRoute<{ id: string }>(async ({ params }) => {
  const view = await getOutputView(parseId(params.id));
  return NextResponse.json({ output: (await serializeOutputs([view], { full: true }))[0] });
});
