import { NextRequest, NextResponse } from 'next/server';
import { listItems } from '@/lib/overlays/character';
import { overlayGuard } from '@/lib/overlays/route-helpers';

// Character B-roll items for the project, with their personalised image, prompt and video state. Items are started only from the Generation screen
// (POST /broll-selection/character-start), never from here.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  return NextResponse.json({ items: await listItems(g.projectId) });
}
