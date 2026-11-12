import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';
import { requireAdmin, requireUser } from '@/lib/api-auth';
import { ACTIVE_BROLL_REVIEW_STATUS, HIDDEN_BROLL_REVIEW_STATUSES } from '@/lib/broll-visibility';

// Admin-only library management: put a clip on hold, archive it, or restore it.
//   { "status": "on_hold" }   keeps the clip out of the library until it is restored
//   { "status": "archived" }  retires the clip; the record and its storage object are kept
//   { "status": "active" }    restores a held or archived clip. It returns to the library if it is classified.
// Nothing is deleted. Classification and brand associations are untouched.
const TARGETS: Record<string, string> = { on_hold: 'on_hold', archived: 'archived' };

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const forbidden = await requireAdmin(auth.user.id);
  if (forbidden) return forbidden;

  const { id } = await params;
  const clipId = Number(id);
  if (!Number.isInteger(clipId) || clipId <= 0) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: { status?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const requested = body.status;
  if (requested !== 'active' && requested !== 'on_hold' && requested !== 'archived') {
    return NextResponse.json({ error: "status must be 'active', 'on_hold' or 'archived'" }, { status: 400 });
  }

  const [clip] = await db.select({ id: brollClips.id, reviewStatus: brollClips.reviewStatus }).from(brollClips).where(eq(brollClips.id, clipId)).limit(1);
  if (!clip) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Restoring a clip that is already active changes nothing.
  const next = requested === 'active'
    ? (HIDDEN_BROLL_REVIEW_STATUSES.includes(clip.reviewStatus) ? ACTIVE_BROLL_REVIEW_STATUS : clip.reviewStatus)
    : TARGETS[requested];

  if (next !== clip.reviewStatus) {
    const now = Date.now();
    await db.update(brollClips).set({ reviewStatus: next, reviewedBy: auth.user.id, reviewedAt: now, updatedAt: now }).where(eq(brollClips.id, clipId));
  }
  return NextResponse.json({ id: clipId, reviewStatus: next });
}
