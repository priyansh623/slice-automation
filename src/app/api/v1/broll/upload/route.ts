import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

const ALLOWED_VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
};

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
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

  const videoFile = formData.get('video');
  const thumbnailFile = formData.get('thumbnail');

  if (!videoFile || !(videoFile instanceof File)) {
    return NextResponse.json({ error: 'Missing video field' }, { status: 400 });
  }

  const videoExt = ALLOWED_VIDEO_TYPES[videoFile.type];
  if (!videoExt) {
    return NextResponse.json(
      { error: `Unsupported video type: ${videoFile.type}. Use MP4, MOV, WEBM or AVI.` },
      { status: 415 },
    );
  }

  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';
  const URL_TTL_S = 24 * 3600;

  const videoFilename = `${crypto.randomUUID()}.${videoExt}`;
  const videoStoragePath = `${user.id}/broll/${videoFilename}`;
  const videoBuffer = Buffer.from(await videoFile.arrayBuffer());

  const { error: videoError } = await service.storage.from(bucket).upload(videoStoragePath, videoBuffer, {
    contentType: videoFile.type,
    upsert: false,
  });

  if (videoError) {
    console.error('[broll/upload] video upload error:', videoError.message);
    return NextResponse.json({ error: 'Failed to upload video' }, { status: 500 });
  }

  const { data: videoSigned } = await service.storage.from(bucket).createSignedUrl(videoStoragePath, URL_TTL_S);

  let thumbnailStoragePath: string | null = null;
  let thumbnailSignedUrl: string | null = null;

  if (thumbnailFile instanceof File) {
    const thumbExt = ALLOWED_IMAGE_TYPES[thumbnailFile.type];
    if (thumbExt) {
      const thumbFilename = `${crypto.randomUUID()}.${thumbExt}`;
      thumbnailStoragePath = `${user.id}/broll/thumbs/${thumbFilename}`;
      const thumbBuffer = Buffer.from(await thumbnailFile.arrayBuffer());

      const { error: thumbError } = await service.storage.from(bucket).upload(thumbnailStoragePath, thumbBuffer, {
        contentType: thumbnailFile.type,
        upsert: false,
      });

      if (!thumbError) {
        const { data: thumbSigned } = await service.storage.from(bucket).createSignedUrl(thumbnailStoragePath, URL_TTL_S);
        thumbnailSignedUrl = thumbSigned?.signedUrl ?? null;
      }
    }
  }

  return NextResponse.json({
    storagePath: videoStoragePath,
    signedUrl: videoSigned?.signedUrl ?? null,
    thumbnailStoragePath,
    thumbnailSignedUrl,
    mimeType: videoFile.type,
    fileSizeBytes: videoBuffer.length,
  }, { status: 201 });
}
