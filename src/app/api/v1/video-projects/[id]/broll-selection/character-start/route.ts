import { NextRequest, NextResponse } from 'next/server';
import { publicItem } from '@/lib/overlays/character';
import { startCharacterPick } from '@/lib/overlays/selection';
import { intOrUndef, overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';

// Starts the existing Character B-roll process (personalised image first; nothing for video until the image is approved) for one selected
// image. Only runs when a person asks for it on the Generation screen.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const assetId = intOrUndef(body.assetId), screenId = intOrUndef(body.screenId);
  if (assetId === undefined || screenId === undefined) return NextResponse.json({ error: 'assetId and screenId required' }, { status: 400 });
  try { return NextResponse.json(publicItem((await startCharacterPick(g.projectId, g.user.id, { assetId, screenId })).item), { status: 201 }); }
  catch (err) { return overlayErrorResponse(err); }
}
