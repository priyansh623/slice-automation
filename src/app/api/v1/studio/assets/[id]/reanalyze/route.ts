import { NextResponse } from 'next/server';
import { studioRoute, parseId, serializeAssets } from '@/lib/studio/api';
import { requestReanalysis } from '@/lib/studio/repository';

// Queues the image for AI analysis again. The new result replaces the AI metadata only; manual edits are kept.
export const POST = studioRoute<{ id: string }>(async ({ params }) => {
  const [asset] = await serializeAssets([await requestReanalysis(parseId(params.id))], { full: true });
  return NextResponse.json({ asset });
});
