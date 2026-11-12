import { NextRequest, NextResponse } from 'next/server';
import { and, desc, notInArray } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';
import { requireAdmin, requireUser } from '@/lib/api-auth';
import { CLOSED_BROLL_REVIEW_STATUSES, unclassifiedBrollCondition } from '@/lib/broll-visibility';

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const tags = JSON.parse(raw);
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

// Admin-only management view of clips that have no category and so never appear in the library.
// Archived and rejected clips are left out unless ?includeArchived=true.
// Returns identifying and status fields only; no signed URLs and no storage paths.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const forbidden = await requireAdmin(auth.user.id);
  if (forbidden) return forbidden;

  const includeArchived = req.nextUrl.searchParams.get('includeArchived') === 'true';

  const rows = await db
    .select({
      id: brollClips.id,
      title: brollClips.title,
      reviewStatus: brollClips.reviewStatus,
      brand: brollClips.brand,
      userTags: brollClips.userTags,
      durationSeconds: brollClips.durationSeconds,
      uploadedBy: brollClips.userId,
      createdAt: brollClips.createdAt,
    })
    .from(brollClips)
    .where(and(
      unclassifiedBrollCondition(),
      includeArchived ? undefined : notInArray(brollClips.reviewStatus, CLOSED_BROLL_REVIEW_STATUSES),
    ))
    .orderBy(desc(brollClips.createdAt));

  return NextResponse.json(rows.map((r) => ({
    id: r.id,
    title: r.title,
    classificationStatus: 'unclassified' as const,
    reviewStatus: r.reviewStatus,
    brand: r.brand,
    tags: parseTags(r.userTags),
    durationSeconds: r.durationSeconds,
    uploadedBy: r.uploadedBy,
    createdAt: r.createdAt,
  })));
}
