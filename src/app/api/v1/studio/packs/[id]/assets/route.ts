import { NextResponse } from 'next/server';
import { studioRoute, parseId, parseLimit, serializeAssets } from '@/lib/studio/api';
import { getPack, listPackAssets } from '@/lib/studio/repository';

// Every image of the pack, a page at a time (cursor = the last id of the previous page). Archived images are left out
// unless ?includeArchived=1. ?q= is a search the person typed; without it every image is returned.
export const GET = studioRoute<{ id: string }>(async ({ req, params }) => {
  const packId = parseId(params.id);
  const pack = await getPack(packId);
  const sp = req.nextUrl.searchParams;
  const after = sp.get('after');
  const limit = sp.get('limit');
  const page = await listPackAssets(packId, {
    after: after ? parseId(after) : undefined,
    limit: parseLimit(limit),
    includeArchived: sp.get('includeArchived') === '1',
    search: sp.get('q') ?? undefined,
  });
  return NextResponse.json({ pack, assets: await serializeAssets(page.items), nextCursor: page.nextCursor, totalActive: page.totalActive });
});
