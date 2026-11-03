import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, promptGenerationTasks } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq } from 'drizzle-orm';
import { enqueueScreen1ApprovalTasks } from '@/services/video-workflow';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const projectRows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (project.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const allScreens = await db.select().from(videoScreens).where(eq(videoScreens.videoProjectId, projectId));
  const screen1 = allScreens.sort((a, b) => a.position - b.position)[0];

  if (!screen1) return NextResponse.json({ error: 'No screens found' }, { status: 400 });

  // Scene 1 must be approved before we can extract a brief for the other scenes.
  if (!screen1.approvedGenerationId) {
    return NextResponse.json(
      { error: 'Scene 1 must be approved before generating prompts for other scenes' },
      { status: 400 },
    );
  }

  // Skip if tasks are already pending/processing to avoid duplicate work.
  const existingTasks = await db
    .select()
    .from(promptGenerationTasks)
    .where(and(
      eq(promptGenerationTasks.videoProjectId, projectId),
      eq(promptGenerationTasks.status, 'pending'),
    ));
  if (existingTasks.length > 0) {
    return NextResponse.json({ tasksQueued: 0, alreadyPending: existingTasks.length });
  }

  const result = await enqueueScreen1ApprovalTasks(projectId, screen1.id);

  return NextResponse.json(result);
}
