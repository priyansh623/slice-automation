import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq } from 'drizzle-orm';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = Number(id);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const [clip] = await db
    .select()
    .from(brollClips)
    .where(and(eq(brollClips.id, clipId), eq(brollClips.userId, user.id)))
    .limit(1);

  if (!clip) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(clip);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = Number(id);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: Partial<{
    title: string;
    category: string;
    notes: string;
    userTags: string[];
    qualityRating: number;
    reviewStatus: string;
    processingStatus: string;
    durationSeconds: number;
  }>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const now = Date.now();
  const updates: Record<string, unknown> = { updatedAt: now };

  if (body.title !== undefined) updates.title = body.title;
  if (body.category !== undefined) updates.category = body.category;
  if (body.notes !== undefined) updates.notes = body.notes;
  if (body.userTags !== undefined) updates.userTags = JSON.stringify(body.userTags);
  if (body.qualityRating !== undefined) updates.qualityRating = body.qualityRating;
  if (body.durationSeconds !== undefined) updates.durationSeconds = body.durationSeconds;
  if (body.reviewStatus !== undefined) {
    updates.reviewStatus = body.reviewStatus;
    updates.reviewedAt = now;
    updates.reviewedBy = user.id;
  }
  if (body.processingStatus !== undefined) updates.processingStatus = body.processingStatus;

  const [updated] = await db
    .update(brollClips)
    .set(updates)
    .where(and(eq(brollClips.id, clipId), eq(brollClips.userId, user.id)))
    .returning();

  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = Number(id);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const [deleted] = await db
    .delete(brollClips)
    .where(and(eq(brollClips.id, clipId), eq(brollClips.userId, user.id)))
    .returning();

  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
