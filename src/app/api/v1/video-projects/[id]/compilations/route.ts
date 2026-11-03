import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import {
  videoCompilations,
  compilationSceneSelections,
  videoScreens,
  videoGenerations,
} from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import { requireUser, requireProjectOwner } from '@/lib/api-auth';

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

  const ownerResult = await requireProjectOwner(projectId, user.id);
  if (ownerResult instanceof NextResponse) return ownerResult;

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

  const ownerResult = await requireProjectOwner(projectId, user.id);
  if (ownerResult instanceof NextResponse) return ownerResult;

  const body = (await req.json()) as {
    // Array of { videoScreenId, videoGenerationId } scene selections
    scenes: Array<{ videoScreenId: number; videoGenerationId: number }>;
  };

  if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
    return NextResponse.json({ error: 'scenes array required' }, { status: 400 });
  }

  // Validate all referenced screens + generations belong to this project
  for (const scene of body.scenes) {
    const screenRows = await db
      .select({ videoProjectId: videoScreens.videoProjectId })
      .from(videoScreens)
      .where(eq(videoScreens.id, scene.videoScreenId))
      .limit(1);
    if (!screenRows[0] || screenRows[0].videoProjectId !== projectId) {
      return NextResponse.json(
        { error: `Screen ${scene.videoScreenId} not found in this project` },
        { status: 422 },
      );
    }

    const genRows = await db
      .select({ videoScreenId: videoGenerations.videoScreenId })
      .from(videoGenerations)
      .where(
        and(
          eq(videoGenerations.id, scene.videoGenerationId),
          eq(videoGenerations.videoScreenId, scene.videoScreenId),
        ),
      )
      .limit(1);
    if (!genRows[0]) {
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
