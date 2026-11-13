import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import {
  videoCompilations,
  compilationSceneSelections,
  videoProjects,
  videoScreens,
  videoGenerations,
} from '@/db/schema.pg';
import { and, eq, inArray } from 'drizzle-orm';
import { requireUser, requireProject } from '@/lib/api-auth';
import { annotateVersions, ffmpegClipLimitMessage, MAX_COMPILATION_CLIPS, MAX_FFMPEG_COMPILATION_CLIPS, MIN_COMPILATION_CLIPS } from '@/lib/compilation-versions';

// Lists every compilation of the project, newest first. Each one carries its version number (successful compilations
// only), whether it is the current one, how it was produced, and which clip was chosen for each scene.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const projectResult = await requireProject(projectId);
  if (projectResult instanceof NextResponse) return projectResult;

  const compilations = await db
    .select()
    .from(videoCompilations)
    .where(eq(videoCompilations.videoProjectId, projectId));

  const ids = compilations.map((c) => c.id);
  const selectionRows = ids.length === 0 ? [] : await db
    .select({
      compilationId: compilationSceneSelections.compilationId,
      videoScreenId: compilationSceneSelections.videoScreenId,
      videoGenerationId: compilationSceneSelections.videoGenerationId,
      screenNumber: videoScreens.screenNumber,
      position: videoScreens.position,
    })
    .from(compilationSceneSelections)
    .innerJoin(videoScreens, eq(compilationSceneSelections.videoScreenId, videoScreens.id))
    .where(inArray(compilationSceneSelections.compilationId, ids));

  const byCompilation = new Map<number, { videoScreenId: number; videoGenerationId: number; screenNumber: number }[]>();
  for (const r of [...selectionRows].sort((a, b) => a.position - b.position)) {
    const list = byCompilation.get(r.compilationId) ?? [];
    list.push({ videoScreenId: r.videoScreenId, videoGenerationId: r.videoGenerationId, screenNumber: r.screenNumber });
    byCompilation.set(r.compilationId, list);
  }

  return NextResponse.json(
    annotateVersions(compilations).map((c) => {
      const selections = byCompilation.get(c.id) ?? [];
      return { ...c, sceneCount: selections.length, selections };
    }),
  );
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

// Starts a new compilation (the next version) of the project from the chosen clips. Earlier compilations are never
// touched. Only one compilation per project can be waiting or running at a time.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const projectResult = await requireProject(projectId);
  if (projectResult instanceof NextResponse) return projectResult;

  let body: { scenes?: Array<{ videoScreenId: number; videoGenerationId: number }> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return NextResponse.json({ error: 'scenes array required' }, { status: 400 });
  }
  const scenes = body.scenes;
  if (scenes.length < MIN_COMPILATION_CLIPS || scenes.length > MAX_COMPILATION_CLIPS) {
    return NextResponse.json(
      { error: `A compilation needs between ${MIN_COMPILATION_CLIPS} and ${MAX_COMPILATION_CLIPS} scenes (got ${scenes.length}).` },
      { status: 422 },
    );
  }
  if (new Set(scenes.map((s) => s.videoScreenId)).size !== scenes.length) {
    return NextResponse.json({ error: 'Each scene can only be selected once' }, { status: 422 });
  }

  // Validate all referenced screens + generations belong to this project (batched)
  const sceneScreenIds = scenes.map((s) => s.videoScreenId);
  const sceneGenIds = scenes.map((s) => s.videoGenerationId);

  const [validScreenRows, validGenRows] = await Promise.all([
    db
      .select({ id: videoScreens.id, videoProjectId: videoScreens.videoProjectId, screenNumber: videoScreens.screenNumber })
      .from(videoScreens)
      .where(inArray(videoScreens.id, sceneScreenIds)),
    db
      .select({
        id: videoGenerations.id,
        videoScreenId: videoGenerations.videoScreenId,
        status: videoGenerations.status,
        videoStoragePath: videoGenerations.videoStoragePath,
        mediaGenerationId: videoGenerations.mediaGenerationId,
      })
      .from(videoGenerations)
      .where(inArray(videoGenerations.id, sceneGenIds)),
  ]);

  const screenById = new Map(validScreenRows.map((s) => [s.id, s]));
  const genById = new Map(validGenRows.map((g) => [g.id, g]));

  for (const scene of scenes) {
    const screen = screenById.get(scene.videoScreenId);
    if (!screen || screen.videoProjectId !== projectId) {
      return NextResponse.json(
        { error: `Screen ${scene.videoScreenId} not found in this project` },
        { status: 422 },
      );
    }
    const gen = genById.get(scene.videoGenerationId);
    if (!gen || gen.videoScreenId !== scene.videoScreenId) {
      return NextResponse.json(
        { error: `Generation ${scene.videoGenerationId} not found for screen ${scene.videoScreenId}` },
        { status: 422 },
      );
    }
    // A clip can be joined if it has its stored video file (any clip) or the media ID the concatenate endpoint needs.
    if (gen.status !== 'completed' || (!gen.videoStoragePath && !gen.mediaGenerationId)) {
      return NextResponse.json(
        { error: `The clip chosen for Scene ${screen.screenNumber} is not ready to compile.` },
        { status: 422 },
      );
    }
  }

  // Any clip without a media ID means the whole set is joined on the server with FFmpeg, which is limited by the worker's
  // memory. Refuse a larger set now, with a clear message, instead of creating a job that could exhaust the worker.
  const needsServerJoin = scenes.some((scene) => !genById.get(scene.videoGenerationId)?.mediaGenerationId);
  if (needsServerJoin && scenes.length > MAX_FFMPEG_COMPILATION_CLIPS) {
    return NextResponse.json({ error: ffmpegClipLimitMessage(scenes.length) }, { status: 422 });
  }

  const now = Date.now();
  const alreadyRunning = (activeId: number | null) => NextResponse.json(
    { error: 'A compilation is already in progress for this project. It will appear in the history when it finishes.', activeCompilationId: activeId },
    { status: 409 },
  );

  try {
    // Atomic: compilation row + scene selections. The project row is locked first so two requests for the same
    // project take turns; the second one then sees the first one's row and is refused. A unique index in the database
    // (one waiting/running compilation per project) backs this up.
    const compilation = await db.transaction(async (tx) => {
      await tx.select({ id: videoProjects.id }).from(videoProjects).where(eq(videoProjects.id, projectId)).for('update');

      const active = await tx
        .select({ id: videoCompilations.id })
        .from(videoCompilations)
        .where(and(
          eq(videoCompilations.videoProjectId, projectId),
          inArray(videoCompilations.status, ['pending', 'processing']),
        ))
        .limit(1);
      if (active[0]) return { activeId: active[0].id } as const;

      const [created] = await tx
        .insert(videoCompilations)
        .values({ videoProjectId: projectId, status: 'pending', createdAt: now, updatedAt: now })
        .returning();

      await tx.insert(compilationSceneSelections).values(
        scenes.map((scene) => ({
          compilationId: created.id,
          videoScreenId: scene.videoScreenId,
          videoGenerationId: scene.videoGenerationId,
          createdAt: now,
        })),
      );
      return { created } as const;
    });

    if ('activeId' in compilation) return alreadyRunning(compilation.activeId ?? null);
    return NextResponse.json({ ...compilation.created, version: null, isCurrent: false }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) return alreadyRunning(null);
    throw err;
  }
}
