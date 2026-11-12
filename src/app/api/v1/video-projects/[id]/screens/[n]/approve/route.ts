import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, videoGenerations } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq } from 'drizzle-orm';
import { enqueueScreen1ApprovalTasks } from '@/services/video-workflow';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, n } = await params;
  const projectId = parseInt(id, 10);
  const screenNumber = parseInt(n, 10);
  if (isNaN(projectId) || isNaN(screenNumber)) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  }

  const projectRows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber)))
    .limit(1);
  const screen = screenRows[0];
  if (!screen) return NextResponse.json({ error: 'Screen not found' }, { status: 404 });

  const body = (await req.json()) as { generationId: number };
  if (!body.generationId) {
    return NextResponse.json({ error: 'generationId required' }, { status: 400 });
  }

  const genRows = await db
    .select()
    .from(videoGenerations)
    .where(and(eq(videoGenerations.id, body.generationId), eq(videoGenerations.videoScreenId, screen.id)))
    .limit(1);
  if (!genRows[0]) return NextResponse.json({ error: 'Generation not found for this screen' }, { status: 404 });

  const now = Date.now();
  await db
    .update(videoScreens)
    .set({ approvedGenerationId: body.generationId, updatedAt: now })
    .where(eq(videoScreens.id, screen.id));

  let tasksQueued = 0;
  if (screenNumber === 1) {
    const result = await enqueueScreen1ApprovalTasks(projectId, screen.id);
    tasksQueued = result.tasksQueued;
  }

  return NextResponse.json({ approvedGenerationId: body.generationId, tasksQueued });
}
