import { NextResponse } from 'next/server';
import { db } from '@/db';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/api-auth';
import { sql } from 'drizzle-orm';
import { R2Provider, r2ConfigFromEnv } from '@/lib/object-store/r2-provider';

export async function GET(): Promise<NextResponse> {
  const authResult = await requireUser();
  if (authResult instanceof NextResponse) return authResult;


  // `configured: false` marks a provider that is switched off on purpose (not a failure).
  const results: Record<string, { ok: boolean; detail: string; configured?: boolean }> = {};

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

  // 3b. Cloudflare R2. Not configured is a normal state while Supabase is the only provider: it is reported as such and
  // does not make the overall result unhealthy. Only a configured R2 that cannot be reached is a failure.
  const r2Config = r2ConfigFromEnv();
  if (!r2Config) {
    results.r2 = { ok: true, configured: false, detail: 'Not configured (R2 is inactive; Supabase is the only storage provider)' };
  } else {
    try {
      const checks = await Promise.race([
        new R2Provider(r2Config).ping(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 8 seconds')), 8000)),
      ]);
      const failed = checks.filter((c) => !c.ok);
      results.r2 = failed.length === 0
        ? { ok: true, configured: true, detail: checks.map((c) => c.detail).join('; ') }
        : { ok: false, configured: true, detail: failed.map((c) => c.detail).join('; ').slice(0, 300) };
    } catch (e: unknown) {
      results.r2 = { ok: false, configured: true, detail: `R2 connection failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` };
    }
  }

  // 3c. Which provider new files go to (informational)
  const writesToR2 = process.env.STORAGE_WRITE_PROVIDER === 'r2';
  const brollToR2 = process.env.STORAGE_WRITE_PROVIDER_BROLL === 'r2';
  const wantsR2 = writesToR2 || brollToR2;
  results.storageRouting = {
    ok: !(wantsR2 && !r2Config),
    detail: wantsR2 && !r2Config
      ? `${writesToR2 ? 'STORAGE_WRITE_PROVIDER' : 'STORAGE_WRITE_PROVIDER_BROLL'}=r2 but R2 is not configured; new files fall back to Supabase`
      : `New files go to ${writesToR2 ? 'R2' : 'Supabase'}; new B-roll uploads go to ${writesToR2 || brollToR2 ? 'R2' : 'Supabase'}; reading falls back between providers: ${process.env.STORAGE_FAILOVER === 'off' ? 'off' : 'on'}`,
  };

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
