import { NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects, adminUsers } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { eq } from 'drizzle-orm';

export type AuthUser = { id: string };

export async function requireUser(): Promise<{ user: AuthUser } | NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return { user };
}

export async function requireProjectOwner(
  projectId: number,
  userId: string,
): Promise<{ project: typeof videoProjects.$inferSelect } | NextResponse> {
  const rows = await db
    .select()
    .from(videoProjects)
    .where(eq(videoProjects.id, projectId))
    .limit(1);
  const project = rows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (project.userId !== userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return { project };
}

export async function requireAdmin(userId: string): Promise<NextResponse | null> {
  const adminIds = (process.env.ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (adminIds.includes(userId)) return null;
  const rows = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.userId, userId)).limit(1);
  if (rows.length > 0) return null;
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
