import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'node:crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 });
  }

  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: `Unsupported image type: ${file.type}. Use JPEG, PNG, WEBP or GIF.` },
      { status: 415 },
    );
  }

  const filename = `${crypto.randomUUID()}.${ext}`;
  // Store under user's own prefix to prevent cross-user path guessing
  const storagePath = `${user.id}/${filename}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const serviceSupabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';
  const { error } = await serviceSupabase.storage.from(bucket).upload(storagePath, buffer, {
    contentType: file.type,
    upsert: false,
  });

  if (error) {
    console.error('[uploads] Supabase Storage upload error:', error.message);
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
  }

  const { data: signedData } = await serviceSupabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, 3600);

  return NextResponse.json(
    {
      storedPath: storagePath,
      storagePath,
      previewUrl: signedData?.signedUrl ?? null,
      filename,
      contentType: file.type,
      size: buffer.length,
    },
    { status: 201 },
  );
}
