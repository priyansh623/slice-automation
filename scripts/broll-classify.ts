/**
 * Applies the reviewed B-roll sample classification to existing clip records.
 *
 * Dry-run (default, makes no changes):
 *   npx ts-node --project tsconfig.scripts.json scripts/broll-classify.ts
 *
 * Apply:
 *   npx ts-node --project tsconfig.scripts.json scripts/broll-classify.ts --apply
 *
 * Inputs (local, git-ignored):
 *   broll-import/classification.json  categories, tags, brands and flags per clip
 *   broll-import/manifest.json        clipId → source filename, title, tags
 *   broll-import/imported.json        clipId → dbId, storagePath
 * Category ids: src/lib/broll-category-map.ts
 *
 * Categories are found by database id, never by name or slug, and are never created.
 * Clips are matched by the database id in imported.json and checked against storagePath and
 * title before anything is written. Safe to re-run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import { brollCategories, brollClipCategories, brollClips } from '../src/db/schema.pg';
import { BROLL_CATEGORY_MAP } from '../src/lib/broll-category-map';
import { runClassification, type Classification, type ImportedRecord, type ManifestClip } from '../src/lib/broll-classification';
import { activeBrollLibraryCondition } from '../src/lib/broll-visibility';

const DIR = path.join(process.cwd(), 'broll-import');
const readJson = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as T;

async function main() {
  const apply = process.argv.includes('--apply');
  const classification = readJson<Classification>('classification.json');
  if (classification.clips.length !== 28) throw new Error(`Expected 28 clips to classify, found ${classification.clips.length}`);

  const run = await runClassification(db, {
    classification,
    manifest: readJson<{ clips: ManifestClip[] }>('manifest.json'),
    imported: readJson<Record<string, ImportedRecord>>('imported.json'),
    categoryMap: BROLL_CATEGORY_MAP,
    apply,
    log: console.log,
  });
  console.log('\nSummary:', JSON.stringify(run.counts));

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(brollClips);
  const active = await db.select({ id: brollClips.id }).from(brollClips).where(activeBrollLibraryCondition());
  const [{ links }] = await db.select({ links: sql<number>`count(*)::int` }).from(brollClipCategories);
  const [{ cats }] = await db.select({ cats: sql<number>`count(*)::int` }).from(brollCategories);
  console.log(`State: ${total} clip rows, ${active.length} active, ${links} category links, ${cats} categories`);
}

main().then(() => process.exit(0)).catch((err) => { console.error('FAILED:', err instanceof Error ? (err.message || err.name) : err); process.exit(1); });
