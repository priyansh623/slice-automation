import { NextRequest, NextResponse } from 'next/server';
import { populateComposition } from '@/lib/overlays/selection';
import { overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';

// Fills the timeline from the B-roll selection (library clips, and Character clips whose video is ready). Idempotent: opening Composition
// again creates nothing new, never brings back a removed clip, and never moves a clip a person placed or edited.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  try { return NextResponse.json(await populateComposition(g.projectId, g.user.id)); }
  catch (err) { return overlayErrorResponse(err); }
}
