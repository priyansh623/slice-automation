/**
 * B-roll selection before generation, and the automatic timeline: real routes, services, workers and FFmpeg on an in-memory Postgres built
 * from the real migrations. Mock providers only: no Higgsfield, no Google Flow, nothing paid.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate, call, reportFakeWorker } from './helpers/studio-fakes';
import { audioHash, makeSolid } from './helpers/ffmpeg-fixtures';

const USER = '00000000-0000-4000-8000-00000000000a';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { GET as selectionGet, PUT as selectionPut } from '@/app/api/v1/video-projects/[id]/broll-selection/route';
import { POST as characterStart } from '@/app/api/v1/video-projects/[id]/broll-selection/character-start/route';
import { POST as populatePost } from '@/app/api/v1/video-projects/[id]/overlays/populate/route';
import { GET as overlaysGet } from '@/app/api/v1/video-projects/[id]/overlays/route';
import { PATCH as overlayPatch, DELETE as overlayDelete } from '@/app/api/v1/video-projects/[id]/overlays/[oid]/route';
import { POST as characterAction } from '@/app/api/v1/video-projects/[id]/character-broll/[cid]/[action]/route';
import { GET as compositionGet } from '@/app/api/v1/video-projects/[id]/composition/route';
import { POST as compilePost } from '@/app/api/v1/video-projects/[id]/compilations/route';
import { approveImage, setMotionPrompt, startClip } from '@/lib/overlays/character';
import { recommendClips } from '@/lib/broll-recommend';
import { generationRound, type GenerationDeps } from '@/lib/studio/generation';
import { MockReplacementProvider } from '@/lib/studio/mock-provider';
import { MockClipProvider } from '@/lib/overlays/mock-clip-provider';
import { processCharacterClips, type ClipDeps } from '@/worker/character-clips';
import { processOverlayIngest } from '@/worker/overlay-ingest';
import { processPendingCompilation } from '@/worker/compilation';
import { ObjectExistsError } from '@/lib/object-store/types';

class Store extends FakeR2 {
  async download(b: string, k: string) { const o = this.objects.get(`${b}/${k}`); if (!o) throw new Error(`missing ${b}/${k}`); return o.buf; }
  async put(b: string, k: string, buf: Buffer, opts: { contentType: string }) { this.objects.set(`${b}/${k}`, { buf, contentType: opts.contentType }); }
  /** Used by the composition page to give the browser links; a test only needs stable fake ones. */
  async signedReadUrls(bucket: string, keys: string[]) { return new Map(keys.map((k) => [k, `https://files.test/${bucket}/${k}`])); }
}
let pg: PGlite; let db: ReturnType<typeof drizzle<typeof schema>>; let store: Store; let dir: string; let seq = 0;
const now = 1_700_000_000_000;
beforeAll(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-selection-')); pg = new PGlite(); await migrate(pg); db = drizzle(pg, { schema }); holder.db = db; }, 180_000);
afterAll(async () => { await pg.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  store = new Store(); holder.store = store;
  process.env.BROLL_OVERLAYS_ENABLED = 'true'; process.env.STUDIO_PROVIDER = 'mock';
  await pg.exec(`truncate video_compilation_overlays, video_overlays, character_broll_items, studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects, studio_deleted_keys, studio_upload_intents, studio_worker_status, studio_budget_usage restart identity cascade; update video_compilations set status = 'failed' where status in ('pending','processing');`);
  await reportFakeWorker(pg);
});
afterEach(() => { delete process.env.BROLL_OVERLAYS_ENABLED; delete process.env.STUDIO_PROVIDER; });

const png = (c: string) => sharp({ create: { width: 400, height: 300, channels: 3, background: c } }).png().toBuffer();
/** A project with three 4 s approved Flow scenes (real clips with narration), one 3 s library clip tagged "coffee", and one Scene Pack image. */
async function world() {
  seq += 1;
  const base = `base-${seq}.png`; store.objects.set(`uploads/${base}`, { buf: await png('#aa5533'), contentType: 'image/png' });
  const [vp] = await db.insert(schema.videoProjects).values({ userId: USER, name: 'Proj', baseImagePath: base, originalScript: 'script', createdAt: now, updatedAt: now } as never).returning();
  const screens: number[] = []; const gens: number[] = [];
  const lines = ['I scroll my phone in bed.', 'I tap my card at the cafe and order coffee.', 'I check my spends at home.'];
  for (let i = 0; i < 3; i++) {
    const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: vp.id, screenNumber: i + 1, dialogue: lines[i], position: i, durationSeconds: 4, createdAt: now, updatedAt: now } as never).returning();
    const [pv] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: s.id, version: 1, promptText: 'p', source: 'manual', createdAt: now }).returning();
    const key = `clips/${seq}-${i}.mp4`; store.objects.set(`videos/${key}`, { buf: fs.readFileSync(makeSolid({ file: path.join(dir, `flow-${seq}-${i}.mp4`), color: 'blue', width: 720, height: 1280, fps: 24, seconds: 4, audioHz: 440 + i * 100 })), contentType: 'video/mp4' });
    const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: s.id, promptVersionId: pv.id, status: 'completed', videoStoragePath: key, durationSeconds: 4, createdAt: now, updatedAt: now } as never).returning();
    await db.update(schema.videoScreens).set({ approvedGenerationId: g.id }).where(eq(schema.videoScreens.id, s.id));
    screens.push(s.id); gens.push(g.id);
  }
  store.objects.set(`uploads/library/${seq}.mp4`, { buf: fs.readFileSync(makeSolid({ file: path.join(dir, `lib-${seq}.mp4`), color: 'red', width: 1920, height: 1080, fps: 25, seconds: 3, audioHz: 880 })), contentType: 'video/mp4' });
  const [clip] = await db.insert(schema.brollClips).values({ userId: USER, title: 'Coffee pour', storagePath: `library/${seq}.mp4`, durationSeconds: 3, aiTags: JSON.stringify(['coffee', 'cafe']), createdAt: now, updatedAt: now } as never).returning();
  const [pack] = await db.insert(schema.studioPacks).values({ name: `Pack ${seq}`, createdBy: USER, createdAt: now, updatedAt: now }).returning();
  const key = `studio/assets/00000000-0000-4000-8000-${String(seq).padStart(12, '0')}.png`;
  store.objects.set(`uploads/${key}`, { buf: await png('#3366cc'), contentType: 'image/png' });
  const [asset] = await db.insert(schema.studioAssets).values({ packId: pack.id, storageKey: key, mime: 'image/png', sizeBytes: 10, sha256: `h${seq}`, createdBy: USER, createdAt: now, updatedAt: now }).returning();
  return { p: vp.id, screens, gens, clip: clip.id, asset: asset.id, params: { id: String(vp.id) } };
}
type W = Awaited<ReturnType<typeof world>>;
const put = (w: W, body: unknown) => call(selectionPut, { method: 'PUT', params: w.params, body });
const get = async (w: W) => (await call(selectionGet, { params: w.params })).json;
const populate = async (w: W) => (await call(populatePost, { method: 'POST', params: w.params })).json as { created: number; moved: number; unplaced: number; sceneMissing: number; waiting: number };
const overlays = async (w: W) => (await call(overlaysGet, { params: w.params })).json.overlays as Array<Record<string, unknown> & { id: number }>;
const comp = async (w: W) => (await call(compositionGet, { params: w.params })).json;
const q = async <T>(sql: string, args: unknown[] = []) => (await pg.query<T & Record<string, unknown>>(sql, args)).rows;
const imgDeps = (p = new MockReplacementProvider({ pollsBeforeDone: 0 })): GenerationDeps => ({ provider: () => p, read: async (k) => store.downloadR2Only('uploads', k), put: async (k, b, m) => { try { await store.putR2Only('uploads', k, b, { contentType: m }); return 'created'; } catch (e) { if (e instanceof ObjectExistsError) return 'exists'; throw e; } } });
const studioRounds = async (n = 4) => { for (let i = 0; i < n; i++) { await pg.exec(`update studio_jobs set next_poll_at = 0 where status = 'processing'`); await generationRound(imgDeps(), { submit: 2, poll: 2 }); } };
const clipDeps = (p: MockClipProvider): ClipDeps => ({ provider: p, readImage: (k) => store.downloadR2Only('uploads', k), writeClip: async (k, b) => { await store.put('videos', k, b, { contentType: 'video/mp4' }); }, now: () => Date.now() });
const counts = async () => ({ jobs: (await q<{ n: number }>(`select count(*)::int as n from studio_jobs`))[0].n, items: (await q<{ n: number }>(`select count(*)::int as n from character_broll_items`))[0].n, overlays: (await q<{ n: number }>(`select count(*)::int as n from video_overlays`))[0].n });
/** Runs the existing Character B-roll steps for one started pick, up to a finished clip, with mock providers. */
async function finishCharacterClip(w: W, itemId: number) {
  await studioRounds(); await approveImage(w.p, itemId, USER); await setMotionPrompt(w.p, itemId, 'Slow push-in.'); await startClip(w.p, itemId);
  const d = clipDeps(new MockClipProvider({ pollsBeforeDone: 0 }));
  for (let i = 0; i < 6; i++) { await pg.exec(`update character_broll_items set next_poll_at = 0 where next_poll_at is not null`); await processCharacterClips(d); }
}

