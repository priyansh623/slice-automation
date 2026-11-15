import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId, serializeAssets } from '@/lib/studio/api';
import { setAssetArchived } from '@/lib/studio/repository';

// Takes an image out of active use (default) or restores it. Nothing is deleted: jobs and outputs keep their history.
export const POST = studioRoute<{ id: string }>(async ({ req, params, user }) => {
  const body = await readJson(req);
  const [asset] = await serializeAssets([await setAssetArchived(parseId(params.id), body.archived !== false, user.id)], { full: true });
  return NextResponse.json({ asset });
});
