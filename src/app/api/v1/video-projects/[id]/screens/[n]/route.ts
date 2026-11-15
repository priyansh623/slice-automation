import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireProject } from '@/lib/api-auth';
import { deleteScene, SceneError } from '@/services/scene-management';

// Takes the scene out of the sequence and renumbers the rest. The scene's prompts, videos and stored files are kept
// (nothing is deleted from storage); it just no longer appears or compiles. The scene is identified by `screenId`
// as well as its number, so a page showing out-of-date numbers can never delete the wrong scene.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const { id, n } = await params;
  const projectId = parseInt(id, 10);
  const screenNumber = parseInt(n, 10);
  if (isNaN(projectId) || isNaN(screenNumber)) return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  const projectResult = await requireProject(projectId);
  if (projectResult instanceof NextResponse) return projectResult;

  const screenId = parseInt(req.nextUrl.searchParams.get('screenId') ?? '', 10);
  if (isNaN(screenId)) return NextResponse.json({ error: 'screenId is required' }, { status: 400 });

  try {
    const result = await deleteScene(projectId, screenId, screenNumber);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SceneError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
}
