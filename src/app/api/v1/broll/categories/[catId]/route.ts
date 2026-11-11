import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollCategories } from '@/db/schema.pg';
import { requireUser, requireAdmin } from '@/lib/api-auth';
import { eq, isNull } from 'drizzle-orm';
import type { CategoryRow } from '../route';

async function hasCircularRef(catId: number, newParentId: number): Promise<boolean> {
  let currentId: number | null = newParentId;
  const visited = new Set<number>();
  while (currentId !== null) {
    if (currentId === catId) return true;
    if (visited.has(currentId)) return true; // existing cycle guard
    visited.add(currentId);
    const rows = await db.select({ parentId: brollCategories.parentId })
      .from(brollCategories)
      .where(eq(brollCategories.id, currentId))
      .limit(1);
    currentId = rows[0]?.parentId ?? null;
  }
  return false;
}

function normalizeBrand(b: string | null | undefined): string | null {
  if (!b) return null;
  const n = b.trim().toLowerCase();
  return n || null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ catId: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const adminError = await requireAdmin(authResult.user.id);
  if (adminError) return adminError;

  const { catId } = await params;
  const id = parseInt(catId, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  // Fetch existing category
  const existing = await db.select().from(brollCategories).where(eq(brollCategories.id, id)).limit(1);
  if (existing.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const cat = existing[0] as CategoryRow;

  let body: Partial<{
    name: string;
    slug: string;
    description: string | null;
    scope: string;
    parentId: number | null;
    sortOrder: number;
    brandScope: string | null;
  }>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Validate scope
  const effectiveScope = body.scope ?? cat.scope;
  if (body.scope && body.scope !== 'soma' && body.scope !== 'brand') {
    return NextResponse.json({ error: "scope must be 'soma' or 'brand'" }, { status: 400 });
  }

  const effectiveBrandScope = 'brandScope' in body
    ? normalizeBrand(body.brandScope)
    : normalizeBrand(cat.brandScope);

  // Parent validation
  if ('parentId' in body) {
    if (body.parentId === id) {
      return NextResponse.json({ error: 'A category cannot be its own parent' }, { status: 400 });
    }
    if (body.parentId != null) {
      // Check circular
      const circular = await hasCircularRef(id, body.parentId);
      if (circular) {
        return NextResponse.json({ error: 'Setting this parent would create a circular hierarchy' }, { status: 400 });
      }
      // Check parent exists and scope matches
      const parentRows = await db.select().from(brollCategories)
        .where(eq(brollCategories.id, body.parentId))
        .limit(1);
      if (parentRows.length === 0) {
        return NextResponse.json({ error: `Parent category ${body.parentId} not found` }, { status: 400 });
      }
      const parent = parentRows[0] as CategoryRow;
      if (parent.scope !== effectiveScope) {
        return NextResponse.json({ error: 'Parent scope must match category scope' }, { status: 400 });
      }
      if (effectiveScope === 'brand' && normalizeBrand(parent.brandScope) !== effectiveBrandScope) {
        return NextResponse.json({ error: 'Parent brandScope must match category brandScope' }, { status: 400 });
      }
    }
  }

  // Normalize brandScope in update
  const updateData: Record<string, unknown> = { ...body };
  if ('brandScope' in body) {
    updateData.brandScope = normalizeBrand(body.brandScope);
  }

  const now = Date.now();
  const [updated] = await db
    .update(brollCategories)
    .set({ ...updateData, updatedAt: now })
    .where(eq(brollCategories.id, id))
    .returning();

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ catId: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const adminError = await requireAdmin(authResult.user.id);
  if (adminError) return adminError;

  const { catId } = await params;
  const id = parseInt(catId, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  await db.delete(brollCategories).where(eq(brollCategories.id, id));
  return new NextResponse(null, { status: 204 });
}
