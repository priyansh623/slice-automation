import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/db';
import { videoProjects } from '@/db/schema.pg';
import { like } from 'drizzle-orm';
import { getStorage } from '@/lib/object-store';

// Only allow UUID-based filenames (no path traversal)
const SAFE_FILENAME = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif)$/i;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { filename } = await params;

  if (!SAFE_FILENAME.test(filename)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Files are stored under the uploader's id prefix. Projects are shared, so a project's image is served from
  // wherever it was stored; a file the caller uploaded that is not on a project yet is looked up under their own prefix.
  const [project] = await db.select({ path: videoProjects.baseImagePath }).from(videoProjects)
    .where(like(videoProjects.baseImagePath, `%/${filename}`)).limit(1);
  const storagePath = project?.path ?? `${user.id}/${filename}`;

  const signedUrl = await getStorage().signedReadUrl('uploads', storagePath, 3600).catch(() => null);
  if (!signedUrl) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Redirect to the signed URL so the browser fetches directly from storage
  return NextResponse.redirect(signedUrl, { status: 302 });
}
