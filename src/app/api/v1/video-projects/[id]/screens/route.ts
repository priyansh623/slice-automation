import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireProject } from '@/lib/api-auth';
import { createSceneRow, listDeletedScreens, SceneError } from '@/services/scene-management';
import { writeScenePrompt } from '@/services/scene-creation';
import { db } from '@/db';
import { screenPromptVersions } from '@/db/schema.pg';
import { desc, eq } from 'drizzle-orm';

// Writing the prompt is the same model call as "Write prompt" on a scene, so it has the same time allowance.
export const maxDuration = 60;

const MAX_DIALOGUE = 2000;

interface AddSceneBody {
  dialogue?: unknown;
  /** Put the new scene right after this scene. Omit or null to add it at the end. */
  afterScreenId?: unknown;
  /** Identifies this attempt: a retry with the same id never adds a second scene. */
  requestId?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Adds a scene described by the creator: creates the scene at the chosen place, renumbers the scenes after it, and
// writes its prompt through the normal prompt pipeline. The scene is never approved here. If the prompt cannot be
// written (or the request is cut off by the time limit) the scene stays, marked failed or interrupted on its card, with
// what the person typed saved; Retry (or the form's retry, which carries the same requestId) finishes that same scene.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const projectResult = await requireProject(projectId);
  if (projectResult instanceof NextResponse) return projectResult;

  const body = (await req.json().catch(() => ({}))) as AddSceneBody;
  const dialogue = text(body.dialogue);

  if (!dialogue) return NextResponse.json({ error: 'Enter the dialogue for this scene.' }, { status: 400 });
  if (dialogue.length > MAX_DIALOGUE) return NextResponse.json({ error: `The dialogue is too long (max ${MAX_DIALOGUE} characters).` }, { status: 400 });

  let afterScreenId: number | null = null;
  if (body.afterScreenId !== undefined && body.afterScreenId !== null) {
    if (typeof body.afterScreenId !== 'number' || !Number.isInteger(body.afterScreenId)) {
      return NextResponse.json({ error: 'afterScreenId must be a scene id' }, { status: 400 });
    }
    afterScreenId = body.afterScreenId;
  }

  // The retry key is required: it is what makes a retry (after a timeout or a refresh) finish the same scene.
  const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.requestId) ? body.requestId : null;
  if (!requestId) return NextResponse.json({ error: 'requestId is required' }, { status: 400 });

  let creation;
  try {
    creation = await createSceneRow(projectId, {
      dialogue, afterScreenId, requestId, userId: authResult.user.id,
    });
  } catch (err) {
    if (err instanceof SceneError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }

  if (creation.state === 'busy') {
    return NextResponse.json(
      { error: 'This scene is still being written by your earlier request. Wait a moment, then try again.', code: 'in_progress', screen: { id: creation.screen.id, screenNumber: creation.screen.screenNumber } },
      { status: 409 },
    );
  }
  if (creation.state === 'done') {
    // The earlier attempt finished (its answer was lost, e.g. a timeout or refresh): hand back the same scene.
    const latest = (await db.select().from(screenPromptVersions).where(eq(screenPromptVersions.videoScreenId, creation.screen.id)).orderBy(desc(screenPromptVersions.version)).limit(1))[0];
    return NextResponse.json({
      screen: { id: creation.screen.id, screenNumber: creation.screen.screenNumber },
      promptText: latest?.promptText ?? '',
      version: latest?.version ?? 1,
      validation: { issues: [], warnings: [] },
      alreadyCreated: true,
    }, { status: 200 });
  }

  const screen = creation.screen;
  const outcome = await writeScenePrompt(projectId, screen.id, creation.eventId);
  if (outcome.ok) {
    const { ok: _ok, ...prompt } = outcome;
    return NextResponse.json({ screen: { id: screen.id, screenNumber: screen.screenNumber }, ...prompt }, { status: 201 });
  }
  // The scene stays in the sequence, marked "Generation failed" with everything the person typed, and can be retried
  // from its card. It cannot be approved or compiled: it has no prompt and no video.
  return NextResponse.json(
    { error: 'The prompt could not be written. The scene was kept: open it and press Retry.', code: 'prompt_failed', screen: { id: screen.id, screenNumber: screen.screenNumber } },
    { status: 502 },
  );
}

// Scenes that were deleted from this project and can be put back (restore: POST /screens/restore).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const projectResult = await requireProject(projectId);
  if (projectResult instanceof NextResponse) return projectResult;
  return NextResponse.json({ deleted: await listDeletedScreens(projectId) });
}
