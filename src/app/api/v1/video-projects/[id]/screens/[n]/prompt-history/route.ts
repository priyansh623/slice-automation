import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoScreens, screenPromptVersions } from '@/db/schema.pg';
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

  const versions = await db
    .select({ version: screenPromptVersions })
    .from(screenPromptVersions)
    .innerJoin(videoScreens, eq(screenPromptVersions.videoScreenId, videoScreens.id))
    .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber)));

  return NextResponse.json(versions.map((r) => r.version).sort((a, b) => b.version - a.version));
}
