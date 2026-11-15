/**
 * Projects-tab thumbnails: a separate small copy of each base image, made once when the project is created. The original
 * must stay byte-for-byte untouched and keep being what Claude and Google Flow receive. Real sharp, real routes, an
 * in-memory Postgres built from the repository's migrations; only auth, the model call and storage are replaced.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';

class FakeStore {
  objects = new Map<string, { buf: Buffer; contentType: string }>();
  puts: string[] = [];
  downloads: string[] = [];
  signed: string[] = [];
  failPut = false;
  failSignThumbs = false;
  private n = 0;
  private k = (b: string, key: string) => `${b}/${key}`;
  async head(b: string, key: string) { const o = this.objects.get(this.k(b, key)); return o ? { size: o.buf.length, contentType: o.contentType, etag: null } : null; }
  async download(b: string, key: string) { this.downloads.push(key); const o = this.objects.get(this.k(b, key)); if (!o) throw new Error(`missing ${key}`); return o.buf; }
  async put(b: string, key: string, buf: Buffer, opts: { contentType: string }) {
    if (this.failPut) throw new Error('storage down');
    if (this.objects.has(this.k(b, key))) { const { ObjectExistsError } = await import('@/lib/object-store/types'); throw new ObjectExistsError(b as 'uploads', key); }
    this.puts.push(key); this.objects.set(this.k(b, key), { buf, contentType: opts.contentType }); return { provider: 'supabase' };
  }
  async signedReadUrl(b: string, key: string) { return this.objects.has(this.k(b, key)) ? `https://signed.test/${key}?n=${++this.n}` : null; }
  async signedReadUrls(b: string, keys: string[]) {
    const out = new Map<string, string>();
    for (const key of keys) {
      if (this.failSignThumbs && key.includes('/thumbs/')) throw new Error('signing down');
      this.signed.push(key);
      if (this.objects.has(this.k(b, key))) out.set(key, `https://signed.test/${key}?n=${++this.n}`);
    }
    return out;
  }
  has(key: string) { return this.objects.has(this.k('uploads', key)); }
  get(key: string) { return this.objects.get(this.k('uploads', key))!.buf; }
}

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  store: undefined as unknown,
  userId: '00000000-0000-4000-8000-00000000a11c' as string | null,
  readPaths: [] as string[],
}));

vi.mock('@/db', () => ({
  db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: holder.userId ? { id: holder.userId, email: 'a@example.test' } : null } }) } }),
}));
vi.mock('@/lib/object-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/object-store')>()),
  getStorage: () => holder.store,
}));
vi.mock('@/lib/object-store/registry', () => ({ locate: async () => new Map() }));
vi.mock('@/services/anthropic', () => ({
  callClaude: vi.fn(async () => '**Prompt**\n\n**Dialogue**\nx'),
  encodeImageFromStorage: vi.fn(async (p: string) => { holder.readPaths.push(p); return { base64: 'eA==', mimeType: 'image/jpeg' }; }),
  loadConversation: vi.fn(async () => []),
}));

import { GET as listProjects, POST as createProject } from '@/app/api/v1/video-projects/route';
import { thumbnailKeyFor, makeThumbnail, ensureThumbnail, THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT } from '@/lib/project-thumbnail';
import { generateInitialScreenPrompt, submitQueuedGeneration } from '@/services/video-workflow';

const ROOT = path.resolve(__dirname, '../..');
const ALICE = '00000000-0000-4000-8000-00000000a11c';
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
let store: FakeStore;

async function migrate(target: PGlite): Promise<void> {
  await target.exec(`create schema if not exists auth; create or replace function auth.uid() returns uuid language sql as 'select null::uuid'; create or replace function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const files = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification')).sort();
  for (const f of files.filter((m) => m < '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
  await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
  for (const f of files.filter((m) => m >= '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
}

/** A large photo-like portrait (smooth gradients with texture), a few MB as a JPEG like a real upload. */
let BIG: Buffer;
beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  holder.db = db;
  await migrate(pg);
  BIG = await sharp({ create: { width: 3000, height: 4500, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 22 } } } as never).blur(1).jpeg({ quality: 92 }).toBuffer();
}, 180_000);
afterAll(async () => { await pg.close(); });
beforeEach(() => { store = new FakeStore(); holder.store = store; holder.userId = ALICE; holder.readPaths = []; });

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const post = (body: unknown) => createProject(new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
async function waitFor(cond: () => boolean) { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50)); }
const original = (name = 'a') => `${ALICE}/${name}-0000-0000-0000-000000000000.jpg`;
const body = (p: string) => ({ name: 'P', originalScript: 'A script', baseImagePath: p });

