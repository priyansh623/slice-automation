import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireProject } from '@/lib/api-auth';
import { restoreScene, SceneError } from '@/services/scene-management';

// Puts a deleted scene back where it was. Nothing was removed when it was deleted, so its prompts, videos and approval
// come back with it, and nothing is copied or regenerated.
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
  if (typeof body.screenId !== 'number' || !Number.isInteger(body.screenId)) {
    return NextResponse.json({ error: 'screenId required' }, { status: 400 });
  }
  try {
    return NextResponse.json(await restoreScene(projectId, body.screenId));
  } catch (err) {
    if (err instanceof SceneError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
}
