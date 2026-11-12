import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { generationFeedback, videoGenerations, videoScreens, videoProjects } from '@/db/schema.pg';
import { requireUser } from '@/lib/api-auth';
import { eq } from 'drizzle-orm';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;


  const { searchParams } = new URL(req.url);
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 200) : 50;

  const rows = await db
    .select({
      feedback: generationFeedback,
      generation: { id: videoGenerations.id, status: videoGenerations.status },
      screen: { id: videoScreens.id, screenNumber: videoScreens.screenNumber },
      project: { id: videoProjects.id, userId: videoProjects.userId },
    })
    .from(generationFeedback)
    .innerJoin(videoGenerations, eq(generationFeedback.videoGenerationId, videoGenerations.id))
    .innerJoin(videoScreens, eq(videoGenerations.videoScreenId, videoScreens.id))
    .innerJoin(videoProjects, eq(videoScreens.videoProjectId, videoProjects.id))
    .orderBy(generationFeedback.createdAt)
    .limit(limit);

  return NextResponse.json(rows);
}
