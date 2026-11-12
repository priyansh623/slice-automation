import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, videoGenerations, screenPromptVersions } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq } from 'drizzle-orm';
import { submitVideoGeneration } from '@/services/video-workflow';
import { AuthenticationError, ConfigurationError, UnexpectedProviderError } from '@/providers/useapi/errors';

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

  const body = (await req.json()) as { promptVersionId: number; creatorFeedback?: string; durationOverride?: number };
  if (!body.promptVersionId) {
    return NextResponse.json({ error: 'promptVersionId required' }, { status: 400 });
  }

  // Stale-prompt guard: reject if the prompt version was created before the last dialogue change
  const pvRows = await db
    .select()
    .from(screenPromptVersions)
    .where(eq(screenPromptVersions.id, body.promptVersionId))
    .limit(1);
  const pv = pvRows[0];
  if (!pv) return NextResponse.json({ error: 'Prompt version not found' }, { status: 404 });
  if (pv.isStale) {
    return NextResponse.json(
      { error: 'Prompt version is stale — the scene dialogue has changed since this prompt was written. Regenerate the prompt before submitting.' },
      { status: 422 },
    );
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
      if (err.httpStatus === 429) {
        return NextResponse.json({ error: 'Google Flow is rate-limited right now. Wait 30–60 seconds and try again.' }, { status: 429 });
      }
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
