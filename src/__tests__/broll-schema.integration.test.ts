/**
 * Checks that the Drizzle definitions in src/db/schema.pg.ts agree with the database the
 * repository's migrations actually build, for the B-roll tables.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { brollCategories, brollClipBrands, brollClipCategories, brollClips } from '@/db/schema.pg';
import { createBrollTestDb, type BrollTestDb } from './helpers/broll-test-db';

let t: BrollTestDb;
beforeAll(async () => { t = await createBrollTestDb('current'); }, 60_000);
afterAll(async () => { await t.close(); });

interface DbColumn { column_name: string; data_type: string; is_nullable: string; column_default: string | null }

const dbColumns = async (table: string) =>
  new Map((await t.pg.query<DbColumn>(
    `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = $1`, [table],
  )).rows.map((r) => [r.column_name, r]));

// serial is an integer column with a sequence default
const sqlType = (drizzleType: string) => (drizzleType === 'serial' ? 'integer' : drizzleType);

const TABLES: [string, PgTable][] = [
  ['broll_clips', brollClips],
  ['broll_clip_brands', brollClipBrands],
  ['broll_categories', brollCategories],
  ['broll_clip_categories', brollClipCategories],
];

describe.each(TABLES)('Drizzle schema for %s', (name, table) => {
  it('has exactly the columns the database has', async () => {
    const config = getTableConfig(table);
    expect(config.name).toBe(name);
    const db = await dbColumns(name);
    expect(config.columns.map((c) => c.name).sort()).toEqual([...db.keys()].sort());
  });

  it('agrees on column types and nullability', async () => {
    const db = await dbColumns(name);
    for (const col of getTableConfig(table).columns) {
      const actual = db.get(col.name)!;
      expect(actual.data_type, `${name}.${col.name} type`).toBe(sqlType(col.getSQLType()));
      expect(actual.is_nullable === 'NO', `${name}.${col.name} not null`).toBe(col.notNull);
    }
  });
});

describe('the new clearance structures', () => {
  it('declares broll_clips.clearance_status as non-null text defaulting to unresolved', async () => {
    const col = getTableConfig(brollClips).columns.find((c) => c.name === 'clearance_status')!;
    expect(col.getSQLType()).toBe('text');
    expect(col.notNull).toBe(true);
    expect(col.default).toBe('unresolved');
    const db = (await dbColumns('broll_clips')).get('clearance_status')!;
    expect(db.column_default).toContain('unresolved');
  });

  it('declares every broll_clip_brands column with the default the migration sets', async () => {
    const config = getTableConfig(brollClipBrands);
    const byName = new Map(config.columns.map((c) => [c.name, c]));
    expect(byName.get('clearance_status')!.default).toBe('unresolved');
    expect(byName.get('brand_name')!.notNull).toBe(false);
    expect(byName.get('note')!.notNull).toBe(false);
    for (const required of ['clip_id', 'role', 'clearance_status', 'created_at', 'updated_at']) expect(byName.get(required)!.notNull).toBe(true);
    const db = await dbColumns('broll_clip_brands');
    for (const col of config.columns) {
      expect(db.get(col.name)!.column_default !== null, `${col.name} default`).toBe(col.hasDefault);
    }
  });

  it('declares the clip foreign key with cascade delete, as the migration does', async () => {
    const [fk] = getTableConfig(brollClipBrands).foreignKeys;
    expect(fk.onDelete).toBe('cascade');
    const ref = fk.reference();
    expect(getTableConfig(ref.foreignTable).name).toBe('broll_clips');
    expect(ref.columns.map((c) => c.name)).toEqual(['clip_id']);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(['id']);
    const db = await t.pg.query<{ confdeltype: string; foreign_table: string }>(
      `select confdeltype, confrelid::regclass::text as foreign_table from pg_constraint where conrelid = 'broll_clip_brands'::regclass and contype = 'f'`,
    );
    expect(db.rows).toEqual([{ confdeltype: 'c', foreign_table: 'broll_clips' }]);
  });
});
