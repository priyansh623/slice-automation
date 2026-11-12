import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollClipCategories, brollClips } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { desc, inArray } from 'drizzle-orm';
import { activeBrollLibraryCondition } from '@/lib/broll-visibility';
import { loadClipBrands } from '@/lib/broll-brands';
import { isAdminUser } from '@/lib/api-auth';
import { clipForViewer } from '@/lib/broll-access';
import { BROLL_URL_TTL_S, currentSignedUrl } from '@/lib/broll-signed-url';

const URL_TTL_S = BROLL_URL_TTL_S;

// The shared library: classified clips that are not on hold, archived or rejected. Every signed-in user gets
// the same clips; the viewer's role only decides how much of each clip is returned (non-admins do not receive
// internal notes, the uploader id, storage paths or unnamed brand observations).
// Admins find unclassified uploads and held or archived clips through the management endpoints instead.
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const isAdmin = await isAdminUser(user.id);

  const rows = await db
    .select()
    .from(brollClips)
    .where(activeBrollLibraryCondition())
    .orderBy(desc(brollClips.createdAt));

  const clipIds = rows.map((c) => c.id);
  const categoryRows = clipIds.length > 0
    ? await db.select({ clipId: brollClipCategories.clipId, categoryId: brollClipCategories.categoryId })
        .from(brollClipCategories)
        .where(inArray(brollClipCategories.clipId, clipIds))
    : [];
  const categoryMap = new Map<number, number[]>();
  for (const r of categoryRows) {
    if (!categoryMap.has(r.clipId)) categoryMap.set(r.clipId, []);
    categoryMap.get(r.clipId)!.push(r.categoryId);
  }
  const brandMap = await loadClipBrands(db, clipIds);

  const result = await Promise.all(rows.map(async (clip) => {
    const signedUrl = await currentSignedUrl(clip);
    const categoryIds = categoryMap.get(clip.id) ?? [];
    return clipForViewer(clip, { categoryIds, categoryCount: categoryIds.length, brands: brandMap.get(clip.id) ?? [], signedUrl }, isAdmin);
  }));

  return NextResponse.json(result);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Only administrators add footage to the library.
  if (!(await isAdminUser(user.id))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: {
    title: string;
    storagePath: string;
    mimeType?: string;
    fileSizeBytes?: number;
    durationSeconds?: number | null;
    signedUrl?: string;
    userTags?: string[];
    subject?: string | null;
    activity?: string | null;
    setting?: string | null;
    brand?: string | null;
    description?: string | null;
  };
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
    signedUrl: body.signedUrl ?? null,
    signedUrlExpiresAt: body.signedUrl ? expiresAt : null,
    mimeType: body.mimeType ?? 'video/mp4',
    fileSizeBytes: body.fileSizeBytes ?? null,
    durationSeconds: body.durationSeconds ?? null,
    userTags: body.userTags ? JSON.stringify(body.userTags) : null,
    subject: body.subject ?? null,
    activity: body.activity ?? null,
    setting: body.setting ?? null,
    brand: body.brand ?? null,
    description: body.description ?? null,
    processingStatus: 'completed',
    reviewStatus: 'unreviewed',
    createdAt: now,
    updatedAt: now,
  }).returning();

  return NextResponse.json(
    clipForViewer(inserted, { categoryCount: 0, brands: [], signedUrl: inserted.signedUrl }, true),
    { status: 201 },
  );
}
