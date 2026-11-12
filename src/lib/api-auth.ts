import { NextResponse } from 'next/server';
import { db } from '@/db';
import { videoProjects } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { eq } from 'drizzle-orm';

export type AuthUser = { id: string; email?: string | null };

// Every signed-in user has the same access. The only gate on the API is "is there a signed-in user".
export async function requireUser(): Promise<{ user: AuthUser } | NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return { user };
}

// Projects are shared across the workspace: any signed-in user can use any project, so this only checks that the
// project exists. (It used to also require that the caller created it.)
export async function requireProject(
  projectId: number,
): Promise<{ project: typeof videoProjects.$inferSelect } | NextResponse> {
  const rows = await db
    .select()
    .from(videoProjects)
    .where(eq(videoProjects.id, projectId))
    .limit(1);
  const project = rows[0];
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return { project };
}
