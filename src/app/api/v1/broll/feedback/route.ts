import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { brollFeedback } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { desc, eq } from 'drizzle-orm';

const VALID_NEXT_ACTIONS = ['Film it', 'Generate it', 'Fix the details', 'Replace the clip', 'Remove the clip'];

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await db
    .select()
    .from(brollFeedback)
    .where(eq(brollFeedback.userId, user.id))
    .orderBy(desc(brollFeedback.createdAt));

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { clipId?: number | null; text: string; nextAction: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.text?.trim()) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  if (!VALID_NEXT_ACTIONS.includes(body.nextAction)) {
    return NextResponse.json({ error: 'Invalid nextAction' }, { status: 400 });
  }

  const now = Date.now();
  const [inserted] = await db.insert(brollFeedback).values({
    userId: user.id,
    clipId: body.clipId ?? null,
    text: body.text.trim(),
    nextAction: body.nextAction,
    createdAt: now,
  }).returning();

  return NextResponse.json(inserted, { status: 201 });
}
