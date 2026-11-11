/**
 * Applies the reviewed B-roll sample classification to existing clip records.
 *
 * Dry-run (default, makes no changes):
 *   npx ts-node --project tsconfig.scripts.json scripts/broll-classify.ts
 *
 * Apply:
 *   npx ts-node --project tsconfig.scripts.json scripts/broll-classify.ts --apply
 *
 * Inputs (all local, git-ignored):
 *   broll-import/classification.json  categories, tags, brands and flags per clip
 *   broll-import/manifest.json        clipId → source filename, title, tags
 *   broll-import/imported.json        clipId → dbId, storagePath
 *
 * Records are matched by the database id in imported.json and checked against
 * storagePath and title before anything is written. Safe to re-run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../src/db';
import { brollCategories, brollClipCategories, brollClips } from '../src/db/schema.pg';
import { HIDDEN_BROLL_REVIEW_STATUSES } from '../src/lib/broll-visibility';

interface CategoryAssignment { primary: string; subs: string[] }
interface BrandEntry { name: string; role: 'hero' | 'incidental' | 'unresolved'; clearance: string; note?: string }
interface ClipClassification {
  clipId: string;
  confidence: string;
  categories: CategoryAssignment[];
  removeTags: string[];
  addTags: string[];
  clientProduct?: { what: string; brandConfirmed: boolean };
  brands: BrandEntry[];
  flags: string[];
  review: string;
}
interface Classification {
  newSubcategories: { name: string; slug: string; parent: string }[];
  hold: { clipId: string; reason: string }[];
  archive: { dbId: number; title: string }[];
  clips: ClipClassification[];
}
interface ManifestClip { clipId: string; filename: string; title: string; tags: string[]; subject: string; activity: string; setting: string }
interface ImportedRecord { dbId: number; storagePath: string }

const APPLY = process.argv.includes('--apply');
const DIR = path.join(process.cwd(), 'broll-import');
const readJson = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as T;

const classification = readJson<Classification>('classification.json');
const manifest = readJson<{ clips: ManifestClip[]; excluded: { clipId: string }[] }>('manifest.json');
const imported = readJson<Record<string, ImportedRecord>>('imported.json');

const NEVER_CLASSIFY = new Set(['C05', 'C10', 'C17', 'C22']);
const manifestById = new Map(manifest.clips.map((c) => [c.clipId, c]));

function fail(message: string): never {
  throw new Error(message);
}

function finalTags(base: string[], remove: string[], add: string[]): string[] {
  const drop = new Set(remove.map((t) => t.toLowerCase()));
  const tags = base.filter((t) => !drop.has(t.toLowerCase()));
  for (const t of add) {
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  }
  return tags;
}

function buildNotes(c: ClipClassification, sourceFilename: string): string {
  const needsClearance = c.brands.length > 0 || !!c.clientProduct;
  return JSON.stringify({
    schema: 'broll-classification/v1',
    clipId: c.clipId,
    sourceFilename,
    confidence: c.confidence,
    clearance: needsClearance ? 'unresolved' : 'not_assessed',
    clientProduct: c.clientProduct ?? null,
    brands: c.brands,
    flags: c.flags,
    review: c.review,
  });
}

async function main() {
  console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (no changes will be written)');

  if (classification.clips.length !== 28) fail(`Expected 28 clips to classify, found ${classification.clips.length}`);
  for (const c of classification.clips) {
    if (NEVER_CLASSIFY.has(c.clipId)) fail(`${c.clipId} must not be classified`);
  }

  const counts = { categoriesCreated: 0, categoriesReused: 0, clipsUpdated: 0, clipsUnchanged: 0, linksCreated: 0, linksExisting: 0, hidden: 0, alreadyHidden: 0 };

  await db.transaction(async (tx) => {
    // 1. Taxonomy: create the approved subcategories if they do not exist yet.
    for (const sub of classification.newSubcategories) {
      const [parent] = await tx.select().from(brollCategories)
        .where(and(eq(brollCategories.slug, sub.parent), isNull(brollCategories.brandScope), isNull(brollCategories.parentId)));
      if (!parent) fail(`Parent category '${sub.parent}' not found`);

      const [existing] = await tx.select().from(brollCategories)
        .where(and(eq(brollCategories.slug, sub.slug), isNull(brollCategories.brandScope)));
      const [sameName] = await tx.select().from(brollCategories)
        .where(and(eq(brollCategories.parentId, parent.id), sql`lower(${brollCategories.name}) = ${sub.name.toLowerCase()}`));
      const found = existing ?? sameName;
      if (found) {
        if (found.parentId !== parent.id) fail(`'${sub.slug}' exists under a different parent`);
        counts.categoriesReused++;
        console.log(`  taxonomy: reuse   ${sub.name} (id ${found.id}) under ${sub.parent}`);
        continue;
      }
      counts.categoriesCreated++;
      console.log(`  taxonomy: create  ${sub.name} under ${sub.parent}`);
      if (APPLY) {
        const [{ maxOrder }] = await tx.select({ maxOrder: sql<number>`coalesce(max(${brollCategories.sortOrder}), 0)` })
          .from(brollCategories).where(eq(brollCategories.parentId, parent.id));
        const now = Date.now();
        await tx.insert(brollCategories).values({
          name: sub.name, slug: sub.slug, scope: 'soma', brandScope: null,
          parentId: parent.id, sortOrder: Number(maxOrder) + 1, createdAt: now, updatedAt: now,
        });
      }
    }

    const allCategories = await tx.select().from(brollCategories).where(isNull(brollCategories.brandScope));
    const bySlug = new Map(allCategories.map((c) => [c.slug, c]));
    const pendingSlugs = new Set(APPLY ? [] : classification.newSubcategories.filter((s) => !bySlug.has(s.slug)).map((s) => s.slug));

    // 2. Clips: metadata and category links.
    for (const c of classification.clips) {
      const m = manifestById.get(c.clipId) ?? fail(`${c.clipId} missing from manifest`);
      const rec = imported[c.clipId] ?? fail(`${c.clipId} missing from imported.json`);
      const [row] = await tx.select().from(brollClips).where(eq(brollClips.id, rec.dbId));
      if (!row) fail(`${c.clipId}: database row ${rec.dbId} not found`);
      if (row.storagePath !== rec.storagePath) fail(`${c.clipId}: storagePath mismatch on row ${rec.dbId}`);
      if (row.title !== m.title) fail(`${c.clipId}: title mismatch on row ${rec.dbId}`);

      const tags = JSON.stringify(finalTags(m.tags, c.removeTags, c.addTags));
      const notes = buildNotes(c, m.filename);
      const updates: Partial<typeof brollClips.$inferInsert> = {};
      if (row.userTags !== tags) updates.userTags = tags;
      if (row.aiTags !== tags) updates.aiTags = tags;
      if (row.notes !== notes) updates.notes = notes;
      if (!row.subject && m.subject) updates.subject = m.subject;
      if (!row.activity && m.activity) updates.activity = m.activity;
      if (!row.setting && m.setting) updates.setting = m.setting;
      for (const [field, expected] of [['subject', m.subject], ['activity', m.activity], ['setting', m.setting]] as const) {
        if (row[field] && row[field] !== expected) console.log(`  ${c.clipId}: ${field} kept as stored ('${row[field]}'), manifest has '${expected}'`);
      }

      // Each subcategory must sit under the primary it is listed with.
      const categoryIds: number[] = [];
      let unresolved = false;
      for (const a of c.categories) {
        const primary = bySlug.get(a.primary) ?? fail(`${c.clipId}: primary '${a.primary}' not found`);
        if (primary.parentId !== null) fail(`${c.clipId}: '${a.primary}' is not a primary category`);
        if (a.subs.length === 0) categoryIds.push(primary.id);
        for (const slug of a.subs) {
          const sub = bySlug.get(slug);
          if (!sub) {
            if (pendingSlugs.has(slug)) { unresolved = true; continue; }
            fail(`${c.clipId}: subcategory '${slug}' not found`);
          }
          if (sub.parentId !== primary.id) fail(`${c.clipId}: '${slug}' does not belong to '${a.primary}'`);
          categoryIds.push(sub.id);
        }
      }

      const existingLinks = categoryIds.length
        ? await tx.select({ categoryId: brollClipCategories.categoryId }).from(brollClipCategories)
            .where(and(eq(brollClipCategories.clipId, row.id), inArray(brollClipCategories.categoryId, categoryIds)))
        : [];
      const have = new Set(existingLinks.map((l) => l.categoryId));
      const missing = categoryIds.filter((id) => !have.has(id));
      counts.linksExisting += have.size;
      counts.linksCreated += missing.length + (unresolved ? c.categories.flatMap((a) => a.subs).filter((s) => pendingSlugs.has(s)).length : 0);

      const changed = Object.keys(updates).length > 0;
      if (changed) counts.clipsUpdated++; else counts.clipsUnchanged++;
      console.log(`  ${c.clipId} → row ${row.id}: ${changed ? `update [${Object.keys(updates).join(', ')}]` : 'metadata unchanged'}; links +${missing.length}${unresolved ? ' (+ new subcategories)' : ''}, ${have.size} existing`);

      if (APPLY) {
        const now = Date.now();
        if (changed) await tx.update(brollClips).set({ ...updates, updatedAt: now }).where(eq(brollClips.id, row.id));
        if (missing.length) {
          await tx.insert(brollClipCategories)
            .values(missing.map((categoryId) => ({ clipId: row.id, categoryId, createdAt: now })))
            .onConflictDoNothing();
        }
      }
    }

    // 3. Hold: sample clips pending clearance.
    for (const h of classification.hold) {
      const m = manifestById.get(h.clipId) ?? fail(`${h.clipId} missing from manifest`);
      const rec = imported[h.clipId] ?? fail(`${h.clipId} missing from imported.json`);
      const [row] = await tx.select().from(brollClips).where(eq(brollClips.id, rec.dbId));
      if (!row || row.storagePath !== rec.storagePath || row.title !== m.title) fail(`${h.clipId}: row ${rec.dbId} does not match`);
      const notes = JSON.stringify({ schema: 'broll-classification/v1', clipId: h.clipId, sourceFilename: m.filename, clearance: 'unresolved', hold: h.reason });
      if (row.reviewStatus === 'on_hold' && row.notes === notes) { counts.alreadyHidden++; console.log(`  ${h.clipId} → row ${row.id}: already on hold`); continue; }
      counts.hidden++;
      console.log(`  ${h.clipId} → row ${row.id}: set review_status on_hold`);
      if (APPLY) await tx.update(brollClips).set({ reviewStatus: 'on_hold', notes, updatedAt: Date.now() }).where(eq(brollClips.id, row.id));
    }

    // 4. Archive: records outside the sample. Only review_status changes.
    for (const a of classification.archive) {
      const [row] = await tx.select().from(brollClips).where(eq(brollClips.id, a.dbId));
      if (!row || row.title !== a.title) fail(`Archive target row ${a.dbId} does not match title '${a.title}'`);
      if (Object.values(imported).some((r) => r.dbId === a.dbId)) fail(`Row ${a.dbId} is a mapped sample clip and must not be archived`);
      if (row.reviewStatus === 'archived') { counts.alreadyHidden++; console.log(`  row ${row.id}: already archived`); continue; }
      counts.hidden++;
      console.log(`  row ${row.id} ('${row.title}'): set review_status archived`);
      if (APPLY) await tx.update(brollClips).set({ reviewStatus: 'archived' }).where(eq(brollClips.id, row.id));
    }
  });

  console.log('\nSummary:', JSON.stringify(counts));

  // Read-only state report.
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(brollClips);
  const active = await db.select({ id: brollClips.id }).from(brollClips).where(notInArray(brollClips.reviewStatus, HIDDEN_BROLL_REVIEW_STATUSES));
  const hidden = await db.select({ id: brollClips.id, reviewStatus: brollClips.reviewStatus }).from(brollClips).where(inArray(brollClips.reviewStatus, HIDDEN_BROLL_REVIEW_STATUSES));
  const [{ links }] = await db.select({ links: sql<number>`count(*)::int` }).from(brollClipCategories);
  const [{ cats }] = await db.select({ cats: sql<number>`count(*)::int` }).from(brollCategories);
  console.log(`State: ${total} clip rows, ${active.length} active, hidden ${JSON.stringify(hidden)}, ${links} category links, ${cats} categories`);
}

main().then(() => process.exit(0)).catch((err) => { console.error('FAILED:', err instanceof Error ? (err.message || (err as { code?: string }).code || err.name) : err); process.exit(1); });
