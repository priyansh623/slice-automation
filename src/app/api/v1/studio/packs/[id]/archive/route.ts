import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId } from '@/lib/studio/api';
import { setPackArchived } from '@/lib/studio/repository';

// Archives (default) or restores a pack. Nothing is deleted; projects that approved it keep their history.
export const POST = studioRoute<{ id: string }>(async ({ req, params }) => {
  const body = await readJson(req);
  const pack = await setPackArchived(parseId(params.id), body.archived !== false);
  return NextResponse.json({ pack });
});
