import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, screenPromptVersions, videoGenerations } from '@/db/schema.pg';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { eq, inArray } from 'drizzle-orm';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Batch 1: project + screens in parallel (both only need projectId)
  const [projectRows, allScreens] = await Promise.all([
    db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1),
    db.select().from(videoScreens).where(eq(videoScreens.videoProjectId, projectId)),
  ]);

  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const screens = allScreens.sort((a, b) => a.position - b.position);
  const screenIds = screens.map((s) => s.id);
  const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';

  // Batch 2: prompt presence, generations, and signed URL all in parallel
  const [promptRows, allGens, signedResult] = await Promise.all([
    screenIds.length > 0
      ? db.select({ videoScreenId: screenPromptVersions.videoScreenId }).from(screenPromptVersions).where(inArray(screenPromptVersions.videoScreenId, screenIds))
      : Promise.resolve([] as { videoScreenId: number }[]),
    screenIds.length > 0
      ? db.select().from(videoGenerations).where(inArray(videoGenerations.videoScreenId, screenIds))
      : Promise.resolve([] as typeof videoGenerations.$inferSelect[]),
    Promise.race([
      supabase.storage.from(bucket).createSignedUrl(project.baseImagePath, 3600),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]).catch(() => ({ data: null as null })),
  ]);

  const promptPresence = new Map<number, boolean>();
  for (const r of promptRows) promptPresence.set(r.videoScreenId, true);

  type GenSummary = { id: number; status: string; videoStoragePath: string | null; updatedAt: number };
  const latestGenByScreen = new Map<number, GenSummary>();
  const latestCompletedGenByScreen = new Map<number, { id: number; videoStoragePath: string }>();
  const sorted = allGens.sort((a, b) => b.updatedAt - a.updatedAt);
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
    baseImagePreviewUrl: signedResult.data?.signedUrl ?? null,
    screens: enrichedScreens,
  });
}
