/**
 * Integration tests for migration 0022 and structured brand associations, run against an
 * in-memory Postgres built from the repository's migration files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { backfillBrands } from '@/lib/broll-brand-backfill';
import { BROLL_BRAND_ROLES } from '@/lib/broll-brands';
import {
  addClip, addLegacyClip, clipFingerprint, createBrollTestDb, isRejected, MIGRATION_0022, rowCount, type BrollTestDb,
} from './helpers/broll-test-db';

const INSERT_BRAND = `insert into broll_clip_brands (clip_id, brand_name, role, note, created_at, updated_at) values ($1, $2, $3, $4, 1, 1)`;

// Notes as the classification script wrote them, including the five observations whose role was left unresolved.
const NOTES = {
  subway: JSON.stringify({ schema: 'broll-classification/v1', clipId: 'C01', clearance: 'unresolved', clientProduct: null, flags: ['brand'], review: '',
    brands: [{ name: 'Subway', role: 'hero', clearance: 'unresolved' }, { name: 'Hyundai', role: 'incidental', clearance: 'unresolved' }] }),
  blinkitDisney: JSON.stringify({ schema: 'broll-classification/v1', clipId: 'C09', clearance: 'unresolved', clientProduct: null,
    brands: [{ name: 'Blinkit', role: 'hero', clearance: 'unresolved' }, { name: 'Disney', role: 'unresolved', clearance: 'unresolved', note: 'Character print on the hero bag.' }] }),
  tape: JSON.stringify({ schema: 'broll-classification/v1', clipId: 'C23', clearance: 'unresolved', clientProduct: null,
    brands: [{ name: 'Printed tape reading "PLAY"', role: 'unresolved', clearance: 'unresolved', note: 'Not an identifiable brand.' }] }),
  snack: JSON.stringify({ schema: 'broll-classification/v1', clipId: 'C27', clearance: 'unresolved', clientProduct: null,
    brands: [{ name: 'Snack packet, brand not legible', role: 'unresolved', clearance: 'unresolved' }] }),
  football: JSON.stringify({ schema: 'broll-classification/v1', clipId: 'C28', clearance: 'unresolved', clientProduct: null,
    brands: [{ name: 'PlayStation', role: 'hero', clearance: 'unresolved' }, { name: 'Football video game, title not identified', role: 'unresolved', clearance: 'unresolved' }] }),
  cardAndCup: JSON.stringify({ schema: 'broll-classification/v1', clipId: 'C31', clearance: 'unresolved',
    clientProduct: { what: 'Red card reading "super slicer"', brandConfirmed: false },
    brands: [{ name: 'Cup branding, partly legible', role: 'unresolved', clearance: 'unresolved' }] }),
  none: JSON.stringify({ schema: 'broll-classification/v1', clipId: 'C03', clearance: 'not_assessed', clientProduct: null, brands: [] }),
};

const LEGACY_CLIPS = [
  { id: 1, title: 'Subway clip', storagePath: 'u/broll/1.mp4', notes: NOTES.subway, brand: 'Subway', userTags: '["food","takeaway"]' },
  { id: 2, title: 'Blinkit bag', storagePath: 'u/broll/2.mp4', notes: NOTES.blinkitDisney, brand: 'Blinkit', userTags: '["delivery"]' },
  { id: 3, title: 'Tape parcel', storagePath: 'u/broll/3.mp4', notes: NOTES.tape },
  { id: 4, title: 'Snack bowl', storagePath: 'u/broll/4.mp4', notes: NOTES.snack },
  { id: 5, title: 'Football', storagePath: 'u/broll/5.mp4', notes: NOTES.football, brand: 'PlayStation' },
  { id: 6, title: 'Card and cups', storagePath: 'u/broll/6.mp4', notes: NOTES.cardAndCup },
  { id: 7, title: 'No brands', storagePath: 'u/broll/7.mp4', notes: NOTES.none, reviewStatus: 'on_hold' },
  { id: 8, title: 'Archived, no notes', storagePath: 'u/broll/8.mp4', reviewStatus: 'archived', brand: 'dominos' },
];

describe('migration 0022 on existing data', () => {
  let t: BrollTestDb;
  let before: string;
  let after: string;

  beforeAll(async () => {
    t = await createBrollTestDb('before-0022');
    for (const clip of LEGACY_CLIPS) await addLegacyClip(t, clip);
    before = await clipFingerprint(t);
    await t.runFile(MIGRATION_0022);
    after = await clipFingerprint(t);
  }, 60_000);

  afterAll(async () => { await t.close(); });

  it('applies successfully on top of the earlier migrations', async () => {
    expect(await rowCount(t, 'broll_clip_brands')).toBe(0);
    expect(await rowCount(t, 'broll_clips')).toBe(LEGACY_CLIPS.length);
  });

  it('can be replayed without error and without changing anything', async () => {
    await expect(t.runFile(MIGRATION_0022)).resolves.not.toThrow();
    expect(await clipFingerprint(t)).toBe(before);
    expect(await rowCount(t, 'broll_clip_brands')).toBe(0);
  });

  it('leaves notes, tags, brand, review status and storage paths exactly as they were', () => {
    expect(after).toBe(before);
  });

  it('leaves review status exactly as it was', async () => {
    const r = await t.pg.query<{ review_status: string; n: number }>('select review_status, count(*)::int as n from broll_clips group by 1 order by 1');
    expect(r.rows).toEqual([{ review_status: 'archived', n: 1 }, { review_status: 'on_hold', n: 1 }, { review_status: 'unreviewed', n: 6 }]);
  });

  it('creates the expected constraints and indexes', async () => {
    const constraints = (await t.pg.query<{ conname: string }>(`select conname from pg_constraint where conrelid in ('broll_clips'::regclass, 'broll_clip_brands'::regclass) and contype in ('c', 'f') and conname like 'broll_%' order by conname`)).rows.map((r) => r.conname);
    expect(constraints).toEqual(expect.arrayContaining([
      'broll_clip_brands_role_check',
      'broll_clip_brands_name_required_check',
      'broll_clip_brands_name_not_blank_check',
      'broll_clip_brands_unnamed_needs_note_check',
    ]));
    const indexes = (await t.pg.query<{ indexname: string }>(`select indexname from pg_indexes where tablename = 'broll_clip_brands' order by indexname`)).rows.map((r) => r.indexname);
    expect(indexes).toEqual(['broll_clip_brands_brand_name_idx', 'broll_clip_brands_clip_id_idx', 'broll_clip_brands_pkey', 'broll_clip_brands_unique_key']);
  });

  it('enables row level security on the new table with no policy, and leaves the clips table policy alone', async () => {
    const rls = await t.pg.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where oid = 'broll_clip_brands'::regclass`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const policies = await t.pg.query<{ tablename: string; policyname: string }>(`select tablename, policyname from pg_policies where tablename in ('broll_clip_brands', 'broll_clips')`);
    expect(policies.rows).toEqual([{ tablename: 'broll_clips', policyname: 'Users manage their own broll clips' }]);
  });

  it('adds only a column and a table: no existing column, table or row is dropped or rewritten', async () => {
    const cols = (await t.pg.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'broll_clips'`)).rows.map((r) => r.column_name);
    expect(cols).toContain('clearance_status'); // legacy: kept in the database, unused by the application
    for (const existing of ['id', 'title', 'storage_path', 'notes', 'user_tags', 'ai_tags', 'brand', 'review_status', 'subject', 'activity', 'setting', 'description']) expect(cols).toContain(existing);
    expect(await rowCount(t, 'broll_clips')).toBe(LEGACY_CLIPS.length);
  });

  it('accepts exactly the roles that the TypeScript union allows', async () => {
    // The fixture clips use explicit ids, so give this one an unused id.
    const clip = await addClip(t, { id: 99, title: 'Union check' });
    for (const role of BROLL_BRAND_ROLES) {
      expect(await isRejected(t, INSERT_BRAND, [clip, `Brand ${role}`, role, null])).toBe(false);
    }
    expect(await isRejected(t, INSERT_BRAND, [clip, 'Other', 'not_a_role', null])).toBe(true);
  });

  it('lets the backfill dry run read existing notes before the migration has been applied', async () => {
    const pre = await createBrollTestDb('before-0022');
    try {
      for (const clip of LEGACY_CLIPS) await addLegacyClip(pre, clip);
      const result = await backfillBrands(pre.db, false);
      expect(result.planned).toBe(10);
      expect(result.inserted).toBe(0);
    } finally {
      await pre.close();
    }
  });
});

describe('brand associations', () => {
  let t: BrollTestDb;
  let clipId: number;

  beforeAll(async () => {
    t = await createBrollTestDb('current');
    clipId = await addClip(t, { title: 'Clip' });
  }, 60_000);

  afterAll(async () => { await t.close(); });

  it('supports several brands on one clip without overwriting each other', async () => {
    await t.pg.query(INSERT_BRAND, [clipId, 'Subway', 'hero', null]);
    await t.pg.query(INSERT_BRAND, [clipId, 'Hyundai', 'incidental', null]);
    await t.pg.query(INSERT_BRAND, [clipId, 'Disney', 'unresolved', 'Character print']);
    const r = await t.pg.query<{ brand_name: string; role: string }>('select brand_name, role from broll_clip_brands where clip_id = $1 order by id', [clipId]);
    expect(r.rows).toEqual([
      { brand_name: 'Subway', role: 'hero' },
      { brand_name: 'Hyundai', role: 'incidental' },
      { brand_name: 'Disney', role: 'unresolved' },
    ]);
  });

  it('supports all four roles', async () => {
    const other = await addClip(t, { title: 'Roles' });
    await t.pg.query(INSERT_BRAND, [other, 'A', 'hero', null]);
    await t.pg.query(INSERT_BRAND, [other, 'B', 'incidental', null]);
    await t.pg.query(INSERT_BRAND, [other, null, 'client_product', 'Payments app']);
    await t.pg.query(INSERT_BRAND, [other, 'C', 'unresolved', null]);
    const r = await t.pg.query<{ role: string }>('select role from broll_clip_brands where clip_id = $1 order by role', [other]);
    expect(r.rows.map((x) => x.role)).toEqual(['client_product', 'hero', 'incidental', 'unresolved']);
  });

  it('rejects a role outside the four', async () => {
    expect(await isRejected(t, INSERT_BRAND, [clipId, 'X', 'sponsor', null])).toBe(true);
  });

  it('prevents the same brand twice in the same role on a clip, whatever the case', async () => {
    expect(await isRejected(t, INSERT_BRAND, [clipId, 'SUBWAY', 'hero', null])).toBe(true);
  });

  it('allows the same brand in a different role', async () => {
    expect(await isRejected(t, INSERT_BRAND, [clipId, 'Subway', 'incidental', null])).toBe(false);
  });

  it('prevents the same unnamed observation twice but allows different ones', async () => {
    const other = await addClip(t, { title: 'Observations' });
    await t.pg.query(INSERT_BRAND, [other, null, 'unresolved', 'Cup branding, partly legible']);
    expect(await isRejected(t, INSERT_BRAND, [other, null, 'unresolved', 'CUP BRANDING, PARTLY LEGIBLE'])).toBe(true);
    expect(await isRejected(t, INSERT_BRAND, [other, null, 'unresolved', 'Snack packet, brand not legible'])).toBe(false);
  });

  it('does not invent brands: an unknown identity stays null and needs a note', async () => {
    const other = await addClip(t, { title: 'Unknown identity' });
    expect(await isRejected(t, INSERT_BRAND, [other, null, 'hero', 'a note'])).toBe(true);
    expect(await isRejected(t, INSERT_BRAND, [other, null, 'incidental', 'a note'])).toBe(true);
    expect(await isRejected(t, INSERT_BRAND, [other, null, 'unresolved', null])).toBe(true);
    expect(await isRejected(t, INSERT_BRAND, [other, null, 'unresolved', '   '])).toBe(true);
    expect(await isRejected(t, INSERT_BRAND, [other, '   ', 'unresolved', 'a note'])).toBe(true);
    expect(await isRejected(t, INSERT_BRAND, [other, null, 'unresolved', 'Football video game, title not identified'])).toBe(false);
    const r = await t.pg.query<{ brand_name: string | null }>('select brand_name from broll_clip_brands where clip_id = $1', [other]);
    expect(r.rows).toEqual([{ brand_name: null }]);
  });

  it('removes a clip\'s brand rows when the clip is deleted', async () => {
    const other = await addClip(t, { title: 'Doomed' });
    await t.pg.query(INSERT_BRAND, [other, 'Subway', 'hero', null]);
    await t.pg.query('delete from broll_clips where id = $1', [other]);
    const r = await t.pg.query('select 1 from broll_clip_brands where clip_id = $1', [other]);
    expect(r.rows).toHaveLength(0);
  });
});

describe('brand backfill', () => {
  let t: BrollTestDb;
  let beforeFingerprint: string;

  beforeAll(async () => {
    t = await createBrollTestDb('current');
    for (const clip of LEGACY_CLIPS) await addLegacyClip(t, clip);
    beforeFingerprint = await clipFingerprint(t);
  }, 60_000);

  afterAll(async () => { await t.close(); });

  it('writes nothing on a dry run', async () => {
    const result = await backfillBrands(t.db, false);
    expect(result.planned).toBe(10);
    expect(result.inserted).toBe(0);
    expect(await rowCount(t, 'broll_clip_brands')).toBe(0);
  });

  it('keeps an association that already exists instead of duplicating or overwriting it', async () => {
    await t.pg.query(INSERT_BRAND, [1, 'Subway', 'hero', 'Reviewer note']);
    const result = await backfillBrands(t.db, true);
    expect(result.alreadyPresent).toBe(1);
    const r = await t.pg.query<{ note: string }>(`select note from broll_clip_brands where clip_id = 1 and brand_name = 'Subway'`);
    expect(r.rows).toEqual([{ note: 'Reviewer note' }]);
  });

  it('copies every brand observation across: 10 associations from 6 clips', async () => {
    expect(await rowCount(t, 'broll_clip_brands')).toBe(10);
    const r = await t.pg.query<{ role: string; n: number }>('select role, count(*)::int as n from broll_clip_brands group by 1 order by 1');
    expect(r.rows).toEqual([
      { role: 'client_product', n: 1 },
      { role: 'hero', n: 3 },
      { role: 'incidental', n: 1 },
      { role: 'unresolved', n: 5 },
    ]);
  });

  it('stores the identifiable brand with an undecided role by name', async () => {
    const r = await t.pg.query(`select brand_name, role, note from broll_clip_brands where brand_name = 'Disney'`);
    expect(r.rows).toEqual([{ brand_name: 'Disney', role: 'unresolved', note: 'Character print on the hero bag.' }]);
  });

  it('stores unidentified observations without a brand name, keeping what was seen', async () => {
    const r = await t.pg.query<{ clip_id: number; note: string }>(`select clip_id, note from broll_clip_brands where role = 'unresolved' and brand_name is null order by clip_id`);
    expect(r.rows).toEqual([
      { clip_id: 3, note: 'Printed tape reading "PLAY" — Not an identifiable brand.' },
      { clip_id: 4, note: 'Snack packet, brand not legible' },
      { clip_id: 5, note: 'Football video game, title not identified' },
      { clip_id: 6, note: 'Cup branding, partly legible' },
    ]);
  });

  it('keeps the C23 "PLAY" tape as an unnamed unresolved observation, never as a brand called PLAY', async () => {
    const r = await t.pg.query(`select brand_name, role, note from broll_clip_brands where clip_id = 3`);
    expect(r.rows).toEqual([{ brand_name: null, role: 'unresolved', note: 'Printed tape reading "PLAY" — Not an identifiable brand.' }]);
    const named = await t.pg.query(`select 1 from broll_clip_brands where lower(trim(brand_name)) = 'play'`);
    expect(named.rows).toHaveLength(0);
  });

  it('records the client product without naming a brand', async () => {
    const r = await t.pg.query(`select clip_id, brand_name, role, note from broll_clip_brands where role = 'client_product'`);
    expect(r.rows).toEqual([{ clip_id: 6, brand_name: null, role: 'client_product', note: 'Red card reading "super slicer"' }]);
  });

  it('is idempotent: a second run adds nothing', async () => {
    const second = await backfillBrands(t.db, true);
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(10);
    expect(await rowCount(t, 'broll_clip_brands')).toBe(10);
  });

  it('preserves the original notes, tags, hero brand column and everything else on the clips', async () => {
    expect(await clipFingerprint(t)).toBe(beforeFingerprint);
  });

  it('reports a brand column value that has no association instead of changing it', async () => {
    const result = await backfillBrands(t.db, false);
    expect(result.heroColumnWithoutAssociation).toEqual([{ clipId: 8, brand: 'dominos' }]);
    expect(result.skipped).toEqual([]);
  });
});
