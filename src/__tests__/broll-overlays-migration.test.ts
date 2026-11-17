/**
 * Migration 0028 (B-roll overlays): the tables and their rules, on an in-memory Postgres built from the real migration files.
 * Flow tables must be untouched: video_screens keeps dialogue NOT NULL and gains no scene type.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from './helpers/studio-fakes';

const ROOT = path.resolve(__dirname, '../..');
const USER = '00000000-0000-4000-8000-00000000000a';
let pg: PGlite;
beforeAll(async () => { pg = new PGlite(); await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });

const now = 1_700_000_000_000;
let seq = 0;
async function world() {
  const p = (await pg.query<{ id: number }>(`insert into video_projects (user_id, name, base_image_path, original_script, created_at, updated_at) values ($1,'P','x.png','s',$2,$2) returning id`, [USER, now])).rows[0].id;
  const s = (await pg.query<{ id: number }>(`insert into video_screens (video_project_id, screen_number, dialogue, position, created_at, updated_at) values ($1,1,'Hello',0,$2,$2) returning id`, [p, now])).rows[0].id;
  const c = (await pg.query<{ id: number }>(`insert into broll_clips (user_id, title, storage_path, created_at, updated_at) values ($1,'Clip','c.mp4',$2,$2) returning id`, [USER, now])).rows[0].id;
  const pk = (await pg.query<{ id: number }>(`insert into studio_packs (name, created_by, created_at, updated_at) values ('Pk',$1,$2,$2) returning id`, [USER, now])).rows[0].id;
  const a = (await pg.query<{ id: number }>(`insert into studio_assets (pack_id, storage_key, mime, size_bytes, sha256, created_by, created_at, updated_at) values ($1,$4,'image/png',1,'h',$2,$3,$3) returning id`, [pk, USER, now, `studio/assets/00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}.png`])).rows[0].id;
  return { p, s, c, a };
}
const overlay = (w: { p: number; s: number; c: number }, over: Record<string, unknown> = {}) => {
  const v = { kind: 'generic', track: 0, start: 0, dur: 3000, src: 0, status: 'preparing', asset: null as string | null, clip: w.c as number | null, item: null as number | null, ...over };
  return pg.query(`insert into video_overlays (video_project_id, kind, track, anchor_screen_id, start_offset_ms, duration_ms, source_start_ms, status, asset_storage_path, broll_clip_id, character_item_id, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
    [w.p, v.kind, v.track, w.s, v.start, v.dur, v.src, v.status, v.asset, v.clip, v.item, USER, now]);
};

describe('migration 0028', () => {
  it('adds the overlay tables and leaves the Flow tables as they were', async () => {
    for (const t of ['video_overlays', 'character_broll_items', 'video_compilation_overlays']) expect((await pg.query(`select to_regclass('public.${t}') as r`)).rows[0]).toMatchObject({ r: t });
    const cols = (await pg.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'video_screens'`)).rows.map((r) => r.column_name);
    expect(cols).not.toContain('scene_type');
    const dlg = (await pg.query<{ is_nullable: string }>(`select is_nullable from information_schema.columns where table_name = 'video_screens' and column_name = 'dialogue'`)).rows[0];
    expect(dlg.is_nullable).toBe('NO');
    const gen = (await pg.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'video_generations'`)).rows.map((r) => r.column_name);
    expect(gen).not.toContain('source_type');
  });

  it('existing compilations get overlay_count 0', async () => {
    const w = await world();
    const c = (await pg.query<{ overlay_count: number }>(`insert into video_compilations (video_project_id, status, created_at, updated_at) values ($1,'pending',$2,$2) returning overlay_count`, [w.p, now])).rows[0];
    expect(c.overlay_count).toBe(0);
  });

  it('accepts a valid generic overlay and rejects bad shapes', async () => {
    const w = await world();
    await overlay(w);
    await expect(overlay(w, { kind: 'character' })).rejects.toThrow(/video_overlays_source_check/);          // character with no item
    await expect(overlay(w, { kind: 'bogus' })).rejects.toThrow(/video_overlays_kind_check/);
    await expect(overlay(w, { dur: 0 })).rejects.toThrow(/video_overlays_timing_check/);
    await expect(overlay(w, { start: -1 })).rejects.toThrow(/video_overlays_timing_check/);
    await expect(overlay(w, { track: -1 })).rejects.toThrow(/video_overlays_track_check/);
    await expect(overlay(w, { status: 'ready' })).rejects.toThrow(/video_overlays_ready_has_asset/);          // ready needs a clip
    await overlay(w, { status: 'ready', asset: 'overlays/1/a.mp4' });
  });

  it('THE PAID-STEP GATE: a video job cannot exist unless the personalised image is approved', async () => {
    const w = await world();
    const ins = (over: string) => pg.query(`insert into character_broll_items (video_project_id, studio_asset_id, created_by, created_at, updated_at${over ? ', ' + over.split('|')[0] : ''}) values ($1,$2,$3,$4,$4${over ? ', ' + over.split('|')[1] : ''})`, [w.p, w.a, USER, now]);
    await ins('');                                                                                    // not_started is fine at any image state
    await expect(ins(`clip_status|'queued'`)).rejects.toThrow(/character_broll_video_needs_approved_image/);
    await expect(ins(`clip_status, image_status|'processing','ready'`.replace("'processing'", "'processing'"))).rejects.toThrow(/character_broll_video_needs_approved_image/);
    await expect(ins(`image_status|'approved'`)).rejects.toThrow(/character_broll_approved_has_output/); // approved needs an output
    await expect(ins(`clip_status, image_status|'ready','approved'`)).rejects.toThrow(); // also needs a stored clip and an output
  });

  it('is safe to run again and fails clearly without its prerequisites', async () => {
    const sql = fs.readFileSync(path.join(ROOT, 'drizzle/pg/0028_broll_overlays.sql'), 'utf8');
    await pg.exec(sql);
    const bare = new PGlite();
    await expect(bare.exec(sql)).rejects.toThrow(/needs the video workflow tables/);
    await bare.close();
  });
});
