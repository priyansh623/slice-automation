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

  const projectRows = await db
    .select()
    .from(videoProjects)
    .where(eq(videoProjects.id, projectId))
    .limit(1);
  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const allScreens = await db
    .select()
    .from(videoScreens)
    .where(eq(videoScreens.videoProjectId, projectId));
  const screens = allScreens.sort((a, b) => a.position - b.position);
  const screenIds = screens.map((s) => s.id);

  const promptPresence = new Map<number, boolean>();
  if (screenIds.length > 0) {
    const rows = await db
      .select({ videoScreenId: screenPromptVersions.videoScreenId })
      .from(screenPromptVersions)
      .where(inArray(screenPromptVersions.videoScreenId, screenIds));
    for (const r of rows) promptPresence.set(r.videoScreenId, true);
  }

  type GenSummary = { id: number; status: string; videoStoragePath: string | null; updatedAt: number };
  const latestGenByScreen = new Map<number, GenSummary>();
  const latestCompletedGenByScreen = new Map<number, { id: number; videoStoragePath: string }>();

  if (screenIds.length > 0) {
    const allGens = await db
      .select()
      .from(videoGenerations)
      .where(inArray(videoGenerations.videoScreenId, screenIds));

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
      if (
        gen.status === 'completed' &&
        gen.videoStoragePath &&
        !latestCompletedGenByScreen.has(gen.videoScreenId)
      ) {
        latestCompletedGenByScreen.set(gen.videoScreenId, {
          id: gen.id,
          videoStoragePath: gen.videoStoragePath,
        });
      }
    }
  }

  const enrichedScreens = screens.map((s) => ({
    ...s,
    hasPrompt: promptPresence.get(s.id) ?? false,
    latestGen: latestGenByScreen.get(s.id) ?? null,
    latestCompletedGen: latestCompletedGenByScreen.get(s.id) ?? null,
  }));

  // Generate signed URL for the base image — race against a 2s timeout so it never blocks the page
  let baseImagePreviewUrl: string | null = null;
  try {
    const signedResult = await Promise.race([
      supabase.storage
        .from(process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads')
        .createSignedUrl(project.baseImagePath, 3600),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    baseImagePreviewUrl = signedResult.data?.signedUrl ?? null;
  } catch {
    // timed out or failed — frontend will show placeholder
  }

  return NextResponse.json({
    ...project,
    baseImagePreviewUrl,
    screens: enrichedScreens,
  });
}
