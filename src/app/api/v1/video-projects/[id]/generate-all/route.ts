import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { eq } from 'drizzle-orm';
import { enqueueAllSceneGenerations } from '@/services/video-workflow';

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

  const rows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  const project = rows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (project.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const result = await enqueueAllSceneGenerations(projectId);

  return NextResponse.json(result);
}
