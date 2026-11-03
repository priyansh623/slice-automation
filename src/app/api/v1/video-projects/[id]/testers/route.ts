import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { projectTesters } from '@/db/schema.pg';
import { requireUser, requireProjectOwner } from '@/lib/api-auth';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (isNaN(projectId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const ownerResult = await requireProjectOwner(projectId, user.id);
  if (ownerResult instanceof NextResponse) return ownerResult;

  const body = (await req.json()) as { userId: string };
  if (!body.userId || typeof body.userId !== 'string') {
    return NextResponse.json({ error: 'userId (UUID) required' }, { status: 400 });
  }

  // Upsert: silently ignore duplicate
  const [tester] = await db
    .insert(projectTesters)
    .values({
      videoProjectId: projectId,
      userId: body.userId,
      invitedAt: Date.now(),
    })
    .onConflictDoNothing()
    .returning();

  return NextResponse.json(tester ?? { videoProjectId: projectId, userId: body.userId }, { status: 201 });
}
