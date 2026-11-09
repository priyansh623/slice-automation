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

    // Response is { "email@...": { remainingCredits, backend, ... }, ... }
    // Try top-level fields first, then dig into the first account entry
    type AccountEntry = { remainingCredits?: number; remaining_credits?: number; credits?: number };
    const firstAccount = Object.values(json).find((v) => v && typeof v === 'object') as AccountEntry | undefined;

    const remaining =
      (json.remainingCredits as number | undefined) ??
      (json.remaining_credits as number | undefined) ??
      firstAccount?.remainingCredits ??
      firstAccount?.remaining_credits ??
      firstAccount?.credits;

    return NextResponse.json({ remainingCredits: remaining ?? null, firstAccount, raw: json });
  } catch (err: unknown) {
    return NextResponse.json({ error: (err instanceof Error ? err.message : String(err)) }, { status: 502 });
  }
}
