import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { probeVideoDuration } from '@/worker/ffmpeg-utils';

const ALLOWED_VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
};

// Best-effort 9:16 aspect ratio check using ffprobe
async function checkAspectRatio(tmpPath: string): Promise<{ width: number; height: number } | null> {
  try {
    const { spawnSync } = await import('node:child_process');
    // Try to get ffprobe-static path the same way ffmpeg-utils does
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffprobeStaticModule = require('ffprobe-static') as string | { path: string };
    const ffprobePath = typeof ffprobeStaticModule === 'string' ? ffprobeStaticModule : ffprobeStaticModule.path;
    if (!ffprobePath) return null;
    const result = spawnSync(
      ffprobePath,
      ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', tmpPath],
      { stdio: 'pipe' },
    );
    if (result.status !== 0) return null;
    const parts = result.stdout?.toString().trim().split(',');
    if (!parts || parts.length < 2) return null;
    const width = parseInt(parts[0], 10);
    const height = parseInt(parts[1], 10);
    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

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

  const videoBuffer = Buffer.from(await videoFile.arrayBuffer());

  // Write to temp file for ffprobe
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'broll-'));
  const tmpPath = path.join(tmpDir, `input.${videoExt}`);
  let durationSeconds: number | null = null;

  try {
    await fs.writeFile(tmpPath, videoBuffer);

    // Probe aspect ratio and validate 9:16
    const dims = await checkAspectRatio(tmpPath);
    if (dims) {
      const ratio = dims.width / dims.height;
      const target = 9 / 16;
      if (Math.abs(ratio - target) > 0.05) {
        return NextResponse.json(
          { error: `Video must be 9:16 aspect ratio. Detected ${dims.width}×${dims.height}.` },
          { status: 422 },
        );
      }
    }

    // Probe duration
    try {
      durationSeconds = Math.round(probeVideoDuration(tmpPath));
    } catch {
      // non-fatal
    }
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
    await fs.rmdir(tmpDir).catch(() => {});
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

  const { error: videoError } = await service.storage.from(bucket).upload(videoStoragePath, videoBuffer, {
    contentType: videoFile.type,
    upsert: false,
  });

  if (videoError) {
    console.error('[broll/upload] video upload error:', videoError.message);
    return NextResponse.json({ error: 'Failed to upload video' }, { status: 500 });
  }

  const { data: videoSigned } = await service.storage.from(bucket).createSignedUrl(videoStoragePath, URL_TTL_S);

  return NextResponse.json({
    storagePath: videoStoragePath,
    signedUrl: videoSigned?.signedUrl ?? null,
    mimeType: videoFile.type,
    fileSizeBytes: videoBuffer.length,
    durationSeconds,
  }, { status: 201 });
}
