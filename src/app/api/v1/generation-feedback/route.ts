import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { generationFeedback, videoGenerations, videoScreens, videoProjects, projectTesters } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq } from 'drizzle-orm';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json()) as {
    videoGenerationId: number;
    hookQuality?: number | null;
    voiceDelivery?: number | null;
    speakingPace?: number | null;
    energyExpressions?: number | null;
    gesturesActions?: number | null;
    visualConsistency?: number | null;
    overallQuality?: number | null;
    notes?: string | null;
  };

  if (!body.videoGenerationId || typeof body.videoGenerationId !== 'number') {
    return NextResponse.json({ error: 'videoGenerationId is required' }, { status: 400 });
  }

  // Validate 1–5 for any rating that was supplied
  const ratingFields = [
    'hookQuality', 'voiceDelivery', 'speakingPace',
    'energyExpressions', 'gesturesActions', 'visualConsistency', 'overallQuality',
  ] as const;
  for (const field of ratingFields) {
    const val = body[field];
    if (val != null && (typeof val !== 'number' || val < 1 || val > 5)) {
      return NextResponse.json({ error: `${field} must be 1–5` }, { status: 400 });
    }
  }

  // Traverse: generation → screen → project, then check owner or tester
  const genRows = await db
    .select({ id: videoGenerations.id, videoScreenId: videoGenerations.videoScreenId })
    .from(videoGenerations)
    .where(eq(videoGenerations.id, body.videoGenerationId))
    .limit(1);
  if (!genRows[0]) return NextResponse.json({ error: 'Generation not found' }, { status: 404 });

  const screenRows = await db
    .select({ videoProjectId: videoScreens.videoProjectId })
    .from(videoScreens)
    .where(eq(videoScreens.id, genRows[0].videoScreenId))
    .limit(1);
  if (!screenRows[0]) return NextResponse.json({ error: 'Screen not found' }, { status: 404 });

  const projectId = screenRows[0].videoProjectId;

  const projectRows = await db
    .select({ userId: videoProjects.userId })
    .from(videoProjects)
    .where(eq(videoProjects.id, projectId))
    .limit(1);
  if (!projectRows[0]) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const isOwner = projectRows[0].userId === user.id;
  if (!isOwner) {
    // Check tester access
    const testerRows = await db
      .select({ id: projectTesters.id })
      .from(projectTesters)
      .where(and(eq(projectTesters.videoProjectId, projectId), eq(projectTesters.userId, user.id)))
      .limit(1);
    if (!testerRows[0]) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = Date.now();

  // Upsert: one feedback row per (user, generation)
  const existing = await db
    .select({ id: generationFeedback.id })
    .from(generationFeedback)
    .where(
      and(
        eq(generationFeedback.videoGenerationId, body.videoGenerationId),
        eq(generationFeedback.userId, user.id),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const updated = await db
      .update(generationFeedback)
      .set({
        hookQuality: body.hookQuality ?? null,
        voiceDelivery: body.voiceDelivery ?? null,
        speakingPace: body.speakingPace ?? null,
        energyExpressions: body.energyExpressions ?? null,
        gesturesActions: body.gesturesActions ?? null,
        visualConsistency: body.visualConsistency ?? null,
        overallQuality: body.overallQuality ?? null,
        notes: body.notes?.trim() || null,
        updatedAt: now,
      })
      .where(eq(generationFeedback.id, existing[0].id))
      .returning();
    return NextResponse.json(updated[0]);
  }

  const inserted = await db
    .insert(generationFeedback)
    .values({
      videoGenerationId: body.videoGenerationId,
      userId: user.id,
      hookQuality: body.hookQuality ?? null,
      voiceDelivery: body.voiceDelivery ?? null,
      speakingPace: body.speakingPace ?? null,
      energyExpressions: body.energyExpressions ?? null,
      gesturesActions: body.gesturesActions ?? null,
      visualConsistency: body.visualConsistency ?? null,
      overallQuality: body.overallQuality ?? null,
      notes: body.notes?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return NextResponse.json(inserted[0], { status: 201 });
}
