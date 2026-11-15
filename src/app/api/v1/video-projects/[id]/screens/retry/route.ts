import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireProject } from '@/lib/api-auth';
import { beginRetry, SceneError } from '@/services/scene-management';
import { writeScenePrompt } from '@/services/scene-creation';

// Same time allowance as adding a scene: it is the same model call.
export const maxDuration = 60;

// Retries writing the prompt of a scene whose creation failed or was interrupted, from the text saved with it.
// Never creates a scene: it finishes the one that exists.
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

  const body = (await req.json().catch(() => ({}))) as { screenId?: unknown };
  if (typeof body.screenId !== 'number' || !Number.isInteger(body.screenId)) return NextResponse.json({ error: 'screenId required' }, { status: 400 });

  let begun;
  try {
    begun = await beginRetry(projectId, body.screenId);
  } catch (err) {
    if (err instanceof SceneError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
  const outcome = await writeScenePrompt(projectId, begun.screen.id, begun.eventId, begun.brief);
  if (!outcome.ok) {
    return NextResponse.json({ error: 'The prompt could not be written. Your text is saved: try Retry again.', code: 'prompt_failed' }, { status: 502 });
  }
  const { ok: _ok, ...prompt } = outcome;
  return NextResponse.json({ screen: { id: begun.screen.id, screenNumber: begun.screen.screenNumber }, ...prompt });
}
