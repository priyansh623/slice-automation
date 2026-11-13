/**
 * Copies existing files from Supabase Storage to Cloudflare R2 and registers each one as living on R2, but only after
 * its size and SHA-256 have been checked by reading the copy back from R2.
 *
 *   Dry run (the default; reads metadata only, never downloads, writes or registers):
 *     npx tsx scripts/storage-copy.ts [--bucket videos|uploads] [--prefix <key prefix>] [--limit <n>]
 *
 *   Real copy (only with the explicit flag):
 *     npx tsx scripts/storage-copy.ts --execute [--bucket ...] [--prefix ...] [--limit <n>]
 *
 *   Re-check files that are already registered as being in R2 (read-only; works with or without --execute):
 *     npx tsx scripts/storage-copy.ts --verify-registered [--bucket ...] [--prefix ...]
 *     Downloads each registered R2 object and compares its SHA-256 with the checksum stored in the registry. Never reads
 *     the Supabase original, never changes R2 or the registry. Rows without a stored checksum are reported as
 *     "unverifiable", never as verified. Does not count towards --limit.
 *
 * Safety:
 *   - Supabase originals are only read, never deleted or changed. (--verify-registered does not even read them.)
 *   - R2 writes are create-only: an object already in R2 is never overwritten.
 *   - The registry is insert-only here: existing rows are never changed. A file whose copy fails any check, or whose
 *     registry write fails, stays unregistered and keeps being served from Supabase.
 *   - Safe to re-run or interrupt (Ctrl-C finishes the current file, then stops). Re-running skips registered files and
 *     finishes any left half-done.
 *   - STORAGE_WRITE_PROVIDER is never read or changed by this script.
 *   - --limit counts files that need work; files already registered do not count.
 *
 * Run with tsx (not ts-node): it uses the project's '@/' import aliases.
 */
import * as path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import type { BucketName } from '../src/lib/object-store/types';

export interface CliArgs { execute: boolean; verifyRegistered: boolean; buckets: BucketName[]; prefix: string; limit: number | null; help: boolean }

