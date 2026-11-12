import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, videoScreens } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { and, eq } from 'drizzle-orm';

export const maxDuration = 60;
import {
  generateScreen1Prompt,
  generateInitialScreenPrompt,
  revisePrompt,
  saveManualPromptEdit,
} from '@/services/video-workflow';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, n } = await params;
  const projectId = parseInt(id, 10);
  const screenNumber = parseInt(n, 10);
  if (isNaN(projectId) || isNaN(screenNumber)) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  }

  const projectRows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber)))
    .limit(1);
  const screen = screenRows[0];
  if (!screen) return NextResponse.json({ error: 'Screen not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    nlFeedback?: string;
    reviewingGenerationId?: number;
  };

  let result: { promptText: string; version: number; validation: { issues: string[]; warnings: string[] }; feedbackScope?: string };

  if (screenNumber === 1) {
    result = await generateScreen1Prompt(projectId, screen.id, body.nlFeedback, body.reviewingGenerationId);
  } else if (!body.nlFeedback) {
    result = await generateInitialScreenPrompt(projectId, screen.id);
  } else {
    result = await revisePrompt(projectId, screen.id, body.nlFeedback, body.reviewingGenerationId);
  }

  return NextResponse.json(result);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, n } = await params;
  const projectId = parseInt(id, 10);
  const screenNumber = parseInt(n, 10);
  if (isNaN(projectId) || isNaN(screenNumber)) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  }

  const projectRows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, projectId), eq(videoScreens.screenNumber, screenNumber)))
    .limit(1);
  const screen = screenRows[0];
  if (!screen) return NextResponse.json({ error: 'Screen not found' }, { status: 404 });

  const body = (await req.json()) as { promptText: string };
  if (!body.promptText) return NextResponse.json({ error: 'promptText required' }, { status: 400 });

  const result = await saveManualPromptEdit(screen.id, body.promptText);
  return NextResponse.json(result);
}
