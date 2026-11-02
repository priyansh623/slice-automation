import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { adminSettings, videoProjects } from '@/db/schema.pg';
import { desc, eq } from 'drizzle-orm';

export async function GET(): Promise<NextResponse> {
  const rows = await db
    .select()
    .from(videoProjects)
    .orderBy(desc(videoProjects.createdAt));

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { name: string; originalScript: string; baseImagePath: string; skillVersion?: string; creatorDescription?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.name || !body.originalScript) {
    return NextResponse.json({ error: 'name and originalScript are required' }, { status: 400 });
  }
  if (!body.baseImagePath) {
    return NextResponse.json({ error: 'baseImagePath is required' }, { status: 400 });
  }

  try {
    // Snapshot the current scene1HookInstruction at creation time
    const settingsRows = await db.select().from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
    const scene1HookSnapshot = settingsRows[0]?.scene1HookInstruction ?? null;

    const now = Date.now();
    const inserted = await db
      .insert(videoProjects)
      .values({
        userId: '00000000-0000-0000-0000-000000000000',
        name: body.name,
        baseImagePath: body.baseImagePath,
        originalScript: body.originalScript,
        skillVersion: body.skillVersion ?? 'v1',
        creatorDescription: body.creatorDescription?.trim() || null,
        scene1HookSnapshot,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return NextResponse.json(inserted[0], { status: 201 });
  } catch (e: unknown) {
    console.error('[video-projects POST] DB error:', e);
    return NextResponse.json({ error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, { status: 500 });
  }
}
