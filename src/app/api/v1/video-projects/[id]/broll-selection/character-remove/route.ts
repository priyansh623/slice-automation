import { NextRequest, NextResponse } from 'next/server';
import { removeCharacterPick } from '@/lib/overlays/selection';
import { intOrUndef, overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';

// Removes one Character B-roll pick (and its timeline overlay) from the project. Started work is kept on record, not deleted, and nothing is started.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const assetId = intOrUndef(body.assetId), screenId = intOrUndef(body.screenId);
  if (assetId === undefined || screenId === undefined) return NextResponse.json({ error: 'assetId and screenId required' }, { status: 400 });
  try { return NextResponse.json(await removeCharacterPick(g.projectId, { assetId, screenId })); }
  catch (err) { return overlayErrorResponse(err); }
}
