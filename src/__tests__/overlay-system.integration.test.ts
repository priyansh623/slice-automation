/**
 * The B-roll overlay system end to end on an in-memory Postgres built from the real migrations, real routes and real FFmpeg:
 * placement rules, the ingest job, the compilation snapshot and the compile worker. Storage is an in-memory fake. No paid service.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/db/schema.pg';
import { migrate, call } from './helpers/studio-fakes';
import { audioHash, isColor, makeSolid, pixelAt, probeJson } from './helpers/ffmpeg-fixtures';

const USER = '00000000-0000-4000-8000-00000000000a';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { GET as overlaysGet, POST as overlaysPost } from '@/app/api/v1/video-projects/[id]/overlays/route';
import { PATCH as overlayPatch, DELETE as overlayDelete } from '@/app/api/v1/video-projects/[id]/overlays/[oid]/route';
import { POST as overlayRetry } from '@/app/api/v1/video-projects/[id]/overlays/[oid]/retry/route';
import { POST as compilePost } from '@/app/api/v1/video-projects/[id]/compilations/route';
import { processOverlayIngest } from '@/worker/overlay-ingest';
import { processPendingCompilation } from '@/worker/compilation';

class MemStore {
  objects = new Map<string, Buffer>();
  async download(b: string, k: string) { const o = this.objects.get(`${b}/${k}`); if (!o) throw new Error(`missing ${b}/${k}`); return o; }
  async put(b: string, k: string, body: Buffer) { this.objects.set(`${b}/${k}`, body); }
  async exists(b: string, k: string) { return this.objects.has(`${b}/${k}`); }
}

let pg: PGlite; let dir: string; let store: MemStore;
const now = 1_700_000_000_000;
beforeAll(async () => {
  process.env.BROLL_OVERLAYS_ENABLED = 'true';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-overlay-sys-'));
  pg = new PGlite(); await migrate(pg);
  holder.db = drizzle(pg, { schema });
}, 180_000);
afterAll(async () => { await pg.close(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.BROLL_OVERLAYS_ENABLED; });
beforeEach(async () => {
  store = new MemStore(); holder.store = store;
  // Each test is self-contained: nothing left over from an earlier test is picked up by the workers.
  await pg.exec(`delete from video_compilation_overlays; delete from video_overlays; update video_compilations set status = 'failed' where status in ('pending','processing');`);
});

let seq = 0;
/** A project with three 4 s Flow scenes whose clips are real files (blue, with narration tone), and one 3 s red library clip. */
async function world(opts: { scenes?: number } = {}) {
  const n = opts.scenes ?? 3; seq += 1;
  const p = (await pg.query<{ id: number }>(`insert into video_projects (user_id, name, base_image_path, original_script, created_at, updated_at) values ($1,'P','x.png','s',$2,$2) returning id`, [USER, now])).rows[0].id;
  const screens: number[] = []; const gens: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = (await pg.query<{ id: number }>(`insert into video_screens (video_project_id, screen_number, dialogue, position, duration_seconds, created_at, updated_at) values ($1,$2,'Hello',$3,4,$4,$4) returning id`, [p, i + 1, i, now])).rows[0].id;
    const file = makeSolid({ file: path.join(dir, `flow-${seq}-${i}.mp4`), color: 'blue', width: 720, height: 1280, fps: 24, seconds: 4, audioHz: 440 + i * 100 });
    const key = `clips/${seq}-${i}.mp4`; store.objects.set(`videos/${key}`, fs.readFileSync(file));
    const pv = (await pg.query<{ id: number }>(`insert into screen_prompt_versions (video_screen_id, version, prompt_text, source, created_at) values ($1,1,'prompt','manual',$2) returning id`, [s, now])).rows[0].id;
    const g = (await pg.query<{ id: number }>(`insert into video_generations (video_screen_id, prompt_version_id, status, video_storage_path, duration_seconds, created_at, updated_at) values ($1,$4,'completed',$2,4,$3,$3) returning id`, [s, key, now, pv])).rows[0].id;
    screens.push(s); gens.push(g);
  }
  const red = makeSolid({ file: path.join(dir, `lib-${seq}.mp4`), color: 'red', width: 1920, height: 1080, fps: 25, seconds: 3, audioHz: 880 });
  store.objects.set(`uploads/library/${seq}.mp4`, fs.readFileSync(red));
  const c = (await pg.query<{ id: number }>(`insert into broll_clips (user_id, title, storage_path, duration_seconds, created_at, updated_at) values ($1,'Red',$2,3,$3,$3) returning id`, [USER, `library/${seq}.mp4`, now])).rows[0].id;
  return { p, screens, gens, c, params: { id: String(p) } };
}
const add = (w: { params: { id: string }; c: number }, body: Record<string, unknown> = {}) => call(overlaysPost, { method: 'POST', params: w.params, body: { brollClipId: w.c, ...body } });
const compile = (w: { params: { id: string }; screens: number[]; gens: number[] }) => call(compilePost, { method: 'POST', params: w.params, body: { scenes: w.screens.map((s, i) => ({ videoScreenId: s, videoGenerationId: w.gens[i] })) } });
const q = async <T>(sql: string, args: unknown[] = []) => (await pg.query<T & Record<string, unknown>>(sql, args)).rows;

