import { NextRequest, NextResponse } from 'next/server';
import { createGenericOverlay, listOverlays } from '@/lib/overlays/service';
import { intOrUndef, overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';

// The project's B-roll overlays with the Flow scene layout they sit on.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  return NextResponse.json(await listOverlays(g.projectId));
}

// Adds a library clip as an overlay. Character B-roll overlays are created by the Character B-roll flow when its clip is ready.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (body.kind !== undefined && body.kind !== 'generic') return NextResponse.json({ error: 'Only library (generic) overlays are created here.' }, { status: 422 });
  const brollClipId = intOrUndef(body.brollClipId);
  if (brollClipId === undefined) return NextResponse.json({ error: 'brollClipId required' }, { status: 400 });
  try {
    const row = await createGenericOverlay(g.projectId, g.user.id, { brollClipId, anchorScreenId: intOrUndef(body.anchorScreenId), startOffsetMs: intOrUndef(body.startOffsetMs), durationMs: intOrUndef(body.durationMs), sourceStartMs: intOrUndef(body.sourceStartMs), track: intOrUndef(body.track) });
    return NextResponse.json(row, { status: 201 });
  } catch (err) { return overlayErrorResponse(err); }
}
