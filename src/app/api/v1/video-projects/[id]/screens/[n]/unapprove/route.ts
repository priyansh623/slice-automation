import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoScreens } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const { id, n } = await params;
  const projectId = parseInt(id, 10);
  const screenNumber = parseInt(n, 10);
  if (isNaN(projectId) || isNaN(screenNumber)) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  }

  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber)))
    .limit(1);
  const screen = screenRows[0];
  if (!screen) return NextResponse.json({ error: 'Screen not found' }, { status: 404 });
  if (!screen.approvedGenerationId) {
    return NextResponse.json({ error: 'Screen is not approved' }, { status: 400 });
  }

  await db
    .update(videoScreens)
    .set({ approvedGenerationId: null, updatedAt: Date.now() })
    .where(eq(videoScreens.id, screen.id));

  return NextResponse.json({ success: true });
}
