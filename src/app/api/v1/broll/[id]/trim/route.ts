import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import { isAdminUser } from '@/lib/api-auth';
import { activeBrollLibraryCondition } from '@/lib/broll-visibility';
import { trimMedia, validateTrimRange } from '@/lib/broll-trim';

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

  const { inPoint, outPoint } = body ?? ({} as { inPoint: number; outPoint: number });
  const rangeError = validateTrimRange(inPoint, outPoint);
  if (rangeError) return NextResponse.json({ error: rangeError }, { status: 400 });

  // Anyone signed in can trim any clip in the shared library; administrators can trim any clip.
  const isAdmin = await isAdminUser(user.id);
  const [clip] = await db
    .select()
    .from(brollClips)
    .where(isAdmin ? eq(brollClips.id, clipId) : and(eq(brollClips.id, clipId), activeBrollLibraryCondition()))
    .limit(1);

  if (!clip) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const beyondEnd = validateTrimRange(inPoint, outPoint, clip.durationSeconds);
  if (beyondEnd) return NextResponse.json({ error: beyondEnd }, { status: 400 });

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
  const sourceExt = MIME_TO_EXT[clip.mimeType] ?? 'mp4';

  // Download original to temp file
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'broll-trim-'));
  const inputPath = path.join(tmpDir, `input.${sourceExt}`);
  const outputPath = path.join(tmpDir, 'trimmed.mp4');

  try {
    const downloadRes = await fetch(signedData.signedUrl);
    if (!downloadRes.ok) throw new Error('Failed to download original video');
    const buf = Buffer.from(await downloadRes.arrayBuffer());
    await fs.writeFile(inputPath, buf);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStaticPath: string | null = require('ffmpeg-static') as string | null;
    if (!ffmpegStaticPath) throw new Error('ffmpeg-static binary not found');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffprobeModule = require('ffprobe-static') as string | { path: string };
    const ffprobePath = typeof ffprobeModule === 'string' ? ffprobeModule : ffprobeModule.path;

    // Stream-copies when the file allows it, converts only the audio when it must (e.g. Opus in MP4), and
    // re-encodes as a last resort. The output is validated before it is returned.
    const outcome = trimMedia({ ffmpegPath: ffmpegStaticPath, ffprobePath, inputPath, outputPath, mimeType: clip.mimeType, inPoint, outPoint });
    console.info(`[broll/trim] clip ${clip.id}: ${outcome.plan}${outcome.fellBack ? ' (fallback)' : ''} - ${outcome.reason}`);

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
