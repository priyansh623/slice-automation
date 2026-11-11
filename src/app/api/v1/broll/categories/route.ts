import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollCategories, brollClips } from '@/db/schema.pg';
import { requireUser, requireAdmin } from '@/lib/api-auth';
import { asc, eq, isNull, isNotNull, or, and } from 'drizzle-orm';

export type CategoryRow = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  scope: string;
  brandScope: string | null;
  parentId: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type CategoryNode = CategoryRow & { children: CategoryNode[] };

function buildTree(rows: CategoryRow[]): CategoryNode[] {
  const map = new Map<number, CategoryNode>();
  for (const r of rows) map.set(r.id, { ...r, children: [] });
  const roots: CategoryNode[] = [];
  for (const r of rows) {
    const node = map.get(r.id)!;
    if (r.parentId === null) {
      roots.push(node);
    } else {
      map.get(r.parentId)?.children.push(node);
    }
  }
  return roots;
}

function normalizeBrand(b: string | null | undefined): string | null {
  if (!b) return null;
  const n = b.trim().toLowerCase();
  return n || null;
}

async function getKnownBrands(): Promise<Set<string>> {
  const rows = await db.selectDistinct({ brand: brollClips.brand })
    .from(brollClips)
    .where(isNotNull(brollClips.brand));
  return new Set(rows.map((r) => r.brand!.trim().toLowerCase()).filter(Boolean));
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const brand = req.nextUrl.searchParams.get('brand');

  let rows;
  if (brand) {
    const normalizedBrand = normalizeBrand(brand);
    if (!normalizedBrand) {
      rows = await db.select().from(brollCategories)
        .where(eq(brollCategories.scope, 'soma'))
        .orderBy(asc(brollCategories.sortOrder), asc(brollCategories.name));
    } else {
      rows = await db.select().from(brollCategories)
        .where(or(
          eq(brollCategories.scope, 'soma'),
          and(eq(brollCategories.scope, 'brand'), eq(brollCategories.brandScope, normalizedBrand)),
        ))
        .orderBy(asc(brollCategories.sortOrder), asc(brollCategories.name));
    }
  } else {
    rows = await db.select().from(brollCategories)
      .orderBy(asc(brollCategories.sortOrder), asc(brollCategories.name));
  }

  return NextResponse.json(buildTree(rows as CategoryRow[]));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const adminError = await requireAdmin(authResult.user.id);
  if (adminError) return adminError;

  let body: {
    name: string;
    slug?: string;
    description?: string | null;
    scope?: string;
    brandScope?: string | null;
    parentId?: number | null;
    sortOrder?: number;
  };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const scope = body.scope ?? 'soma';
  if (scope !== 'soma' && scope !== 'brand') {
    return NextResponse.json({ error: "scope must be 'soma' or 'brand'" }, { status: 400 });
  }

  const normalizedBrandScope = normalizeBrand(body.brandScope);

  if (scope === 'brand') {
    if (!normalizedBrandScope) {
      return NextResponse.json({ error: 'brandScope is required when scope is brand' }, { status: 400 });
    }
    const knownBrands = await getKnownBrands();
    if (knownBrands.size === 0) {
      return NextResponse.json(
        { error: 'No brand values found in the library. Upload clips with brand values before creating brand-specific categories.' },
        { status: 422 },
      );
    }
    if (!knownBrands.has(normalizedBrandScope)) {
      return NextResponse.json(
        { error: `Unknown brand '${normalizedBrandScope}'. Valid brands: ${[...knownBrands].sort().join(', ')}` },
        { status: 400 },
      );
    }
  }

  if (scope === 'soma' && normalizedBrandScope) {
    return NextResponse.json({ error: 'brandScope must be null when scope is soma' }, { status: 400 });
  }

  // Validate parent if provided
  if (body.parentId != null) {
    const parentRows = await db.select().from(brollCategories)
      .where(eq(brollCategories.id, body.parentId))
      .limit(1);
    if (parentRows.length === 0) {
      return NextResponse.json({ error: `Parent category ${body.parentId} not found` }, { status: 400 });
    }
    const parent = parentRows[0] as CategoryRow;
    if (parent.scope !== scope) {
      return NextResponse.json({ error: 'Parent scope must match category scope' }, { status: 400 });
    }
    if (scope === 'brand' && normalizeBrand(parent.brandScope) !== normalizedBrandScope) {
      return NextResponse.json({ error: 'Parent brandScope must match category brandScope' }, { status: 400 });
    }
  }

  // Check slug uniqueness
  const existingRows = await db.select({ id: brollCategories.id })
    .from(brollCategories)
    .where(normalizedBrandScope
      ? and(eq(brollCategories.slug, body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')), eq(brollCategories.brandScope, normalizedBrandScope))
      : and(eq(brollCategories.slug, body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')), isNull(brollCategories.brandScope)),
    )
    .limit(1);
  const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (existingRows.length > 0) {
    return NextResponse.json({ error: `Category with slug '${slug}' already exists in this scope` }, { status: 409 });
  }

  const now = Date.now();
  const [inserted] = await db.insert(brollCategories).values({
    name: body.name.trim(),
    slug,
    description: body.description ?? null,
    scope,
    brandScope: normalizedBrandScope,
    parentId: body.parentId ?? null,
    sortOrder: body.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return NextResponse.json(inserted, { status: 201 });
}
