import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema.pg';
import { BROLL_CATEGORY_MAP } from '@/lib/broll-category-map';

// A disposable in-memory Postgres (PGlite) built from the repository's real migration files.
// It never touches a real database.

const ROOT = path.resolve(__dirname, '../../..');

export const MIGRATION_0022 = 'drizzle/pg/0022_broll_clearance_and_brands.sql';
export const TEST_USER_ID = '00000000-0000-4000-8000-0000000000b1';
export const ADMIN_USER_ID = '00000000-0000-4000-8000-0000000000a1';

export interface BrollTestDb {
  pg: PGlite;
  db: PgliteDatabase<typeof schema>;
  runFile(file: string): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

// 'before-0022' stops before the clearance and brand migration so it can be applied to existing data.
export async function createBrollTestDb(stage: 'before-0022' | 'current'): Promise<BrollTestDb> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  const runFile = async (file: string) => { await pg.exec(fs.readFileSync(path.join(ROOT, file), 'utf8')); };

  // Supabase provides auth.uid(); the migrations' row level security policy refers to it.
  await pg.exec(`create schema auth; create function auth.uid() returns uuid language sql as 'select null::uuid';`);
  for (const file of [
    'drizzle/pg/0016_admin_users.sql',
    'drizzle/pg/0020_broll_clips.sql',
    'drizzle/pg/0021_broll_clips_v2.sql',
    'drizzle/0009_broll_categories.sql',
  ]) {
    await runFile(file);
  }
  // Migration 0009 seeds the taxonomy with arbitrary ids; tests seed their own.
  await pg.exec('truncate broll_clip_categories, broll_categories restart identity cascade');
  if (stage === 'current') await runFile(MIGRATION_0022);

  return {
    pg,
    db,
    runFile,
    reset: async () => { await pg.exec('truncate broll_clip_categories, broll_categories, broll_clips, admin_users restart identity cascade'); },
    close: async () => { await pg.close(); },
  };
}

export interface CategorySeed { id: number; name: string; slug: string; parentId: number | null; scope?: string; brandScope?: string | null }

export async function seedCategories(t: BrollTestDb, rows: CategorySeed[]): Promise<void> {
  const now = Date.now();
  await t.db.insert(schema.brollCategories).values(rows.map((r, i) => ({
    id: r.id, name: r.name, slug: r.slug, parentId: r.parentId, scope: r.scope ?? 'soma', brandScope: r.brandScope ?? null,
    sortOrder: i, createdAt: now, updatedAt: now,
  })));
  await t.pg.exec(`select setval('broll_categories_id_seq', (select max(id) from broll_categories))`);
}

// Seeds every category in the production id map, with names and slugs that no longer match the
// keys the classification uses, as happens when categories are edited in the app.
export async function seedMapCategories(t: BrollTestDb, slugOverrides: Record<number, string> = {}): Promise<void> {
  await seedCategories(t, Object.entries(BROLL_CATEGORY_MAP).map(([key, entry]) => ({
    id: entry.id,
    name: `Edited ${key}`,
    slug: slugOverrides[entry.id] ?? `edited-${entry.id}`,
    parentId: entry.parentId,
  })));
}

export async function addClip(t: BrollTestDb, clip: Partial<typeof schema.brollClips.$inferInsert> & { title: string }): Promise<number> {
  const now = Date.now();
  const [row] = await t.db.insert(schema.brollClips).values({
    userId: TEST_USER_ID,
    storagePath: `${TEST_USER_ID}/broll/${clip.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mp4`,
    signedUrl: 'https://example.test/clip.mp4',
    signedUrlExpiresAt: now + 7 * 24 * 3_600_000,
    processingStatus: 'completed',
    reviewStatus: 'unreviewed',
    createdAt: now,
    updatedAt: now,
    ...clip,
  }).returning({ id: schema.brollClips.id });
  return row.id;
}

// Inserts a clip with only the columns that exist before migration 0022.
export async function addLegacyClip(t: BrollTestDb, clip: {
  id: number; title: string; storagePath: string; reviewStatus?: string; notes?: string | null; brand?: string | null; userTags?: string | null;
}): Promise<void> {
  const now = Date.now();
  await t.pg.query(
    `insert into broll_clips (id, user_id, title, storage_path, processing_status, review_status, notes, brand, user_tags, created_at, updated_at)
     values ($1, $2, $3, $4, 'completed', $5, $6, $7, $8, $9, $9)`,
    [clip.id, TEST_USER_ID, clip.title, clip.storagePath, clip.reviewStatus ?? 'unreviewed', clip.notes ?? null, clip.brand ?? null, clip.userTags ?? null, now],
  );
}

export async function categorize(t: BrollTestDb, clipId: number, categoryId: number): Promise<void> {
  await t.db.insert(schema.brollClipCategories).values({ clipId, categoryId, createdAt: Date.now() });
}

export async function addAdmin(t: BrollTestDb, userId: string): Promise<void> {
  await t.db.insert(schema.adminUsers).values({ userId, email: 'admin@example.test', addedAt: Date.now() });
}

// A fingerprint of the fields that must survive migrations and backfills untouched.
export async function clipFingerprint(t: BrollTestDb): Promise<string> {
  const r = await t.pg.query(
    `select id, title, storage_path, notes, user_tags, ai_tags, brand, review_status, subject, activity, setting from broll_clips order by id`,
  );
  return crypto.createHash('md5').update(JSON.stringify(r.rows)).digest('hex');
}

export async function rowCount(t: BrollTestDb, table: string): Promise<number> {
  const r = await t.pg.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return r.rows[0].n;
}

// True when the statement is rejected by the database (constraint violation or similar).
export async function isRejected(t: BrollTestDb, statement: string, params: unknown[] = []): Promise<boolean> {
  try {
    await t.pg.query(statement, params);
    return false;
  } catch {
    return true;
  }
}
