import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';
import { enqueueScreen1ApprovalTasks } from '@/services/video-workflow';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const projectRows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  if (!projectRows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const allScreens = await db.select().from(videoScreens).where(eq(videoScreens.videoProjectId, projectId));
  const screen1 = allScreens.sort((a, b) => a.position - b.position)[0];

  if (!screen1) return NextResponse.json({ error: 'No screens found' }, { status: 400 });

  const result = await enqueueScreen1ApprovalTasks(projectId, screen1.id);

  return NextResponse.json(result);
}
