import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { db } from '@/db';
import { videoProjects } from '@/db/schema.pg';
import { and, eq } from 'drizzle-orm';
import { notDeleted } from '@/lib/project-deletion';

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
    // Archiving never turns a user-deleted project (negative archived_at) back into a visible, merely archived one. Restore (DELETE here) does that.
    .where(and(eq(videoProjects.id, projectId), notDeleted()));

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
