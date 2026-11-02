import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoScreens } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import {
  generateScreen1Prompt,
  generateInitialScreenPrompt,
  revisePrompt,
  saveManualPromptEdit,
} from '@/services/video-workflow';

function getIds(idStr: string, nStr: string): { projectId: number; screenNumber: number } | null {
  const projectId = parseInt(idStr, 10);
  const screenNumber = parseInt(nStr, 10);
  if (isNaN(projectId) || isNaN(screenNumber)) return null;
  return { projectId, screenNumber };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const { id, n } = await params;
  const ids = getIds(id, n);
  if (!ids) return NextResponse.json({ error: 'Invalid params' }, { status: 400 });

  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, ids.projectId), eq(videoScreens.screenNumber, ids.screenNumber)))
    .limit(1);
  const screen = screenRows[0];
  if (!screen) return NextResponse.json({ error: 'Screen not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    nlFeedback?: string;
    reviewingGenerationId?: number;
  };

  let result: { promptText: string; version: number; validation: { issues: string[]; warnings: string[] }; feedbackScope?: string };

  if (ids.screenNumber === 1) {
    result = await generateScreen1Prompt(ids.projectId, screen.id, body.nlFeedback, body.reviewingGenerationId);
  } else if (!body.nlFeedback) {
    result = await generateInitialScreenPrompt(ids.projectId, screen.id);
  } else {
    result = await revisePrompt(ids.projectId, screen.id, body.nlFeedback, body.reviewingGenerationId);
  }

  return NextResponse.json(result);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; n: string }> },
): Promise<NextResponse> {
  const { id, n } = await params;
  const ids = getIds(id, n);
  if (!ids) return NextResponse.json({ error: 'Invalid params' }, { status: 400 });

  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, ids.projectId), eq(videoScreens.screenNumber, ids.screenNumber)))
    .limit(1);
  const screen = screenRows[0];
  if (!screen) return NextResponse.json({ error: 'Screen not found' }, { status: 404 });

  const body = (await req.json()) as { promptText: string };
  if (!body.promptText) return NextResponse.json({ error: 'promptText required' }, { status: 400 });

  const result = await saveManualPromptEdit(screen.id, body.promptText);
  return NextResponse.json(result);
}
