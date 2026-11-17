import { NextRequest, NextResponse } from 'next/server';
import { loadComposition } from '@/lib/overlays/composition';
import { overlayGuard } from '@/lib/overlays/route-helpers';

// One read for the Composition page. 404 when the B-roll overlay feature is off, so the page (and the link to it) simply do not appear.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  return NextResponse.json(await loadComposition(g.projectId));
}