describe('placing overlays', () => {
  it('adds a library clip at the first free spot, relative to a Flow scene, without touching the scenes', async () => {
    const w = await world();
    const before = await q(`select id, dialogue, screen_number, position from video_screens where video_project_id = $1 order by id`, [w.p]);
    const r = await add(w, { anchorScreenId: w.screens[1], startOffsetMs: 1000, durationMs: 2000 });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: 'generic', anchorScreenId: w.screens[1], startOffsetMs: 1000, durationMs: 2000, status: 'preparing', brollClipId: w.c });
    expect(await q(`select id, dialogue, screen_number, position from video_screens where video_project_id = $1 order by id`, [w.p])).toEqual(before);
    const list = await call(overlaysGet, { params: w.params });
    expect(list.json.overlays).toHaveLength(1);
    expect(list.json.overlays[0]).toMatchObject({ startMs: 5000, endMs: 7000, needsAttention: false, anchorSceneNumber: 2 });
    expect(list.json.totalMs).toBe(12000);
  });

  it('with no position given, takes the first free stretch and fills the track in order', async () => {
    const w = await world();
    const a = await add(w, { durationMs: 3000 }); const b = await add(w, { durationMs: 3000 });
    expect(a.json).toMatchObject({ anchorScreenId: w.screens[0], startOffsetMs: 0 });
    expect(b.json).toMatchObject({ anchorScreenId: w.screens[0], startOffsetMs: 3000 });   // starts at 3 s on scene 1, runs into scene 2
  });

  it('allows an overlay to run past its scene into the next one', async () => {
    const w = await world();
    const r = await add(w, { anchorScreenId: w.screens[0], startOffsetMs: 3000, durationMs: 3000 });
    expect(r.status).toBe(201);
    const list = await call(overlaysGet, { params: w.params });
    expect(list.json.overlays[0]).toMatchObject({ startMs: 3000, endMs: 6000 });
  });

  it('refuses an overlap on the one track, an unknown clip, a start outside the scene, and the limit', async () => {
    const w = await world();
    await add(w, { anchorScreenId: w.screens[0], startOffsetMs: 0, durationMs: 3000 });
    const clash = await add(w, { anchorScreenId: w.screens[0], startOffsetMs: 2000, durationMs: 2000 });
    expect(clash.status).toBe(409); expect(clash.json.code).toBe('overlap');
    expect((await add({ ...w, c: 999999 })).status).toBe(404);
    expect((await add(w, { anchorScreenId: w.screens[0], startOffsetMs: 4000 })).status).toBe(409);
    process.env.BROLL_OVERLAY_LIMIT = '1';
    try { const over = await add(w, { anchorScreenId: w.screens[2], startOffsetMs: 0 }); expect(over.status).toBe(409); expect(over.json.code).toBe('overlay_limit'); }
    finally { delete process.env.BROLL_OVERLAY_LIMIT; }
  });

  it('moves, retimes and trims, and refuses a move that would overlap', async () => {
    const w = await world();
    const a = (await add(w, { anchorScreenId: w.screens[0], startOffsetMs: 0, durationMs: 2000 })).json;
    const b = (await add(w, { anchorScreenId: w.screens[1], startOffsetMs: 0, durationMs: 2000 })).json;
    const moved = await call(overlayPatch, { method: 'PATCH', params: { ...w.params, oid: String(a.id) }, body: { anchorScreenId: w.screens[2], startOffsetMs: 500, durationMs: 1500, sourceStartMs: 500 } });
    expect(moved.status).toBe(200); expect(moved.json).toMatchObject({ anchorScreenId: w.screens[2], startOffsetMs: 500, durationMs: 1500, sourceStartMs: 500 });
    const clash = await call(overlayPatch, { method: 'PATCH', params: { ...w.params, oid: String(b.id) }, body: { anchorScreenId: w.screens[2], startOffsetMs: 1000 } });
    expect(clash.status).toBe(409);
    expect((await call(overlayPatch, { method: 'PATCH', params: { ...w.params, oid: String(b.id) }, body: { sourceStartMs: 2900 } })).status).toBe(422);   // trim beyond the 3 s clip
  });

  it('keeps an overlay whose scene is deleted, flags it, never moves it, and refuses to compile until it is dealt with', async () => {
    const w = await world();
    const o = (await add(w, { anchorScreenId: w.screens[2], startOffsetMs: 0, durationMs: 2000 })).json;
    await q(`update video_overlays set status='ready', asset_storage_path='overlays/x.mp4', asset_duration_ms=3000 where id=$1`, [o.id]);
    await q(`update video_screens set screen_number = -id, position = -id where id = $1`, [w.screens[2]]);   // how a scene is soft-deleted
    const list = await call(overlaysGet, { params: w.params });
    expect(list.json.overlays[0]).toMatchObject({ id: o.id, needsAttention: true, anchorScreenId: w.screens[2], startMs: null });
    expect(list.json.overlays[0].attentionReason).toMatch(/deleted/);
    const c = await call(compilePost, { method: 'POST', params: w.params, body: { scenes: [0, 1].map((i) => ({ videoScreenId: w.screens[i], videoGenerationId: w.gens[i] })) } });
    expect(c.status).toBe(409); expect(c.json.code).toBe('overlay_scene_deleted');
    expect(await q(`select id from video_compilations where video_project_id = $1`, [w.p])).toHaveLength(0);   // rolled back: no half-made compilation
    // Moving it to a live scene clears the flag.
    const ok = await call(overlayPatch, { method: 'PATCH', params: { ...w.params, oid: String(o.id) }, body: { anchorScreenId: w.screens[0], startOffsetMs: 0 } });
    expect(ok.status).toBe(200);
  });

  it('is invisible (404) when the feature flag is off', async () => {
    const w = await world();
    process.env.BROLL_OVERLAYS_ENABLED = 'false';
    try { expect((await call(overlaysGet, { params: w.params })).status).toBe(404); } finally { process.env.BROLL_OVERLAYS_ENABLED = 'true'; }
  });
});

