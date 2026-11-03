import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { analyticsEvents, videoProjects } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { eq } from 'drizzle-orm';

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

  // If scoped to a project, verify ownership
  if (body.videoProjectId != null) {
    const rows = await db
      .select({ userId: videoProjects.userId })
      .from(videoProjects)
      .where(eq(videoProjects.id, body.videoProjectId))
      .limit(1);
    if (!rows[0]) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    if (rows[0].userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
