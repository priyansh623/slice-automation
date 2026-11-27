import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { isDeletedProject } from '@/lib/project-deletion';
import { videoProjects, videoScreens, videoGenerations, screenPromptVersions } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq } from 'drizzle-orm';
import { submitVideoGeneration } from '@/services/video-workflow';

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
  if (!project || isDeletedProject(project)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

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

  if (pv.videoScreenId !== screen.id) return NextResponse.json({ error: 'Prompt version not found' }, { status: 404 });

  // QUEUE ONLY. The request records the job and answers at once; the worker sends it to the provider and stores the video, so closing the tab or a
  // slow provider changes nothing. One active job per scene and prompt version: a repeated request gets the existing one back (`deduped`).
  let result: { generationId: number; deduped: boolean };
  try {
    result = await submitVideoGeneration(projectId, screen.id, body.promptVersionId, body.durationOverride);
  } catch (err) {
    console.error('[generate] Could not queue the generation:', err);
    return NextResponse.json({ error: 'The video could not be queued. Please try again.' }, { status: 500 });
  }

  if (body.creatorFeedback && !result.deduped) {
    await db
      .update(videoGenerations)
      .set({ creatorFeedback: body.creatorFeedback, updatedAt: Date.now() })
      .where(eq(videoGenerations.id, result.generationId));
  }

  return NextResponse.json({ generationId: result.generationId, status: 'queued', deduped: result.deduped }, { status: result.deduped ? 200 : 201 });
}