describe('thumbnail names and generation', () => {
  it('names the thumbnail from the original without any database field', () => {
    expect(thumbnailKeyFor('u1/abc.jpg')).toBe('u1/thumbs/abc.webp');
    expect(thumbnailKeyFor('u1/abc.PNG')).toBe('u1/thumbs/abc.webp');
    expect(thumbnailKeyFor('u1/thumbs/abc.webp')).toBeNull(); // never a thumbnail of a thumbnail
    expect(thumbnailKeyFor('noslash.jpg')).toBe('thumbs/noslash.webp'); // the oldest projects have no folder
    expect(thumbnailKeyFor('thumbs/noslash.webp')).toBeNull();
    expect(thumbnailKeyFor('u1/no-extension')).toBeNull();
    expect(thumbnailKeyFor('')).toBeNull();
  });

  it('makes a small WebP that fits the card, from a large original, without changing the original', async () => {
    const before = sha(BIG);
    const thumb = await makeThumbnail(BIG);
    expect(sha(BIG)).toBe(before);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width!).toBeLessThanOrEqual(THUMB_MAX_WIDTH);
    expect(meta.height!).toBeLessThanOrEqual(THUMB_MAX_HEIGHT);
    expect(meta.width! / meta.height!).toBeCloseTo(3000 / 4500, 1); // same shape
    expect(BIG.length).toBeGreaterThan(1_000_000);
    expect(thumb.length).toBeLessThan(150 * 1024);
    expect(thumb.length).toBeLessThan(BIG.length / 20);
  });

  it('does not enlarge a small image', async () => {
    const small = await sharp({ create: { width: 100, height: 150, channels: 3, background: '#888' } }).png().toBuffer();
    const meta = await sharp(await makeThumbnail(small)).metadata();
    expect(meta).toMatchObject({ width: 100, height: 150 });
  });

  it('stores the thumbnail next to the original, leaves the original byte-identical, and makes it only once', async () => {
    const key = original();
    store.objects.set(`uploads/${key}`, { buf: BIG, contentType: 'image/jpeg' });
    const before = sha(BIG);
    const r1 = await ensureThumbnail(store, key);
    expect(r1).toMatchObject({ status: 'created', key: thumbnailKeyFor(key) });
    expect(store.puts).toEqual([thumbnailKeyFor(key)]); // the only write is the new thumbnail object
    expect(sha(store.get(key))).toBe(before);
    expect(store.get(thumbnailKeyFor(key)!).length).toBeLessThan(150 * 1024);

    store.downloads = [];
    const r2 = await ensureThumbnail(store, key);
    expect(r2.status).toBe('exists');
    expect(store.downloads).toHaveLength(0); // the original is not even read again
    expect(store.puts).toHaveLength(1);
  });

  it('never throws: a missing original, an unreadable image or a storage failure just means no thumbnail', async () => {
    expect((await ensureThumbnail(store, original('missing'))).status).toBe('failed');
    const bad = original('bad');
    store.objects.set(`uploads/${bad}`, { buf: Buffer.from('not an image at all'), contentType: 'image/jpeg' });
    expect((await ensureThumbnail(store, bad)).status).toBe('failed');
    const ok = original('ok');
    store.objects.set(`uploads/${ok}`, { buf: BIG, contentType: 'image/jpeg' });
    store.failPut = true;
    expect((await ensureThumbnail(store, ok)).status).toBe('failed');
    expect(sha(store.get(ok))).toBe(sha(BIG)); // original unharmed by every failure
  });
});

describe('creating a project', () => {
  it('makes the thumbnail after the project is created, and the original is untouched', async () => {
    const key = original('new');
    store.objects.set(`uploads/${key}`, { buf: BIG, contentType: 'image/jpeg' });
    const res = await post(body(key));
    expect(res.status).toBe(201);
    const project = await res.json() as { id: number; baseImagePath: string };
    expect(project.baseImagePath).toBe(key); // still points at the original
    await waitFor(() => store.has(thumbnailKeyFor(key)!));
    expect(store.has(thumbnailKeyFor(key)!)).toBe(true);
    expect(sha(store.get(key))).toBe(sha(BIG));
    expect(store.puts).toEqual([thumbnailKeyFor(key)]);
  });

  it('a failed thumbnail does not affect the project', async () => {
    const key = original('broken');
    store.objects.set(`uploads/${key}`, { buf: Buffer.from('corrupt'), contentType: 'image/jpeg' });
    const res = await post(body(key));
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 200));
    expect(store.puts).toHaveLength(0);
    const rows = await db.select().from(schema.videoProjects).where(eq(schema.videoProjects.baseImagePath, key));
    expect(rows).toHaveLength(1);
  });
});

