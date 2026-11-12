import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoCompilations } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import { createClient as createServiceClient } from '@supabase/supabase-js';
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

  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const bucket = process.env.SUPABASE_BUCKET_VIDEOS ?? 'videos';
  const { data, error } = await serviceClient.storage
    .from(bucket)
    .createSignedUrl(compilation.outputStoragePath, 3600);

  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: 'Failed to generate signed URL' }, { status: 500 });
  }

  return NextResponse.json({ signedUrl: data.signedUrl, compilationId: compilation.id });
}