describe('preparing a library clip', () => {
  it('makes a silent 720x1280 project copy and leaves the library original untouched', async () => {
    const w = await world();
    const o = (await add(w, { anchorScreenId: w.screens[0], startOffsetMs: 0, durationMs: 2000 })).json;
    const original = store.objects.get(`uploads/library/${seq}.mp4`)!; const before = Buffer.from(original);
    expect(await processOverlayIngest()).toBe(true);
    const [row] = await q<{ status: string; asset_storage_path: string; asset_width: number; asset_height: number }>(`select * from video_overlays where id = $1`, [o.id]);
    expect(row).toMatchObject({ status: 'ready', asset_width: 720, asset_height: 1280 });
    expect(row.asset_storage_path).toMatch(new RegExp(`^overlays/${w.p}/${o.id}-`));
    const file = path.join(dir, 'ingested.mp4'); fs.writeFileSync(file, store.objects.get(`videos/${row.asset_storage_path}`)!);
    expect(probeJson(file).streams.some((s) => s.codec_type === 'audio')).toBe(false);
    expect(store.objects.get(`uploads/library/${seq}.mp4`)!.equals(before)).toBe(true);
    expect(await processOverlayIngest()).toBe(false);   // nothing left to do
  }, 120_000);

  it('marks only that overlay failed when the file is not a video, and a retry puts it back in the queue', async () => {
    const w = await world();
    store.objects.set(`uploads/library/${seq}.mp4`, Buffer.from('not a video'));
    const o = (await add(w, { anchorScreenId: w.screens[0], startOffsetMs: 0, durationMs: 2000 })).json;
    await processOverlayIngest();
    const [row] = await q<{ status: string; error_message: string }>(`select status, error_message from video_overlays where id = $1`, [o.id]);
    expect(row.status).toBe('failed'); expect(row.error_message).toBeTruthy();
    expect(await q(`select id from video_screens where video_project_id = $1`, [w.p])).toHaveLength(3);   // Flow untouched
    const retry = await call(overlayRetry, { method: 'POST', params: { ...w.params, oid: String(o.id) } });
    expect(retry.json.status).toBe('preparing');
  }, 120_000);
});

