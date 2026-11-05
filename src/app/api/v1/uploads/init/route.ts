import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'node:crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';
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

  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';

  const { data: uploadData, error: uploadError } = await serviceClient.storage
    .from(bucket)
    .createSignedUploadUrl(path);

  if (uploadError || !uploadData) {
    console.error('[uploads/init] createSignedUploadUrl error:', uploadError?.message);
    return NextResponse.json({ error: 'Failed to create upload URL' }, { status: 500 });
  }

  // Pre-generate the read URL — valid once the file is uploaded.
  const { data: previewData } = await serviceClient.storage
    .from(bucket)
    .createSignedUrl(path, 24 * 3600);

  return NextResponse.json({
    signedUploadUrl: uploadData.signedUrl,
    path,
    filename,
    previewUrl: previewData?.signedUrl ?? null,
  });
}
