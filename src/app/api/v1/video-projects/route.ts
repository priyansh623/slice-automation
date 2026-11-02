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
  const body = (await req.json()) as {
    name: string;
    originalScript: string;
    baseImagePath: string;
    skillVersion?: string;
    creatorDescription?: string;
  };

  if (!body.name || !body.originalScript) {
    return NextResponse.json({ error: 'name and originalScript are required' }, { status: 400 });
  }
  if (!body.baseImagePath) {
    return NextResponse.json({ error: 'baseImagePath is required' }, { status: 400 });
  }

  // Snapshot the current scene1HookInstruction at creation time
  const settingsRows = await db.select().from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
  const scene1HookSnapshot = settingsRows[0]?.scene1HookInstruction ?? null;

  const now = Date.now();
  const inserted = await db
    .insert(videoProjects)
    .values({
      userId: 'anonymous',
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
}
