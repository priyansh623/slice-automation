import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollClipCategories, brollCategories, brollClips } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq, inArray } from 'drizzle-orm';

function normalizeBrand(b: string | null | undefined): string | null {
  if (!b) return null;
  const n = b.trim().toLowerCase();
  return n || null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = parseInt(id, 10);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const rows = await db
    .select({ categoryId: brollClipCategories.categoryId })
    .from(brollClipCategories)
    .where(eq(brollClipCategories.clipId, clipId));

  return NextResponse.json(rows.map((r) => r.categoryId));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = parseInt(id, 10);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: { categoryIds: number[] };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!Array.isArray(body.categoryIds) || body.categoryIds.length === 0) {
    return NextResponse.json({ error: 'categoryIds array required' }, { status: 400 });
  }

  // Fetch the clip to get its brand.
  const clipRows = await db.select({ brand: brollClips.brand })
    .from(brollClips)
    .where(eq(brollClips.id, clipId))
    .limit(1);
  if (clipRows.length === 0) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
  const clipBrand = normalizeBrand(clipRows[0].brand);

  // Validate all category IDs exist
  const foundCategories = await db.select({ id: brollCategories.id, scope: brollCategories.scope, brandScope: brollCategories.brandScope })
    .from(brollCategories)
    .where(inArray(brollCategories.id, body.categoryIds));

  const foundIds = new Set(foundCategories.map((c) => c.id));
  const missing = body.categoryIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return NextResponse.json({ error: `Category IDs not found: ${missing.join(', ')}` }, { status: 400 });
  }

  // Check brand compatibility: brand-scoped categories must match the clip's brand
  for (const cat of foundCategories) {
    if (cat.scope === 'brand') {
      const catBrand = normalizeBrand(cat.brandScope);
      if (catBrand !== clipBrand) {
        return NextResponse.json(
          { error: `Category ${cat.id} belongs to brand '${catBrand ?? 'unknown'}' but clip brand is '${clipBrand ?? 'none'}'` },
          { status: 400 },
        );
      }
    }
  }

  const now = Date.now();
  const values = body.categoryIds.map((categoryId) => ({ clipId, categoryId, createdAt: now }));

  await db
    .insert(brollClipCategories)
    .values(values)
    .onConflictDoNothing();

  return new NextResponse(null, { status: 204 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const clipId = parseInt(id, 10);
  if (isNaN(clipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: { categoryIds?: number[] };
  try { body = await req.json(); } catch { body = {}; }

  const owner = await db.select({ id: brollClips.id }).from(brollClips).where(eq(brollClips.id, clipId)).limit(1);
  if (owner.length === 0) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });

  if (body.categoryIds && body.categoryIds.length > 0) {
    await db.delete(brollClipCategories).where(
      and(
        eq(brollClipCategories.clipId, clipId),
        inArray(brollClipCategories.categoryId, body.categoryIds),
      ),
    );
  } else {
    await db.delete(brollClipCategories).where(eq(brollClipCategories.clipId, clipId));
  }

  return new NextResponse(null, { status: 204 });
}
