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

  // DB-backed signed URL cache: only call Storage for projects whose cached URL has expired.
  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';
  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ONE_HOUR_MS = 3_600_000;
  const URL_TTL_S = 7 * 24 * 3600; // 7-day TTL; refresh 1 h before expiry
  const now = Date.now();

  const needsRefresh = rows.filter(
    (p) => !p.baseImageSignedUrlExpiresAt || p.baseImageSignedUrlExpiresAt < now + ONE_HOUR_MS,
  );
  const refreshPaths = needsRefresh.map((p) => p.baseImagePath).filter(Boolean) as string[];
  const refreshedUrlMap = new Map<string, string>();

  if (refreshPaths.length > 0) {
    const { data: freshUrls } = await serviceClient.storage.from(bucket).createSignedUrls(refreshPaths, URL_TTL_S);
    const expiresAt = now + URL_TTL_S * 1000;
    const writeResults = await Promise.allSettled(
      (freshUrls ?? []).map((item) => {
        if (!item.signedUrl || !item.path) return Promise.resolve();
        refreshedUrlMap.set(item.path, item.signedUrl);
        const proj = needsRefresh.find((p) => p.baseImagePath === item.path);
        if (!proj) return Promise.resolve();
        return db.update(videoProjects)
          .set({ baseImageSignedUrl: item.signedUrl, baseImageSignedUrlExpiresAt: expiresAt })
          .where(eq(videoProjects.id, proj.id));
      }),
    );
    for (const r of writeResults) {
      if (r.status === 'rejected') {
        console.warn('[video-projects] signed URL cache write failed:', r.reason);
      }
    }
  }

  const signedUrlById = new Map<number, string | null>(
    rows.map((p) => {
      if (p.baseImageSignedUrl && p.baseImageSignedUrlExpiresAt && p.baseImageSignedUrlExpiresAt >= now + ONE_HOUR_MS) {
        return [p.id, p.baseImageSignedUrl];
      }
      const refreshed = refreshedUrlMap.get(p.baseImagePath) ?? null;
      if (refreshed) return [p.id, refreshed];
      // Signing failed: serve existing URL if it has not actually expired yet (still within safety buffer).
      if (p.baseImageSignedUrl && p.baseImageSignedUrlExpiresAt && p.baseImageSignedUrlExpiresAt > now) {
        return [p.id, p.baseImageSignedUrl];
      }
      return [p.id, null];
    }),
  );

  return NextResponse.json(rows.map((p) => ({
    ...p,
    approvedSceneCount: screensByProject.get(p.id)?.approved ?? 0,
    totalSceneCount: screensByProject.get(p.id)?.total ?? 0,
    ownerEmail: user.email ?? null,
    baseImagePreviewUrl: signedUrlById.get(p.id) ?? null,
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
