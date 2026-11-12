import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, screenPromptVersions, videoGenerations } from '@/db/schema.pg';
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

  const projectRows = await db.select({ userId: videoProjects.userId })
    .from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [promptRows, genRows] = await Promise.all([
    db.select({ version: screenPromptVersions })
      .from(screenPromptVersions)
      .innerJoin(videoScreens, eq(screenPromptVersions.videoScreenId, videoScreens.id))
      .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber))),

    db.select({ generation: videoGenerations, promptVersion: screenPromptVersions })
      .from(videoGenerations)
      .innerJoin(screenPromptVersions, eq(videoGenerations.promptVersionId, screenPromptVersions.id))
      .innerJoin(videoScreens, eq(videoGenerations.videoScreenId, videoScreens.id))
      .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber))),
  ]);

  return NextResponse.json({
    promptHistory: promptRows.map((r) => r.version).sort((a, b) => b.version - a.version),
    generations: genRows.sort((a, b) => b.generation.createdAt - a.generation.createdAt),
  });
}
