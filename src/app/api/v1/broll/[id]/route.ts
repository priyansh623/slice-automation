import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollClipCategories, brollClips } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { eq, sql } from 'drizzle-orm';
import { isInActiveBrollLibrary } from '@/lib/broll-visibility';
import { loadClipBrands } from '@/lib/broll-brands';
import { isAdminUser } from '@/lib/api-auth';
import { canManageClip, clipForViewer } from '@/lib/broll-access';
import { currentSignedUrl } from '@/lib/broll-signed-url';

// Detail of one clip.
//   everyone        any clip in the shared library (classified, not on hold, archived or rejected)
//   administrators  also unclassified, held and archived clips, so they can manage them
// A clip outside the library answers 404 to non-admins, whoever uploaded it.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = Number(id);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const [clip] = await db.select().from(brollClips).where(eq(brollClips.id, clipId)).limit(1);
  if (!clip) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [{ categoryCount }] = await db
    .select({ categoryCount: sql<number>`count(*)::int` })
    .from(brollClipCategories)
    .where(eq(brollClipCategories.clipId, clip.id));

  const isAdmin = await isAdminUser(user.id);
  if (!isAdmin && !isInActiveBrollLibrary(clip.reviewStatus, categoryCount)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const signedUrl = await currentSignedUrl(clip);
  const brands = (await loadClipBrands(db, [clip.id])).get(clip.id) ?? [];
  return NextResponse.json(clipForViewer(clip, { categoryCount, brands, signedUrl }, isAdmin));
}

// Edits a clip's metadata. Administrators can edit any clip; everyone else only clips they uploaded.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = Number(id);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: Partial<{
    title: string;
    userTags: string[];
    subject: string | null;
    activity: string | null;
    setting: string | null;
    brand: string | null;
    description: string | null;
    durationSeconds: number;
  }>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const isAdmin = await isAdminUser(user.id);
  if (!canManageClip(isAdmin)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const [existing] = await db.select({ id: brollClips.id }).from(brollClips).where(eq(brollClips.id, clipId)).limit(1);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const now = Date.now();
  const updates: Record<string, unknown> = { updatedAt: now };

  if (body.title !== undefined) updates.title = body.title;
  if (body.userTags !== undefined) updates.userTags = JSON.stringify(body.userTags);
  if (body.subject !== undefined) updates.subject = body.subject;
  if (body.activity !== undefined) updates.activity = body.activity;
  if (body.setting !== undefined) updates.setting = body.setting;
  if (body.brand !== undefined) updates.brand = body.brand;
  if (body.description !== undefined) updates.description = body.description;
  if (body.durationSeconds !== undefined) updates.durationSeconds = body.durationSeconds;

  const [updated] = await db.update(brollClips).set(updates).where(eq(brollClips.id, clipId)).returning();
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [{ categoryCount }] = await db
    .select({ categoryCount: sql<number>`count(*)::int` })
    .from(brollClipCategories)
    .where(eq(brollClipCategories.clipId, clipId));
  const brands = (await loadClipBrands(db, [clipId])).get(clipId) ?? [];
  return NextResponse.json(clipForViewer(updated, { categoryCount, brands, signedUrl: updated.signedUrl }, isAdmin));
}

// Deletes a clip permanently. Administrators can delete any clip; everyone else only clips they uploaded.
// Administrators can archive a clip instead (PATCH /api/v1/broll/[id]/status), which keeps it.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = Number(id);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const isAdmin = await isAdminUser(user.id);
  if (!canManageClip(isAdmin)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const [existing] = await db.select({ id: brollClips.id }).from(brollClips).where(eq(brollClips.id, clipId)).limit(1);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await db.delete(brollClips).where(eq(brollClips.id, clipId));
  return NextResponse.json({ ok: true });
}
