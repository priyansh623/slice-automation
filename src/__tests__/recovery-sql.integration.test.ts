/** The production recovery script, run as written against a throwaway database: all-or-nothing, exact count, safe to repeat. */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from './helpers/studio-fakes';

const sql = fs.readFileSync(path.join(__dirname, '../../docs/stabilisation-recovery.sql'), 'utf8');
const A = [91, 137, 193, 226, 228, 244, 248, 250, 251, 306, 330, 356, 358];
const B = [258, 261, 352];
const part = (from: string, to?: string) => sql.slice(sql.indexOf(from), to ? sql.indexOf(to) : undefined);
const preview = part('SELECT CASE', '-- ═════════════ STEP 2');
const groupA = part('BEGIN;', '-- ═════════════ STEP 3');
const groupB = sql.slice(sql.lastIndexOf('BEGIN;'));

let pg: PGlite;
beforeAll(async () => { pg = new PGlite(); await migrate(pg); }, 120_000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec('truncate video_projects restart identity cascade');
  await pg.exec(`insert into video_projects (user_id, name, base_image_path, original_script, created_at, updated_at) values ('00000000-0000-4000-8000-000000000001','p','x','s',1,1);
    insert into video_screens (video_project_id, screen_number, dialogue, position, created_at, updated_at) values (1,1,'d',1,1,1);
    insert into screen_prompt_versions (video_screen_id, version, prompt_text, source, created_at) values (1,1,'p','manual',1);`);
  for (const id of [...A, ...B, 999]) await pg.exec(`insert into video_generations (id, video_screen_id, prompt_version_id, status, error_message, video_storage_path, media_generation_id, created_at, updated_at) values (${id},1,1,'failed','Video completed but URL was not returned by provider','k-${id}.mp4','m',1,1)`);
  await pg.exec('update video_screens set approved_generation_id = 999');
});
const statuses = async (ids: number[]) => (await pg.query(`select status from video_generations where id in (${ids.join(',')})`)).rows.map((r) => (r as { status: string }).status);
const run = async (script: string) => { try { await pg.exec(script); return null; } catch (e) { await pg.exec('rollback').catch(() => {}); return (e as Error).message; } };

describe('stabilisation-recovery.sql', () => {
  it('previews exactly the 16 targets in two groups without changing them', async () => {
    const rows = (await pg.query(preview)).rows as Array<{ grp: string; state: string }>;
    expect(rows).toHaveLength(16);
    expect(rows.filter((r) => r.grp.startsWith('A'))).toHaveLength(13);
    expect(rows.every((r) => r.state === 'eligible')).toBe(true);
    expect(await statuses(A)).toEqual(Array(13).fill('failed'));
  });
  it('repairs only its group, nothing else, and a second run is a no-op', async () => {
    expect(await run(groupA)).toBeNull();
    expect(await statuses(A)).toEqual(Array(13).fill('completed'));
    expect(await statuses([...B, 999])).toEqual(Array(4).fill('failed'));
    const stamp = async () => (await pg.query('select updated_at from video_generations where id = 91')).rows[0];
    const first = await stamp();
    expect(await run(groupA)).toBeNull();
    expect(await stamp()).toEqual(first);
    expect(await run(groupB)).toBeNull();
    expect(await statuses(B)).toEqual(Array(3).fill('completed'));
    expect((await pg.query('select approved_generation_id from video_screens')).rows[0]).toEqual({ approved_generation_id: 999 });
  });
  it('changes NOTHING if even one target no longer qualifies', async () => {
    await pg.exec("update video_generations set video_storage_path = null where id = 330");
    expect(await run(groupA)).toMatch(/expected 13 eligible rows, found 12/);
    expect(await statuses(A)).toEqual(Array(13).fill('failed'));
    await pg.exec("delete from video_generations where id = 352");
    expect(await run(groupB)).toMatch(/expected 3 eligible rows, found 2/);
    expect(await statuses([258, 261])).toEqual(['failed', 'failed']);
  });
});
