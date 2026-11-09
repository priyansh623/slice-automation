import { NextResponse } from 'next/server';
import { requireUser, requireAdmin } from '@/lib/api-auth';
import { db } from '@/db';
import { adminSettings } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';

export async function GET(): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const adminError = await requireAdmin(authResult.user.id);
  if (adminError) return adminError;

  const rows = await db.select().from(adminSettings).where(eq(adminSettings.id, 1)).limit(1);
  const row = rows[0];

  return NextResponse.json({
    remainingCredits: row?.lastSeenCredits ?? null,
    lastSeenAt: row?.lastSeenCreditsAt ?? null,
  });
}
