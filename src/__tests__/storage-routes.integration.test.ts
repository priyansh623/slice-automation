/**
 * The routes that hand out or accept files go through the storage layer: the right logical bucket and key, the right
 * lifetimes, and a clear failure when no URL can be made. Real routes and a real in-memory Postgres; the storage layer
 * is replaced by a recorder so no provider is contacted.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema.pg';

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: null as string | null,
  calls: [] as string[],
  urlFor: (_b: string, _k: string, _ttl: number): string | null => null,
  locations: new Map<string, 'supabase' | 'r2'>(),
}));

vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId, email: 'u@example.test' } : null } }) } }) }));
vi.mock('@/lib/object-store/registry', () => ({
  locate: async (bucket: string, keys: string[]) => new Map(keys.map((k) => [k, holder.locations.get(`${bucket}/${k}`) ?? 'supabase'])),
  registerObject: async () => undefined,
  clearLocationCache: () => undefined,
}));
vi.mock('@/lib/object-store', () => ({
  getStorage: () => ({
    signedReadUrl: async (bucket: string, key: string, ttl: number) => { holder.calls.push(`sign ${bucket}/${key} ${ttl}`); return holder.urlFor(bucket, key, ttl); },
    signedReadUrls: async (bucket: string, keys: string[], ttl: number) => { holder.calls.push(`signMany ${bucket} ${keys.length} ${ttl}`); return new Map(keys.flatMap((k) => { const u = holder.urlFor(bucket, k, ttl); return u ? [[k, u] as [string, string]] : []; })); },
    signedUpload: async (bucket: string, key: string, contentType: string) => { holder.calls.push(`upload ${bucket}/${key} ${contentType}`); return { url: `https://upload.example/${bucket}/${key}`, method: 'PUT', headers: { 'Content-Type': contentType }, provider: 'r2' }; },
    put: async () => ({ provider: 'supabase' }),
    download: async () => Buffer.from(''),
  }),
  toLogicalBucket: (n: string) => n,
}));

import { GET as screenVideo } from '@/app/api/v1/video-projects/[id]/screens/[n]/video/route';
import { GET as compilationVideo } from '@/app/api/v1/video-projects/[id]/compilations/[cid]/video/route';
import { GET as compilationDownload } from '@/app/api/v1/video-projects/[id]/compilations/[cid]/download/route';
import { GET as uploadInit } from '@/app/api/v1/uploads/init/route';
import { GET as uploadByName } from '@/app/api/v1/uploads/[filename]/route';
import { GET as listProjects } from '@/app/api/v1/video-projects/route';
import { currentSignedUrl } from '@/lib/broll-signed-url';

const ROOT = path.resolve(__dirname, '../..');
const USER = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  holder.db = db;
  await pg.exec(`create schema auth; create function auth.uid() returns uuid language sql as 'select null::uuid'; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const migrations = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00(0[1-9]|1[0-9]|2[0-4])_.*\.sql$/.test(f) && !f.includes('verification')).sort();
  const run = (file: string) => pg.exec(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  for (const f of migrations.filter((m) => m < '0022')) await run(`drizzle/pg/${f}`);
  await run('drizzle/0009_broll_categories.sql');
  for (const f of migrations.filter((m) => m >= '0022')) await run(`drizzle/pg/${f}`);
}, 120_000);
afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  holder.userId = USER; holder.calls = []; holder.locations = new Map();
  holder.urlFor = (b, k) => `https://signed.example/${b}/${k}`;
  await pg.exec('truncate video_compilations, video_generations, screen_prompt_versions, video_screens, video_projects restart identity cascade');
});

const ctx = (id: number, extra: Record<string, string> = {}) => ({ params: Promise.resolve({ id: String(id), n: '1', cid: '1', ...extra }) });
const req = (url = 'http://localhost/x') => new NextRequest(url);

async function seed() {
  const now = Date.now();
  const [p] = await db.insert(schema.videoProjects).values({ userId: USER, name: 'p', baseImagePath: `${USER}/00000000-0000-4000-8000-000000000001.png`, originalScript: 's', createdAt: now, updatedAt: now }).returning();
  const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: p.id, screenNumber: 1, dialogue: 'd', position: 1, createdAt: now, updatedAt: now }).returning();
  const [v] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: s.id, version: 1, promptText: 'x', source: 'manual', createdAt: now }).returning();
  const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: s.id, promptVersionId: v.id, status: 'completed', videoStoragePath: 'screen-1/100-gen-1.mp4', createdAt: now, updatedAt: now }).returning();
  const [c] = await db.insert(schema.videoCompilations).values({ videoProjectId: p.id, status: 'completed', outputStoragePath: 'compilations/1/200-compilation-1.mp4', createdAt: now, updatedAt: now }).returning();
  return { p, s, g, c };
}

describe('video playback and download routes', () => {
  it('signs a generated clip in the videos bucket for one hour', async () => {
    const { p, g } = await seed();
    const res = await screenVideo(req(`http://localhost/x?generationId=${g.id}`), ctx(p.id, { n: '1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedUrl: 'https://signed.example/videos/screen-1/100-gen-1.mp4', generationId: g.id });
    expect(holder.calls).toEqual(['sign videos/screen-1/100-gen-1.mp4 3600']);
  });

  it('signs a compilation for one hour', async () => {
    const { p, c } = await seed();
    const res = await compilationVideo(req(), ctx(p.id, { cid: String(c.id) }));
    expect(await res.json()).toMatchObject({ signedUrl: 'https://signed.example/videos/compilations/1/200-compilation-1.mp4' });
    expect(holder.calls).toEqual(['sign videos/compilations/1/200-compilation-1.mp4 3600']);
  });

  it('answers 500 with a clear message when no URL can be made', async () => {
    const { p, g, c } = await seed();
    holder.urlFor = () => null;
    expect((await screenVideo(req(`http://localhost/x?generationId=${g.id}`), ctx(p.id, { n: '1' }))).status).toBe(500);
    expect((await compilationVideo(req(), ctx(p.id, { cid: String(c.id) }))).status).toBe(500);
    expect((await compilationDownload(req(), ctx(p.id, { cid: String(c.id) }))).status).toBe(500);
  });

  it('streams a compilation download from the 60 second URL as an attachment', async () => {
    const { p, c } = await seed();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('video-bytes', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '11' } }));
    try {
      const res = await compilationDownload(req(), ctx(p.id, { cid: String(c.id) }));
      expect(res.headers.get('Content-Disposition')).toContain(`compilation-${c.id}.mp4`);
      expect(await res.text()).toBe('video-bytes');
      expect(fetchSpy).toHaveBeenCalledWith('https://signed.example/videos/compilations/1/200-compilation-1.mp4');
      expect(holder.calls).toEqual(['sign videos/compilations/1/200-compilation-1.mp4 60']);
    } finally { fetchSpy.mockRestore(); }
  });

  it('refuses signed-out callers on every route', async () => {
    const { p, c } = await seed();
    holder.userId = null;
    expect((await screenVideo(req(), ctx(p.id, { n: '1' }))).status).toBe(401);
    expect((await compilationVideo(req(), ctx(p.id, { cid: String(c.id) }))).status).toBe(401);
    expect((await compilationDownload(req(), ctx(p.id, { cid: String(c.id) }))).status).toBe(401);
    expect(holder.calls).toEqual([]);
  });
});

describe('project image upload and preview routes', () => {
  it('hands the browser a presigned upload URL for the right key and type, and keeps the response shape', async () => {
    const res = await uploadInit(req('http://localhost/x?contentType=image%2Fpng'));
    const body = (await res.json()) as { signedUploadUrl: string; path: string; filename: string };
    expect(res.status).toBe(200);
    expect(body.path).toMatch(new RegExp(`^${USER}/[0-9a-f-]{36}\\.png$`));
    expect(body.signedUploadUrl).toBe(`https://upload.example/uploads/${body.path}`);
    expect(holder.calls).toEqual([`upload uploads/${body.path} image/png`]);
  });

  it('rejects a non-image type and a signed-out caller without creating a URL', async () => {
    expect((await uploadInit(req('http://localhost/x?contentType=video%2Fmp4'))).status).toBe(415);
    holder.userId = null;
    expect((await uploadInit(req('http://localhost/x?contentType=image%2Fpng'))).status).toBe(401);
    expect(holder.calls).toEqual([]);
  });

  it("serves a project's image to any signed-in user, from wherever it was stored", async () => {
    const { p } = await seed();
    const filename = '00000000-0000-4000-8000-000000000001.png';
    holder.userId = OTHER;
    const res = await uploadByName(req(), { params: Promise.resolve({ filename }) });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://signed.example/uploads/${p.baseImagePath}`);
  });
});

describe('project list: saved preview URLs', () => {
  it('uses the saved URL for a Supabase image but never for an image registered on R2', async () => {
    const { p } = await seed();
    const future = Date.now() + 20 * 3_600_000;
    await db.update(schema.videoProjects).set({ baseImageSignedUrl: 'https://old-supabase.example/saved', baseImageSignedUrlExpiresAt: future });

    let res = await listProjects();
    expect(((await res.json()) as { baseImagePreviewUrl: string }[])[0].baseImagePreviewUrl).toBe('https://old-supabase.example/saved');
    expect(holder.calls).toEqual([]); // fresh saved URL: no storage call

    holder.locations.set(`uploads/${p.baseImagePath}`, 'r2');
    res = await listProjects();
    expect(((await res.json()) as { baseImagePreviewUrl: string }[])[0].baseImagePreviewUrl).toBe(`https://signed.example/uploads/${p.baseImagePath}`);
    const saved = (await db.select().from(schema.videoProjects))[0];
    expect(saved.baseImageSignedUrl).toBe('https://old-supabase.example/saved'); // an R2 URL is never written over the saved one
  });
});

describe('B-roll saved URLs', () => {
  const clip = (over: Partial<{ id: number; storagePath: string }> = {}) => ({ id: 1, storagePath: 'u/broll/a.mp4', signedUrl: 'https://old-supabase.example/clip', signedUrlExpiresAt: Date.now() + 20 * 3_600_000, ...over });

  it('keeps using a fresh saved URL for a clip that is still on Supabase', async () => {
    expect(await currentSignedUrl(clip())).toBe('https://old-supabase.example/clip');
    expect(holder.calls).toEqual([]);
  });

  it('ignores the saved URL for a clip registered on R2 and signs a fresh one without saving it', async () => {
    const now = Date.now();
    const [row] = await db.insert(schema.brollClips).values({ userId: USER, title: 't', storagePath: 'u/broll/a.mp4', signedUrl: 'https://old-supabase.example/clip', signedUrlExpiresAt: now + 20 * 3_600_000, createdAt: now, updatedAt: now }).returning();
    holder.locations.set('uploads/u/broll/a.mp4', 'r2');
    const url = await currentSignedUrl(clip({ id: row.id }));
    expect(url).toBe('https://signed.example/uploads/u/broll/a.mp4');
    expect(holder.calls).toEqual(['sign uploads/u/broll/a.mp4 86400']);
    const saved = (await db.select().from(schema.brollClips))[0];
    expect(saved.signedUrl).toBe('https://old-supabase.example/clip');
  });
});
