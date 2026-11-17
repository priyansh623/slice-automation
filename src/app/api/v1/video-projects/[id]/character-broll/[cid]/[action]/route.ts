import { NextRequest, NextResponse } from 'next/server';
import { approveImage, getItem, publicItem, regenerateImage, rejectImage, setMotionPrompt, startClip, suggestMotionPrompt } from '@/lib/overlays/character';
import { intOrUndef, overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';

/**
 * One step of the Character B-roll flow, named in the URL:
 *   approve | reject | regenerate   the personalised image (approve is the ONLY way to unlock the paid video step)
 *   suggest-prompt | prompt         the motion prompt (written from the approved image; then editable)
 *   generate                        the paid image-to-video request (needs an approved image and a prompt)
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; cid: string; action: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  const p = await params;
  const itemId = parseInt(p.cid, 10);
  if (!Number.isInteger(itemId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* no body */ }
  try {
    switch (p.action) {
      case 'approve': return NextResponse.json(publicItem(await approveImage(g.projectId, itemId, g.user.id)));
      case 'reject': return NextResponse.json(publicItem(await rejectImage(g.projectId, itemId, g.user.id)));
      case 'regenerate': return NextResponse.json(publicItem(await regenerateImage(g.projectId, itemId, g.user.id, { confirmDuplicate: body.confirmDuplicate === true })));
      case 'suggest-prompt': return NextResponse.json(publicItem(await suggestMotionPrompt(g.projectId, itemId)));
      case 'prompt': return NextResponse.json(publicItem(await setMotionPrompt(g.projectId, itemId, typeof body.motionPrompt === 'string' ? body.motionPrompt : '')));
      case 'generate': return NextResponse.json(publicItem(await startClip(g.projectId, itemId, { confirmDuplicate: body.confirmDuplicate === true })));
      default: return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
    }
  } catch (err) { return overlayErrorResponse(err); }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; cid: string; action: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  const p = await params;
  if (p.action !== 'status') return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
  try { return NextResponse.json(publicItem(await getItem(g.projectId, parseInt(p.cid, 10)))); } catch (err) { return overlayErrorResponse(err); }
}
