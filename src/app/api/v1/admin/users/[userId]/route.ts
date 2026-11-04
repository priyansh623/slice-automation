import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { adminUsers } from '@/db/schema.pg';
import { requireUser, requireAdmin } from '@/lib/api-auth';
import { eq } from 'drizzle-orm';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const { userId } = await params;

  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const adminError = await requireAdmin(authResult.user.id);
  if (adminError) return adminError;

  if (userId === authResult.user.id) {
    return NextResponse.json({ error: 'Cannot remove yourself as admin' }, { status: 400 });
  }

  const result = await db.delete(adminUsers).where(eq(adminUsers.userId, userId)).returning();
  if (result.length === 0) return NextResponse.json({ error: 'Admin not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
