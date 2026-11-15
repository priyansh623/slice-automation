import { NextResponse } from 'next/server';
import { studioRoute, parseId, parseLimit, serializeAssets } from '@/lib/studio/api';
import { listApprovedPackAssets } from '@/lib/studio/approvals';

// EVERY non-archived image of an approved pack, a page at a time (cursor = last id of the previous page). 403 for a pack the
// project has not approved. ?q= is a search the person typed; without it nothing is filtered.
export const GET = studioRoute<{ id: string; packId: string }>(async ({ req, params }) => {
  const sp = req.nextUrl.searchParams;
  const after = sp.get('after');
  const limit = sp.get('limit');
  const page = await listApprovedPackAssets(parseId(params.id), parseId(params.packId), {
    after: after ? parseId(after) : undefined, limit: parseLimit(limit), search: sp.get('q') ?? undefined,
  });
  return NextResponse.json({ assets: await serializeAssets(page.items), nextCursor: page.nextCursor, totalActive: page.totalActive });
});
