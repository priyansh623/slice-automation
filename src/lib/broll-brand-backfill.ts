import { asc } from 'drizzle-orm';
import { brollClipBrands, brollClips } from '../db/schema.pg';
import type { BrollDb } from './broll-db';
import { planBrandAssociations } from './broll-brands';

export interface BackfillResult {
  clipsWithBrands: number;
  planned: number;
  inserted: number;
  alreadyPresent: number;
  skipped: { clipId: number; name: string; reason: string }[];
  heroColumnWithoutAssociation: { clipId: number; brand: string }[];
}

// Copies brand details from broll_clips.notes into broll_clip_brands.
// notes is never modified. Every association is written with clearance 'unresolved'.
// Safe to re-run: associations that already exist are left as they are.
export async function backfillBrands(database: BrollDb, apply: boolean, log: (line: string) => void = () => {}): Promise<BackfillResult> {
  const result: BackfillResult = { clipsWithBrands: 0, planned: 0, inserted: 0, alreadyPresent: 0, skipped: [], heroColumnWithoutAssociation: [] };

  // Explicit columns so a dry run also works before the migration adds clearance_status.
  const clips = await database
    .select({ id: brollClips.id, notes: brollClips.notes, brand: brollClips.brand })
    .from(brollClips)
    .orderBy(asc(brollClips.id));

  for (const clip of clips) {
    const plan = planBrandAssociations(clip.notes);
    for (const s of plan.skipped) result.skipped.push({ clipId: clip.id, ...s });

    const heroNames = plan.associations.filter((a) => a.role === 'hero').map((a) => (a.brandName ?? '').toLowerCase());
    if (clip.brand && !heroNames.includes(clip.brand.trim().toLowerCase())) {
      result.heroColumnWithoutAssociation.push({ clipId: clip.id, brand: clip.brand });
    }

    if (plan.associations.length === 0) continue;
    result.clipsWithBrands++;
    result.planned += plan.associations.length;

    for (const a of plan.associations) {
      log(`  clip ${clip.id}: ${a.role.padEnd(14)} ${a.brandName ?? '(no brand name)'}${a.note ? `  [${a.note}]` : ''}`);
      if (!apply) continue;
      const now = Date.now();
      const inserted = await database
        .insert(brollClipBrands)
        .values({ clipId: clip.id, brandName: a.brandName, role: a.role, clearanceStatus: a.clearanceStatus, note: a.note, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ id: brollClipBrands.id });
      if (inserted.length > 0) result.inserted++; else result.alreadyPresent++;
    }
  }

  return result;
}
