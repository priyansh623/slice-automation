import { NextResponse } from 'next/server';
import { studioRoute, parseId, serializeAssets } from '@/lib/studio/api';
import { getAssetView } from '@/lib/studio/repository';

export const GET = studioRoute<{ id: string }>(async ({ params }) => {
  const [asset] = await serializeAssets([await getAssetView(parseId(params.id))], { full: true });
  return NextResponse.json({ asset });
});
