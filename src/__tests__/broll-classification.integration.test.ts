/**
 * Integration tests for the classification run. Categories are resolved by database id, so the
 * tests rename and swap category slugs and check that nothing breaks and nothing is duplicated.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { BROLL_CATEGORY_MAP, validateCategoryMap } from '@/lib/broll-category-map';
import { runClassification, validateClassificationInput, type Classification, type ClassificationOptions, type ManifestClip } from '@/lib/broll-classification';
import { addClip, createBrollTestDb, rowCount, seedMapCategories, type BrollTestDb } from './helpers/broll-test-db';

let t: BrollTestDb;

beforeAll(async () => { t = await createBrollTestDb('current'); }, 60_000);
afterAll(async () => { await t.close(); });

const STORAGE = (n: number) => `u/broll/${n}.mp4`;

const manifestClips: ManifestClip[] = [
  { clipId: 'C01', filename: 'a.mp4', title: 'Street momos', tags: ['food', 'unboxing'], subject: 'Plate of momos', activity: 'Eating', setting: 'Car' },
  { clipId: 'C02', filename: 'b.mp4', title: 'Cashback list', tags: ['cashback', 'app'], subject: 'Phone', activity: 'Scrolling', setting: 'Cafe' },
  { clipId: 'C05', filename: 'c.mp4', title: 'TV noodles', tags: ['food'], subject: 'Noodles', activity: 'Eating', setting: 'Home' },
];
const imported = {
  C01: { dbId: 1, storagePath: STORAGE(1) },
  C02: { dbId: 2, storagePath: STORAGE(2) },
  C05: { dbId: 3, storagePath: STORAGE(3) },
};

function classification(): Classification {
  return {
    newSubcategories: [
      { name: 'Rewards & cashback', slug: 'rewards-cashback', parent: 'payments-finance' },
      { name: 'At home', slug: 'food-at-home', parent: 'food-beverage' },
    ],
    hold: [{ clipId: 'C05', reason: 'Face visible on television' }],
    archive: [{ dbId: 4, title: 'Unmapped record' }],
    clips: [
      {
        clipId: 'C01', confidence: 'High',
        categories: [{ primary: 'food-beverage', subs: ['street-food', 'food-at-home'] }],
        removeTags: ['unboxing'], addTags: ['momos'], brands: [], flags: [], review: '',
      },
      {
        clipId: 'C02', confidence: 'High',
        categories: [{ primary: 'payments-finance', subs: ['rewards-cashback'] }, { primary: 'digital-products-ui', subs: [] }],
        removeTags: [], addTags: [], clientProduct: { what: 'Payments app', brandConfirmed: false },
        brands: [], flags: ['client'], review: '',
      },
    ],
  };
}

function options(overrides: Partial<ClassificationOptions> = {}): ClassificationOptions {
  return { classification: classification(), manifest: { clips: manifestClips }, imported, categoryMap: BROLL_CATEGORY_MAP, apply: true, ...overrides };
}

const linkedCategoryIds = async (clipId: number) =>
  (await t.pg.query<{ category_id: number }>('select category_id from broll_clip_categories where clip_id = $1 order by category_id', [clipId])).rows.map((r) => r.category_id);

const categorySnapshot = async () => JSON.stringify((await t.pg.query('select id, name, slug, parent_id, scope, brand_scope from broll_categories order by id')).rows);

async function resetData(slugOverrides: Record<number, string> = {}) {
  await t.reset();
  await seedMapCategories(t, slugOverrides);
  await addClip(t, { title: 'Street momos', storagePath: STORAGE(1), userTags: '["food","unboxing"]' });
  await addClip(t, { title: 'Cashback list', storagePath: STORAGE(2), userTags: '["cashback","app"]' });
  await addClip(t, { title: 'TV noodles', storagePath: STORAGE(3) });
  await addClip(t, { title: 'Unmapped record', storagePath: STORAGE(4) });
}

describe('category map', () => {
  it('is internally consistent: unique ids and every parent is a primary category in the map', () => {
    expect(validateCategoryMap(BROLL_CATEGORY_MAP)).toEqual([]);
  });

  it('covers the 12 primary categories and 41 subcategories, including the five added subcategories', () => {
    const entries = Object.values(BROLL_CATEGORY_MAP);
    expect(entries.filter((e) => e.parentId === null)).toHaveLength(12);
    expect(entries.filter((e) => e.parentId !== null)).toHaveLength(41);
    for (const key of ['rewards-cashback', 'cab-ride-hailing', 'bags-after-purchase', 'food-at-home', 'quick-commerce']) {
      expect(BROLL_CATEGORY_MAP[key]).toBeDefined();
    }
  });

  it('detects duplicate ids, missing parents and self-parents', () => {
    expect(validateCategoryMap({ a: { id: 1, parentId: null }, b: { id: 1, parentId: null } })).not.toEqual([]);
    expect(validateCategoryMap({ a: { id: 1, parentId: 9 } })).not.toEqual([]);
    expect(validateCategoryMap({ a: { id: 1, parentId: 1 } })).not.toEqual([]);
    expect(validateCategoryMap({ a: { id: 1, parentId: null }, b: { id: 2, parentId: 1 }, c: { id: 3, parentId: 2 } })).not.toEqual([]);
  });
});

describe('classification run', () => {
  beforeEach(async () => { await resetData(); });

  it('resolves categories by id even though every name and slug has been edited', async () => {
    const run = await runClassification(t.db, options());
    const id = (key: string) => BROLL_CATEGORY_MAP[key].id;
    // A primary with subcategories is linked through its subcategories; a primary with none is linked directly.
    expect(await linkedCategoryIds(1)).toEqual([id('street-food'), id('food-at-home')].sort((a, b) => a - b));
    expect(await linkedCategoryIds(2)).toEqual([id('rewards-cashback'), id('digital-products-ui')].sort((a, b) => a - b));
    for (const c of run.categories) expect(c.slug).toBe(`edited-${c.id}`);
  });

  it('is not fooled by slugs that now belong to a different category', async () => {
    // Swap the slugs the old script looked up between two categories.
    const food = BROLL_CATEGORY_MAP['food-beverage'].id;
    const shopping = BROLL_CATEGORY_MAP['shopping-retail'].id;
    await resetData({ [food]: 'shopping-retail', [shopping]: 'food-beverage' });
    await runClassification(t.db, options());
    expect(await linkedCategoryIds(1)).toEqual([BROLL_CATEGORY_MAP['street-food'].id, BROLL_CATEGORY_MAP['food-at-home'].id].sort((a, b) => a - b));
    const parents = (await t.pg.query<{ parent_id: number }>('select c.parent_id from broll_clip_categories l join broll_categories c on c.id = l.category_id where l.clip_id = 1')).rows;
    expect(parents.every((p) => p.parent_id === food && p.parent_id !== shopping)).toBe(true);
  });

  it('never creates, renames or reparents a category', async () => {
    const before = await categorySnapshot();
    const count = await rowCount(t, 'broll_categories');
    await runClassification(t.db, options());
    await runClassification(t.db, options());
    expect(await categorySnapshot()).toBe(before);
    expect(await rowCount(t, 'broll_categories')).toBe(count);
  });

  it('keeps every parent-child relationship intact', async () => {
    await runClassification(t.db, options());
    const rows = (await t.pg.query<{ id: number; parent_id: number | null }>('select id, parent_id from broll_categories')).rows;
    for (const { id, parent_id } of rows) {
      const entry = Object.values(BROLL_CATEGORY_MAP).find((e) => e.id === id)!;
      expect(parent_id).toBe(entry.parentId);
    }
  });

  it('writes nothing on a dry run but reports the ids and categories it would change', async () => {
    const lines: string[] = [];
    const run = await runClassification(t.db, options({ apply: false, log: (l) => lines.push(l) }));
    expect(await rowCount(t, 'broll_clip_categories')).toBe(0);
    const [r1] = (await t.pg.query<{ review_status: string }>('select review_status from broll_clips where id = 3')).rows;
    expect(r1.review_status).toBe('unreviewed');
    expect(lines[0]).toContain('DRY RUN');
    expect(run.plan.find((p) => p.clipId === 'C01')!.linksToCreate.map((l) => l.id)).toEqual([
      BROLL_CATEGORY_MAP['street-food'].id, BROLL_CATEGORY_MAP['food-at-home'].id,
    ]);
    const text = lines.join('\n');
    expect(text).toContain(`#${BROLL_CATEGORY_MAP['street-food'].id}`);
    expect(text).toContain('Edited street-food');
    expect(text).toContain('row 1');
  });

  it('is idempotent: a second run changes and creates nothing', async () => {
    const first = await runClassification(t.db, options());
    const links = await rowCount(t, 'broll_clip_categories');
    const fingerprint = JSON.stringify((await t.pg.query('select id, user_tags, ai_tags, notes, review_status from broll_clips order by id')).rows);
    expect(first.counts.linksCreated).toBe(4);

    const second = await runClassification(t.db, options());
    expect(second.counts).toMatchObject({ clipsUpdated: 0, clipsUnchanged: 2, linksCreated: 0, hidden: 0 });
    expect(await rowCount(t, 'broll_clip_categories')).toBe(links);
    expect(JSON.stringify((await t.pg.query('select id, user_tags, ai_tags, notes, review_status from broll_clips order by id')).rows)).toBe(fingerprint);
  });

  it('removes the unsupported tag and keeps the supported ones', async () => {
    await runClassification(t.db, options());
    const r = await t.pg.query<{ user_tags: string }>('select user_tags from broll_clips where id = 1');
    expect(JSON.parse(r.rows[0].user_tags)).toEqual(['food', 'momos']);
  });

  it('holds C05 and archives the unmapped record without touching their storage paths', async () => {
    await runClassification(t.db, options());
    const r = await t.pg.query<{ id: number; review_status: string; storage_path: string }>('select id, review_status, storage_path from broll_clips where id in (3, 4) order by id');
    expect(r.rows).toEqual([
      { id: 3, review_status: 'on_hold', storage_path: STORAGE(3) },
      { id: 4, review_status: 'archived', storage_path: STORAGE(4) },
    ]);
  });
});

describe('classification fails safely', () => {
  beforeEach(async () => { await resetData(); });

  async function expectNoWrites() {
    expect(await rowCount(t, 'broll_clip_categories')).toBe(0);
    const r = await t.pg.query<{ n: number }>(`select count(*)::int as n from broll_clips where notes is not null or review_status <> 'unreviewed'`);
    expect(r.rows[0].n).toBe(0);
    expect(await rowCount(t, 'broll_categories')).toBe(Object.keys(BROLL_CATEGORY_MAP).length);
  }

  it('stops when a category has no entry in the map', async () => {
    const c = classification();
    c.clips[0].categories[0].subs.push('brand-new-subcategory');
    await expect(runClassification(t.db, options({ classification: c }))).rejects.toThrow(/no category mapping for 'brand-new-subcategory'/);
    await expectNoWrites();
  });

  it('stops when a mapped category id no longer exists, without creating a replacement', async () => {
    await t.pg.query('delete from broll_categories where id = $1', [BROLL_CATEGORY_MAP['food-at-home'].id]);
    const countBefore = await rowCount(t, 'broll_categories');
    await expect(runClassification(t.db, options())).rejects.toThrow(new RegExp(`id ${BROLL_CATEGORY_MAP['food-at-home'].id}.*not found`));
    expect(await rowCount(t, 'broll_clip_categories')).toBe(0);
    expect(await rowCount(t, 'broll_categories')).toBe(countBefore);
  });

  it('stops when a subcategory has been moved under a different parent', async () => {
    await t.pg.query('update broll_categories set parent_id = $1 where id = $2', [BROLL_CATEGORY_MAP['shopping-retail'].id, BROLL_CATEGORY_MAP['street-food'].id]);
    await expect(runClassification(t.db, options())).rejects.toThrow(/has parent/);
    await expectNoWrites();
  });

  it('stops when a mapped category has become brand-scoped', async () => {
    await t.pg.query(`update broll_categories set scope = 'brand', brand_scope = 'subway' where id = $1`, [BROLL_CATEGORY_MAP['street-food'].id]);
    await expect(runClassification(t.db, options())).rejects.toThrow(/not a Soma-wide category/);
    await expectNoWrites();
  });

  it('stops before any database work when a subcategory is listed under the wrong primary', async () => {
    const c = classification();
    c.clips[0].categories = [{ primary: 'payments-finance', subs: ['street-food'] }];
    await expect(runClassification(t.db, options({ classification: c }))).rejects.toThrow(/does not belong under 'payments-finance'/);
    await expectNoWrites();
  });

  it('refuses to classify C05, C10, C17 or C22', async () => {
    for (const clipId of ['C05', 'C10', 'C17', 'C22']) {
      const c = classification();
      c.clips[0].clipId = clipId;
      expect(validateClassificationInput(options({ classification: c })).some((e) => e.includes(`${clipId} must not be classified`))).toBe(true);
    }
    const c = classification();
    c.clips[0].clipId = 'C05';
    await expect(runClassification(t.db, options({ classification: c }))).rejects.toThrow(/must not be classified/);
    await expectNoWrites();
  });

  it('stops when a clip row does not match its recorded storage path or title', async () => {
    await expect(runClassification(t.db, options({ imported: { ...imported, C01: { dbId: 1, storagePath: 'someone/else.mp4' } } }))).rejects.toThrow(/storagePath mismatch/);
    await t.pg.query(`update broll_clips set title = 'Renamed' where id = 2`);
    await expect(runClassification(t.db, options())).rejects.toThrow(/title mismatch/);
    await t.pg.query(`update broll_clips set title = 'Cashback list' where id = 2`);
    await expectNoWrites();
  });

  it('refuses to archive a mapped sample clip', async () => {
    const c = classification();
    c.archive = [{ dbId: 1, title: 'Street momos' }];
    await expect(runClassification(t.db, options({ classification: c }))).rejects.toThrow(/must not be archived/);
    expect((await t.pg.query('select 1 from broll_clips where id = 1 and review_status = $1', ['archived'])).rows).toHaveLength(0);
  });
});

describe('local classification data', () => {
  const file = path.resolve(__dirname, '../../broll-import/classification.json');
  const exists = fs.existsSync(file);

  // broll-import/ is git-ignored, so this only runs where the reviewed data is present.
  it.runIf(exists)('resolves every category in the reviewed classification through the map', () => {
    const real = JSON.parse(fs.readFileSync(file, 'utf8')) as Classification;
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../broll-import/manifest.json'), 'utf8')) as { clips: ManifestClip[] };
    const log = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../broll-import/imported.json'), 'utf8')) as ClassificationOptions['imported'];
    expect(real.clips).toHaveLength(28);
    expect(validateClassificationInput({ classification: real, manifest, imported: log, categoryMap: BROLL_CATEGORY_MAP })).toEqual([]);
  });
});
