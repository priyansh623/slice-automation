/**
 * Copies brand details from broll_clips.notes into broll_clip_brands.
 * Requires the broll_clip_brands table from migration drizzle/pg/0022_broll_clearance_and_brands.sql for --apply.
 *
 * Dry-run (default, read-only, works before the migration is applied):
 *   npx ts-node --project tsconfig.scripts.json scripts/broll-backfill-brands.ts
 *
 * Apply (needs separate approval; do not run against production without it):
 *   npx ts-node --project tsconfig.scripts.json scripts/broll-backfill-brands.ts --apply
 *
 * notes is never modified.
 * Safe to re-run: existing associations are left as they are.
 */
import * as path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import { brollClipBrands } from '../src/db/schema.pg';
import { backfillBrands } from '../src/lib/broll-brand-backfill';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'MODE: APPLY' : 'MODE: DRY RUN (no changes will be written)');
  const result = await backfillBrands(db, apply, console.log);

  for (const s of result.skipped) console.log(`  SKIPPED clip ${s.clipId}: ${s.name} (${s.reason})`);
  for (const h of result.heroColumnWithoutAssociation) console.log(`  NOTE clip ${h.clipId}: brand column '${h.brand}' has no matching hero association`);
  console.log(`\nSummary: ${result.clipsWithBrands} clips, ${result.planned} associations planned, ${result.inserted} inserted, ${result.alreadyPresent} already present, ${result.skipped.length} skipped`);

  if (apply) {
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(brollClipBrands);
    console.log(`State: ${total} rows in broll_clip_brands`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('FAILED:', err instanceof Error ? (err.message || (err as { code?: string }).code || err.name) : err);
  process.exit(1);
});
