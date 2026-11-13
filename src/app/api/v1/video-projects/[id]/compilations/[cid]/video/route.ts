import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoCompilations } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import { getStorage } from '@/lib/object-store';
import { requireUser, requireProject } from '@/lib/api-auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id, cid } = await params;
  const projectId = parseInt(id, 10);
  const compilationId = parseInt(cid, 10);
  if (isNaN(projectId) || isNaN(compilationId)) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  }

  const projectResult = await requireProject(projectId);
  if (projectResult instanceof NextResponse) return projectResult;

  const rows = await db
    .select()
    .from(videoCompilations)
    .where(
      and(
        eq(videoCompilations.id, compilationId),
        eq(videoCompilations.videoProjectId, projectId),
      ),
    )
    .limit(1);

  const compilation = rows[0];
  if (!compilation) return NextResponse.json({ error: 'Compilation not found' }, { status: 404 });
  if (!compilation.outputStoragePath) {
    return NextResponse.json({ error: 'Compilation video not yet available' }, { status: 404 });
  }

  let signedUrl: string | null = null;
  try {
    signedUrl = await getStorage().signedReadUrl('videos', compilation.outputStoragePath, 3600);
  } catch (err) {
    console.error('[compilation video] signed URL failed:', (err as Error).message);
  }

  if (!signedUrl) {
    return NextResponse.json({ error: 'Failed to generate signed URL' }, { status: 500 });
  }

  return NextResponse.json({ signedUrl, compilationId: compilation.id });
}