const USAGE = `Usage: npx tsx scripts/storage-copy.ts [--execute] [--verify-registered] [--bucket videos|uploads] [--prefix <key prefix>] [--limit <n>]
  (no --execute)  dry run: lists what would be copied, changes nothing
  --execute       really copy, verify and register
  --verify-registered  also download files already registered as R2 and compare SHA-256 with the registry (read-only)
  --bucket        videos or uploads (default: both)
  --prefix        only keys starting with this text
  --limit         at most n files that need work`;

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { execute: false, verifyRegistered: false, buckets: ['videos', 'uploads'], prefix: '', limit: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--execute') out.execute = true;
    else if (a === '--verify-registered') out.verifyRegistered = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--bucket') {
      const v = value();
      if (v !== 'videos' && v !== 'uploads') throw new Error(`--bucket must be videos or uploads, got "${v}"`);
      out.buckets = [v];
    } else if (a === '--prefix') out.prefix = value();
    else if (a === '--limit') {
      const v = value();
      if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`--limit must be a positive whole number, got "${v}"`);
      out.limit = Number(v);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${(e as Error).message}\n\n${USAGE}`); return 2; }
  if (args.help) { console.log(USAGE); return 0; }

  // Loaded after dotenv so the database and storage clients see the environment.
  const { createClient } = await import('@supabase/supabase-js');
  const { SupabaseProvider, bucketId } = await import('../src/lib/object-store/supabase-provider');
  const { R2Provider, r2ConfigFromEnv } = await import('../src/lib/object-store/r2-provider');
  const { registerObjectIfAbsent, registeredRows } = await import('../src/lib/object-store/registry');
  const { db } = await import('../src/db');
  const { sql } = await import('drizzle-orm');
  const { runCopy, listSupabaseObjects } = await import('../src/lib/object-store/copy');

  const r2Config = r2ConfigFromEnv();
  if ((args.execute || args.verifyRegistered) && !r2Config) { console.error('R2 is not configured (R2_* environment variables missing). Nothing was done.'); return 2; }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error('Supabase environment variables are missing. Nothing was done.'); return 2; }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const supabase = new SupabaseProvider(sb);

  let stop = false;
  process.on('SIGINT', () => {
    if (stop) { console.error('\nForced exit. Anything half-done is picked up by the next run.'); process.exit(130); }
    stop = true;
    console.error('\nStopping after the current file (Ctrl-C again to quit immediately)...');
  });

  console.log(args.execute ? 'REAL COPY (--execute). Supabase originals are never changed.' : 'DRY RUN: nothing is written to R2 or the registry, and nothing is downloaded from Supabase. Add --execute to copy.');
  if (args.verifyRegistered) console.log('--verify-registered: registered R2 objects are downloaded from R2 and checksummed (read-only; Supabase is not read).');
  console.log(`buckets=${args.buckets.join(',')} prefix="${args.prefix}" limit=${args.limit ?? 'none'}`);

  const report = await runCopy(
    {
      source: supabase,
      target: r2Config ? new R2Provider(r2Config) : null,
      listSource: (bucket, prefix) => listSupabaseObjects(sb, bucketId(bucket), prefix),
      registeredRows,
      registerIfAbsent: registerObjectIfAbsent,
      // Independent count straight from the storage tables (not through the listing API), to catch a listing that missed
      // objects. Returns null if the database role cannot read them: the run then says it was NOT cross-checked.
      countSource: async (bucket, prefix) => {
        try {
          const like = `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
          const rows = await db.execute(sql`select count(*)::int as n from storage.objects where bucket_id = ${bucketId(bucket)} and archived_at is null and not is_delete_marker and name like ${like}`);
          const n = (rows as unknown as { n: number }[])[0]?.n;
          return typeof n === 'number' ? n : null;
        } catch { return null; }
      },
      shouldStop: () => stop,
      log: (line) => console.log(line),
    },
    { buckets: args.buckets, prefix: args.prefix, limit: args.limit, execute: args.execute, verifyRegistered: args.verifyRegistered },
  );

  const c = report.counts;
  console.log('\n--- summary ---');
  console.log(report.dryRun
    ? `would copy ${c['would-copy']}, already in R2 with the same size, checksum verification PENDING (not verified) ${c['would-register']}, CONFLICTS ${c['would-conflict']}, already registered ${c['skipped-registered']} (rows pointing at R2 are checked for existence and size only, not checksum), problems ${c.failed}; ${report.bytesPlanned} bytes planned${r2Config ? '' : ' (R2 not configured: existing R2 objects and registry rows were not checked against R2)'}`
    : `copied and checksum-verified ${c.copied}, existing R2 objects checksum-verified and registered ${c['registered-existing']}, already registered ${c['skipped-registered']} (existence and size checked only, checksum not compared), failed ${c.failed}; ${report.bytesCopied} bytes migrated`);
  if (args.verifyRegistered) {
    console.log(`registered rows: checksum-verified ${c['verified-registered']}, UNVERIFIABLE (no checksum stored; contents NOT verified) ${c.unverifiable}, failed ${c.failed}`);
  }
  for (const [bucket, seen] of Object.entries(report.listed)) console.log(`listed in Supabase ${bucket}: ${seen.objects} distinct objects, ${seen.bytes} bytes`);
  let listingMismatch = false;
  for (const [bucket, chk] of Object.entries(report.listingChecks)) {
    if (!chk) continue;
    if (chk.match === true) console.log(`listing cross-check ${bucket}: OK (${chk.listed} listed = ${chk.expected} counted independently${chk.duplicates ? `; ${chk.duplicates} duplicate listings ignored` : ''})`);
    else if (chk.match === false) { listingMismatch = true; console.log(`LISTING MISMATCH ${bucket}: listed ${chk.listed} but ${chk.expected} counted independently. The listing is incomplete or stale; do not trust this run's coverage.`); }
    else console.log(`listing cross-check ${bucket}: NOT DONE (${chk.note})`);
  }
  if (!report.stoppedEarly && args.limit !== null) console.log('A --limit was set: cross-checks only apply to buckets that were listed to the end.');
  if (report.stoppedEarly) console.log('Stopped early on request; re-run to continue.');
  for (const r of report.results.filter((x) => x.outcome === 'failed' || x.outcome === 'would-conflict' || x.outcome === 'unverifiable')) console.log(`${r.outcome === 'failed' ? 'FAILED' : r.outcome === 'unverifiable' ? 'UNVERIFIABLE' : 'CONFLICT'} ${r.bucket}/${r.key}${r.stage ? ` at ${r.stage}` : ''}: ${r.reason}`);
  return c.failed > 0 || c['would-conflict'] > 0 || c.unverifiable > 0 || listingMismatch ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(`Aborted: ${(err as Error).message}`); process.exit(1); });
}
