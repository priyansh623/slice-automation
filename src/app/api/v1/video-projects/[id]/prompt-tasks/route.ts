import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, promptGenerationTasks } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const projectRows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  if (!projectRows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const tasks = await db
    .select()
    .from(promptGenerationTasks)
    .where(eq(promptGenerationTasks.videoProjectId, projectId));

  return NextResponse.json({ tasks });
}