describe('script-based suggestions (the library\'s own search, no AI, no new data)', () => {
  const clip = (id: number, over: Record<string, unknown>) => ({ id, title: 'x', userTags: null, ...over });
  const scenes = [{ screenId: 1, dialogue: 'I tap my card at the cafe and pay.' }, { screenId: 2, dialogue: 'Quiet night.' }];
  it('suggests clips the script points to, with the scene and the reason, and nothing for a scene with no match', () => {
    const out = recommendClips(scenes, [clip(1, { title: 'Paying with a credit card', userTags: JSON.stringify(['payment', 'card']) }), clip(2, { title: 'Mountain sunrise', userTags: JSON.stringify(['travel']) })], []);
    expect(out.map((r) => r.clip.id)).toEqual([1]);
    expect(out[0].scenes).toEqual([1]); expect(out[0].why.length).toBeGreaterThan(0);
  });
  it('returns nothing when the script has no concept the library understands', () => {
    expect(recommendClips([{ screenId: 1, dialogue: 'Hmm.' }], [clip(1, { title: 'Paying' })], [])).toEqual([]);
  });
});

describe('selection storage', () => {
  it('a project with no selection returns an empty one, with its scenes, and reading creates nothing', async () => {
    const w = await world();
    const g = await get(w);
    expect(g.selection).toEqual({ version: 1, generic: [], character: [] });
    expect(g.scenes).toHaveLength(3);
    expect(await counts()).toEqual({ jobs: 0, items: 0, overlays: 0 });          // suggestions select nothing
    expect((await q<{ s: unknown }>(`select broll_selection as s from video_projects where id = $1`, [w.p]))[0].s).toBeNull();
  });

  it('saves IDs per scene, survives reading again (refresh), and creates no overlay, no item and no job', async () => {
    const w = await world();
    const r = await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[1] }], character: [{ assetId: w.asset, screenId: w.screens[1], action: 'taps card' }] });
    expect(r.status).toBe(200);
    const back = await get(w);
    expect(back.selection).toEqual({ version: 1, generic: [{ clipId: w.clip, screenId: w.screens[1] }], character: [{ assetId: w.asset, screenId: w.screens[1], action: 'taps card' }] });
    expect(back.previews.assets[w.asset]).toMatch(/^https:\/\/files\.test\//);                                      // a picture link for the chosen image
    expect(await counts()).toEqual({ jobs: 0, items: 0, overlays: 0 });
  });

  it('validates scenes, clips and images, ignores duplicates, and respects the overlay limit', async () => {
    const w = await world();
    expect((await put(w, { generic: [{ clipId: w.clip, screenId: 999999 }] })).json.code).toBe('scene_not_found');
    expect((await put(w, { generic: [{ clipId: 999999, screenId: w.screens[0] }] })).json.code).toBe('clip_not_found');
    expect((await put(w, { character: [{ assetId: 999999, screenId: w.screens[0] }] })).json.code).toBe('asset_not_found');
    expect((await put(w, { generic: [{ clipId: 'x', screenId: 1 }] })).status).toBe(400);
    const dup = await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }, { clipId: w.clip, screenId: w.screens[0] }] });
    expect(dup.json.selection.generic).toHaveLength(1);
    process.env.BROLL_OVERLAY_LIMIT = '1';
    try { expect((await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }, { clipId: w.clip, screenId: w.screens[1] }] })).json.code).toBe('overlay_limit'); } finally { delete process.env.BROLL_OVERLAY_LIMIT; }
  });

  it('is off (404) when the B-roll feature flag is off, and existing projects are untouched', async () => {
    const w = await world();
    process.env.BROLL_OVERLAYS_ENABLED = 'false';
    try { expect((await call(selectionGet, { params: w.params })).status).toBe(404); expect((await call(populatePost, { method: 'POST', params: w.params })).status).toBe(404); } finally { process.env.BROLL_OVERLAYS_ENABLED = 'true'; }
  });
});

