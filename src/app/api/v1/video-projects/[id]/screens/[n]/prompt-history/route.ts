import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, screenPromptVersions } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq } from 'drizzle-orm';

export async function GET(
  _req: NextRequest,
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

  const versions = await db
    .select({ version: screenPromptVersions })
    .from(screenPromptVersions)
    .innerJoin(videoScreens, eq(screenPromptVersions.videoScreenId, videoScreens.id))
    .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber)));

  return NextResponse.json(versions.map((r) => r.version).sort((a, b) => b.version - a.version));
}
