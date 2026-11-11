import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = Number(id);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: { inPoint: number; outPoint: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { inPoint, outPoint } = body;
  if (typeof inPoint !== 'number' || typeof outPoint !== 'number' || outPoint <= inPoint) {
    return NextResponse.json({ error: 'inPoint and outPoint must be numbers with outPoint > inPoint' }, { status: 400 });
  }

  // Fetch clip (user-scoped)
  const [clip] = await db
    .select()
    .from(brollClips)
    .where(and(eq(brollClips.id, clipId), eq(brollClips.userId, user.id)))
    .limit(1);

  if (!clip) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Get a fresh signed URL to download the original
  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';
  const { data: signedData } = await service.storage.from(bucket).createSignedUrl(clip.storagePath, 300);
  if (!signedData?.signedUrl) return NextResponse.json({ error: 'Could not generate download URL' }, { status: 500 });

  // Map MIME types to temp file extensions so FFmpeg gets the right demuxer
  const MIME_TO_EXT: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-msvideo': 'avi',
  };
  // MP4 and MOV (MPEG-4 family) can be stream-copied into an MP4 output safely.
  // WebM (VP8/VP9 + Opus/Vorbis) and AVI need re-encoding to H.264+AAC for MP4 output.
  const STREAM_COPY_MIME = new Set(['video/mp4', 'video/quicktime']);

  const sourceExt = MIME_TO_EXT[clip.mimeType] ?? 'mp4';
  const useCopy = STREAM_COPY_MIME.has(clip.mimeType);

  // Download original to temp file
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'broll-trim-'));
  const inputPath = path.join(tmpDir, `input.${sourceExt}`);
  const outputPath = path.join(tmpDir, 'trimmed.mp4');

  try {
    const downloadRes = await fetch(signedData.signedUrl);
    if (!downloadRes.ok) throw new Error('Failed to download original video');
    const buf = Buffer.from(await downloadRes.arrayBuffer());
    await fs.writeFile(inputPath, buf);

    // Run ffmpeg trim
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStaticPath: string | null = require('ffmpeg-static') as string | null;
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static binary not found');

    const { spawnSync } = await import('node:child_process');
    const duration = outPoint - inPoint;
    const encodeArgs = useCopy
      ? ['-c', 'copy']
      : ['-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
    const args = [
      '-y',
      '-ss', String(inPoint),
      '-i', inputPath,
      '-t', String(duration),
      ...encodeArgs,
      outputPath,
    ];

    const result = spawnSync(ffmpegStaticPath, args, { stdio: 'pipe' });
    if (result.status !== 0) {
      const stderr = result.stderr?.toString().slice(-400) ?? '';
      console.error('[broll/trim] ffmpeg failed:', stderr);
      throw new Error('FFmpeg trim failed');
    }

    const trimmedBuf = await fs.readFile(outputPath);

    return new NextResponse(trimmedBuf, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'attachment; filename="trimmed.mp4"',
        'Content-Length': String(trimmedBuf.length),
      },
    });
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
    await fs.rmdir(tmpDir).catch(() => {});
  }
}