describe('Generic B-roll reaches Composition on its own', () => {
  it('puts a selected clip on its scene, automatically placed, once; opening Composition again changes nothing', async () => {
    const w = await world();
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[1] }] });
    expect(await populate(w)).toMatchObject({ created: 1, waiting: 0 });
    await processOverlayIngest();
    let [o] = await overlays(w);
    expect(o).toMatchObject({ kind: 'generic', anchorScreenId: w.screens[1], placementSource: 'auto', status: 'ready', startOffsetMs: 500, startMs: 4500, endMs: 7500 });   // centred in its 4 s scene
    for (let i = 0; i < 3; i++) expect(await populate(w)).toMatchObject({ created: 0, moved: 0 });
    expect(await overlays(w)).toHaveLength(1);
    expect((await get(w)).selection.generic[0].overlayId).toBe(o.id);
    [o] = await overlays(w); expect(o.startOffsetMs).toBe(500);
  }, 120_000);

  it('never brings back a clip the person removed from the timeline', async () => {
    const w = await world();
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }] }); await populate(w);
    const [o] = await overlays(w);
    expect((await call(overlayDelete, { method: 'DELETE', params: { ...w.params, oid: String(o.id) } })).status).toBe(200);
    expect(await populate(w)).toMatchObject({ created: 0 });
    expect(await overlays(w)).toHaveLength(0);
  });

  it('a person\'s edit makes the placement manual and automatic arrangement never moves it, while untouched ones still follow the scene', async () => {
    const w = await world();
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }, { clipId: w.clip, screenId: w.screens[2] }] }); await populate(w);
    const list = await overlays(w); const first = list.find((o) => o.anchorScreenId === w.screens[0])!; const last = list.find((o) => o.anchorScreenId === w.screens[2])!;
    expect(list.every((o) => o.placementSource === 'auto')).toBe(true);
    expect((await call(overlayPatch, { method: 'PATCH', params: { ...w.params, oid: String(first.id) }, body: { startOffsetMs: 100 } })).json.placementSource).toBe('manual');
    await q(`update video_screens set duration_seconds = 8 where id = $1`, [w.screens[2]]);
    await q(`update video_generations set duration_seconds = 8 where video_screen_id = $1`, [w.screens[2]]);          // the last scene turned out longer
    const again = await populate(w);
    expect(again.moved).toBe(1);                                                                                    // only the automatic one followed
    const rows = await q<{ id: number; start_offset_ms: number; placement_source: string }>(`select id, start_offset_ms, placement_source from video_overlays order by id`);
    expect(rows.find((r) => r.id === first.id)).toMatchObject({ start_offset_ms: 100, placement_source: 'manual' });
    expect(rows.find((r) => r.id === last.id)).toMatchObject({ placement_source: 'auto' });
    expect(rows.find((r) => r.id === last.id)!.start_offset_ms).toBe(2500);                                         // centred in 8 s: (8 - 3) / 2
    expect(await populate(w)).toMatchObject({ moved: 0 });
  });

  it('keeps two clips for one scene apart, routing around a clip the person placed', async () => {
    const w = await world();
    const second = (await db.insert(schema.brollClips).values({ userId: USER, title: 'B', storagePath: `library/${seq}.mp4`, durationSeconds: 3, createdAt: now, updatedAt: now } as never).returning())[0];
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }] }); await populate(w);
    const [a] = await overlays(w);
    await call(overlayPatch, { method: 'PATCH', params: { ...w.params, oid: String(a.id) }, body: { startOffsetMs: 0 } });   // manual, 0 - 3 s
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }, { clipId: second.id, screenId: w.screens[0] }] });
    const r = await populate(w);
    expect(r.created + r.unplaced).toBe(1);
    if (r.created) { const o = (await overlays(w)).find((x) => x.id !== a.id)!; expect(Number(o.startMs)).toBeGreaterThanOrEqual(3000); }   // after the person's clip (0 to 3 s of this scene), not on top of it
  });

  it('dropping a pick removes its automatic overlay but keeps one the person edited', async () => {
    const w = await world();
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }, { clipId: w.clip, screenId: w.screens[1] }] }); await populate(w);
    const [a, b] = await overlays(w);
    await call(overlayPatch, { method: 'PATCH', params: { ...w.params, oid: String(b.id) }, body: { startOffsetMs: 200 } });
    await put(w, { generic: [] });
    const left = await overlays(w);
    expect(left.map((o) => o.id)).toEqual([b.id]); void a;
  });

  it('a scene that was deleted is reported, not re-attached', async () => {
    const w = await world();
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[2] }] });
    await q(`update video_screens set screen_number = -3 where id = $1`, [w.screens[2]]);
    expect(await populate(w)).toMatchObject({ created: 0, sceneMissing: 1 });
    expect(await overlays(w)).toHaveLength(0);
  });
});

