import { and, eq, inArray } from 'drizzle-orm';
import { brollCategories, brollClipCategories, brollClips } from '../db/schema.pg';
import type { BrollDb } from './broll-db';
import { validateCategoryMap, type CategoryMap } from './broll-category-map';

// Applies a reviewed classification to existing B-roll clip rows.
//
// Categories are found by database id through an explicit map. Names and slugs are editable,
// so they are never matched. This code never creates a category: a category that cannot be
// resolved stops the run before anything is written.

export interface CategoryAssignment { primary: string; subs: string[] }
export interface BrandEntry { name: string; role: 'hero' | 'incidental' | 'unresolved'; clearance: string; note?: string }
export interface ClipClassification {
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
export interface Classification {
  // Subcategories that are expected to exist already. Verified, never created.
  newSubcategories: { name: string; slug: string; parent: string }[];
  hold: { clipId: string; reason: string }[];
  archive: { dbId: number; title: string }[];
  clips: ClipClassification[];
}
export interface ManifestClip { clipId: string; filename: string; title: string; tags: string[]; subject: string; activity: string; setting: string }
export interface ImportedRecord { dbId: number; storagePath: string }

export interface ResolvedCategory { key: string; id: number; name: string; slug: string; parentId: number | null }
export interface PlannedClip {
  clipId: string;
  rowId: number;
  updates: string[];
  linksToCreate: ResolvedCategory[];
  linksExisting: ResolvedCategory[];
}
export interface ClassificationCounts {
  clipsUpdated: number;
  clipsUnchanged: number;
  linksCreated: number;
  linksExisting: number;
  hidden: number;
  alreadyHidden: number;
}
export interface ClassificationRun {
  counts: ClassificationCounts;
  categories: ResolvedCategory[];
  plan: PlannedClip[];
  held: { clipId: string; rowId: number }[];
  archived: { rowId: number; title: string }[];
}
export interface ClassificationOptions {
  classification: Classification;
  manifest: { clips: ManifestClip[] };
  imported: Record<string, ImportedRecord>;
  categoryMap: CategoryMap;
  apply: boolean;
  log?: (line: string) => void;
}

// Clips that must never be classified here: C05 is held for review, C10 was never imported,
// C17 and C22 contain personal data.
export const NEVER_CLASSIFY = new Set(['C05', 'C10', 'C17', 'C22']);

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

export function buildClassificationNotes(c: ClipClassification, sourceFilename: string): string {
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

// Everything that can be checked without a database, so a bad input stops the run first.
export function validateClassificationInput(opts: Pick<ClassificationOptions, 'classification' | 'categoryMap' | 'manifest' | 'imported'>): string[] {
  const { classification, categoryMap, manifest, imported } = opts;
  const errors = validateCategoryMap(categoryMap);
  const manifestIds = new Set(manifest.clips.map((c) => c.clipId));
  const seen = new Set<string>();

  const needKey = (key: string, where: string) => {
    if (!categoryMap[key]) errors.push(`${where}: no category mapping for '${key}'`);
  };

  for (const s of classification.newSubcategories) {
    needKey(s.slug, 'newSubcategories');
    needKey(s.parent, 'newSubcategories');
    if (categoryMap[s.slug] && categoryMap[s.parent] && categoryMap[s.slug].parentId !== categoryMap[s.parent].id) {
      errors.push(`newSubcategories: '${s.slug}' is mapped under a different parent than '${s.parent}'`);
    }
  }

  for (const c of classification.clips) {
    if (NEVER_CLASSIFY.has(c.clipId)) errors.push(`${c.clipId} must not be classified`);
    if (seen.has(c.clipId)) errors.push(`${c.clipId} appears more than once`);
    seen.add(c.clipId);
    if (!manifestIds.has(c.clipId)) errors.push(`${c.clipId} is missing from the manifest`);
    if (!imported[c.clipId]) errors.push(`${c.clipId} is missing from the import log`);
    for (const a of c.categories) {
      needKey(a.primary, c.clipId);
      if (categoryMap[a.primary] && categoryMap[a.primary].parentId !== null) errors.push(`${c.clipId}: '${a.primary}' is not a primary category`);
      for (const subKey of a.subs) {
        needKey(subKey, c.clipId);
        if (categoryMap[subKey] && categoryMap[a.primary] && categoryMap[subKey].parentId !== categoryMap[a.primary].id) {
          errors.push(`${c.clipId}: '${subKey}' does not belong under '${a.primary}'`);
        }
      }
    }
  }
  for (const h of classification.hold) {
    if (!imported[h.clipId]) errors.push(`${h.clipId} (hold) is missing from the import log`);
    if (!manifestIds.has(h.clipId)) errors.push(`${h.clipId} (hold) is missing from the manifest`);
  }
  return errors;
}

export async function runClassification(database: BrollDb, opts: ClassificationOptions): Promise<ClassificationRun> {
  const { classification, manifest, imported, categoryMap, apply } = opts;
  const log = opts.log ?? (() => {});
  const manifestById = new Map(manifest.clips.map((c) => [c.clipId, c]));

  const inputErrors = validateClassificationInput(opts);
  if (inputErrors.length > 0) fail(`Classification input is not valid:\n  - ${inputErrors.join('\n  - ')}`);

  log(apply ? 'MODE: APPLY' : 'MODE: DRY RUN (no changes will be written)');

  const counts: ClassificationCounts = { clipsUpdated: 0, clipsUnchanged: 0, linksCreated: 0, linksExisting: 0, hidden: 0, alreadyHidden: 0 };
  const run: ClassificationRun = { counts, categories: [], plan: [], held: [], archived: [] };

  await database.transaction(async (tx) => {
    // 1. Resolve every category the run needs by id and check its place in the tree.
    const keys = new Set<string>();
    for (const s of classification.newSubcategories) { keys.add(s.slug); keys.add(s.parent); }
    for (const c of classification.clips) for (const a of c.categories) { keys.add(a.primary); a.subs.forEach((k) => keys.add(k)); }

    const ids = [...new Set([...keys].map((k) => categoryMap[k].id))];
    const rows = ids.length ? await tx.select().from(brollCategories).where(inArray(brollCategories.id, ids)) : [];
    const rowById = new Map(rows.map((r) => [r.id, r]));

    const resolved = new Map<string, ResolvedCategory>();
    for (const key of [...keys].sort()) {
      const entry = categoryMap[key];
      const row = rowById.get(entry.id) ?? fail(`Category '${key}' (id ${entry.id}) was not found in the database`);
      if (row.scope !== 'soma' || row.brandScope !== null) fail(`Category '${key}' (id ${entry.id}) is not a Soma-wide category`);
      if (row.parentId !== entry.parentId) {
        fail(`Category '${key}' (id ${entry.id}) has parent ${row.parentId ?? 'none'} but the map expects ${entry.parentId ?? 'none'}`);
      }
      resolved.set(key, { key, id: row.id, name: row.name, slug: row.slug, parentId: row.parentId });
    }
    run.categories = [...resolved.values()];

    log('Categories (resolved by id):');
    for (const r of run.categories) {
      log(`  #${String(r.id).padStart(2)}  ${r.key.padEnd(20)} now "${r.name}" / ${r.slug}${r.parentId ? `  (parent #${r.parentId})` : ''}`);
    }

    // 2. Clip metadata and category links.
    for (const c of classification.clips) {
      const m = manifestById.get(c.clipId)!;
      const rec = imported[c.clipId];
      const [row] = await tx.select().from(brollClips).where(eq(brollClips.id, rec.dbId));
      if (!row) fail(`${c.clipId}: database row ${rec.dbId} not found`);
      if (row.storagePath !== rec.storagePath) fail(`${c.clipId}: storagePath mismatch on row ${rec.dbId}`);
      if (row.title !== m.title) fail(`${c.clipId}: title mismatch on row ${rec.dbId}`);

      const tags = JSON.stringify(finalTags(m.tags, c.removeTags, c.addTags));
      const notes = buildClassificationNotes(c, m.filename);
      const updates: Partial<typeof brollClips.$inferInsert> = {};
      if (row.userTags !== tags) updates.userTags = tags;
      if (row.aiTags !== tags) updates.aiTags = tags;
      if (row.notes !== notes) updates.notes = notes;
      if (!row.subject && m.subject) updates.subject = m.subject;
      if (!row.activity && m.activity) updates.activity = m.activity;
      if (!row.setting && m.setting) updates.setting = m.setting;

      const wanted: ResolvedCategory[] = [];
      for (const a of c.categories) {
        const primary = resolved.get(a.primary)!;
        if (a.subs.length === 0) wanted.push(primary);
        for (const subKey of a.subs) wanted.push(resolved.get(subKey)!);
      }
      const wantedIds = [...new Set(wanted.map((w) => w.id))];
      const existingLinks = wantedIds.length
        ? await tx.select({ categoryId: brollClipCategories.categoryId }).from(brollClipCategories)
            .where(and(eq(brollClipCategories.clipId, row.id), inArray(brollClipCategories.categoryId, wantedIds)))
        : [];
      const have = new Set(existingLinks.map((l) => l.categoryId));
      const linksToCreate = wanted.filter((w) => !have.has(w.id));
      const linksExisting = wanted.filter((w) => have.has(w.id));

      const changed = Object.keys(updates).length > 0;
      if (changed) counts.clipsUpdated++; else counts.clipsUnchanged++;
      counts.linksCreated += linksToCreate.length;
      counts.linksExisting += linksExisting.length;
      run.plan.push({ clipId: c.clipId, rowId: row.id, updates: Object.keys(updates), linksToCreate, linksExisting });

      log(`  ${c.clipId} → row ${row.id}: ${changed ? `update [${Object.keys(updates).join(', ')}]` : 'metadata unchanged'}`);
      for (const l of linksToCreate) log(`      link + #${l.id} "${l.name}"`);
      if (linksExisting.length) log(`      ${linksExisting.length} link(s) already present`);

      if (apply) {
        const now = Date.now();
        if (changed) await tx.update(brollClips).set({ ...updates, updatedAt: now }).where(eq(brollClips.id, row.id));
        if (linksToCreate.length) {
          await tx.insert(brollClipCategories)
            .values(linksToCreate.map((l) => ({ clipId: row.id, categoryId: l.id, createdAt: now })))
            .onConflictDoNothing();
        }
      }
    }

    // 3. Hold: sample clips pending clearance.
    for (const h of classification.hold) {
      const m = manifestById.get(h.clipId)!;
      const rec = imported[h.clipId];
      const [row] = await tx.select().from(brollClips).where(eq(brollClips.id, rec.dbId));
      if (!row || row.storagePath !== rec.storagePath || row.title !== m.title) fail(`${h.clipId}: row ${rec.dbId} does not match`);
      const notes = JSON.stringify({ schema: 'broll-classification/v1', clipId: h.clipId, sourceFilename: m.filename, clearance: 'unresolved', hold: h.reason });
      if (row.reviewStatus === 'on_hold' && row.notes === notes) { counts.alreadyHidden++; log(`  ${h.clipId} → row ${row.id}: already on hold`); continue; }
      counts.hidden++;
      run.held.push({ clipId: h.clipId, rowId: row.id });
      log(`  ${h.clipId} → row ${row.id}: set review_status on_hold`);
      if (apply) await tx.update(brollClips).set({ reviewStatus: 'on_hold', notes, updatedAt: Date.now() }).where(eq(brollClips.id, row.id));
    }

    // 4. Archive: records outside the sample. Only review_status changes.
    const sampleRowIds = new Set(Object.values(imported).map((r) => r.dbId));
    for (const a of classification.archive) {
      const [row] = await tx.select().from(brollClips).where(eq(brollClips.id, a.dbId));
      if (!row || row.title !== a.title) fail(`Archive target row ${a.dbId} does not match title '${a.title}'`);
      if (sampleRowIds.has(a.dbId)) fail(`Row ${a.dbId} is a mapped sample clip and must not be archived`);
      if (row.reviewStatus === 'archived') { counts.alreadyHidden++; log(`  row ${row.id}: already archived`); continue; }
      counts.hidden++;
      run.archived.push({ rowId: row.id, title: row.title });
      log(`  row ${row.id} ('${row.title}'): set review_status archived`);
      if (apply) await tx.update(brollClips).set({ reviewStatus: 'archived' }).where(eq(brollClips.id, row.id));
    }
  });

  return run;
}
