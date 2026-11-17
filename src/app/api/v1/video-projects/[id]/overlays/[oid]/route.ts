import { NextRequest, NextResponse } from 'next/server';
import { deleteOverlay, updateOverlay } from '@/lib/overlays/service';
import { intOrUndef, overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';

// Moves, retimes, trims or replaces an overlay. Only the fields sent change.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; oid: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  try {
    return NextResponse.json(await updateOverlay(g.projectId, g.overlayId!, { anchorScreenId: intOrUndef(body.anchorScreenId), startOffsetMs: intOrUndef(body.startOffsetMs), durationMs: intOrUndef(body.durationMs), sourceStartMs: intOrUndef(body.sourceStartMs), track: intOrUndef(body.track), replaceWithBrollClipId: intOrUndef(body.replaceWithBrollClipId) }));
  } catch (err) { return overlayErrorResponse(err); }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; oid: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  try { await deleteOverlay(g.projectId, g.overlayId!); return NextResponse.json({ ok: true }); } catch (err) { return overlayErrorResponse(err); }
}
