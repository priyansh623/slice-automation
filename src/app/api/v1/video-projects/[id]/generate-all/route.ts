import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens, screenPromptVersions, promptGenerationTasks } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { enqueueAllSceneGenerations } from '@/services/video-workflow';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const rows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  const project = rows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (project.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Queue video generations for screens that already have prompts
  const genResult = await enqueueAllSceneGenerations(projectId);

  // Also enqueue prompt tasks for screens that don't have a prompt yet,
  // so the full flow (prompt → video) completes automatically.
  // Requires Screen 1 to be approved (brief extraction prerequisite).
  const allScreens = await db.select().from(videoScreens).where(eq(videoScreens.videoProjectId, projectId));
  const screens = allScreens.sort((a, b) => a.position - b.position);
  const screen1 = screens[0];
  let promptsQueued = 0;

  if (screen1?.approvedGenerationId) {
    const screenIds = screens.map((s) => s.id);

    // Screens that already have at least one prompt version
    const promptRows = screenIds.length > 0
      ? await db.select({ videoScreenId: screenPromptVersions.videoScreenId })
          .from(screenPromptVersions)
          .where(inArray(screenPromptVersions.videoScreenId, screenIds))
      : [];
    const screensWithPrompts = new Set(promptRows.map((r) => r.videoScreenId));

    // Screens that already have a pending/processing prompt task (avoid duplicates)
    const activeTasks = screenIds.length > 0
      ? await db.select({ videoScreenId: promptGenerationTasks.videoScreenId })
          .from(promptGenerationTasks)
          .where(and(
            inArray(promptGenerationTasks.videoScreenId, screenIds),
            ne(promptGenerationTasks.status, 'completed'),
            ne(promptGenerationTasks.status, 'failed'),
          ))
      : [];
    const screensWithActiveTasks = new Set(activeTasks.map((t) => t.videoScreenId));

    const screensNeedingPrompts = screens.filter(
      (s) => !screensWithPrompts.has(s.id) && !screensWithActiveTasks.has(s.id),
    );

    if (screensNeedingPrompts.length > 0) {
      const now = Date.now();
      // If the brief is already extracted, go straight to generate_prompt tasks.
      // Otherwise enqueue an extract_brief task first (idempotent — skip if already active).
      const needsBriefExtract = !project.creativeBrief;
      const hasActiveBriefTask = needsBriefExtract
        ? (await db.select().from(promptGenerationTasks).where(and(
            eq(promptGenerationTasks.videoProjectId, projectId),
            eq(promptGenerationTasks.taskType, 'extract_brief'),
            ne(promptGenerationTasks.status, 'completed'),
            ne(promptGenerationTasks.status, 'failed'),
          ))).length > 0
        : false;

      if (needsBriefExtract && !hasActiveBriefTask) {
        await db.insert(promptGenerationTasks).values({
          videoProjectId: projectId,
          videoScreenId: screen1.id,
          taskType: 'extract_brief',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        });
      }

      for (const screen of screensNeedingPrompts) {
        await db.insert(promptGenerationTasks).values({
          videoProjectId: projectId,
          videoScreenId: screen.id,
          taskType: 'generate_prompt',
          status: 'pending',
          createdAt: now + 1,
          updatedAt: now + 1,
        });
        promptsQueued++;
      }
    }
  }

  return NextResponse.json({ ...genResult, promptsQueued });
}
