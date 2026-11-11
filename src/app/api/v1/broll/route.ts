import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { desc, eq } from 'drizzle-orm';

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

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await db
    .select()
    .from(brollClips)
    .where(eq(brollClips.userId, user.id))
    .orderBy(desc(brollClips.createdAt));

  const now = Date.now();
  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';

  const result = await Promise.all(rows.map(async (clip) => {
    let signedUrl = clip.signedUrl;
    let signedUrlExpiresAt = clip.signedUrlExpiresAt;
    if (!signedUrlExpiresAt || signedUrlExpiresAt < now + ONE_HOUR_MS) {
      const fresh = await refreshSignedUrl(clip.storagePath);
      if (fresh) {
        signedUrl = fresh.url;
        signedUrlExpiresAt = fresh.expiresAt;
        await db.update(brollClips).set({ signedUrl: fresh.url, signedUrlExpiresAt: fresh.expiresAt, updatedAt: now }).where(eq(brollClips.id, clip.id));
      }
    }

    let thumbnailSignedUrl = clip.thumbnailSignedUrl;
    if (clip.thumbnailStoragePath && (!clip.thumbnailSignedUrlExpiresAt || clip.thumbnailSignedUrlExpiresAt < now + ONE_HOUR_MS)) {
      const fresh = await refreshSignedUrl(clip.thumbnailStoragePath);
      if (fresh) {
        thumbnailSignedUrl = fresh.url;
        await db.update(brollClips).set({ thumbnailSignedUrl: fresh.url, thumbnailSignedUrlExpiresAt: fresh.expiresAt, updatedAt: now }).where(eq(brollClips.id, clip.id));
      }
    }

    return { ...clip, signedUrl, thumbnailSignedUrl };
  }));

  return NextResponse.json(result);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { title: string; storagePath: string; thumbnailStoragePath?: string; mimeType?: string; fileSizeBytes?: number; signedUrl?: string; thumbnailSignedUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.title || !body.storagePath) {
    return NextResponse.json({ error: 'title and storagePath are required' }, { status: 400 });
  }

  const now = Date.now();
  const expiresAt = now + URL_TTL_S * 1000;

  const [inserted] = await db.insert(brollClips).values({
    userId: user.id,
    title: body.title,
    storagePath: body.storagePath,
    thumbnailStoragePath: body.thumbnailStoragePath ?? null,
    signedUrl: body.signedUrl ?? null,
    signedUrlExpiresAt: body.signedUrl ? expiresAt : null,
    thumbnailSignedUrl: body.thumbnailSignedUrl ?? null,
    thumbnailSignedUrlExpiresAt: body.thumbnailSignedUrl ? expiresAt : null,
    mimeType: body.mimeType ?? 'video/mp4',
    fileSizeBytes: body.fileSizeBytes ?? null,
    processingStatus: 'pending',
    reviewStatus: 'unreviewed',
    createdAt: now,
    updatedAt: now,
  }).returning();

  return NextResponse.json(inserted, { status: 201 });
}
