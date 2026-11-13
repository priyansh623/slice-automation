import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'node:crypto';
import { getStorage } from '@/lib/object-store';
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

  const storage = getStorage();
  try {
    await storage.put('uploads', storagePath, buffer, { contentType: file.type });
  } catch (err) {
    console.error('[uploads] storage upload error:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
  }

  const previewUrl = await storage.signedReadUrl('uploads', storagePath, 3600).catch(() => null);

  return NextResponse.json(
    {
      storedPath: storagePath,
      storagePath,
      previewUrl,
      filename,
      contentType: file.type,
      size: buffer.length,
    },
    { status: 201 },
  );
}
