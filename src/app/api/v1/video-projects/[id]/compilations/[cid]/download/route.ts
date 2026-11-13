import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoCompilations } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import { getStorage } from '@/lib/object-store';
import { requireUser, requireProject } from '@/lib/api-auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> },
): Promise<NextResponse | Response> {
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
    .where(and(eq(videoCompilations.id, compilationId), eq(videoCompilations.videoProjectId, projectId)))
    .limit(1);

  const compilation = rows[0];
  if (!compilation) return NextResponse.json({ error: 'Compilation not found' }, { status: 404 });
  if (compilation.status !== 'completed' || !compilation.outputStoragePath) {
    return NextResponse.json({ error: 'Compilation video not yet available' }, { status: 404 });
  }

  let signedUrl: string | null = null;
  try {
    signedUrl = await getStorage().signedReadUrl('videos', compilation.outputStoragePath, 60);
  } catch (err) {
    console.error('[compilation download] signed URL failed:', (err as Error).message);
  }

  if (!signedUrl) {
    return NextResponse.json({ error: 'Failed to generate download URL' }, { status: 500 });
  }

  // Proxy-stream from storage so the browser sees a same-origin response
  // and Content-Disposition: attachment triggers a real file-save dialog.
  const upstream = await fetch(signedUrl);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'Failed to fetch video from storage' }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'video/mp4',
      'Content-Disposition': `attachment; filename="compilation-${compilationId}.mp4"`,
      ...(upstream.headers.get('Content-Length')
        ? { 'Content-Length': upstream.headers.get('Content-Length')! }
        : {}),
    },
  });
}
