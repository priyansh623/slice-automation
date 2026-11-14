/**
 * Fills in the SHA-256 of existing B-roll objects that have none (the clips created before checksums were recorded), so the
 * bulk uploader's exact-duplicate check can recognise them. See src/lib/broll-bulk/checksum-backfill.ts for the safety rules.
 *
 *   npx tsx scripts/broll-checksum-backfill.ts                 list the clips that need a checksum (reads the database only)
 *   npx tsx scripts/broll-checksum-backfill.ts --verify        also stream each object from R2 and check its size (read-only)
 *   npx tsx scripts/broll-checksum-backfill.ts --verify --expected <state.json>
 *                                                              compare with checksums known from an earlier import log
 *   npx tsx scripts/broll-checksum-backfill.ts --execute       hash and RECORD the checksums (the only write: empty sha256 fields)
 *
 * Needs the usual database settings and the R2_* variables (for --verify / --execute). Never deletes, overwrites or uploads.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const hash = execute || args.includes('--verify');
  const expectedPath = args.includes('--expected') ? args[args.indexOf('--expected') + 1] : null;

  const { db } = await import('../src/db');
  const { R2Provider, r2ConfigFromEnv } = await import('../src/lib/object-store/r2-provider');
  const { findBackfillCandidates, runBackfill, recordChecksum } = await import('../src/lib/broll-bulk/checksum-backfill');

  const candidates = await findBackfillCandidates(db);
  const totalBytes = candidates.reduce((n, c) => n + (c.registrySize ?? c.clipSize ?? 0), 0);
  console.log(`${execute ? 'EXECUTE' : hash ? 'VERIFY (read-only hashing)' : 'LIST ONLY'}: ${candidates.length} clip(s) have no recorded checksum, ${totalBytes} bytes (${(totalBytes / 1048576).toFixed(1)} MiB) to read.`);
  if (candidates.length === 0) return;

  const r2 = hash ? (() => { const cfg = r2ConfigFromEnv(); if (!cfg) throw new Error('R2 is not configured (R2_* variables missing). Nothing was done.'); return new R2Provider(cfg); })() : null;
  const results = await runBackfill(candidates, {
    hash: (key) => r2!.hashObject('uploads', key),
    record: (key, sha, now) => recordChecksum(db, key, sha, now),
    log: (l) => console.log(l),
  }, { hash, execute });

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  console.log('\nsummary:', JSON.stringify(counts));

  if (hash) {
    // Exact duplicates among the library's own clips, which the checksums make visible.
    const bySha = new Map<string, number[]>();
    for (const r of results) if (r.sha256) bySha.set(r.sha256, [...(bySha.get(r.sha256) ?? []), r.candidate.clipId]);
    const dups = [...bySha.values()].filter((v) => v.length > 1);
    console.log(dups.length ? `identical clips found: ${dups.map((d) => d.join(' = ')).join('; ')}` : 'no two of these clips are identical');
  }
  if (expectedPath && hash) {
    const known = JSON.parse(fs.readFileSync(expectedPath, 'utf8')) as Record<string, { dbId: number; sha256: string }>;
    const byId = new Map(Object.values(known).map((k) => [k.dbId, k.sha256]));
    let match = 0, differ = 0, unknown = 0;
    for (const r of results) {
      const want = byId.get(r.candidate.clipId);
      if (!want || !r.sha256) { unknown++; continue; }
      if (want === r.sha256) match++; else { differ++; console.log(`DIFFERS clip ${r.candidate.clipId}`); }
    }
    console.log(`cross-check against ${path.basename(expectedPath)}: ${match} match, ${differ} differ, ${unknown} not in that log`);
  }
  if (!execute && hash) console.log('\nNothing was written. Re-run with --execute to record these checksums.');
  process.exit(results.some((r) => r.outcome === 'hash-failed' || r.outcome === 'size-mismatch') ? 1 : 0);
}
main().catch((e) => { console.error('Failed:', (e as Error).message); process.exit(1); });
