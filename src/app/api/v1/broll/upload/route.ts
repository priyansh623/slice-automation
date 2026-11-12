import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { isAdminUser } from '@/lib/api-auth';
import { probeVideoDuration } from '@/worker/ffmpeg-utils';

const ALLOWED_VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
};

// Best-effort 9:16 aspect ratio check using ffprobe.
// Returns display dimensions (after applying rotation metadata) so portrait
// videos recorded by iPhones as coded-landscape with a rotate tag are accepted.
async function checkAspectRatio(tmpPath: string): Promise<{ width: number; height: number } | null> {
  try {
    const { spawnSync } = await import('node:child_process');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffprobeStaticModule = require('ffprobe-static') as string | { path: string };
    const ffprobePath = typeof ffprobeStaticModule === 'string' ? ffprobeStaticModule : ffprobeStaticModule.path;
    if (!ffprobePath) return null;
    // Use JSON output so we get tags (rotate) and side_data_list (Display Matrix)
    const result = spawnSync(
      ffprobePath,
      ['-v', 'quiet', '-select_streams', 'v:0', '-show_streams', '-of', 'json', tmpPath],
      { stdio: 'pipe' },
    );
    if (result.status !== 0) return null;
    const output = result.stdout?.toString().trim();
    if (!output) return null;

    interface FfprobeStream {
      width?: number;
      height?: number;
      tags?: Record<string, string>;
      side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
    }
    const json = JSON.parse(output) as { streams?: FfprobeStream[] };
    const stream = json.streams?.[0];
    if (!stream) return null;

    let { width, height } = stream;
    if (!width || !height || width <= 0 || height <= 0) return null;

    // Determine rotation from container metadata.
    // tags.rotate (MOV/MP4 from iPhones): string like "90", "-90", "270"
    // side_data_list Display Matrix: numeric rotation field
    let rotation = 0;
    if (stream.tags?.rotate) {
      rotation = parseInt(stream.tags.rotate, 10);
    }
    const displayMatrix = stream.side_data_list?.find((sd) => sd.side_data_type === 'Display Matrix');
    if (displayMatrix?.rotation !== undefined) {
      rotation = displayMatrix.rotation;
    }

    // Normalize to [0, 360)
    rotation = ((rotation % 360) + 360) % 360;

    // 90° or 270°: coded dimensions are transposed — swap to get display dimensions
    if (rotation === 90 || rotation === 270) {
      [width, height] = [height, width];
    }

    return { width, height };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Only administrators add footage to the library.
  if (!(await isAdminUser(user.id))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

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
