import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const projectRows = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  if (!projectRows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const now = Date.now();
  await db
    .update(videoProjects)
    .set({ breakdownApprovedAt: now, updatedAt: now })
    .where(eq(videoProjects.id, projectId));

  return NextResponse.json({ breakdownApprovedAt: now });
}
