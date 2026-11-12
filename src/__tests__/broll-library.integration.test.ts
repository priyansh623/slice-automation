/**
 * Integration tests for the shared B-roll library against a real (in-memory) Postgres built from the
 * repository's migrations. Only the database handle, Supabase auth and Supabase storage are replaced;
 * route and query code is real.
 *
 * What these prove:
 *   - one library: every signed-in user sees the same classified, active clips
 *   - no clearance or approval status filters clips or blocks access (the legacy column is ignored)
 *   - non-admins receive no internal data (notes, uploader, storage paths, unnamed brand observations)
 *   - unclassified, held and archived clips are admin-only
 *   - only admins upload, edit, classify, archive, restore and delete; owning an upload gives no rights
 *   - preview, trim and categories work for every clip in the shared library
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
// Storage cannot make a signed URL here; the trim route then stops with 500 *after* its access check passes,
// which lets these tests tell "allowed" (500) from "not allowed" (404).
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) } }),
}));

import { GET as listLibrary, POST as createClip } from '@/app/api/v1/broll/route';
import { GET as listUnclassified } from '@/app/api/v1/broll/unclassified/route';
import { GET as getClip, PATCH as patchClip, DELETE as deleteClip } from '@/app/api/v1/broll/[id]/route';
import { PATCH as setStatus } from '@/app/api/v1/broll/[id]/status/route';
import { POST as trimClip } from '@/app/api/v1/broll/[id]/trim/route';
import { GET as getCategories, POST as addCategories, DELETE as removeCategories } from '@/app/api/v1/broll/[id]/categories/route';
import { POST as uploadFile } from '@/app/api/v1/broll/upload/route';
import { GET as adminMe } from '@/app/api/v1/admin/me/route';

const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000b2';

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

const as = (userId: string | null) => { holder.userId = userId; };
const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;
const titles = async (res: Response) => ((await res.json()) as { title: string }[]).map((c) => c.title).sort();
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const body = (method: string, payload: unknown) => ({ method, body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
const url = (path: string) => `http://localhost/api/v1/broll${path}`;

const library = () => listLibrary();
const unclassified = (query = '') => listUnclassified(new NextRequest(url(`/unclassified${query}`)));
const detail = (id: number) => getClip(new NextRequest(url(`/${id}`)), ctx(id));
const patch = (id: number, payload: unknown) => patchClip(new NextRequest(url(`/${id}`), body('PATCH', payload)), ctx(id));
const remove = (id: number) => deleteClip(new NextRequest(url(`/${id}`), { method: 'DELETE' }), ctx(id));
const status = (id: number, payload: unknown) => setStatus(new NextRequest(url(`/${id}/status`), body('PATCH', payload)), ctx(id));
const trim = (id: number) => trimClip(new NextRequest(url(`/${id}/trim`), body('POST', { inPoint: 0, outPoint: 2 })), ctx(id));
const categoriesOf = (id: number) => getCategories(new NextRequest(url(`/${id}/categories`)), ctx(id));
const assign = (id: number, categoryIds: number[]) => addCategories(new NextRequest(url(`/${id}/categories`), body('POST', { categoryIds })), ctx(id));
const unassign = (id: number, categoryIds: number[]) => removeCategories(new NextRequest(url(`/${id}/categories`), body('DELETE', { categoryIds })), ctx(id));

async function classifiedClip(title: string, overrides: Parameters<typeof addClip>[1] extends infer T ? Partial<T> : never = {}) {
  const id = await addClip(t, { title, ...overrides });
  await categorize(t, id, 2);
  return id;
}

async function addBrand(clipId: number, brandName: string | null, role: string, note: string | null = null) {
  await t.pg.query(
    `insert into broll_clip_brands (clip_id, brand_name, role, note, created_at, updated_at) values ($1, $2, $3, $4, 1, 1)`,
    [clipId, brandName, role, note],
  );
}

describe('one shared library', () => {
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

  it('shows a new upload only once it has a category, with no other step', async () => {
    const id = await addClip(t, { title: 'New upload' });
    expect(await titles(await library())).toEqual([]);
    await categorize(t, id, 1);
    expect(await titles(await library())).toEqual(['New upload']);
  });

  it('requires a signed-in user', async () => {
    as(null);
    expect((await library()).status).toBe(401);
  });

  it('gives an administrator, the uploader and another user exactly the same clips and categories', async () => {
    const a = await classifiedClip('One');
    await categorize(t, a, 3);
    await classifiedClip('Two', { userId: OTHER_USER_ID });
    await addClip(t, { title: 'Not in library' });
    const seen: Record<string, { title: string; categoryIds: number[] }[]> = {};
    for (const [who, id] of [['admin', ADMIN_USER_ID], ['uploader', TEST_USER_ID], ['other', OTHER_USER_ID]] as const) {
      as(id);
      const list = (await (await library()).json()) as { title: string; categoryIds: number[] }[];
      seen[who] = list.map((c) => ({ title: c.title, categoryIds: [...c.categoryIds].sort() })).sort((x, y) => x.title.localeCompare(y.title));
    }
    expect(seen.admin).toEqual([{ title: 'One', categoryIds: [2, 3] }, { title: 'Two', categoryIds: [2] }]);
    expect(seen.uploader).toEqual(seen.admin);
    expect(seen.other).toEqual(seen.admin);
  });
});

describe('no clearance concept', () => {
  it('is not filtered or flagged by the legacy clearance column, whatever it holds', async () => {
    for (const value of ['unresolved', 'cleared', 'not_cleared']) await classifiedClip(`Legacy ${value}`);
    await t.pg.query(`update broll_clips set clearance_status = case title when 'Legacy cleared' then 'cleared' when 'Legacy not_cleared' then 'not_cleared' else 'unresolved' end`);
    for (const who of [TEST_USER_ID, OTHER_USER_ID, ADMIN_USER_ID]) {
      as(who);
      expect(await titles(await library())).toEqual(['Legacy cleared', 'Legacy not_cleared', 'Legacy unresolved']);
    }
  });

  it('exposes no clearance fields on the library, a clip, or the management view', async () => {
    const id = await classifiedClip('Clip');
    await addBrand(id, 'Subway', 'hero');
    await addClip(t, { title: 'Unclassified' });
    for (const who of [OTHER_USER_ID, ADMIN_USER_ID]) {
      as(who);
      const [clip] = (await (await library()).json()) as Record<string, unknown>[];
      const one = await json(await detail(id));
      const text = JSON.stringify([clip, one, ...(who === ADMIN_USER_ID ? await (await unclassified()).json() as unknown[] : [])]);
      for (const field of ['clearance', 'cleared', 'clearedForUse', 'effectiveClearance', 'notCleared']) {
        expect(text.toLowerCase(), `${field} for ${who}`).not.toContain(field.toLowerCase());
      }
    }
  });

  it('ignores a clearance query parameter instead of filtering by it', async () => {
    await classifiedClip('Clip');
    for (const value of ['cleared', 'not_cleared', 'unresolved', 'nonsense']) {
      const res = await (listLibrary as unknown as (req: NextRequest) => Promise<Response>)(new NextRequest(url(`?clearance=${value}`)));
      expect(res.status).toBe(200);
      expect(await titles(res)).toEqual(['Clip']);
    }
  });
});

describe('brand associations are shared metadata', () => {
  async function clipWithBrands() {
    const id = await classifiedClip('Branded');
    await addBrand(id, 'Subway', 'hero', 'Internal observation note');
    await addBrand(id, 'Hyundai', 'incidental');
    await addBrand(id, null, 'unresolved', 'Cup branding, partly legible');
    await addBrand(id, null, 'client_product', 'Payments app on a phone');
    return id;
  }

  it('gives everyone the named brands and their roles', async () => {
    await clipWithBrands();
    for (const who of [TEST_USER_ID, OTHER_USER_ID, ADMIN_USER_ID]) {
      as(who);
      const [clip] = (await (await library()).json()) as { brands: { brandName: string; role: string }[] }[];
      expect(clip.brands.filter((b) => b.brandName).map((b) => [b.brandName, b.role])).toEqual([['Subway', 'hero'], ['Hyundai', 'incidental']]);
    }
  });

  it('gives admins the unnamed observations and notes, and keeps them from everyone else', async () => {
    const id = await clipWithBrands();
    as(ADMIN_USER_ID);
    const adminView = (await json(await detail(id))) as { brands: { brandName: string | null; note: string | null }[] };
    expect(adminView.brands).toHaveLength(4);
    expect(adminView.brands.map((b) => b.note)).toContain('Cup branding, partly legible');

    as(OTHER_USER_ID);
    const userView = (await json(await detail(id))) as { brands: Record<string, unknown>[] };
    expect(userView.brands).toEqual([{ brandName: 'Subway', role: 'hero' }, { brandName: 'Hyundai', role: 'incidental' }]);
    expect(JSON.stringify(userView)).not.toContain('Cup branding');
    expect(JSON.stringify(userView)).not.toContain('Payments app');
    expect(JSON.stringify(userView)).not.toContain('Internal observation note');
  });
});

describe('private data stays private', () => {
  it('does not send internal fields to non-admins on the library, detail and create responses', async () => {
    const id = await classifiedClip('Private fields', { notes: '{"review":"internal"}' });
    await t.pg.query(`update broll_clips set reviewed_by = $1, reviewed_at = 5, processing_error = 'boom' where id = $2`, [ADMIN_USER_ID, id]);
    as(OTHER_USER_ID);
    const fromList = ((await (await library()).json()) as Record<string, unknown>[])[0];
    const fromDetail = await json(await detail(id));
    for (const clip of [fromList, fromDetail]) {
      for (const field of ['notes', 'userId', 'reviewedBy', 'reviewedAt', 'storagePath', 'thumbnailStoragePath', 'processingError', 'claimedAt']) {
        expect(clip, field).not.toHaveProperty(field);
      }
      expect(clip).toMatchObject({ id, title: 'Private fields' });
      expect(clip.signedUrl).toBeTruthy(); // preview and download still work
    }
  });

  it('gives administrators the full record', async () => {
    const id = await classifiedClip('Admin fields', { notes: '{"review":"internal"}' });
    as(ADMIN_USER_ID);
    expect(await json(await detail(id))).toMatchObject({ notes: '{"review":"internal"}', userId: TEST_USER_ID, storagePath: expect.any(String) });
  });
});

describe('clips outside the library are admin-only', () => {
  async function outsideClips() {
    return {
      unclassified: await addClip(t, { title: 'Unclassified' }),
      onHold: await classifiedClip('On hold', { reviewStatus: 'on_hold' }),
      archived: await classifiedClip('Archived', { reviewStatus: 'archived' }),
    };
  }

  it('answers 404 to a non-admin, even for their own upload', async () => {
    const clips = await outsideClips();
    for (const who of [TEST_USER_ID, OTHER_USER_ID]) {
      as(who);
      for (const id of Object.values(clips)) {
        expect((await detail(id)).status).toBe(404);
        expect((await categoriesOf(id)).status).toBe(404);
        expect((await trim(id)).status).toBe(404);
      }
    }
  });

  it('lets an administrator open all of them', async () => {
    const clips = await outsideClips();
    as(ADMIN_USER_ID);
    for (const id of Object.values(clips)) {
      expect((await detail(id)).status).toBe(200);
      expect((await categoriesOf(id)).status).toBe(200);
      expect((await trim(id)).status).toBe(500); // passed the access check; storage is stubbed out
    }
  });

  it('lists unclassified uploads for admins only, excluding archived ones by default', async () => {
    await addClip(t, { title: 'Unclassified' });
    await addClip(t, { title: 'Unclassified on hold', reviewStatus: 'on_hold' });
    await addClip(t, { title: 'Unclassified archived', reviewStatus: 'archived' });
    await classifiedClip('Classified');
    as(OTHER_USER_ID);
    expect((await unclassified()).status).toBe(403);
    as(TEST_USER_ID);
    expect((await unclassified()).status).toBe(403);
    as(null);
    expect((await unclassified()).status).toBe(401);
    as(ADMIN_USER_ID);
    expect(await titles(await unclassified())).toEqual(['Unclassified', 'Unclassified on hold']);
    expect(await titles(await unclassified('?includeArchived=true'))).toEqual(['Unclassified', 'Unclassified archived', 'Unclassified on hold']);
  });

  it('shows enough to identify each unclassified upload, without storage details or notes', async () => {
    await addClip(t, { title: 'Unclassified', notes: 'internal' });
    as(ADMIN_USER_ID);
    const [clip] = (await (await unclassified()).json()) as Record<string, unknown>[];
    expect(clip).toMatchObject({ title: 'Unclassified', classificationStatus: 'unclassified', reviewStatus: 'unreviewed' });
    for (const field of ['storagePath', 'signedUrl', 'notes']) expect(clip).not.toHaveProperty(field);
  });

  it('moves a clip from the management view into the library as soon as it is classified', async () => {
    const id = await addClip(t, { title: 'Waiting' });
    as(ADMIN_USER_ID);
    expect(await titles(await unclassified())).toEqual(['Waiting']);
    expect(await titles(await library())).toEqual([]);
    expect((await assign(id, [1])).status).toBe(204);
    expect(await titles(await unclassified())).toEqual([]);
    as(OTHER_USER_ID);
    expect(await titles(await library())).toEqual(['Waiting']);
  });

  it('honours the ADMIN_USER_IDS bootstrap list as well as the admin table', async () => {
    const bootstrapAdmin = '00000000-0000-4000-8000-0000000000c1';
    as(bootstrapAdmin);
    expect((await unclassified()).status).toBe(403);
    process.env.ADMIN_USER_IDS = bootstrapAdmin;
    expect((await unclassified()).status).toBe(200);
  });
});

describe('preview, trim and download for the whole library', () => {
  it('lets any signed-in user open and trim any clip in the library, whoever uploaded it', async () => {
    const id = await classifiedClip('Shared', { userId: OTHER_USER_ID });
    for (const who of [TEST_USER_ID, OTHER_USER_ID, ADMIN_USER_ID]) {
      as(who);
      expect((await detail(id)).status).toBe(200);
      expect((await trim(id)).status).toBe(500); // passed the access check; storage is stubbed out
    }
  });

  it('rejects an unauthenticated trim', async () => {
    const id = await classifiedClip('Shared');
    as(null);
    expect((await trim(id)).status).toBe(401);
  });
});

describe('who can change a clip', () => {
  it('stops a non-admin from editing or deleting their own upload', async () => {
    const id = await classifiedClip('Mine', { userId: OTHER_USER_ID });
    as(OTHER_USER_ID);
    expect((await patch(id, { title: 'Renamed' })).status).toBe(403);
    expect((await remove(id)).status).toBe(403);
    expect(await titles(await library())).toEqual(['Mine']);
  });

  it("stops a non-admin from editing or deleting another user's clip", async () => {
    const id = await classifiedClip('Theirs', { userId: OTHER_USER_ID });
    as(TEST_USER_ID);
    expect((await patch(id, { title: 'Hijacked' })).status).toBe(403);
    expect((await remove(id)).status).toBe(403);
    as(OTHER_USER_ID);
    expect(await titles(await library())).toEqual(['Theirs']);
  });

  it('stops a non-admin from uploading, and signed-out callers get 401', async () => {
    as(OTHER_USER_ID);
    expect((await createClip(new NextRequest(url(''), body('POST', { title: 'Mine', storagePath: 'x/y.mp4' })))).status).toBe(403);
    as(null);
    expect((await createClip(new NextRequest(url(''), body('POST', { title: 'Mine', storagePath: 'x/y.mp4' })))).status).toBe(401);
    as(ADMIN_USER_ID);
    expect(await json(await createClip(new NextRequest(url(''), body('POST', { title: 'Admin upload', storagePath: 'x/y.mp4' }))))).toMatchObject({ title: 'Admin upload' });
    expect(await titles(await library())).toEqual([]); // unclassified, so not in the shared library yet
  });

  it('lets an administrator edit and delete any clip', async () => {
    const id = await classifiedClip('Anyones', { userId: OTHER_USER_ID });
    as(ADMIN_USER_ID);
    expect(await json(await patch(id, { title: 'Edited by admin' }))).toMatchObject({ title: 'Edited by admin' });
    expect((await remove(id)).status).toBe(200);
  });

});

describe('trim range validation (before any file is touched)', () => {
  const trimWith = (id: number, payload: unknown) => trimClip(new NextRequest(url(`/${id}/trim`), body('POST', payload)), ctx(id));

  it.each([
    ['out equals in', { inPoint: 3, outPoint: 3 }],
    ['out before in', { inPoint: 5, outPoint: 2 }],
    ['negative in', { inPoint: -1, outPoint: 2 }],
    ['too short', { inPoint: 1, outPoint: 1.02 }],
    ['not numbers', { inPoint: '1', outPoint: '2' }],
    ['missing', {}],
  ])('answers 400 for %s', async (_label, payload) => {
    const id = await classifiedClip('Shared');
    expect((await trimWith(id, payload)).status).toBe(400);
  });

  it('answers 400 when the start is beyond the end of a clip with a known duration', async () => {
    const id = await classifiedClip('Short', { durationSeconds: 5 });
    expect((await trimWith(id, { inPoint: 8, outPoint: 9 })).status).toBe(400);
  });

  it('lets a valid range through to the file step for any signed-in user', async () => {
    const id = await classifiedClip('Shared', { durationSeconds: 10 });
    as(OTHER_USER_ID);
    expect((await trimWith(id, { inPoint: 1, outPoint: 4 })).status).toBe(500); // storage is stubbed, so it stops after access and validation pass
  });
});

describe('file upload endpoint', () => {
  it('is closed to non-admins and signed-out callers before anything is read', async () => {
    const req = () => new NextRequest(url('/upload'), { method: 'POST' });
    as(OTHER_USER_ID);
    expect((await uploadFile(req())).status).toBe(403);
    as(null);
    expect((await uploadFile(req())).status).toBe(401);
  });
});

describe('who can classify a clip', () => {
  it('lets an administrator classify and unclassify any clip', async () => {
    const id = await addClip(t, { title: 'Theirs', userId: OTHER_USER_ID });
    as(ADMIN_USER_ID);
    expect((await assign(id, [1, 2])).status).toBe(204);
    expect(await (await categoriesOf(id)).json()).toEqual(expect.arrayContaining([1, 2]));
    expect((await unassign(id, [1])).status).toBe(204);
    expect(await (await categoriesOf(id)).json()).toEqual([2]);
  });

  it('stops a non-admin from classifying their own upload', async () => {
    const id = await addClip(t, { title: 'Mine', userId: OTHER_USER_ID });
    as(OTHER_USER_ID);
    expect((await assign(id, [2])).status).toBe(403);
    expect(await titles(await library())).toEqual([]);
  });

  it("stops a non-admin from changing another user's classification", async () => {
    const id = await classifiedClip('Theirs', { userId: OTHER_USER_ID });
    as(TEST_USER_ID);
    expect((await assign(id, [3])).status).toBe(403);
    expect((await unassign(id, [2])).status).toBe(403);
    as(ADMIN_USER_ID);
    expect(await (await categoriesOf(id)).json()).toEqual([2]);
  });

  it('lets anyone read the categories of a clip in the library', async () => {
    const id = await classifiedClip('Shared', { userId: OTHER_USER_ID });
    as(TEST_USER_ID);
    expect(await (await categoriesOf(id)).json()).toEqual([2]);
  });
});

describe('archiving and restoring (administrators only)', () => {
  it('rejects non-admins and signed-out callers', async () => {
    const id = await classifiedClip('Clip');
    as(TEST_USER_ID);
    expect((await status(id, { status: 'archived' })).status).toBe(403);
    as(null);
    expect((await status(id, { status: 'archived' })).status).toBe(401);
    as(ADMIN_USER_ID);
    expect(await titles(await library())).toEqual(['Clip']);
  });

  it('archives a clip out of the library and restores it, changing nothing else', async () => {
    const id = await classifiedClip('Clip', { notes: 'keep me' });
    await addBrand(id, 'Subway', 'hero');
    const before = (await t.pg.query(`select title, storage_path, notes, brand from broll_clips where id = $1`, [id])).rows;
    as(ADMIN_USER_ID);
    expect(await json(await status(id, { status: 'archived' }))).toEqual({ id, reviewStatus: 'archived' });
    expect(await titles(await library())).toEqual([]);
    expect(await json(await status(id, { status: 'active' }))).toEqual({ id, reviewStatus: 'unreviewed' });
    expect(await titles(await library())).toEqual(['Clip']);

    expect((await t.pg.query(`select title, storage_path, notes, brand from broll_clips where id = $1`, [id])).rows).toEqual(before);
    expect((await t.pg.query('select category_id from broll_clip_categories where clip_id = $1', [id])).rows).toEqual([{ category_id: 2 }]);
    expect((await t.pg.query('select brand_name from broll_clip_brands where clip_id = $1', [id])).rows).toEqual([{ brand_name: 'Subway' }]);
    const stamped = (await t.pg.query<{ reviewed_by: string }>('select reviewed_by from broll_clips where id = $1', [id])).rows[0];
    expect(stamped.reviewed_by).toBe(ADMIN_USER_ID);
  });

  it('puts a clip on hold and releases it', async () => {
    const id = await classifiedClip('Clip');
    as(ADMIN_USER_ID);
    expect((await status(id, { status: 'on_hold' })).status).toBe(200);
    expect(await titles(await library())).toEqual([]);
    expect((await status(id, { status: 'active' })).status).toBe(200);
    expect(await titles(await library())).toEqual(['Clip']);
  });

  it('keeps an unclassified clip out of the library even when restored', async () => {
    const id = await addClip(t, { title: 'Unclassified', reviewStatus: 'archived' });
    as(ADMIN_USER_ID);
    await status(id, { status: 'active' });
    expect(await titles(await library())).toEqual([]);
    expect(await titles(await unclassified())).toEqual(['Unclassified']);
  });

  it('leaves an approved clip as it is when asked to restore a clip that is already active', async () => {
    const id = await classifiedClip('Clip', { reviewStatus: 'approved' });
    as(ADMIN_USER_ID);
    expect(await json(await status(id, { status: 'active' }))).toEqual({ id, reviewStatus: 'approved' });
  });

  it('rejects an unknown status and an unknown clip', async () => {
    const id = await classifiedClip('Clip');
    as(ADMIN_USER_ID);
    expect((await status(id, { status: 'cleared' })).status).toBe(400);
    expect((await status(id, {})).status).toBe(400);
    expect((await status(9999, { status: 'archived' })).status).toBe(404);
  });
});

describe('who is an administrator', () => {
  it('reports true for admins and false for everyone else, using the same check as the admin routes', async () => {
    as(ADMIN_USER_ID);
    expect(await json(await adminMe())).toEqual({ isAdmin: true });
    as(TEST_USER_ID);
    expect(await json(await adminMe())).toEqual({ isAdmin: false });
    process.env.ADMIN_USER_IDS = TEST_USER_ID;
    expect(await json(await adminMe())).toEqual({ isAdmin: true });
    as(null);
    expect((await adminMe()).status).toBe(401);
  });
});

describe('existing data and brand rows', () => {
  it('still reads brand associations whose legacy clearance column holds a value', async () => {
    const id = await classifiedClip('Clip');
    await t.db.insert(brollClipBrands).values({ clipId: id, brandName: 'Subway', role: 'hero', createdAt: 1, updatedAt: 1 });
    await t.pg.query(`update broll_clip_brands set clearance_status = 'not_cleared'`);
    as(OTHER_USER_ID);
    expect(await titles(await library())).toEqual(['Clip']);
  });
});
