import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { generationFeedback, videoGenerations } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';

export async function POST(req: NextRequest): Promise<NextResponse> {
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

  // Verify the generation exists
  const genRows = await db
    .select({ id: videoGenerations.id })
    .from(videoGenerations)
    .where(eq(videoGenerations.id, body.videoGenerationId))
    .limit(1);
  if (!genRows[0]) return NextResponse.json({ error: 'Generation not found' }, { status: 404 });

  const now = Date.now();

  // Upsert: one feedback row per generation
  const existing = await db
    .select({ id: generationFeedback.id })
    .from(generationFeedback)
    .where(eq(generationFeedback.videoGenerationId, body.videoGenerationId))
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
      userId: '00000000-0000-0000-0000-000000000000',
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
