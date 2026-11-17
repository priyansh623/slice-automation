import { NextRequest, NextResponse } from 'next/server';
import { retryOverlay } from '@/lib/overlays/service';
import { overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; oid: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  try { return NextResponse.json(await retryOverlay(g.projectId, g.overlayId!)); } catch (err) { return overlayErrorResponse(err); }
}
