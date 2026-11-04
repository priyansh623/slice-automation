import { NextResponse } from 'next/server';
import { requireUser, requireAdmin } from '@/lib/api-auth';

export async function GET(): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;

  const adminError = await requireAdmin(authResult.user.id);
  if (adminError) return adminError;

  const token = process.env.USEAPI_TOKEN;
  if (!token) return NextResponse.json({ error: 'USEAPI_TOKEN not configured' }, { status: 500 });

  try {
    // useapi.net returns account info including remainingCredits on the accounts endpoint
    const res = await fetch('https://api.useapi.net/v1/google-flow/accounts', {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json({ error: `useapi returned ${res.status}: ${text}` }, { status: 502 });
    }

    const json = await res.json() as Record<string, unknown>;

    // The response shape varies; try several known field names
    const remaining =
      (json.remainingCredits as number | undefined) ??
      (json.remaining_credits as number | undefined) ??
      ((json.accounts as { remainingCredits?: number }[] | undefined)?.[0]?.remainingCredits);

    return NextResponse.json({ remainingCredits: remaining ?? null, raw: json });
  } catch (err: unknown) {
    return NextResponse.json({ error: (err instanceof Error ? err.message : String(err)) }, { status: 502 });
  }
}
