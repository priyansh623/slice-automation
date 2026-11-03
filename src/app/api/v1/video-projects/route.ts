import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { adminSettings, videoProjects, videoScreens } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { desc, eq, inArray } from 'drizzle-orm';

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await db
    .select()
    .from(videoProjects)
    .where(eq(videoProjects.userId, user.id))
    .orderBy(desc(videoProjects.createdAt));

  const projectIds = rows.map((p) => p.id);
  const allScreens = projectIds.length > 0
    ? await db
        .select({ videoProjectId: videoScreens.videoProjectId, approvedGenerationId: videoScreens.approvedGenerationId })
        .from(videoScreens)
        .where(inArray(videoScreens.videoProjectId, projectIds))
    : [];

  const screensByProject = new Map<number, { total: number; approved: number }>();
  for (const s of allScreens) {
    const existing = screensByProject.get(s.videoProjectId) ?? { total: 0, approved: 0 };
    screensByProject.set(s.videoProjectId, {
      total: existing.total + 1,
      approved: existing.approved + (s.approvedGenerationId ? 1 : 0),
    });
  }

  // Generate signed preview URLs for all base images in one batch call
  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';
  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const paths = rows.map((p) => p.baseImagePath).filter(Boolean) as string[];
  const { data: signedUrlsData } = paths.length > 0
    ? await serviceClient.storage.from(bucket).createSignedUrls(paths, 3600)
    : { data: [] };
  const signedUrlMap = new Map(
    (signedUrlsData ?? []).map((item) => [item.path, item.signedUrl]),
  );

  return NextResponse.json(rows.map((p) => ({
    ...p,
    approvedSceneCount: screensByProject.get(p.id)?.approved ?? 0,
    totalSceneCount: screensByProject.get(p.id)?.total ?? 0,
    ownerEmail: user.email ?? null,
    baseImagePreviewUrl: signedUrlMap.get(p.baseImagePath) ?? null,
  })));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { name: string; originalScript: string; baseImagePath: string; skillVersion?: string; creatorDescription?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.name || !body.originalScript) {
    return NextResponse.json({ error: 'name and originalScript are required' }, { status: 400 });
  }
  if (!body.baseImagePath) {
    return NextResponse.json({ error: 'baseImagePath is required' }, { status: 400 });
  }

  // Snapshot the current scene1HookInstruction at creation time
  const settingsRows = await db.select().from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
  const scene1HookSnapshot = settingsRows[0]?.scene1HookInstruction ?? null;

  const now = Date.now();
  const inserted = await db
    .insert(videoProjects)
    .values({
      userId: user.id,
      name: body.name,
      baseImagePath: body.baseImagePath,
      originalScript: body.originalScript,
      skillVersion: body.skillVersion ?? 'v1',
      creatorDescription: body.creatorDescription?.trim() || null,
      scene1HookSnapshot,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return NextResponse.json(inserted[0], { status: 201 });
}