describe('Character B-roll goes through the existing Generation process, then lands on its scene', () => {
  const start = (w: W, screen = 0) => call(characterStart, { method: 'POST', params: w.params, body: { assetId: w.asset, screenId: w.screens[screen] } });

  it('selecting does not start anything; starting makes the existing item and ONE job; a double click cannot make two', async () => {
    const w = await world();
    await put(w, { character: [{ assetId: w.asset, screenId: w.screens[1], action: 'taps card' }] });
    expect(await counts()).toEqual({ jobs: 0, items: 0, overlays: 0 });
    expect((await start(w, 0)).status).toBe(404);                                                                  // not selected for that scene
    const [a, b] = await Promise.all([start(w, 1), start(w, 1)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await counts()).toEqual({ jobs: 1, items: 1, overlays: 0 });
    const item = (await q<{ id: number; intended_action: string; image_status: string }>(`select id, intended_action, image_status from character_broll_items`))[0];
    expect(item).toMatchObject({ intended_action: 'taps card', image_status: 'generating' });
    expect((await get(w)).selection.character[0].itemId).toBe(item.id);
    expect((await start(w, 1)).status).toBe(409);
    expect((await put(w, { character: [] })).json.code).toBe('already_started');                                   // paid work exists: it cannot just disappear
  });

  it('keeps the approval gate: the video cannot start before the image is approved, and nothing reaches Composition until the video is ready', async () => {
    const w = await world();
    await put(w, { character: [{ assetId: w.asset, screenId: w.screens[1], action: '' }] });
    const itemId = (await start(w, 1)).json.id as number;
    await expect(startClip(w.p, itemId)).rejects.toMatchObject({ code: expect.stringMatching(/image_not_approved|not_approved/) });
    expect(await populate(w)).toMatchObject({ created: 0, waiting: 1 });
    await studioRounds(); await approveImage(w.p, itemId, USER);
    expect(await populate(w)).toMatchObject({ created: 0, waiting: 1 });                                          // approved, but still no video
    expect(await overlays(w)).toHaveLength(0);
  });

  it('when the video is ready it appears on its selected scene, automatically placed and silent-ready, once', async () => {
    const w = await world();
    await put(w, { character: [{ assetId: w.asset, screenId: w.screens[1], action: 'taps card' }] });
    const itemId = (await start(w, 1)).json.id as number;
    await finishCharacterClip(w, itemId);
    const jobsBefore = await counts();
    expect(await populate(w)).toMatchObject({ created: 1, waiting: 0 });
    const [o] = await overlays(w);
    expect(o).toMatchObject({ kind: 'character', anchorScreenId: w.screens[1], characterItemId: itemId, placementSource: 'auto', status: 'ready', durationMs: 5000 });
    expect(o.startOffsetMs).toBe(0);                                                                              // a 5 s clip is longer than the 4 s scene: starts with it
    for (let i = 0; i < 3; i++) expect(await populate(w)).toMatchObject({ created: 0, moved: 0 });
    expect(await overlays(w)).toHaveLength(1);
    expect((await counts()).jobs).toBe(jobsBefore.jobs);                                                          // revisiting costs nothing
    expect((await get(w)).selection.character[0].overlayId).toBe(o.id);
  }, 180_000);

  it('revisiting the selection, Generation data and Composition never starts a paid job', async () => {
    const w = await world();
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }], character: [{ assetId: w.asset, screenId: w.screens[1], action: '' }] });
    const before = await counts();
    for (let i = 0; i < 3; i++) { await get(w); await populate(w); await comp(w); }
    const after = await counts();
    expect({ jobs: after.jobs, items: after.items }).toEqual({ jobs: before.jobs, items: before.items });
    expect((await q<{ n: number }>(`select count(*)::int as n from studio_budget_usage`))[0].n).toBe(0);
  });
});