describe('the Projects tab', () => {
  type Row = { id: number; baseImagePath: string; baseImagePreviewUrl: string | null; baseImageIsThumbnail: boolean };
  const list = async () => (await (await listProjects()).json()) as Row[];
  async function makeProject(key: string, withThumb: boolean) {
    store.objects.set(`uploads/${key}`, { buf: BIG, contentType: 'image/jpeg' });
    if (withThumb) await ensureThumbnail(store, key);
    const now = Date.now();
    const [p] = await db.insert(schema.videoProjects).values({ userId: ALICE, name: 'P', baseImagePath: key, originalScript: 's', createdAt: now, updatedAt: now }).returning();
    return p;
  }

  it('is given the thumbnail, not the original, and never signs the original for it', async () => {
    const key = original('t1');
    const p = await makeProject(key, true);
    store.signed = [];
    const row = (await list()).find((r) => r.id === p.id)!;
    expect(row.baseImageIsThumbnail).toBe(true);
    expect(row.baseImagePreviewUrl).toContain('/thumbs/');
    expect(row.baseImagePreviewUrl).not.toContain(key.replace('/thumbs/', '/'));
    expect(store.signed).not.toContain(key);
    expect(store.downloads.filter((d) => d === key)).toHaveLength(1); // only the one read that made the thumbnail
  });

  it('keeps showing the original for an older project that has no thumbnail', async () => {
    const key = original('legacy');
    const p = await makeProject(key, false);
    const row = (await list()).find((r) => r.id === p.id)!;
    expect(row.baseImageIsThumbnail).toBe(false);
    expect(row.baseImagePreviewUrl).toBeTruthy();
    expect(row.baseImagePreviewUrl).not.toContain('/thumbs/');
  });

  it('mixes old and new projects, and falls back to originals if signing thumbnails fails', async () => {
    const a = await makeProject(original('mixa'), true);
    const b = await makeProject(original('mixb'), false);
    let rows = await list();
    expect(rows.find((r) => r.id === a.id)!.baseImageIsThumbnail).toBe(true);
    expect(rows.find((r) => r.id === b.id)!.baseImageIsThumbnail).toBe(false);
    store.failSignThumbs = true;
    rows = await list();
    expect(rows.find((r) => r.id === a.id)!.baseImageIsThumbnail).toBe(false);
    expect(rows.find((r) => r.id === a.id)!.baseImagePreviewUrl).toBeTruthy(); // the original, as before
  });

  it('repeated visits reuse the stored thumbnail: nothing is generated, written or downloaded', async () => {
    const p = await makeProject(original('rep'), true);
    store.puts = []; store.downloads = [];
    for (let i = 0; i < 5; i++) expect((await list()).find((r) => r.id === p.id)!.baseImageIsThumbnail).toBe(true);
    expect(store.puts).toHaveLength(0);
    expect(store.downloads).toHaveLength(0);
  });
});

describe('the originals still go to Claude and Google Flow', () => {
  it('Claude reads the original path, never the thumbnail', async () => {
    const key = original('claude');
    store.objects.set(`uploads/${key}`, { buf: BIG, contentType: 'image/jpeg' });
    const created = await (await post(body(key))).json() as { id: number };
    await waitFor(() => store.has(thumbnailKeyFor(key)!));
    const now = Date.now();
    const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: created.id, screenNumber: 2, dialogue: 'Hi', position: 2, createdAt: now, updatedAt: now }).returning();
    await generateInitialScreenPrompt(created.id, s.id);
    expect(holder.readPaths).toEqual([key]);
    expect(holder.readPaths.some((p) => p.includes('/thumbs/'))).toBe(false);
  });

  it('Google Flow receives the original file, byte for byte', async () => {
    const key = original('flow');
    store.objects.set(`uploads/${key}`, { buf: BIG, contentType: 'image/jpeg' });
    const created = await (await post(body(key))).json() as { id: number };
    await waitFor(() => store.has(thumbnailKeyFor(key)!));
    const now = Date.now();
    const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: created.id, screenNumber: 1, dialogue: 'Hi', position: 1, createdAt: now, updatedAt: now }).returning();
    const [v] = await db.insert(schema.screenPromptVersions).values({ videoScreenId: s.id, version: 1, promptText: 'p', source: 'claude', createdAt: now }).returning();
    const [g] = await db.insert(schema.videoGenerations).values({ videoScreenId: s.id, promptVersionId: v.id, status: 'queued', createdAt: now, updatedAt: now }).returning();

    let uploadedHash = '';
    let uploadedName = '';
    const provider = {
      uploadReferenceImage: vi.fn(async (p: { imagePath: string }) => { uploadedHash = sha(fs.readFileSync(p.imagePath)); uploadedName = p.imagePath; return { mediaGenerationId: 'media-1' }; }),
      submitGeneration: vi.fn(async () => ({ jobId: 'j1' })),
      pollJob: vi.fn(),
    };
    process.env.GOOGLE_FLOW_EMAIL = 'flow@example.test';
    await submitQueuedGeneration(g.id, provider as never);
    expect(provider.uploadReferenceImage).toHaveBeenCalledOnce();
    expect(uploadedHash).toBe(sha(BIG));
    expect(uploadedName).not.toContain('webp');
  });
});
