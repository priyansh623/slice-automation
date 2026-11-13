/**
 * The storage location registry against a real in-memory Postgres, using the actual migration file (0023).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema.pg';

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/db', () => ({
  db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }),
}));

import { locate, registerObject, registerObjectIfAbsent, registeredRows, clearLocationCache } from '@/lib/object-store/registry';

const MIGRATION = fs.readFileSync(path.resolve(__dirname, '../../drizzle/pg/0023_storage_objects.sql'), 'utf8');
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  holder.db = drizzle(pg, { schema });
  await pg.exec(MIGRATION);
}, 60_000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => { await pg.exec('truncate storage_objects'); clearLocationCache(); });

describe('migration 0023', () => {
  it('can be applied twice and only adds the registry table', async () => {
    await pg.exec(MIGRATION);
    const tables = (await pg.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema='public' order by 1`)).rows.map((r) => r.table_name);
    expect(tables).toEqual(['storage_objects']);
  });

  it('refuses an unknown provider', async () => {
    await expect(pg.query(`insert into storage_objects (bucket, key, provider, created_at, updated_at) values ('videos','k','s3',1,1)`)).rejects.toThrow();
  });
});

describe('locate and registerObject', () => {
  it('says Supabase for every file that has no row', async () => {
    const m = await locate('videos', ['a.mp4', 'b.mp4']);
    expect([...m.values()]).toEqual(['supabase', 'supabase']);
  });

  it('records a file as being on R2, and a rollback sets it back', async () => {
    await registerObject({ bucket: 'videos', key: 'a.mp4', provider: 'r2', sizeBytes: 10, contentType: 'video/mp4', sha256: 'ab'.repeat(32), verifiedAt: 5 });
    expect((await locate('videos', ['a.mp4'])).get('a.mp4')).toBe('r2');
    const row = (await pg.query<{ size_bytes: string; sha256: string }>(`select size_bytes, sha256 from storage_objects where key='a.mp4'`)).rows[0];
    expect(Number(row.size_bytes)).toBe(10);
    expect(row.sha256).toBe('ab'.repeat(32));

    await registerObject({ bucket: 'videos', key: 'a.mp4', provider: 'supabase' });
    expect((await locate('videos', ['a.mp4'])).get('a.mp4')).toBe('supabase');
    expect((await pg.query(`select 1 from storage_objects where key='a.mp4'`)).rows).toHaveLength(1); // one row, updated in place
  });

  it('keeps the same key in the two buckets apart', async () => {
    await registerObject({ bucket: 'videos', key: 'same.bin', provider: 'r2' });
    expect((await locate('uploads', ['same.bin'])).get('same.bin')).toBe('supabase');
    expect((await locate('videos', ['same.bin'])).get('same.bin')).toBe('r2');
  });

  it('answers a batch in one query and reuses the cache', async () => {
    await registerObject({ bucket: 'uploads', key: 'x', provider: 'r2' });
    clearLocationCache();
    const spy = vi.spyOn(holder.db as { select: (...a: unknown[]) => unknown }, 'select');
    const first = await locate('uploads', ['x', 'y', 'z']);
    await locate('uploads', ['x', 'y', 'z']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect([...first.entries()]).toEqual([['x', 'r2'], ['y', 'supabase'], ['z', 'supabase']]);
    spy.mockRestore();
  });
});

describe('when the registry cannot be read', () => {
  it('treats every file as Supabase instead of failing (missing table here)', async () => {
    const real = holder.db;
    const empty = new PGlite();
    holder.db = drizzle(empty, { schema }); // no storage_objects table
    clearLocationCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await locate('videos', ['a.mp4'])).get('a.mp4')).toBe('supabase');
    } finally {
      warn.mockRestore();
      holder.db = real;
      await empty.close();
    }
  });
});

describe('insert-only registration used by the copy tool', () => {
  it('stores exactly the bucket, key, provider and metadata it is given', async () => {
    await registerObjectIfAbsent({ bucket: 'uploads', key: 'user-1/clip.mp4', provider: 'r2', sizeBytes: 1234, contentType: 'video/mp4', sha256: 'ab'.repeat(32), verifiedAt: 42 });
    const row = (await pg.query<Record<string, unknown>>(`select bucket, key, provider, size_bytes, content_type, sha256, verified_at from storage_objects`)).rows;
    expect(row).toHaveLength(1);
    expect({ ...row[0], size_bytes: Number(row[0].size_bytes), verified_at: Number(row[0].verified_at) }).toEqual({
      bucket: 'uploads', key: 'user-1/clip.mp4', provider: 'r2', size_bytes: 1234, content_type: 'video/mp4', sha256: 'ab'.repeat(32), verified_at: 42,
    });
  });

  it('inserts a new row once and never changes an existing one', async () => {
    expect(await registerObjectIfAbsent({ bucket: 'videos', key: 'a.mp4', provider: 'r2', sizeBytes: 5, sha256: 'aa', verifiedAt: 1 })).toBe(true);
    expect(await registerObjectIfAbsent({ bucket: 'videos', key: 'a.mp4', provider: 'r2', sizeBytes: 999, sha256: 'bb', verifiedAt: 2 })).toBe(false);
    const row = (await pg.query<{ size_bytes: string; sha256: string }>(`select size_bytes, sha256 from storage_objects where key='a.mp4'`)).rows[0];
    expect({ size: Number(row.size_bytes), sha256: row.sha256 }).toEqual({ size: 5, sha256: 'aa' });
  });

  it('leaves a row that says supabase exactly as it is', async () => {
    await registerObject({ bucket: 'videos', key: 'b.mp4', provider: 'supabase' });
    expect(await registerObjectIfAbsent({ bucket: 'videos', key: 'b.mp4', provider: 'r2' })).toBe(false);
    expect((await pg.query<{ provider: string }>(`select provider from storage_objects where key='b.mp4'`)).rows[0].provider).toBe('supabase');
  });

  it('registeredRows returns exact rows with their checksum, and throws when the registry is unreadable', async () => {
    await registerObject({ bucket: 'videos', key: 'c.mp4', provider: 'r2', sizeBytes: 7, sha256: 'cd'.repeat(32) });
    await registerObject({ bucket: 'videos', key: 'old.mp4', provider: 'r2' });
    const m = await registeredRows('videos', ['c.mp4', 'old.mp4', 'missing.mp4']);
    expect([...m]).toEqual([['c.mp4', { provider: 'r2', sha256: 'cd'.repeat(32), sizeBytes: 7 }], ['old.mp4', { provider: 'r2', sha256: null, sizeBytes: null }]]);
    await pg.exec('alter table storage_objects rename to storage_objects_gone');
    try { await expect(registeredRows('videos', ['c.mp4'])).rejects.toThrow(); }
    finally { await pg.exec('alter table storage_objects_gone rename to storage_objects'); }
  });
});
