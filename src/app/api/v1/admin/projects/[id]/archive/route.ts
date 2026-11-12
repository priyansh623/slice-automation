import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { db } from '@/db';
import { videoProjects } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const now = Date.now();
  await db
    .update(videoProjects)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(videoProjects.id, projectId));

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const now = Date.now();
  await db
    .update(videoProjects)
    .set({ archivedAt: null, updatedAt: now })
    .where(eq(videoProjects.id, projectId));

  return NextResponse.json({ ok: true });
}
