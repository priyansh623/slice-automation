import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, screenPromptVersions, videoGenerations, generationFeedback, videoCompilations, compilationSceneSelections, promptGenerationTasks, claudeConversations, analyticsEvents, projectTesters } from '@/db/schema.pg';
import { getStorage } from '@/lib/object-store';
import { locate } from '@/lib/object-store/registry';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/api-auth';
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

  const [projectRows, allScreens] = await Promise.all([
    db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1),
    db.select().from(videoScreens).where(eq(videoScreens.videoProjectId, projectId)),
  ]);

  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const screens = allScreens.sort((a, b) => a.position - b.position);
  const screenIds = screens.map((s) => s.id);
  // DB-backed signed URL cache: skip Storage call when the cached URL is still fresh.
  // An image on R2 never uses the cache (signing there is local, and a cached URL may still point at the Supabase copy).
  const ONE_HOUR_MS = 3_600_000;
  const URL_TTL_S = 24 * 3600; // 24-hour TTL; refresh 1 h before expiry
  const nowMs = Date.now();
  let baseImagePreviewUrl: string | null = null;
  const onR2 = (await locate('uploads', [project.baseImagePath])).get(project.baseImagePath) === 'r2';
  if (
    !onR2 &&
    project.baseImageSignedUrl &&
    project.baseImageSignedUrlExpiresAt &&
    project.baseImageSignedUrlExpiresAt >= nowMs + ONE_HOUR_MS
  ) {
    baseImagePreviewUrl = project.baseImageSignedUrl;
  } else {
    const signed = await Promise.race([
      getStorage().signedReadUrl('uploads', project.baseImagePath, URL_TTL_S),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]).catch(() => null);
    if (signed) {
      baseImagePreviewUrl = signed;
      if (!onR2) {
        const expiresAt = nowMs + URL_TTL_S * 1000;
        try {
          await db.update(videoProjects)
            .set({ baseImageSignedUrl: baseImagePreviewUrl, baseImageSignedUrlExpiresAt: expiresAt })
            .where(eq(videoProjects.id, projectId));
        } catch (err) {
          console.warn(`[video-projects/${projectId}] signed URL cache write failed:`, err);
        }
      }
    } else if (
      !onR2 &&
      project.baseImageSignedUrl &&
      project.baseImageSignedUrlExpiresAt &&
      project.baseImageSignedUrlExpiresAt > nowMs
    ) {
      // Signing failed but the existing URL has not yet expired — serve it rather than returning null.
      baseImagePreviewUrl = project.baseImageSignedUrl;
    }
  }

  // Fetch only the columns needed by the breakdown view; avoid pulling every generation column.
  type GenRow = { id: number; videoScreenId: number; status: string; videoStoragePath: string | null; updatedAt: number };
  const [promptRows, allGens, promptTaskRows] = await Promise.all([
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
    screenIds.length > 0
      ? db.select({ videoScreenId: promptGenerationTasks.videoScreenId, status: promptGenerationTasks.status })
          .from(promptGenerationTasks)
          .where(inArray(promptGenerationTasks.videoScreenId, screenIds))
      : Promise.resolve([] as { videoScreenId: number | null; status: string }[]),
  ]);

  const promptPresence = new Map<number, boolean>();
  for (const r of promptRows) promptPresence.set(r.videoScreenId, true);

  // Active prompt task status per screen (pending/processing = in progress, completed/failed = done)
  const promptTaskByScreen = new Map<number, string>();
  for (const t of promptTaskRows) {
    if (t.videoScreenId === null) continue;
    const existing = promptTaskByScreen.get(t.videoScreenId);
    // Prefer active over terminal states
    const isActive = t.status === 'pending' || t.status === 'processing';
    if (!existing || isActive) promptTaskByScreen.set(t.videoScreenId, t.status);
  }

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
    promptTaskStatus: promptTaskByScreen.get(s.id) ?? null,
  }));

  return NextResponse.json({
    ...project,
    baseImagePreviewUrl,
    screens: enrichedScreens,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const projectRows = await db.select({ id: videoProjects.id })
    .from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  if (!projectRows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Cascade delete manually in FK-safe order
  const screenRows = await db.select({ id: videoScreens.id }).from(videoScreens).where(eq(videoScreens.videoProjectId, projectId));
  const screenIds = screenRows.map((s) => s.id);

  const compilationRows = await db.select({ id: videoCompilations.id }).from(videoCompilations).where(eq(videoCompilations.videoProjectId, projectId));
  const compilationIds = compilationRows.map((c) => c.id);

  // compilationSceneSelections must come before videoGenerations (FK: css.video_generation_id → video_generations.id)
  if (compilationIds.length > 0) {
    await db.delete(compilationSceneSelections).where(inArray(compilationSceneSelections.compilationId, compilationIds));
    await db.delete(videoCompilations).where(eq(videoCompilations.videoProjectId, projectId));
  }

  if (screenIds.length > 0) {
    // Null out approvedGenerationId before deleting generations (FK: video_screens_approved_gen_fk)
    await db.update(videoScreens).set({ approvedGenerationId: null }).where(inArray(videoScreens.id, screenIds));
    const genRows = await db.select({ id: videoGenerations.id }).from(videoGenerations).where(inArray(videoGenerations.videoScreenId, screenIds));
    const genIds = genRows.map((g) => g.id);
    if (genIds.length > 0) await db.delete(generationFeedback).where(inArray(generationFeedback.videoGenerationId, genIds));
    await db.delete(videoGenerations).where(inArray(videoGenerations.videoScreenId, screenIds));
    await db.delete(screenPromptVersions).where(inArray(screenPromptVersions.videoScreenId, screenIds));
  }

  await db.delete(promptGenerationTasks).where(eq(promptGenerationTasks.videoProjectId, projectId));
  await db.delete(claudeConversations).where(eq(claudeConversations.videoProjectId, projectId));
  await db.delete(projectTesters).where(eq(projectTesters.videoProjectId, projectId));

  if (screenIds.length > 0) await db.delete(videoScreens).where(eq(videoScreens.videoProjectId, projectId));

  await db.update(analyticsEvents).set({ videoProjectId: null }).where(eq(analyticsEvents.videoProjectId, projectId));
  await db.delete(videoProjects).where(eq(videoProjects.id, projectId));

  return NextResponse.json({ ok: true });
}