describe('compilation is unchanged', () => {
  it('compiles the automatic arrangement; the Flow narration is bit-identical to a compile without B-roll', async () => {
    const w = await world();
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }], character: [{ assetId: w.asset, screenId: w.screens[2], action: '' }] });
    const itemId = (await call(characterStart, { method: 'POST', params: w.params, body: { assetId: w.asset, screenId: w.screens[2] } })).json.id as number;
    await finishCharacterClip(w, itemId);
    await populate(w); await processOverlayIngest();
    expect((await comp(w)).overlays).toHaveLength(2);
    const scenes = w.screens.map((s, i) => ({ videoScreenId: s, videoGenerationId: w.gens[i] }));
    const withBroll = await call(compilePost, { method: 'POST', params: w.params, body: { scenes } });
    expect(withBroll.status).toBe(201); expect(withBroll.json.overlayCount).toBe(2);
    await processPendingCompilation();
    const [done] = await q<{ status: string; output_storage_path: string; error_message: string | null }>(`select status, output_storage_path, error_message from video_compilations where id = $1`, [withBroll.json.id]);
    expect(done.error_message).toBeNull(); expect(done.status).toBe('completed');
    for (const o of await overlays(w)) await call(overlayDelete, { method: 'DELETE', params: { ...w.params, oid: String(o.id) } });
    const plain = await call(compilePost, { method: 'POST', params: w.params, body: { scenes } });
    expect(plain.json.overlayCount).toBe(0);
    await processPendingCompilation();
    const [p2] = await q<{ output_storage_path: string }>(`select output_storage_path from video_compilations where id = $1`, [plain.json.id]);
    const f1 = path.join(dir, `sel-${seq}-a.mp4`); const f2 = path.join(dir, `sel-${seq}-b.mp4`);
    fs.writeFileSync(f1, store.objects.get(`videos/${done.output_storage_path}`)!.buf); fs.writeFileSync(f2, store.objects.get(`videos/${p2.output_storage_path}`)!.buf);
    expect(audioHash(f1)).toBe(audioHash(f2));
  }, 300_000);

  it('a project with no selection populates nothing and compiles exactly as before', async () => {
    const w = await world();
    expect(await populate(w)).toEqual({ created: 0, moved: 0, unplaced: 0, sceneMissing: 0, waiting: 0 });
    const r = await call(compilePost, { method: 'POST', params: w.params, body: { scenes: w.screens.map((s, i) => ({ videoScreenId: s, videoGenerationId: w.gens[i] })) } });
    expect(r.status).toBe(201); expect(r.json.overlayCount).toBe(0);
  });
});

