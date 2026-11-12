/**
 * Integration tests for the B-roll library API against a real (in-memory) Postgres built from the
 * repository's migrations:
 *   - GET /api/v1/broll               active library, clearance filter, brands
 *   - GET /api/v1/broll/unclassified  admin-only management view
 *   - GET /api/v1/broll/[id]          single clip
 *
 * Only the database handle and Supabase auth are replaced; route and query code is real.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { brollClipBrands } from '@/db/schema.pg';
import { addAdmin, addClip, ADMIN_USER_ID, categorize, createBrollTestDb, seedCategories, TEST_USER_ID, type BrollTestDb } from './helpers/broll-test-db';

const holder = vi.hoisted(() => ({ db: undefined as unknown, userId: null as string | null }));

vi.mock('@/db', () => ({
  db: new Proxy({}, {
    get(_target, prop) {
      const real = holder.db as Record<string | symbol, unknown>;
      const value = real[prop];
      return typeof value === 'function' ? value.bind(real) : value;
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

import { GET as listLibrary } from '@/app/api/v1/broll/route';
import { GET as listUnclassified } from '@/app/api/v1/broll/unclassified/route';
import { GET as getClip } from '@/app/api/v1/broll/[id]/route';

let t: BrollTestDb;

beforeAll(async () => {
  t = await createBrollTestDb('current');
  holder.db = t.db;
}, 60_000);

afterAll(async () => { await t.close(); });

beforeEach(async () => {
  delete process.env.ADMIN_USER_IDS;
  await t.reset();
  await seedCategories(t, [
    { id: 1, name: 'Food', slug: 'food', parentId: null },
    { id: 2, name: 'Street food', slug: 'street-food', parentId: 1 },
    { id: 3, name: 'Travel', slug: 'travel', parentId: null },
  ]);
  await addAdmin(t, ADMIN_USER_ID);
  holder.userId = TEST_USER_ID;
});

const library = (query = '') => listLibrary(new NextRequest(`http://localhost/api/v1/broll${query}`));
const unclassified = (query = '') => listUnclassified(new NextRequest(`http://localhost/api/v1/broll/unclassified${query}`));
const titles = async (res: Response) => ((await res.json()) as { title: string }[]).map((c) => c.title).sort();

async function classifiedClip(title: string, overrides: Parameters<typeof addClip>[1] extends infer T ? Partial<T> : never = {}) {
  const id = await addClip(t, { title, ...overrides });
  await categorize(t, id, 2);
  return id;
}

describe('active library visibility', () => {
  it('shows classified clips and hides unclassified ones', async () => {
    await classifiedClip('Classified');
    await addClip(t, { title: 'Unclassified' });
    expect(await titles(await library())).toEqual(['Classified']);
  });

  it('shows classified clips that are unreviewed or approved', async () => {
    await classifiedClip('Unreviewed');
    await classifiedClip('Approved', { reviewStatus: 'approved' });
    expect(await titles(await library())).toEqual(['Approved', 'Unreviewed']);
  });

  it('hides on-hold, archived and rejected clips even when they are classified', async () => {
    await classifiedClip('Visible');
    await classifiedClip('On hold', { reviewStatus: 'on_hold' });
    await classifiedClip('Archived', { reviewStatus: 'archived' });
    await classifiedClip('Rejected', { reviewStatus: 'rejected' });
    expect(await titles(await library())).toEqual(['Visible']);
  });

  it('shows a new upload only once it has a category', async () => {
    const id = await addClip(t, { title: 'New upload' });
    expect(await titles(await library())).toEqual([]);
    await categorize(t, id, 1);
    expect(await titles(await library())).toEqual(['New upload']);
  });

  it('requires a signed-in user', async () => {
    holder.userId = null;
    expect((await library()).status).toBe(401);
  });
});

async function addBrand(clipId: number, brandName: string | null, role: string, clearanceStatus: string, note: string | null = null) {
  const now = Date.now();
  await t.pg.query(
    `insert into broll_clip_brands (clip_id, brand_name, role, clearance_status, note, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $6)`,
    [clipId, brandName, role, clearanceStatus, note, now],
  );
}

type LibraryClip = { title: string; clearanceStatus: string; effectiveClearance: string; clearedForUse: boolean; notCleared: boolean };
const clips = async (res: Response) => (await res.json()) as LibraryClip[];

describe('clearance is independent of visibility', () => {
  it('returns unresolved clearance on every clip and never treats it as cleared', async () => {
    await classifiedClip('Fresh');
    const [clip] = await clips(await library());
    expect(clip).toMatchObject({ clearanceStatus: 'unresolved', effectiveClearance: 'unresolved', clearedForUse: false, notCleared: false });
  });

  it('shows classified clips with unresolved clearance in the internal library without clearing them', async () => {
    await classifiedClip('Unresolved');
    await classifiedClip('Cleared', { clearanceStatus: 'cleared' });
    const all = await clips(await library());
    expect(Object.fromEntries(all.map((c) => [c.title, c.clearedForUse]))).toEqual({ Unresolved: false, Cleared: true });
  });

  it('keeps not-cleared clips visible internally and identifies them as not cleared', async () => {
    await classifiedClip('Not cleared', { clearanceStatus: 'not_cleared' });
    const [clip] = await clips(await library());
    expect(clip).toMatchObject({ title: 'Not cleared', clearanceStatus: 'not_cleared', effectiveClearance: 'not_cleared', notCleared: true, clearedForUse: false });
  });

  it('still hides unclassified, on-hold, archived and rejected clips whatever their clearance', async () => {
    for (const clearanceStatus of ['unresolved', 'cleared', 'not_cleared']) {
      await addClip(t, { title: `Unclassified ${clearanceStatus}`, clearanceStatus });
      for (const reviewStatus of ['on_hold', 'archived', 'rejected']) await classifiedClip(`${reviewStatus} ${clearanceStatus}`, { reviewStatus, clearanceStatus });
    }
    expect(await titles(await library())).toEqual([]);
    expect(await titles(await library('?clearance=cleared'))).toEqual([]);
    expect(await titles(await library('?clearance=not_cleared'))).toEqual([]);
  });

  it('keeps a clip visible when its clearance changes', async () => {
    const id = await classifiedClip('Clip');
    for (const status of ['cleared', 'not_cleared', 'unresolved']) {
      await t.pg.query('update broll_clips set clearance_status = $1 where id = $2', [status, id]);
      expect(await titles(await library())).toEqual(['Clip']);
    }
  });

  it('rejects an invalid clearance filter', async () => {
    expect((await library('?clearance=approved')).status).toBe(400);
  });
});

describe('usable footage requires the clip and every brand to be cleared', () => {
  it('returns a cleared clip with no brands', async () => {
    await classifiedClip('Cleared, no brands', { clearanceStatus: 'cleared' });
    const [clip] = await clips(await library('?clearance=cleared'));
    expect(clip).toMatchObject({ title: 'Cleared, no brands', clearedForUse: true, effectiveClearance: 'cleared' });
  });

  it('returns a cleared clip whose every brand is cleared', async () => {
    const id = await classifiedClip('All cleared', { clearanceStatus: 'cleared' });
    await addBrand(id, 'Subway', 'hero', 'cleared');
    await addBrand(id, 'Hyundai', 'incidental', 'cleared');
    expect(await titles(await library('?clearance=cleared'))).toEqual(['All cleared']);
  });

  it('excludes a cleared clip when even one brand is unresolved', async () => {
    const id = await classifiedClip('One unresolved brand', { clearanceStatus: 'cleared' });
    await addBrand(id, 'Subway', 'hero', 'cleared');
    await addBrand(id, 'Hyundai', 'incidental', 'unresolved');
    expect(await titles(await library('?clearance=cleared'))).toEqual([]);
    const [clip] = await clips(await library());
    expect(clip).toMatchObject({ clearanceStatus: 'cleared', effectiveClearance: 'unresolved', clearedForUse: false, notCleared: false });
  });

  it('excludes a cleared clip when even one brand is not cleared, and flags it as not cleared', async () => {
    const id = await classifiedClip('One not-cleared brand', { clearanceStatus: 'cleared' });
    await addBrand(id, 'Subway', 'hero', 'cleared');
    await addBrand(id, 'Hyundai', 'incidental', 'not_cleared');
    expect(await titles(await library('?clearance=cleared'))).toEqual([]);
    expect(await titles(await library('?clearance=not_cleared'))).toEqual(['One not-cleared brand']);
    const [clip] = await clips(await library());
    expect(clip).toMatchObject({ clearanceStatus: 'cleared', effectiveClearance: 'not_cleared', notCleared: true, clearedForUse: false });
  });

  it('excludes a cleared clip that carries an unnamed unresolved observation', async () => {
    const id = await classifiedClip('Unresolved observation', { clearanceStatus: 'cleared' });
    await addBrand(id, null, 'unresolved', 'unresolved', 'Cup branding, partly legible');
    expect(await titles(await library('?clearance=cleared'))).toEqual([]);
  });

  it('excludes a clip whose brands are cleared but whose own clearance is not', async () => {
    for (const status of ['unresolved', 'not_cleared']) {
      const id = await classifiedClip(`Brands cleared, clip ${status}`, { clearanceStatus: status });
      await addBrand(id, 'Subway', 'hero', 'cleared');
    }
    expect(await titles(await library('?clearance=cleared'))).toEqual([]);
  });

  it('excludes cleared clips that are on hold, archived, rejected or unclassified', async () => {
    for (const reviewStatus of ['on_hold', 'archived', 'rejected']) await classifiedClip(reviewStatus, { clearanceStatus: 'cleared', reviewStatus });
    await addClip(t, { title: 'unclassified', clearanceStatus: 'cleared' });
    await classifiedClip('Usable', { clearanceStatus: 'cleared' });
    expect(await titles(await library('?clearance=cleared'))).toEqual(['Usable']);
  });

  it('reports the same answer in the filter and in the clearedForUse field', async () => {
    const a = await classifiedClip('Usable', { clearanceStatus: 'cleared' });
    await addBrand(a, 'Subway', 'hero', 'cleared');
    const b = await classifiedClip('Blocked by brand', { clearanceStatus: 'cleared' });
    await addBrand(b, 'Subway', 'hero', 'unresolved');
    await classifiedClip('Blocked by clip', { clearanceStatus: 'unresolved' });
    const all = await clips(await library());
    const usableTitles = all.filter((c) => c.clearedForUse).map((c) => c.title).sort();
    expect(usableTitles).toEqual(['Usable']);
    expect(await titles(await library('?clearance=cleared'))).toEqual(usableTitles);
  });

  it('splits the library cleanly: every visible clip is in exactly one of the three clearance filters', async () => {
    await classifiedClip('Cleared', { clearanceStatus: 'cleared' });
    await classifiedClip('Unresolved', { clearanceStatus: 'unresolved' });
    await classifiedClip('Not cleared', { clearanceStatus: 'not_cleared' });
    const brandUnresolved = await classifiedClip('Cleared, brand unresolved', { clearanceStatus: 'cleared' });
    await addBrand(brandUnresolved, 'Subway', 'hero', 'unresolved');
    const brandBlocked = await classifiedClip('Cleared, brand not cleared', { clearanceStatus: 'cleared' });
    await addBrand(brandBlocked, 'Subway', 'hero', 'not_cleared');
    const unresolvedClipNotClearedBrand = await classifiedClip('Unresolved, brand not cleared', { clearanceStatus: 'unresolved' });
    await addBrand(unresolvedClipNotClearedBrand, 'Subway', 'hero', 'not_cleared');

    const everything = await titles(await library());
    const cleared = await titles(await library('?clearance=cleared'));
    const notCleared = await titles(await library('?clearance=not_cleared'));
    const unresolved = await titles(await library('?clearance=unresolved'));
    expect(cleared).toEqual(['Cleared']);
    expect(notCleared).toEqual(['Cleared, brand not cleared', 'Not cleared', 'Unresolved, brand not cleared']);
    expect(unresolved).toEqual(['Cleared, brand unresolved', 'Unresolved']);
    expect([...cleared, ...notCleared, ...unresolved].sort()).toEqual(everything);
  });

  it('never clears anything by itself: a new clip and a new brand both start unresolved', async () => {
    const id = await classifiedClip('Fresh');
    await t.pg.query(`insert into broll_clip_brands (clip_id, brand_name, role, note, created_at, updated_at) values ($1, 'Subway', 'hero', null, 1, 1)`, [id]);
    const [clip] = await clips(await library());
    expect(clip).toMatchObject({ clearanceStatus: 'unresolved', clearedForUse: false });
    const brands = (await t.pg.query<{ clearance_status: string }>('select clearance_status from broll_clip_brands')).rows;
    expect(brands).toEqual([{ clearance_status: 'unresolved' }]);
  });
});

describe('brand associations in the library response', () => {
  it('returns several brands per clip with their roles and independent clearance', async () => {
    const id = await classifiedClip('Clip with brands');
    const now = Date.now();
    await t.db.insert(brollClipBrands).values([
      { clipId: id, brandName: 'Subway', role: 'hero', clearanceStatus: 'unresolved', note: null, createdAt: now, updatedAt: now },
      { clipId: id, brandName: 'Hyundai', role: 'incidental', clearanceStatus: 'cleared', note: null, createdAt: now, updatedAt: now },
      { clipId: id, brandName: null, role: 'unresolved', clearanceStatus: 'unresolved', note: 'Cup branding, partly legible', createdAt: now, updatedAt: now },
    ]);
    const [clip] = (await (await library()).json()) as { brands: { brandName: string | null; role: string; clearanceStatus: string; note: string | null }[] }[];
    expect(clip.brands.map((b) => [b.brandName, b.role, b.clearanceStatus])).toEqual([
      ['Subway', 'hero', 'unresolved'],
      ['Hyundai', 'incidental', 'cleared'],
      [null, 'unresolved', 'unresolved'],
    ]);
    expect(clip.brands[2].note).toBe('Cup branding, partly legible');
  });

  it('returns an empty list for a clip with no brands', async () => {
    await classifiedClip('No brands');
    const [clip] = (await (await library()).json()) as { brands: unknown[] }[];
    expect(clip.brands).toEqual([]);
  });
});

describe('management view for unclassified clips', () => {
  beforeEach(async () => {
    await classifiedClip('Classified');
    await addClip(t, { title: 'Unclassified' });
    await addClip(t, { title: 'Unclassified on hold', reviewStatus: 'on_hold' });
    await addClip(t, { title: 'Unclassified archived', reviewStatus: 'archived' });
  });

  it('is not available without signing in', async () => {
    holder.userId = null;
    expect((await unclassified()).status).toBe(401);
  });

  it('is forbidden to a signed-in user who is not an administrator', async () => {
    holder.userId = TEST_USER_ID;
    const res = await unclassified();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain('Unclassified');
  });

  it('lists unclassified clips for an administrator, excluding archived ones by default', async () => {
    holder.userId = ADMIN_USER_ID;
    const res = await unclassified();
    expect(res.status).toBe(200);
    expect(await titles(res)).toEqual(['Unclassified', 'Unclassified on hold']);
  });

  it('includes archived clips on request', async () => {
    holder.userId = ADMIN_USER_ID;
    expect(await titles(await unclassified('?includeArchived=true'))).toEqual(['Unclassified', 'Unclassified archived', 'Unclassified on hold']);
  });

  it('shows enough to identify each clip and its state, without storage details', async () => {
    holder.userId = ADMIN_USER_ID;
    const clips = (await (await unclassified()).json()) as Record<string, unknown>[];
    const clip = clips.find((c) => c.title === 'Unclassified')!;
    expect(clip).toMatchObject({ classificationStatus: 'unclassified', reviewStatus: 'unreviewed', clearanceStatus: 'unresolved' });
    expect(clip).toHaveProperty('id');
    expect(clip).toHaveProperty('createdAt');
    expect(clip).not.toHaveProperty('storagePath');
    expect(clip).not.toHaveProperty('signedUrl');
    expect(clip).not.toHaveProperty('notes');
  });

  it('keeps unclassified clips out of the library while they stay reachable here', async () => {
    holder.userId = ADMIN_USER_ID;
    expect(await titles(await library())).toEqual(['Classified']);
    expect(await titles(await unclassified())).not.toContain('Classified');
  });

  it('moves a clip from the management view into the library once it is categorised', async () => {
    holder.userId = ADMIN_USER_ID;
    const clips = (await (await unclassified()).json()) as { id: number; title: string }[];
    const id = clips.find((c) => c.title === 'Unclassified')!.id;
    await categorize(t, id, 1);
    expect(await titles(await library())).toHaveLength(2);
    expect(await titles(await unclassified())).not.toContain('Unclassified');
  });

  it('honours the ADMIN_USER_IDS bootstrap list as well as the admin table', async () => {
    const bootstrapAdmin = '00000000-0000-4000-8000-0000000000c1';
    holder.userId = bootstrapAdmin;
    expect((await unclassified()).status).toBe(403);
    process.env.ADMIN_USER_IDS = bootstrapAdmin;
    expect((await unclassified()).status).toBe(200);
  });
});

describe('single clip', () => {
  const detail = (id: number) => getClip(new NextRequest(`http://localhost/api/v1/broll/${id}`), { params: Promise.resolve({ id: String(id) }) });

  it('is usable only when classified, not hidden, and cleared at clip and brand level', async () => {
    const usable = await classifiedClip('Usable', { clearanceStatus: 'cleared' });
    await addBrand(usable, 'Subway', 'hero', 'cleared');
    expect(await (await detail(usable)).json()).toMatchObject({ clearedForUse: true, effectiveClearance: 'cleared', notCleared: false });

    const onHold = await classifiedClip('On hold', { clearanceStatus: 'cleared', reviewStatus: 'on_hold' });
    expect(await (await detail(onHold)).json()).toMatchObject({ clearanceStatus: 'cleared', effectiveClearance: 'cleared', clearedForUse: false });

    const unclassified = await addClip(t, { title: 'Unclassified', clearanceStatus: 'cleared' });
    expect(await (await detail(unclassified)).json()).toMatchObject({ classificationStatus: 'unclassified', clearedForUse: false });
  });

  it('identifies a not-cleared clip', async () => {
    const id = await classifiedClip('Not cleared', { clearanceStatus: 'not_cleared' });
    expect(await (await detail(id)).json()).toMatchObject({ clearanceStatus: 'not_cleared', notCleared: true, clearedForUse: false });
  });

  it('stays reachable by id when unclassified and reports its state', async () => {
    const id = await addClip(t, { title: 'Unclassified' });
    const res = await getClip(new NextRequest(`http://localhost/api/v1/broll/${id}`), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ classificationStatus: 'unclassified', clearanceStatus: 'unresolved', effectiveClearance: 'unresolved', clearedForUse: false, notCleared: false, brands: [] });
  });

  it('reports a classified clip with brands', async () => {
    const id = await classifiedClip('Classified', { clearanceStatus: 'cleared' });
    const now = Date.now();
    await t.db.insert(brollClipBrands).values({ clipId: id, brandName: 'Disney', role: 'unresolved', clearanceStatus: 'unresolved', note: null, createdAt: now, updatedAt: now });
    const res = await getClip(new NextRequest(`http://localhost/api/v1/broll/${id}`), { params: Promise.resolve({ id: String(id) }) });
    const body = await res.json();
    // The clip is cleared but its Disney association is not, so the footage is not usable.
    expect(body).toMatchObject({ classificationStatus: 'classified', clearanceStatus: 'cleared', effectiveClearance: 'unresolved', clearedForUse: false });
    expect(body.brands).toHaveLength(1);
    expect(body.brands[0]).toMatchObject({ brandName: 'Disney', role: 'unresolved', clearanceStatus: 'unresolved' });
  });
});
