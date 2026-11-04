import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, screenPromptVersions, videoGenerations } from '@/db/schema.pg';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { eq, inArray } from 'drizzle-orm';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const [projectRows, allScreens] = await Promise.all([
    db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1),
    db.select().from(videoScreens).where(eq(videoScreens.videoProjectId, projectId)),
  ]);

  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (project.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const screens = allScreens.sort((a, b) => a.position - b.position);
  const screenIds = screens.map((s) => s.id);
  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';

  // DB-backed signed URL cache: skip Storage call when the cached URL is still fresh.
  const ONE_HOUR_MS = 3_600_000;
  const URL_TTL_S = 7 * 24 * 3600;
  const nowMs = Date.now();
  let baseImagePreviewUrl: string | null = null;
  if (
    project.baseImageSignedUrl &&
    project.baseImageSignedUrlExpiresAt &&
    project.baseImageSignedUrlExpiresAt >= nowMs + ONE_HOUR_MS
  ) {
    baseImagePreviewUrl = project.baseImageSignedUrl;
  } else {
    const signedResult = await Promise.race([
      serviceClient.storage.from(bucket).createSignedUrl(project.baseImagePath, URL_TTL_S),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]).catch(() => ({ data: null as null }));
    if (signedResult.data?.signedUrl) {
      baseImagePreviewUrl = signedResult.data.signedUrl;
      const expiresAt = nowMs + URL_TTL_S * 1000;
      try {
        await db.update(videoProjects)
          .set({ baseImageSignedUrl: baseImagePreviewUrl, baseImageSignedUrlExpiresAt: expiresAt })
          .where(eq(videoProjects.id, projectId));
      } catch {
        // Cache write failure is non-fatal; signed URL was already obtained.
      }
    }
  }

  // Fetch only the columns needed by the breakdown view; avoid pulling every generation column.
  type GenRow = { id: number; videoScreenId: number; status: string; videoStoragePath: string | null; updatedAt: number };
  const [promptRows, allGens] = await Promise.all([
    screenIds.length > 0
      ? db.select({ videoScreenId: screenPromptVersions.videoScreenId }).from(screenPromptVersions).where(inArray(screenPromptVersions.videoScreenId, screenIds))
      : Promise.resolve([] as { videoScreenId: number }[]),
    screenIds.length > 0
      ? db.select({
          id: videoGenerations.id,
          videoScreenId: videoGenerations.videoScreenId,
          status: videoGenerations.status,
          videoStoragePath: videoGenerations.videoStoragePath,
          updatedAt: videoGenerations.updatedAt,
        }).from(videoGenerations).where(inArray(videoGenerations.videoScreenId, screenIds))
      : Promise.resolve([] as GenRow[]),
  ]);

  const promptPresence = new Map<number, boolean>();
  for (const r of promptRows) promptPresence.set(r.videoScreenId, true);

  type GenSummary = { id: number; status: string; videoStoragePath: string | null; updatedAt: number };
  const latestGenByScreen = new Map<number, GenSummary>();
  const latestCompletedGenByScreen = new Map<number, { id: number; videoStoragePath: string }>();
  const sorted = (allGens as GenRow[]).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const gen of sorted) {
    if (!latestGenByScreen.has(gen.videoScreenId)) {
      latestGenByScreen.set(gen.videoScreenId, {
        id: gen.id,
        status: gen.status,
        videoStoragePath: gen.videoStoragePath ?? null,
        updatedAt: gen.updatedAt,
      });
    }
    if (gen.status === 'completed' && gen.videoStoragePath && !latestCompletedGenByScreen.has(gen.videoScreenId)) {
      latestCompletedGenByScreen.set(gen.videoScreenId, { id: gen.id, videoStoragePath: gen.videoStoragePath });
    }
  }

  const enrichedScreens = screens.map((s) => ({
    ...s,
    hasPrompt: promptPresence.get(s.id) ?? false,
    latestGen: latestGenByScreen.get(s.id) ?? null,
    latestCompletedGen: latestCompletedGenByScreen.get(s.id) ?? null,
  }));

  return NextResponse.json({
    ...project,
    baseImagePreviewUrl,
    screens: enrichedScreens,
  });
}
