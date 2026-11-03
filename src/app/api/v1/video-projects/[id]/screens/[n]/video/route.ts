import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, videoGenerations } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq } from 'drizzle-orm';

export async function GET(
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
  if (project.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const generationIdParam = searchParams.get('generationId');

  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber)))
    .limit(1);
  const screen = screenRows[0];
  if (!screen) return NextResponse.json({ error: 'Screen not found' }, { status: 404 });

  let generation: typeof videoGenerations.$inferSelect | undefined;

  if (generationIdParam) {
    const rows = await db
      .select()
      .from(videoGenerations)
      .where(
        and(
          eq(videoGenerations.id, parseInt(generationIdParam, 10)),
          eq(videoGenerations.videoScreenId, screen.id),
        ),
      )
      .limit(1);
    generation = rows[0];
  } else {
    const rows = await db
      .select()
      .from(videoGenerations)
      .where(and(eq(videoGenerations.videoScreenId, screen.id), eq(videoGenerations.status, 'completed')));
    generation = rows.sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  if (!generation || !generation.videoStoragePath) {
    return NextResponse.json({ error: 'No completed video found' }, { status: 404 });
  }

  const bucket = process.env.SUPABASE_BUCKET_VIDEOS ?? 'videos';
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(generation.videoStoragePath, 3600);

  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: 'Failed to generate signed video URL' }, { status: 500 });
  }

  return NextResponse.json({ signedUrl: data.signedUrl, generationId: generation.id });
}
