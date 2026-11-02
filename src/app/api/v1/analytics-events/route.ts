import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { analyticsEvents } from '@/db/schema.pg';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as {
    eventType: string;
    videoProjectId?: number | null;
    payload?: Record<string, unknown> | null;
  };

  if (!body.eventType || typeof body.eventType !== 'string') {
    return NextResponse.json({ error: 'eventType is required' }, { status: 400 });
  }

  const inserted = await db
    .insert(analyticsEvents)
    .values({
      userId: 'anonymous',
      eventType: body.eventType,
      videoProjectId: body.videoProjectId ?? null,
      payload: body.payload ?? null,
      createdAt: Date.now(),
    })
    .returning();

  return NextResponse.json(inserted[0], { status: 201 });
}
