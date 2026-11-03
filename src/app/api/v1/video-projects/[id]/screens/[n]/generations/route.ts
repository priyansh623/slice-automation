import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoScreens, videoGenerations, screenPromptVersions } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const { id, n } = await params;
  const projectId = parseInt(id, 10);
  const screenNumber = parseInt(n, 10);
  if (isNaN(projectId) || isNaN(screenNumber)) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  }

  const gens = await db
    .select({ generation: videoGenerations, promptVersion: screenPromptVersions })
    .from(videoGenerations)
    .innerJoin(screenPromptVersions, eq(videoGenerations.promptVersionId, screenPromptVersions.id))
    .innerJoin(videoScreens, eq(videoGenerations.videoScreenId, videoScreens.id))
    .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber)));

  return NextResponse.json(gens.sort((a, b) => b.generation.createdAt - a.generation.createdAt));
}