describe('review: authorization-neutral edges and leftovers', () => {
  it('a pick whose scene was deleted does not block saving other picks, and is not re-attached', async () => {
    const w = await world();
    await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[2] }] });
    await q(`update video_screens set screen_number = -3 where id = $1`, [w.screens[2]]);
    const r = await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[2] }, { clipId: w.clip, screenId: w.screens[0] }] });
    expect(r.status).toBe(200); expect(r.json.selection.generic).toHaveLength(2);
    expect((await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[2] }, { clipId: w.clip, screenId: 999999 }] })).json.code).toBe('scene_not_found');   // a NEW pick still needs a live scene
    expect(await populate(w)).toMatchObject({ created: 1, sceneMissing: 1 });
  });

  it('every kind of edit by a person (move, resize, trim, change scene, replace) makes the overlay manual', async () => {
    const w = await world();
    const second = (await db.insert(schema.brollClips).values({ userId: USER, title: 'B', storagePath: `library/${seq}.mp4`, durationSeconds: 3, createdAt: now, updatedAt: now } as never).returning())[0];
    const patches: Array<Record<string, unknown>> = [{ startOffsetMs: 300 }, { durationMs: 1500 }, { sourceStartMs: 500 }, { anchorScreenId: w.screens[1] }, { replaceWithBrollClipId: second.id }];
    for (const body of patches) {
      await q(`delete from video_overlays`); await put(w, { generic: [] }); await put(w, { generic: [{ clipId: w.clip, screenId: w.screens[0] }] }); await populate(w);
      const [o] = await overlays(w); expect(o.placementSource).toBe('auto');
      const r = await call(overlayPatch, { method: 'PATCH', params: { ...w.params, oid: String(o.id) }, body });
      expect([200, 201].includes(r.status) ? r.json.placementSource : r.json).toBe('manual');
    }
  });

  it('Composition has no way to start, approve, prompt, generate or place Character B-roll', async () => {
    const w = await world();
    await put(w, { character: [{ assetId: w.asset, screenId: w.screens[0], action: '' }] });
    const itemId = (await call(characterStart, { method: 'POST', params: w.params, body: { assetId: w.asset, screenId: w.screens[0] } })).json.id as number;
    const r = await call(characterAction, { method: 'POST', params: { ...w.params, cid: String(itemId), action: 'place' }, body: {} });
    expect(r.status).toBe(404);                                                                                    // the old "add to timeline" action is gone
    expect(await overlays(w)).toHaveLength(0);
  });

  it('a start that died after creating its item is taken over, not paid for twice', async () => {
    const w = await world();
    await put(w, { character: [{ assetId: w.asset, screenId: w.screens[0], action: 'x' }] });
    const first = (await call(characterStart, { method: 'POST', params: w.params, body: { assetId: w.asset, screenId: w.screens[0] } })).json.id as number;
    const old = Date.now() - 10 * 60_000;
    await q(`update character_broll_items set created_at = $1`, [old]);
    await q(`update video_projects set broll_selection = jsonb_set(broll_selection, '{character,0}', (broll_selection->'character'->0) - 'itemId' || jsonb_build_object('startingAt', $2::bigint)) where id = $1`, [w.p, old]);
    const again = await call(characterStart, { method: 'POST', params: w.params, body: { assetId: w.asset, screenId: w.screens[0] } });
    expect(again.status).toBe(201); expect(again.json.id).toBe(first);
    expect(await counts()).toMatchObject({ jobs: 1, items: 1 });
    expect((await get(w)).selection.character[0].itemId).toBe(first);
  });
});
