import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import {
  videoCompilations,
  compilationSceneSelections,
  videoScreens,
  videoGenerations,
} from '@/db/schema.pg';
import { and, eq, inArray } from 'drizzle-orm';
import { requireUser, requireProject } from '@/lib/api-auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const projectResult = await requireProject(projectId);
  if (projectResult instanceof NextResponse) return projectResult;

  const compilations = await db
    .select()
    .from(videoCompilations)
    .where(eq(videoCompilations.videoProjectId, projectId))
    .orderBy(videoCompilations.createdAt);

  return NextResponse.json(compilations);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const projectResult = await requireProject(projectId);
  if (projectResult instanceof NextResponse) return projectResult;

  const body = (await req.json()) as {
    // Array of { videoScreenId, videoGenerationId } scene selections
    scenes: Array<{ videoScreenId: number; videoGenerationId: number }>;
  };

  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return NextResponse.json({ error: 'scenes array required' }, { status: 400 });
  }

  // Validate all referenced screens + generations belong to this project (batched)
  const sceneScreenIds = body.scenes.map((s) => s.videoScreenId);
  const sceneGenIds = body.scenes.map((s) => s.videoGenerationId);

  const [validScreenRows, validGenRows] = await Promise.all([
    db
      .select({ id: videoScreens.id, videoProjectId: videoScreens.videoProjectId })
      .from(videoScreens)
      .where(inArray(videoScreens.id, sceneScreenIds)),
    db
      .select({ id: videoGenerations.id, videoScreenId: videoGenerations.videoScreenId })
      .from(videoGenerations)
      .where(inArray(videoGenerations.id, sceneGenIds)),
  ]);

  const screenProjectMap = new Map(validScreenRows.map((s) => [s.id, s.videoProjectId]));
  const genScreenMap = new Map(validGenRows.map((g) => [g.id, g.videoScreenId]));

  for (const scene of body.scenes) {
    if (screenProjectMap.get(scene.videoScreenId) !== projectId) {
      return NextResponse.json(
        { error: `Screen ${scene.videoScreenId} not found in this project` },
        { status: 422 },
      );
    }
    if (genScreenMap.get(scene.videoGenerationId) !== scene.videoScreenId) {
      return NextResponse.json(
        { error: `Generation ${scene.videoGenerationId} not found for screen ${scene.videoScreenId}` },
        { status: 422 },
      );
    }
  }

  const now = Date.now();

  // Atomic insert: compilation row + scene selections in a transaction with FOR UPDATE
  const compilation = await db.transaction(async (tx) => {
    // Lock the project row to prevent concurrent duplicate compilations
    await tx
      .select({ id: videoCompilations.videoProjectId })
      .from(videoCompilations)
      .where(
        and(
          eq(videoCompilations.videoProjectId, projectId),
          eq(videoCompilations.status, 'pending'),
        ),
      )
      .for('update');

    const [newCompilation] = await tx
      .insert(videoCompilations)
      .values({
        videoProjectId: projectId,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await tx.insert(compilationSceneSelections).values(
      body.scenes.map((scene) => ({
        compilationId: newCompilation.id,
        videoScreenId: scene.videoScreenId,
        videoGenerationId: scene.videoGenerationId,
        createdAt: now,
      })),
    );

    return newCompilation;
  });

  return NextResponse.json(compilation, { status: 201 });
}
