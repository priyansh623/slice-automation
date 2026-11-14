import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getStorage } from '@/lib/object-store';
import { checkInit, DIRECT_UPLOAD_MAX_BYTES, DIRECT_UPLOAD_TTL_S, newBrollKey } from '@/lib/broll-direct-upload';

/**
 * Step 1 of a browser-direct B-roll upload: the server checks who is asking and what they want to upload, chooses the
 * object key itself, and returns a short-lived presigned PUT URL for R2. The video then goes from the browser straight
 * to R2 and never passes through this server. Nothing is recorded in the database here.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { contentType?: unknown; fileSize?: unknown; fileName?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const check = checkInit(body ?? {});
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const storage = getStorage();
  if (!storage.directUploadAvailable()) {
    // The browser then uses the server-side upload (small files only).
    return NextResponse.json({ error: 'Direct upload is not available', code: 'direct_upload_unavailable' }, { status: 503 });
  }

  const storagePath = newBrollKey(user.id, check.ext);
  try {
    const upload = await storage.signedDirectUpload('uploads', storagePath, check.contentType, check.size, DIRECT_UPLOAD_TTL_S);
    return NextResponse.json({
      storagePath,
      uploadUrl: upload.url,
      method: upload.method,
      headers: upload.headers,
      expiresInSeconds: DIRECT_UPLOAD_TTL_S,
      maxBytes: DIRECT_UPLOAD_MAX_BYTES,
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[broll/upload/init] could not sign an upload:', (err as Error).message);
    return NextResponse.json({ error: 'Could not prepare the upload', code: 'direct_upload_unavailable' }, { status: 503 });
  }
}
