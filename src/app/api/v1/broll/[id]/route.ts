import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { and, eq } from 'drizzle-orm';

const ONE_HOUR_MS = 3_600_000;
const URL_TTL_S = 24 * 3600;

async function refreshSignedUrl(storagePath: string): Promise<{ url: string; expiresAt: number } | null> {
  if (!storagePath) return null;
  try {
    const service = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';
    const { data } = await service.storage.from(bucket).createSignedUrl(storagePath, URL_TTL_S);
    if (!data?.signedUrl) return null;
    return { url: data.signedUrl, expiresAt: Date.now() + URL_TTL_S * 1000 };
  } catch {
    return null;
  }
}

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

  // Refresh signed URL if needed
  const now = Date.now();
  let signedUrl = clip.signedUrl;
  if (!clip.signedUrlExpiresAt || clip.signedUrlExpiresAt < now + ONE_HOUR_MS) {
    const fresh = await refreshSignedUrl(clip.storagePath);
    if (fresh) {
      signedUrl = fresh.url;
      await db.update(brollClips).set({ signedUrl: fresh.url, signedUrlExpiresAt: fresh.expiresAt, updatedAt: now }).where(eq(brollClips.id, clip.id));
    }
  }

  return NextResponse.json({ ...clip, signedUrl });
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
