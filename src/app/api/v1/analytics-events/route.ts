import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { analyticsEvents } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
      userId: user.id,
      eventType: body.eventType,
      videoProjectId: body.videoProjectId ?? null,
      payload: body.payload ?? null,
      createdAt: Date.now(),
    })
    .returning();

  return NextResponse.json(inserted[0], { status: 201 });
}
