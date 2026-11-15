/** The one shared selection: across packs, with each image's original pack, and archived images flagged but kept. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate, call } from './helpers/studio-fakes';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown, userId: '00000000-0000-4000-8000-00000000000a' as string | null }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { POST as projectsPost } from '@/app/api/v1/studio/projects/route';
import { POST as approvePacks } from '@/app/api/v1/studio/projects/[id]/packs/route';
import { DELETE as revoke } from '@/app/api/v1/studio/projects/[id]/packs/[packId]/route';
import { GET as selectionGet, POST as selectionPost, DELETE as selectionDelete } from '@/app/api/v1/studio/projects/[id]/selection/route';
import { POST as assetArchive } from '@/app/api/v1/studio/assets/[id]/archive/route';

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(() => { holder.store = new FakeR2(); holder.userId = USER_A; });

let seq = 0;
const now = () => Date.now();
const newProject = async () => (await call(projectsPost, { method: 'POST', body: { name: 'P' } })).json.project.id as number;
const pack = async (name: string) => (await db.insert(schema.studioPacks).values({ name, createdBy: USER_A, createdAt: now(), updatedAt: now() }).returning())[0].id;
async function asset(packId: number) {
  const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/sel${++seq}.png`, mime: 'image/png', sizeBytes: 5, sha256: `sel${seq}`, createdBy: USER_A, createdAt: now(), updatedAt: now() }).returning();
  return a.id;
}
const P = (id: number) => ({ id: String(id) });
const approve = (proj: number, ids: number[]) => call(approvePacks, { method: 'POST', params: P(proj), body: { packIds: ids } });
const add = (proj: number, assetIds: number[]) => call(selectionPost, { method: 'POST', params: P(proj), body: { assetIds } });
const ids = async (proj: number) => (await call(selectionGet, { params: P(proj) })).json.selection.map((s: any) => s.assetId);

describe('shared selection', () => {
  it('requires a signed-in user, and then any user can manage anyone\'s selection', async () => {
    const proj = await newProject(); const p = await pack('P'); const a = await asset(p); await approve(proj, [p]);
    holder.userId = null;
    expect((await call(selectionGet, { params: P(proj) })).status).toBe(401);
    expect((await add(proj, [a])).status).toBe(401);
    expect((await call(selectionDelete, { method: 'DELETE', params: P(proj), body: {} })).status).toBe(401);
    holder.userId = USER_B;
    expect((await add(proj, [a])).status).toBe(200);
  });

  it('holds images from several approved packs in ONE selection, each with its original pack and asset id', async () => {
    const proj = await newProject(); const p1 = await pack('Kitchens'); const p2 = await pack('Airports'); const p3 = await pack('Unapproved');
    const a1 = await asset(p1); const a2 = await asset(p1); const b1 = await asset(p2); const c1 = await asset(p3);
    await approve(proj, [p1, p2]);
    const r = await add(proj, [a1, b1, a2]);
    expect(r.status).toBe(200);
    expect(r.json.added.sort()).toEqual([a1, a2, b1].sort());
    const sel = (await call(selectionGet, { params: P(proj) })).json.selection;
    expect(sel.map((s: any) => [s.assetId, s.packId, s.packName]).sort()).toEqual([[a1, p1, 'Kitchens'], [a2, p1, 'Kitchens'], [b1, p2, 'Airports']].sort());
    // the rows in the database record the same
    const rows = await db.select().from(schema.studioSelections).where(eq(schema.studioSelections.projectId, proj));
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.packId === (x.assetId === b1 ? p2 : p1))).toBe(true);
    // a pack the project has not approved cannot contribute
    const blocked = await add(proj, [c1]);
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe('pack_not_approved');
    expect((await ids(proj)).length).toBe(3);
  });

  it('adding twice is harmless, and bad input is rejected', async () => {
    const proj = await newProject(); const p = await pack('P'); const a = await asset(p); await approve(proj, [p]);
    await add(proj, [a]);
    expect((await add(proj, [a])).json).toMatchObject({ added: [], already: [a] });
    expect((await add(proj, [])).status).toBe(400);
    expect((await add(proj, [999999])).status).toBe(404);
    expect((await call(selectionPost, { method: 'POST', params: P(proj), body: { assetIds: 'x' } })).status).toBe(400);
    expect(await ids(proj)).toEqual([a]);
  });

  it('removes some images or clears everything', async () => {
    const proj = await newProject(); const p = await pack('P'); const [a, b, c] = [await asset(p), await asset(p), await asset(p)]; await approve(proj, [p]);
    await add(proj, [a, b, c]);
    const r = await call(selectionDelete, { method: 'DELETE', params: P(proj), body: { assetIds: [b] } });
    expect(r.json.removed).toBe(1);
    expect(await ids(proj)).toEqual([a, c]);
    expect((await call(selectionDelete, { method: 'DELETE', params: P(proj), body: {} })).json.removed).toBe(2);
    expect(await ids(proj)).toEqual([]);
  });

  it('keeps an image selected after it is archived, shows it as archived, and refuses to select an archived image', async () => {
    const proj = await newProject(); const p = await pack('P'); const a = await asset(p); const b = await asset(p); await approve(proj, [p]);
    await add(proj, [a]);
    await call(assetArchive, { method: 'POST', params: { id: String(a) }, body: {} });
    const sel = (await call(selectionGet, { params: P(proj) })).json.selection;
    expect(sel).toHaveLength(1);
    expect(sel[0]).toMatchObject({ assetId: a, archived: true });
    await call(assetArchive, { method: 'POST', params: { id: String(b) }, body: {} });
    const r = await add(proj, [b]);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('asset_archived');
  });

  it('ties approval and selection together: a pack with selected images cannot be revoked until they are removed', async () => {
    const proj = await newProject(); const p = await pack('P'); const a = await asset(p); await approve(proj, [p]); await add(proj, [a]);
    expect((await call(revoke, { method: 'DELETE', params: { id: String(proj), packId: String(p) } })).status).toBe(409);
    await call(selectionDelete, { method: 'DELETE', params: P(proj), body: { assetIds: [a] } });
    expect((await call(revoke, { method: 'DELETE', params: { id: String(proj), packId: String(p) } })).status).toBe(200);
  });
});
