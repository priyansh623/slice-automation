import { NextRequest, NextResponse } from 'next/server';
import { createCharacterItem, listItems, publicItem } from '@/lib/overlays/character';
import { intOrUndef, overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';

// Character B-roll items for the project, with their personalised image, prompt and video state.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  return NextResponse.json({ items: await listItems(g.projectId) });
}

// Starts the personalised image for one Scene Pack image. Nothing paid for video happens here.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const studioAssetId = intOrUndef(body.studioAssetId);
  if (studioAssetId === undefined) return NextResponse.json({ error: 'studioAssetId required' }, { status: 400 });
  try { return NextResponse.json(publicItem(await createCharacterItem(g.projectId, g.user.id, { studioAssetId, intendedAction: typeof body.intendedAction === 'string' ? body.intendedAction : '' })), { status: 201 }); }
  catch (err) { return overlayErrorResponse(err); }
}
