import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoCompilations } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireUser, requireProjectOwner } from '@/lib/api-auth';

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

  const ownerResult = await requireProjectOwner(projectId, user.id);
  if (ownerResult instanceof NextResponse) return ownerResult;

  const rows = await db
    .select()
    .from(videoCompilations)
    .where(and(eq(videoCompilations.id, compilationId), eq(videoCompilations.videoProjectId, projectId)))
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
    .createSignedUrl(compilation.outputStoragePath, 60);

  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: 'Failed to generate download URL' }, { status: 500 });
  }

  // Proxy-stream from Supabase so the browser sees a same-origin response
  // and Content-Disposition: attachment triggers a real file-save dialog.
  const upstream = await fetch(data.signedUrl);
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
