import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollClipCategories, brollClips } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { activeBrollLibraryCondition, effectiveClearance, effectiveClearanceCondition, isBrollClearanceStatus, isUsableFootage } from '@/lib/broll-visibility';
import { loadClipBrands } from '@/lib/broll-brands';

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

// Returns the active library: classified clips that are not on hold, archived or rejected.
// Visibility is not clearance. Each clip reports:
//   clearanceStatus     the clip-level decision
//   effectiveClearance  cleared only if the clip and every brand on it are cleared; not_cleared if the
//                       clip or any brand is not cleared; otherwise unresolved
//   clearedForUse       true only when usable (effectiveClearance is cleared)
//   notCleared          true when effectiveClearance is not_cleared
// ?clearance=cleared returns usable footage only; ?clearance=not_cleared and ?clearance=unresolved
// filter on effectiveClearance, so the three filters partition the library.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const clearanceParam = req.nextUrl.searchParams.get('clearance');
  if (clearanceParam !== null && !isBrollClearanceStatus(clearanceParam)) {
    return NextResponse.json({ error: "clearance must be 'unresolved', 'cleared' or 'not_cleared'" }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(brollClips)
    .where(and(
      activeBrollLibraryCondition(),
      clearanceParam ? effectiveClearanceCondition(clearanceParam) : undefined,
    ))
    .orderBy(desc(brollClips.createdAt));

  const now = Date.now();

  // Load category assignments for all clips in one query
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
    const categoryIds = categoryMap.get(clip.id) ?? [];
    const brands = brandMap.get(clip.id) ?? [];
    const brandClearanceStatuses = brands.map((b) => b.clearanceStatus);
    const effective = effectiveClearance(clip.clearanceStatus, brandClearanceStatuses);
    return {
      ...clip,
      signedUrl,
      categoryIds,
      classificationStatus: 'classified' as const,
      effectiveClearance: effective,
      clearedForUse: isUsableFootage({ reviewStatus: clip.reviewStatus, categoryCount: categoryIds.length, clearanceStatus: clip.clearanceStatus, brandClearanceStatuses }),
      notCleared: effective === 'not_cleared',
      brands,
    };
  }));

  return NextResponse.json(result);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  return NextResponse.json(inserted, { status: 201 });
}
