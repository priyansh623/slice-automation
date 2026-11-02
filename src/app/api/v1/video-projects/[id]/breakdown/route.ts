import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const projectRows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  if (!projectRows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json()) as {
    screens: Array<{ screenNumber: number; dialogue: string; position?: number; durationSeconds?: number | null; durationNote?: string | null }>;
    approvedScript?: string | null;
  };

  if (!Array.isArray(body.screens)) {
    return NextResponse.json({ error: 'screens array required' }, { status: 400 });
  }

  const now = Date.now();

  await db.delete(videoScreens).where(eq(videoScreens.videoProjectId, projectId));
  await db
    .update(videoProjects)
    .set({
      breakdownApprovedAt: null,
      updatedAt: now,
      ...(body.approvedScript !== undefined ? { approvedScript: body.approvedScript } : {}),
    })
    .where(eq(videoProjects.id, projectId));

  for (const s of body.screens) {
    await db.insert(videoScreens).values({
      videoProjectId: projectId,
      screenNumber: s.screenNumber,
      dialogue: s.dialogue,
      position: s.position ?? s.screenNumber,
      durationSeconds: s.durationSeconds ?? null,
      durationNote: s.durationNote ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const allScreens = await db.select().from(videoScreens).where(eq(videoScreens.videoProjectId, projectId));
  const screens = allScreens.sort((a, b) => a.position - b.position);

  return NextResponse.json({ screens });
}
