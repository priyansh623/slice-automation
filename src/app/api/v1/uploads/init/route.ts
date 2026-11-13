import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'node:crypto';
import { getStorage } from '@/lib/object-store';
import { requireUser } from '@/lib/api-auth';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Returns a signed upload URL so the browser can PUT the file directly to
// Supabase Storage — bypassing the Next.js/Vercel 4.5 MB request body limit.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const contentType = req.nextUrl.searchParams.get('contentType') ?? '';
  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    return NextResponse.json(
      { error: `Unsupported image type: ${contentType}. Use JPEG, PNG, WEBP or GIF.` },
      { status: 415 },
    );
  }

  const filename = `${crypto.randomUUID()}.${ext}`;
  const path = `${user.id}/${filename}`;

  let upload;
  try {
    upload = await getStorage().signedUpload('uploads', path, contentType);
  } catch (err) {
    console.error('[uploads/init] signed upload URL error:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to create upload URL' }, { status: 500 });
  }

  return NextResponse.json({
    signedUploadUrl: upload.url,
    path,
    filename,
  });
}
