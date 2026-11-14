import { isNotNull } from 'drizzle-orm';
import { brollCategories, brollClipBrands, brollClips } from '@/db/schema.pg';
import type { BrollDb } from '@/lib/broll-db';
import { distinctByUse, withPaths, type Taxonomy } from './taxonomy';

/**
 * Reads the approved vocabulary from the database. Read-only: this is the only database access the AI analysis has.
 * Activities, settings and brands are the values already used in the library; tags are counted from existing clips.
 */
export async function loadTaxonomy(db: BrollDb): Promise<Taxonomy> {
  const [cats, clips, brandRows] = await Promise.all([
    db.select({ id: brollCategories.id, name: brollCategories.name, parentId: brollCategories.parentId, scope: brollCategories.scope, brandScope: brollCategories.brandScope, sortOrder: brollCategories.sortOrder }).from(brollCategories),
    db.select({ activity: brollClips.activity, setting: brollClips.setting, brand: brollClips.brand, userTags: brollClips.userTags }).from(brollClips),
    db.select({ name: brollClipBrands.brandName }).from(brollClipBrands).where(isNotNull(brollClipBrands.brandName)),
  ]);

  const tagCounts = new Map<string, number>();
  for (const c of clips) {
    if (!c.userTags) continue;
    let list: unknown;
    try { list = JSON.parse(c.userTags); } catch { continue; }
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (typeof t !== 'string') continue;
      const n = t.replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim().toLowerCase();
      if (n.length >= 2 && n.length <= 40) tagCounts.set(n, (tagCounts.get(n) ?? 0) + 1);
    }
  }

  return {
    categories: withPaths(cats),
    activities: distinctByUse(clips.map((c) => c.activity)),
    settings: distinctByUse(clips.map((c) => c.setting)),
    brands: distinctByUse([...clips.map((c) => c.brand), ...brandRows.map((b) => b.name)]),
    tags: [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  };
}
