/**
 * Studio projects through their real routes: shared access, the one character image in R2, the script, the pack profile and
 * the recommendation call. Real sharp and routes; in-memory Postgres from the repository's migrations; auth, storage and the
 * model are replaced.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate, call } from './helpers/studio-fakes';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const holder = vi.hoisted(() => ({
  db: undefined as unknown, store: undefined as unknown, userId: '00000000-0000-4000-8000-00000000000a' as string | null,
  aiConfigured: true, create: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId } : null } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));
vi.mock('@/lib/studio/ai-client', () => ({ aiConfigured: () => holder.aiConfigured, getStudioClient: () => ({ messages: { create: (...a: unknown[]) => (holder.create as (...x: unknown[]) => unknown)(...a) } }) }));

import { GET as projectsGet, POST as projectsPost } from '@/app/api/v1/studio/projects/route';
import { GET as projectGet, PUT as projectPut } from '@/app/api/v1/studio/projects/[id]/route';
import { POST as charInit } from '@/app/api/v1/studio/projects/[id]/character/init/route';
import { POST as charComplete } from '@/app/api/v1/studio/projects/[id]/character/complete/route';
import { POST as analyze } from '@/app/api/v1/studio/projects/[id]/analyze/route';
import { GET as projectPacksGet, POST as projectPacksPost } from '@/app/api/v1/studio/projects/[id]/packs/route';
import { DELETE as packRevoke } from '@/app/api/v1/studio/projects/[id]/packs/[packId]/route';
import { GET as approvedAssets } from '@/app/api/v1/studio/projects/[id]/packs/[packId]/assets/route';
import { computePackProfile, buildRecommendationPrompt, sanitiseRecommendations } from '@/lib/studio/recommend';

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
let r2: FakeR2;
beforeAll(async () => { pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(() => { r2 = new FakeR2(); holder.store = r2; holder.userId = USER_A; holder.aiConfigured = true; holder.create = vi.fn(); });

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (color: string, w = 1000, h = 1400) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const P = (id: number) => ({ id: String(id) });
const newProject = async (name = 'Ad one') => { const r = await call(projectsPost, { method: 'POST', body: { name } }); if (r.status !== 201) throw new Error(JSON.stringify(r.json)); return r.json.project.id as number; };
const toolReply = (recs: unknown) => ({ content: [{ type: 'tool_use', name: 'recommend_scene_packs', id: 't', input: { recommendations: recs } }] });

let seq = 0;
async function pack(name: string, desc: string | null = null) {
  const now = Date.now();
  return (await db.insert(schema.studioPacks).values({ name, description: desc, createdBy: USER_A, createdAt: now, updatedAt: now }).returning())[0].id;
}
async function asset(packId: number, ai: Record<string, unknown> | null = null, manual: Record<string, unknown> = {}, status = 'completed') {
  const now = Date.now();
  const [a] = await db.insert(schema.studioAssets).values({ packId, storageKey: `studio/assets/s${++seq}.png`, mime: 'image/png', sizeBytes: 5, sha256: `s${seq}`, analysisStatus: status, createdBy: USER_A, createdAt: now, updatedAt: now }).returning();
  await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, ai, manual, createdAt: now, updatedAt: now });
  return a.id;
}

describe('access', () => {
  it('rejects every project route without a signed-in user, and lets any signed-in user manage anyone\'s project', async () => {
    holder.userId = USER_A;
    const id = await newProject('Shared');
    holder.userId = null;
    const calls: Array<[unknown, Parameters<typeof call>[1]]> = [
      [projectsGet, {}], [projectsPost, { method: 'POST', body: { name: 'x' } }], [projectGet, { params: P(id) }], [projectPut, { method: 'PUT', params: P(id), body: { name: 'x' } }],
      [charInit, { method: 'POST', params: P(id), body: {} }], [charComplete, { method: 'POST', params: P(id), body: {} }], [analyze, { method: 'POST', params: P(id) }],
      [projectPacksGet, { params: P(id) }], [projectPacksPost, { method: 'POST', params: P(id), body: { packIds: [1] } }],
      [packRevoke, { method: 'DELETE', params: { id: String(id), packId: '1' } }], [approvedAssets, { params: { id: String(id), packId: '1' } }],
    ];
    for (const [h, o] of calls) expect((await call(h, o)).status).toBe(401);

    holder.userId = USER_B;
    expect((await call(projectPut, { method: 'PUT', params: P(id), body: { name: 'Renamed by B', script: 'B wrote this script.' } })).status).toBe(200);
    expect((await call(projectGet, { params: P(id) })).json.project).toMatchObject({ name: 'Renamed by B', script: 'B wrote this script.', createdBy: USER_A });
    expect((await call(projectsGet)).json.projects.some((p: any) => p.id === id)).toBe(true);
  });
});

describe('project and script', () => {
  it('creates, lists, renames and saves the complete script, and validates input', async () => {
    const id = await newProject('Launch');
    expect((await call(projectsPost, { method: 'POST', body: { name: '  ' } })).status).toBe(400);
    const r = await call(projectPut, { method: 'PUT', params: P(id), body: { script: 'Scene one.\nScene two.' } });
    expect(r.json.project.script).toBe('Scene one.\nScene two.');
    const row = (await db.select().from(schema.studioProjects).where(eq(schema.studioProjects.id, id)))[0];
    expect(row.scriptHash).toBe(crypto.createHash('sha256').update('Scene one.\nScene two.').digest('hex'));
    expect((await call(projectPut, { method: 'PUT', params: P(id), body: { script: 'x'.repeat(50_001) } })).status).toBe(400);
    expect((await call(projectPut, { method: 'PUT', params: P(id), body: {} })).status).toBe(400);
    expect((await call(projectGet, { params: P(999999) })).status).toBe(404);
    await call(projectPut, { method: 'PUT', params: P(id), body: { archived: true } });
    expect((await call(projectsGet)).json.projects.some((p: any) => p.id === id)).toBe(false);
  });
});

describe('the one character image: R2 only, verified, original untouched', () => {
  async function uploadCharacter(id: number, buf: Buffer) {
    const init = await call(charInit, { method: 'POST', params: P(id), body: { contentType: 'image/png', fileSize: buf.length, fileName: 'c.png' } });
    if (init.status !== 200) return { init, done: null as null };
    r2.browserPut(init.json.storageKey, buf, 'image/png');
    const done = await call(charComplete, { method: 'POST', params: P(id), body: { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: buf.length } });
    return { init, done };
  }

  it('stores the original unchanged in R2 with a thumbnail, records it, and refuses when R2 is unavailable', async () => {
    const id = await newProject();
    r2.available = false;
    const down = await call(charInit, { method: 'POST', params: P(id), body: { contentType: 'image/png', fileSize: 1000 } });
    expect(down.status).toBe(503);
    r2.available = true;

    const buf = await png('#884422', 3000, 4000);
    const { init, done } = await uploadCharacter(id, buf);
    expect(init.json.storageKey).toMatch(new RegExp(`^studio/projects/${id}/character/[0-9a-f-]{36}\\.png$`));
    expect(done!.status).toBe(200);
    expect(done!.json.project).toMatchObject({ hasCharacter: true });
    const key = init.json.storageKey as string;
    expect(sha(r2.get(key))).toBe(sha(buf));
    expect(r2.puts.some((k) => k.includes('/character/thumbs/'))).toBe(true);
    expect(r2.puts).not.toContain(key); // the server never wrote the original
    expect((await db.select().from(schema.storageObjects).where(eq(schema.storageObjects.key, key)))[0]).toMatchObject({ provider: 'r2', sha256: sha(buf) });
    expect((await db.select().from(schema.studioProjects).where(eq(schema.studioProjects.id, id)))[0]).toMatchObject({ characterKey: key, characterMime: 'image/png' });
  });

  it('changing the character keeps the earlier image in R2, byte for byte', async () => {
    const id = await newProject();
    const first = await png('#111111'); const second = await png('#eeeeee');
    const a = await uploadCharacter(id, first);
    const b = await uploadCharacter(id, second);
    const k1 = a.init.json.storageKey as string; const k2 = b.init.json.storageKey as string;
    expect((await db.select().from(schema.studioProjects).where(eq(schema.studioProjects.id, id)))[0].characterKey).toBe(k2);
    expect(r2.has(k1)).toBe(true);
    expect(sha(r2.get(k1))).toBe(sha(first));
    expect(r2.deletes).not.toContain(k1);
  });

  it('rejects another project\'s folder, a missing upload, a wrong size and a non-image, and completing twice is harmless', async () => {
    const id = await newProject(); const other = await newProject('other');
    const ok = await png('#223344');
    const init = await call(charInit, { method: 'POST', params: P(id), body: { contentType: 'image/png', fileSize: ok.length } });
    const body = { storageKey: init.json.storageKey, contentType: 'image/png', fileSize: ok.length };
    expect((await call(charComplete, { method: 'POST', params: P(other), body })).status).toBe(403);   // not this project's folder
    expect((await call(charComplete, { method: 'POST', params: P(id), body })).status).toBe(409);      // never uploaded
    r2.browserPut(init.json.storageKey, ok, 'image/png');
    expect((await call(charComplete, { method: 'POST', params: P(id), body: { ...body, fileSize: ok.length + 1 } })).status).toBe(422);
    r2.browserPut(init.json.storageKey, ok, 'image/png');
    expect((await call(charComplete, { method: 'POST', params: P(id), body })).status).toBe(200);
    expect((await call(charComplete, { method: 'POST', params: P(id), body })).status).toBe(200);
    const junk = Buffer.from('not an image');
    const init2 = await call(charInit, { method: 'POST', params: P(other), body: { contentType: 'image/png', fileSize: junk.length } });
    r2.browserPut(init2.json.storageKey, junk, 'image/png');
    expect((await call(charComplete, { method: 'POST', params: P(other), body: { storageKey: init2.json.storageKey, contentType: 'image/png', fileSize: junk.length } })).json.code).toBe('not_an_image');
  });
});

describe('pack profiles use the effective metadata (manual over AI)', () => {
  it('counts what the images show, with a person\'s edit replacing the AI value', async () => {
    const p = await pack('Mixed');
    await asset(p, { environment: 'Kitchen', activity: 'cooking', objects_props: 'pan, knife', tags: ['food'] });
    await asset(p, { environment: 'kitchen', activity: 'cooking' });
    await asset(p, { environment: 'office', activity: 'typing' }, { environment: 'Kitchen' });   // edited by a person
    await asset(p, null, {}, 'failed');                                                          // no metadata at all
    const profile = await computePackProfile(p);
    expect(profile.environments).toEqual(['kitchen']);            // 3 kitchen values (two AI, one manual); "office" was replaced
    expect(profile.activities[0]).toBe('cooking');
    expect(profile.objects).toEqual(['knife', 'pan']);
    expect(profile).toMatchObject({ imageCount: 4, analysedCount: 3 });
  });
});

describe('script analysis and recommendations', () => {
  it('needs a script and a configured model', async () => {
    const id = await newProject();
    expect((await call(analyze, { method: 'POST', params: P(id) })).status).toBe(400);
    await call(projectPut, { method: 'PUT', params: P(id), body: { script: 'A day at home.' } });
    holder.aiConfigured = false;
    const r = await call(analyze, { method: 'POST', params: P(id) });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('ai_not_configured');
  });

  it('sends the whole script and pack-level information, keeps only real packs, bounds scores, and stores the result for this script', async () => {
    const kitchen = await pack('Kitchens', 'Home kitchens and cooking');
    const airport = await pack('Airports', 'Travel hubs');
    await asset(kitchen, { environment: 'sunny kitchen', activity: 'cooking' });
    const id = await newProject();
    const script = 'She wakes up and makes breakfast in her kitchen. Later she rushes to the airport.';
    await call(projectPut, { method: 'PUT', params: P(id), body: { script } });
    holder.create = vi.fn(async () => toolReply([
      { pack_id: airport, score: 0.4, reasons: ['Travel scene at the end'], moments: ['rushes to the airport'] },
      { pack_id: kitchen, score: 1.7, reasons: ['Breakfast in the kitchen'], moments: ['makes breakfast'] },
      { pack_id: 999999, score: 0.9, reasons: ['made up'], moments: [] },
      { pack_id: kitchen, score: 0.1, reasons: ['duplicate'], moments: [] },
    ]));
    const res = await call(analyze, { method: 'POST', params: P(id) });
    expect(res.status).toBe(200);
    const p = res.json.project;
    expect(p.analysis).toMatchObject({ status: 'completed', current: true });
    expect(p.recommendations.map((r: any) => [r.packId, r.score, r.name])).toEqual([[kitchen, 1, 'Kitchens'], [airport, 0.4, 'Airports']]);
    expect(p.recommendations[0]).toMatchObject({ reasons: ['Breakfast in the kitchen'], moments: ['makes breakfast'] });

    const args = (holder.create.mock.calls[0] as unknown as [Record<string, any>])[0];
    const prompt = args.messages[0].content as string;
    expect(prompt).toContain(script);
    expect(prompt).toContain('Kitchens');
    expect(prompt).toContain('sunny kitchen');                      // pack-level information built from the images
    expect(prompt).toContain('Home kitchens and cooking');
    expect(JSON.stringify(args)).not.toMatch(/studio\/assets|\.png/); // no image bytes or file names are sent
    expect(args.tool_choice).toEqual({ type: 'auto' });
  });

  it('returns the stored result for an unchanged script without calling the model again, and marks it out of date when the script changes', async () => {
    const k = await pack('Kitchens');
    const id = await newProject();
    await call(projectPut, { method: 'PUT', params: P(id), body: { script: 'Breakfast.' } });
    holder.create = vi.fn(async () => toolReply([{ pack_id: k, score: 0.8, reasons: ['r'], moments: ['m'] }]));
    await call(analyze, { method: 'POST', params: P(id) });
    await call(analyze, { method: 'POST', params: P(id) });
    expect(holder.create).toHaveBeenCalledTimes(1);
    const changed = await call(projectPut, { method: 'PUT', params: P(id), body: { script: 'Dinner instead.' } });
    expect(changed.json.project.analysis.current).toBe(false);
    expect(changed.json.project.recommendations).toHaveLength(1);     // the earlier result is still shown, marked out of date
    await call(analyze, { method: 'POST', params: P(id) });
    expect(holder.create).toHaveBeenCalledTimes(2);
    await call(analyze, { method: 'POST', params: P(id), body: { force: true } });
    expect(holder.create).toHaveBeenCalledTimes(3);
  });

  it('records a failure visibly, keeps the script, and a retry works; a run in progress is not started twice', async () => {
    const id = await newProject();
    await call(projectPut, { method: 'PUT', params: P(id), body: { script: 'Some script.' } });
    holder.create = vi.fn(async () => { throw Object.assign(new Error('request body with secrets'), { status: 529, name: 'APIError' }); });
    const bad = await call(analyze, { method: 'POST', params: P(id) });
    expect(bad.status).toBe(502);
    expect(JSON.stringify(bad.json)).not.toContain('secrets');
    const mid = (await call(projectGet, { params: P(id) })).json.project;
    expect(mid.script).toBe('Some script.');
    expect(mid.analysis).toMatchObject({ status: 'failed', error: expect.stringContaining('could not be analysed') });
    holder.create = vi.fn(async () => toolReply([]));
    expect((await call(analyze, { method: 'POST', params: P(id) })).status).toBe(200);

    await db.update(schema.studioProjects).set({ analysisStatus: 'processing', analysisAt: Date.now() }).where(eq(schema.studioProjects.id, id));
    expect((await call(analyze, { method: 'POST', params: P(id), body: { force: true } })).status).toBe(409);
    await db.update(schema.studioProjects).set({ analysisAt: Date.now() - 5 * 60_000 }).where(eq(schema.studioProjects.id, id));
    expect((await call(analyze, { method: 'POST', params: P(id), body: { force: true } })).status).toBe(200); // abandoned run: start over
  });

  it('prompt building and sanitising are bounded', () => {
    expect(buildRecommendationPrompt(' hi ', [{ id: 3, name: 'N', description: null, profile: null }])).toContain('Images: none analysed yet');
    expect(sanitiseRecommendations({ recommendations: 'nope' }, new Set([1]))).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ({ pack_id: i + 1, score: 0.5 }));
    expect(sanitiseRecommendations({ recommendations: many }, new Set(many.map((m) => m.pack_id)))).toHaveLength(12);
  });
});
