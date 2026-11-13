import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { adminSettings, videoProjects, videoScreens } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { getStorage } from '@/lib/object-store';
import { locate } from '@/lib/object-store/registry';
import { desc, eq, inArray } from 'drizzle-orm';

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await db
    .select()
    .from(videoProjects)
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
  // Projects whose image is on R2 never use the cache: signing there is a local computation, and a cached URL could
  // still point at the old Supabase copy.
  const storage = getStorage();
  const ONE_HOUR_MS = 3_600_000;
  const URL_TTL_S = 24 * 3600; // 24-hour TTL; refresh 1 h before expiry
  const now = Date.now();
  const locations = await locate('uploads', rows.map((p) => p.baseImagePath).filter(Boolean));
  const onR2 = new Set(rows.filter((p) => locations.get(p.baseImagePath) === 'r2').map((p) => p.id));

  const needsRefresh = rows.filter(
    (p) => onR2.has(p.id) || !p.baseImageSignedUrlExpiresAt || p.baseImageSignedUrlExpiresAt < now + ONE_HOUR_MS,
  );
  const refreshPaths = needsRefresh.map((p) => p.baseImagePath).filter(Boolean) as string[];
  const refreshedUrlMap = new Map<string, string>();

  if (refreshPaths.length > 0) {
    const freshUrls = await storage.signedReadUrls('uploads', refreshPaths, URL_TTL_S);
    const expiresAt = now + URL_TTL_S * 1000;
    const writeResults = await Promise.allSettled(
      [...freshUrls.entries()].map(([path, url]) => {
        refreshedUrlMap.set(path, url);
        const proj = needsRefresh.find((p) => p.baseImagePath === path);
        if (!proj || onR2.has(proj.id)) return Promise.resolve();
        return db.update(videoProjects)
          .set({ baseImageSignedUrl: url, baseImageSignedUrlExpiresAt: expiresAt })
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
      if (!onR2.has(p.id) && p.baseImageSignedUrl && p.baseImageSignedUrlExpiresAt && p.baseImageSignedUrlExpiresAt >= now + ONE_HOUR_MS) {
        return [p.id, p.baseImageSignedUrl];
      }
      const refreshed = refreshedUrlMap.get(p.baseImagePath) ?? null;
      if (refreshed) return [p.id, refreshed];
      // Signing failed: serve existing URL if it has not actually expired yet (still within safety buffer).
      if (!onR2.has(p.id) && p.baseImageSignedUrl && p.baseImageSignedUrlExpiresAt && p.baseImageSignedUrlExpiresAt > now) {
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

  try {
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
        skillVersion: body.skillVersion ?? 'v3',
        creatorDescription: body.creatorDescription?.trim() || null,
        scene1HookSnapshot,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return NextResponse.json(inserted[0], { status: 201 });
  } catch (err) {
    console.error('[POST /api/v1/video-projects]', err);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