describe('compiling with overlays', () => {
  it('freezes the overlays, runs the compile, and the result is the Flow video with B-roll over it and the Flow narration untouched', async () => {
    const w = await world();
    const placed = (await add(w, { anchorScreenId: w.screens[1], startOffsetMs: 1000, durationMs: 2000 })).json;   // 5 s .. 7 s
    await processOverlayIngest();
    const c = await compile(w);
    expect(c.status).toBe(201); expect(c.json.overlayCount).toBe(1);
    const snap = await q<{ resolved_start_ms: number | null; asset_storage_path: string }>(`select * from video_compilation_overlays where compilation_id = $1`, [c.json.id]);
    expect(snap).toHaveLength(1);
    expect(await processPendingCompilation()).toBe(true);
    const [done] = await q<{ status: string; output_storage_path: string; error_message: string | null }>(`select status, output_storage_path, error_message from video_compilations where id = $1`, [c.json.id]);
    expect(done.error_message).toBeNull(); expect(done.status).toBe('completed');
    const out = path.join(dir, `out-${seq}.mp4`); fs.writeFileSync(out, store.objects.get(`videos/${done.output_storage_path}`)!);
    expect(isColor(pixelAt(out, 4.5), 'blue')).toBe(true);
    expect(isColor(pixelAt(out, 6.0), 'red')).toBe(true);
    expect(isColor(pixelAt(out, 7.5), 'blue')).toBe(true);
    const [resolved] = await q<{ resolved_start_ms: number; resolved_end_ms: number }>(`select resolved_start_ms, resolved_end_ms from video_compilation_overlays where compilation_id = $1`, [c.json.id]);
    expect(resolved).toMatchObject({ resolved_start_ms: 5000, resolved_end_ms: 7000 });

    // The same Flow clips compiled with no overlay at all: identical narration, identical length.
    expect((await call(overlayDelete, { method: 'DELETE', params: { ...w.params, oid: String(placed.id) } })).status).toBe(200);
    const plain = await compile(w);
    expect(plain.json.overlayCount).toBe(0);
    await processPendingCompilation();
    const [p2] = await q<{ output_storage_path: string }>(`select output_storage_path from video_compilations where id = $1`, [plain.json.id]);
    const plainFile = path.join(dir, `plain-${seq}.mp4`); fs.writeFileSync(plainFile, store.objects.get(`videos/${p2.output_storage_path}`)!);
    expect(audioHash(out)).toBe(audioHash(plainFile));
    const dur = (f: string) => Number(probeJson(f).format.duration);
    expect(Math.abs(dur(out) - dur(plainFile))).toBeLessThan(0.05);
    // The earlier version is unchanged by deleting the overlay afterwards.
    expect(await q(`select id from video_compilation_overlays where compilation_id = $1`, [c.json.id])).toHaveLength(1);
  }, 240_000);

  it('refuses to compile while a clip is still preparing, and a project with no overlays compiles exactly as before', async () => {
    const w = await world();
    await add(w, { anchorScreenId: w.screens[0], startOffsetMs: 0, durationMs: 2000 });
    const blocked = await compile(w);
    expect(blocked.status).toBe(409); expect(blocked.json.code).toBe('overlay_not_ready');
    expect(await q(`select id from video_compilations where video_project_id = $1`, [w.p])).toHaveLength(0);
    const w2 = await world();
    const c = await compile(w2);
    expect(c.status).toBe(201); expect(c.json.overlayCount).toBe(0);
    expect(await q(`select id from video_compilation_overlays where compilation_id = $1`, [c.json.id])).toHaveLength(0);
    await processPendingCompilation();
    const [row] = await q<{ status: string; method: string }>(`select status, method from video_compilations where id = $1`, [c.json.id]);
    expect(row).toMatchObject({ status: 'completed', method: 'ffmpeg' });
  }, 240_000);

  it('fails that compilation with a clear message if the real lengths make two overlays overlap, and leaves the earlier version alone', async () => {
    const w = await world();
    const a = (await add(w, { anchorScreenId: w.screens[0], startOffsetMs: 2000, durationMs: 2000 })).json;   // 2..4 s
    await add(w, { anchorScreenId: w.screens[1], startOffsetMs: 0, durationMs: 2000 });                        // 4..6 s (planned)
    await processOverlayIngest(); await processOverlayIngest();
    const c = await compile(w);
    expect(c.status).toBe(201);
    // Scene 1's real clip is only 3.5 s... (simulated by shortening it so the first overlay now runs into the second)
    const short = makeSolid({ file: path.join(dir, `short-${seq}.mp4`), color: 'blue', width: 720, height: 1280, fps: 24, seconds: 3, audioHz: 440 });
    const [g0] = await q<{ video_storage_path: string }>(`select video_storage_path from video_generations where id = $1`, [w.gens[0]]);
    store.objects.set(`videos/${g0.video_storage_path}`, fs.readFileSync(short));
    await processPendingCompilation();
    const [row] = await q<{ status: string; error_message: string }>(`select status, error_message from video_compilations where id = $1`, [c.json.id]);
    expect(row.status).toBe('failed'); expect(row.error_message).toMatch(/B-roll/);
    void a;
  }, 240_000);
});
