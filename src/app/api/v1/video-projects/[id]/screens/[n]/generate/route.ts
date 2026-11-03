import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoScreens, videoGenerations } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import { submitVideoGeneration } from '@/services/video-workflow';
import { AuthenticationError, ConfigurationError, UnexpectedProviderError } from '@/providers/useapi/errors';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const { id, n } = await params;
  const projectId = parseInt(id, 10);
  const screenNumber = parseInt(n, 10);
  if (isNaN(projectId) || isNaN(screenNumber)) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  }

  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber)))
    .limit(1);
  const screen = screenRows[0];
  if (!screen) return NextResponse.json({ error: 'Screen not found' }, { status: 404 });

  const body = (await req.json()) as { promptVersionId: number; creatorFeedback?: string; durationOverride?: number };
  if (!body.promptVersionId) {
    return NextResponse.json({ error: 'promptVersionId required' }, { status: 400 });
  }

  let result: { generationId: number };
  try {
    result = await submitVideoGeneration(projectId, screen.id, body.promptVersionId, body.durationOverride);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.error('[generate] Provider authentication failed:', err.message);
      return NextResponse.json({ error: 'Video provider authentication failed. Check USEAPI_TOKEN.' }, { status: 401 });
    }
    if (err instanceof ConfigurationError) {
      console.error('[generate] Provider configuration error:', err.message);
      return NextResponse.json({ error: 'Google Flow is not configured or the Google session has expired.' }, { status: 502 });
    }
    if (err instanceof UnexpectedProviderError) {
      console.error(`[generate] Unexpected provider error (HTTP ${err.httpStatus}):`, err.message);
      return NextResponse.json({ error: `Video provider returned an unexpected error (${err.httpStatus}).` }, { status: 502 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[generate] Unhandled error:', msg);
    return NextResponse.json({ error: `Video generation failed: ${msg.slice(0, 300)}` }, { status: 500 });
  }

  if (body.creatorFeedback) {
    await db
      .update(videoGenerations)
      .set({ creatorFeedback: body.creatorFeedback, updatedAt: Date.now() })
      .where(eq(videoGenerations.id, result.generationId));
  }

  return NextResponse.json(result, { status: 201 });
}
