import { NextResponse } from 'next/server';
import { db } from '@/db';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/api-auth';
import { sql } from 'drizzle-orm';

export async function GET(): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;


  const results: Record<string, { ok: boolean; detail: string }> = {};

  // 1. PostgreSQL (pooler)
  try {
    await db.execute(sql`SELECT 1`);
    results.database = { ok: true, detail: 'Connected via pooler' };
  } catch (e: unknown) {
    results.database = { ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }

  // 2. Supabase Auth (anon key reachability)
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.getUser();
    const sessionMissing = error?.message?.includes('session') || error?.message?.includes('missing');
    results.supabaseAuth = (!error || sessionMissing)
      ? { ok: true, detail: 'Reachable' }
      : { ok: false, detail: error.message };
  } catch (e: unknown) {
    results.supabaseAuth = { ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }

  // 3. Supabase Storage (uploads bucket)
  try {
    const supabase = await createClient();
    const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';
    const { error } = await supabase.storage.from(bucket).list('', { limit: 1 });
    results.storage = error
      ? { ok: false, detail: error.message }
      : { ok: true, detail: `Bucket "${bucket}" reachable` };
  } catch (e: unknown) {
    results.storage = { ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }

  // 4. Anthropic API key present (no test call — don't spend tokens)
  results.anthropic = process.env.ANTHROPIC_API_KEY
    ? { ok: true, detail: 'API key present' }
    : { ok: false, detail: 'ANTHROPIC_API_KEY not set' };

  // 5. useapi.net token present
  results.useapi = process.env.USEAPI_TOKEN
    ? { ok: true, detail: 'Token present' }
    : { ok: false, detail: 'USEAPI_TOKEN not set' };

  const allOk = Object.values(results).every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}
