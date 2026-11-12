import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { eq } from 'drizzle-orm';

export const maxDuration = 60;
import { analyzeScript } from '@/services/video-workflow';

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

  const projectRows = await db
    .select()
    .from(videoProjects)
    .where(eq(videoProjects.id, projectId))
    .limit(1);
  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Prevent re-analysis after breakdown has been approved — screens would be destructively deleted
  if (project.breakdownApprovedAt) {
    return NextResponse.json(
      { error: 'Cannot re-analyze after breakdown has been approved' },
      { status: 409 },
    );
  }

  const breakdown = await analyzeScript(projectId);
  const now = Date.now();

  await db.delete(videoScreens).where(eq(videoScreens.videoProjectId, projectId));
  await db
    .update(videoProjects)
    .set({ breakdownApprovedAt: null, updatedAt: now })
    .where(eq(videoProjects.id, projectId));

  for (const s of breakdown.screens) {
    await db.insert(videoScreens).values({
      videoProjectId: projectId,
      screenNumber: s.screenNumber,
      dialogue: s.dialogue,
      position: s.screenNumber,
      durationSeconds: s.durationSeconds ?? null,
      durationNote: s.durationNote ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const allScreens = await db.select().from(videoScreens).where(eq(videoScreens.videoProjectId, projectId));
  const screens = allScreens.sort((a, b) => a.position - b.position);

  return NextResponse.json({ screens, possibleTypos: breakdown.possibleTypos });
}
