import { NextResponse } from 'next/server';
import { isAdminUser, requireUser } from '@/lib/api-auth';

// Tells the signed-in user whether they are an administrator, using the same check as every admin route.
// Used by the UI to show admin navigation only to admins; the admin APIs enforce access themselves.
export async function GET(): Promise<NextResponse> {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ isAdmin: await isAdminUser(auth.user.id) });
}
