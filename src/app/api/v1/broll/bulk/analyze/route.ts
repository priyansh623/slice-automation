import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { requireUser } from '@/lib/api-auth';
import { analyseFrames, MAX_FRAMES, MAX_FRAME_BYTES } from '@/lib/broll-bulk/analyzer';
import { loadTaxonomy } from '@/lib/broll-bulk/taxonomy-server';

export const maxDuration = 60;

/**
 * AI analysis of ONE video from a few frames the browser sampled. It stores nothing: no video, no frame, no clip row,
 * and it has no way to create or change a category (it reads the taxonomy and returns a suggestion). Uploading is a
 * separate step the user approves later.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;

  let body: { frames?: unknown; durationSeconds?: unknown; width?: unknown; height?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const frames = Array.isArray(body.frames) ? body.frames : [];
  if (frames.length === 0 || frames.length > MAX_FRAMES) return NextResponse.json({ error: `Send between 1 and ${MAX_FRAMES} frames.` }, { status: 400 });
  for (const f of frames) {
    if (typeof f !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(f)) return NextResponse.json({ error: 'Frames must be base64 JPEG data.' }, { status: 400 });
    if (f.length * 0.75 > MAX_FRAME_BYTES) return NextResponse.json({ error: 'A frame is too large. Use smaller frames.' }, { status: 413 });
    if (!f.startsWith('/9j/')) return NextResponse.json({ error: 'Frames must be JPEG images.' }, { status: 400 });
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: 'AI analysis is not configured (ANTHROPIC_API_KEY is missing).', code: 'ai_not_configured' }, { status: 503 });

  try {
    const taxonomy = await loadTaxonomy(db);
    const suggestion = await analyseFrames({ frames: frames as string[], durationSeconds: num(body.durationSeconds), width: num(body.width), height: num(body.height) }, taxonomy);
    return NextResponse.json({ suggestion }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    // Deliberately logs no message text: provider errors can quote request details, and the request holds the sampled frames.
    const e = err as { name?: string; status?: number };
    console.error('[broll/bulk/analyze] failed:', e.name ?? 'Error', e.status ?? '');
    return NextResponse.json({ error: 'The analysis failed. Try again.', code: 'analysis_failed' }, { status: 502 });
  }
}
