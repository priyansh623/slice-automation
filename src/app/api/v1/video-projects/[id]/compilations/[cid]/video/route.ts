import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoCompilations } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';
import { requireUser, requireProjectOwner } from '@/lib/api-auth';

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

  const ownerResult = await requireProjectOwner(projectId, user.id);
  if (ownerResult instanceof NextResponse) return ownerResult;

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

  const supabase = await createClient();
  const bucket = process.env.SUPABASE_BUCKET_VIDEOS ?? 'videos';
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(compilation.outputStoragePath, 3600);

  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: 'Failed to generate signed URL' }, { status: 500 });
  }

  return NextResponse.json({ signedUrl: data.signedUrl, compilationId: compilation.id });
}
