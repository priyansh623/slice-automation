import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { db } from '@/db';
import { adminUsers } from '@/db/schema.pg';
import { requireUser, requireAdmin } from '@/lib/api-auth';

export async function GET(): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const adminError = await requireAdmin(authResult.user.id);
  if (adminError) return adminError;

  const rows = await db.select().from(adminUsers).orderBy(adminUsers.addedAt);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;
  const adminError = await requireAdmin(authResult.user.id);
  if (adminError) return adminError;

  let body: { email: string };
  try { body = (await req.json()) as typeof body; } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: listData, error: lookupError } = await serviceClient.auth.admin.listUsers({ perPage: 1000 });
  const targetUser = listData?.users?.find((u) => u.email === email);
  if (lookupError || !targetUser) {
    return NextResponse.json({ error: 'No user with that email found in Supabase Auth' }, { status: 404 });
  }
  const targetUserId = targetUser.id;

  try {
    await db.insert(adminUsers).values({ userId: targetUserId, email, addedAt: Date.now() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return NextResponse.json({ error: 'User is already an admin' }, { status: 409 });
    }
    console.error('[POST /api/v1/admin/users]', err);
    return NextResponse.json({ error: 'Failed to add admin' }, { status: 500 });
  }

  return NextResponse.json({ userId: targetUserId, email, addedAt: Date.now() }, { status: 201 });
}
