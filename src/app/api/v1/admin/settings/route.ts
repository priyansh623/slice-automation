import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { adminSettings } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';

export async function GET(): Promise<NextResponse> {

  const rows = await db.select().from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
  const settings = rows[0] ?? { id: 1, scene1HookInstruction: null, compilationCrf: 23, updatedAt: 0 };

  return NextResponse.json(settings);
}

export async function PUT(req: NextRequest): Promise<NextResponse> {

  const body = (await req.json()) as {
    scene1HookInstruction?: string | null;
    compilationCrf?: number;
  };

  const now = Date.now();

  const existing = await db.select().from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
  if (existing[0]) {
    await db
      .update(adminSettings)
      .set({
        ...(body.scene1HookInstruction !== undefined ? { scene1HookInstruction: body.scene1HookInstruction } : {}),
        ...(body.compilationCrf !== undefined ? { compilationCrf: body.compilationCrf } : {}),
        updatedAt: now,
      })
      .where(eq(adminSettings.id, 1));
  } else {
    await db.insert(adminSettings).values({
      id: 1,
      scene1HookInstruction: body.scene1HookInstruction ?? null,
      compilationCrf: body.compilationCrf ?? 23,
      updatedAt: now,
    });
  }

  const rows = await db.select().from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
  return NextResponse.json(rows[0]);
}
