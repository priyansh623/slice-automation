import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';
import type { CreativeBrief } from '@/services/video-workflow';
import { parseBrief } from '@/services/video-workflow';

function getId(idStr: string): number | null {
  const id = parseInt(idStr, 10);
  return isNaN(id) ? null : id;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const projectId = getId(id);
  if (!projectId) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const rows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(parseBrief(rows[0].creativeBrief));
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const projectId = getId(id);
  if (!projectId) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const rows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  const project = rows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const raw = (await req.json()) as Record<string, unknown>;
  const incoming: Partial<CreativeBrief> = {};
  if (typeof raw.voiceIdentity === 'string') incoming.voiceIdentity = raw.voiceIdentity;
  if (typeof raw.characterAppearance === 'string') incoming.characterAppearance = raw.characterAppearance;
  if (typeof raw.performanceStyle === 'string') incoming.performanceStyle = raw.performanceStyle;
  if (raw.gestureIntensity === 'low' || raw.gestureIntensity === 'medium' || raw.gestureIntensity === 'high') {
    incoming.gestureIntensity = raw.gestureIntensity;
  }
  if (typeof raw.camera === 'string') incoming.camera = raw.camera;
  if (typeof raw.setting === 'string') incoming.setting = raw.setting;

  const merged: CreativeBrief = { ...parseBrief(project.creativeBrief), ...incoming };

  await db
    .update(videoProjects)
    .set({ creativeBrief: JSON.stringify(merged), updatedAt: Date.now() })
    .where(eq(videoProjects.id, projectId));

  return NextResponse.json(merged);
}
