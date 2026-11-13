/**
 * callClaude against a real in-memory Postgres (the repository's migrations). Only the Anthropic SDK and Supabase
 * Storage are replaced. Proves that new conversations store a reference instead of the image, that Claude still
 * receives the same image bytes, and that old (base64) conversations keep working.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema.pg';

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  sent: [] as { messages: unknown }[],
  downloads: [] as string[],
  files: new Map<string, Buffer>(),
  failDownloads: false,
}));

vi.mock('@/db', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const real = holder.db as Record<string | symbol, unknown>;
      const v = real[prop];
      return typeof v === 'function' ? v.bind(real) : v;
    },
  }),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (args: { messages: unknown }) => {
        holder.sent.push({ messages: JSON.parse(JSON.stringify(args.messages)) }); // what Claude receives
        return { content: [{ type: 'text', text: 'reply' }] };
      },
    };
  },
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      from: (bucket: string) => ({
        download: async (p: string) => {
          holder.downloads.push(`${bucket}:${p}`);
          const file = holder.files.get(p);
          if (holder.failDownloads || !file) return { data: null, error: { message: 'Object not found' } };
          return { data: new Blob([new Uint8Array(file)]), error: null };
        },
        // Any attempt to store a new image file would fail this test.
        upload: async () => { throw new Error('conversations must not upload image files'); },
      }),
    },
  }),
}));

import { callClaude, encodeImageFromStorage, loadConversation } from '@/services/anthropic';
import { ConversationImageError, convertLegacyImages } from '@/lib/conversation-images';

const ROOT = path.resolve(__dirname, '../..');
const USER = '00000000-0000-4000-8000-0000000000b1';
let pg: PGlite;
let db: PgliteDatabase<typeof schema>;
let seq = 0;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
  pg = new PGlite();
  db = drizzle(pg, { schema });
  holder.db = db;
  await pg.exec(`create schema auth; create function auth.uid() returns uuid language sql as 'select null::uuid'; create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const migrations = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00(0[1-9]|1[0-9]|2[0-2])_.*\.sql$/.test(f) && !f.includes('verification')).sort();
  const run = (file: string) => pg.exec(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  for (const f of migrations.filter((m) => m < '0022')) await run(`drizzle/pg/${f}`);
  await run('drizzle/0009_broll_categories.sql');
  for (const f of migrations.filter((m) => m >= '0022')) await run(`drizzle/pg/${f}`);
}, 120_000);

afterAll(async () => { await pg.close(); });
beforeEach(() => { holder.sent = []; holder.downloads = []; holder.failDownloads = false; });

// A fresh project and image path per test: the module's in-process image cache must not hide a storage call.
async function setup() {
  seq++;
  const fileId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const imagePath = `${USER}/${fileId}.png`;
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + seq) % 256));
  holder.files.set(imagePath, bytes);
  const now = Date.now();
  const [project] = await db.insert(schema.videoProjects).values({ userId: USER, name: 'p', baseImagePath: imagePath, originalScript: 's', createdAt: now, updatedAt: now }).returning();
  const [screen] = await db.insert(schema.videoScreens).values({ videoProjectId: project.id, screenNumber: 1, dialogue: 'd', position: 1, createdAt: now, updatedAt: now }).returning();
  return { projectId: project.id, screenId: screen.id, imagePath, bytes, base64: bytes.toString('base64') };
}

const storedRow = async (screenId: number) => (await db.select().from(schema.claudeConversations).where(eq(schema.claudeConversations.videoScreenId, screenId)))[0];
const imageBlocks = (messages: unknown) => (messages as { role: string; content: unknown }[]).flatMap((m) => (Array.isArray(m.content) ? m.content : []) as { type: string; source?: { data: string; media_type: string } }[]).filter((b) => b.type === 'image');

describe('new conversations store an image reference', () => {
  it('sends Claude the exact image bytes but stores only a reference', async () => {
    const t = await setup();
    const image = await encodeImageFromStorage(t.imagePath, 'uploads');
    await callClaude(t.projectId, 'first', 'system', { videoScreenId: t.screenId, image });

    const sent = imageBlocks(holder.sent[0].messages);
    expect(sent).toHaveLength(1);
    expect(sent[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: t.base64 });
    expect(createHash('md5').update(Buffer.from(sent[0].source!.data, 'base64')).digest('hex')).toBe(createHash('md5').update(t.bytes).digest('hex'));

    const row = await storedRow(t.screenId);
    expect(row.messagesJson).not.toContain('base64');
    expect(row.messagesJson).not.toContain(t.base64.slice(0, 64));
    expect(row.messagesJson.length).toBeLessThan(1000);
    expect(JSON.parse(row.messagesJson)[0].content[0]).toEqual({ type: 'soma_image_ref', bucket: 'uploads', path: t.imagePath, mediaType: 'image/png' });
  });

  it('resumes a new conversation: every turn is sent with the real image, and storage stays small', async () => {
    const t = await setup();
    for (const text of ['one', 'two', 'three']) {
      const image = await encodeImageFromStorage(t.imagePath, 'uploads');
      await callClaude(t.projectId, text, 'system', { videoScreenId: t.screenId, image });
    }
    const lastRequest = holder.sent[2].messages as { role: string }[];
    expect(lastRequest.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    const blocks = imageBlocks(lastRequest);
    expect(blocks).toHaveLength(3); // Claude sees what it saw before: one image per user turn
    for (const b of blocks) expect(b.source!.data).toBe(t.base64);

    const row = await storedRow(t.screenId);
    expect(row.messagesJson).not.toContain('"base64"');
    expect(row.messagesJson.length).toBeLessThan(3000); // three turns, no image data
    expect((row.messagesJson.match(/soma_image_ref/g) ?? []).length).toBe(3);
  });

  it('reuses the one stored file for every message and never uploads another copy', async () => {
    const t = await setup();
    for (const text of ['a', 'b']) {
      const image = await encodeImageFromStorage(t.imagePath, 'uploads');
      await callClaude(t.projectId, text, 'system', { videoScreenId: t.screenId, image });
    }
    const paths = (JSON.stringify(JSON.parse((await storedRow(t.screenId)).messagesJson)).match(/"path":"[^"]+"/g) ?? []);
    expect(new Set(paths).size).toBe(1);
    expect(holder.downloads.every((d) => d === `uploads:${t.imagePath}`)).toBe(true); // upload() would have thrown
  });

  it('keeps text-only calls and fresh calls working as before', async () => {
    const t = await setup();
    await callClaude(t.projectId, 'plain', 'system', { videoScreenId: t.screenId });
    expect(await loadConversation(t.projectId, t.screenId)).toHaveLength(2);
    const before = (await storedRow(t.screenId)).messagesJson;
    await callClaude(t.projectId, 'fresh one', 'system', { videoScreenId: t.screenId, fresh: true });
    expect((await storedRow(t.screenId)).messagesJson).toBe(before); // fresh calls are not saved
    expect(holder.sent[1].messages).toHaveLength(1); // and do not include history
  });

  it('falls back to embedding when an image has no usable reference', async () => {
    const t = await setup();
    await callClaude(t.projectId, 'x', 'system', { videoScreenId: t.screenId, image: { base64: 'QUJD', mimeType: 'image/png' } });
    expect((await storedRow(t.screenId)).messagesJson).toContain('"base64"');
  });
});

describe('existing conversations with embedded base64 images', () => {
  async function legacyConversation(t: Awaited<ReturnType<typeof setup>>) {
    const legacy = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: t.base64 } }, { type: 'text', text: 'old question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
    ];
    await db.insert(schema.claudeConversations).values({ videoProjectId: t.projectId, videoScreenId: t.screenId, messagesJson: JSON.stringify(legacy), updatedAt: 1 });
    return legacy;
  }

  it('opens and is sent to Claude exactly as before', async () => {
    const t = await setup();
    const legacy = await legacyConversation(t);
    expect(await loadConversation(t.projectId, t.screenId)).toEqual(legacy);
    const image = await encodeImageFromStorage(t.imagePath, 'uploads');
    await callClaude(t.projectId, 'new question', 'system', { videoScreenId: t.screenId, image });
    const sent = holder.sent[0].messages as unknown[];
    expect(sent.slice(0, 2)).toEqual(legacy); // legacy turns reach Claude unchanged
    expect(imageBlocks(sent).map((b) => b.source!.data)).toEqual([t.base64, t.base64]);
  });

  it('keeps the legacy messages untouched when the conversation continues and adds only a reference', async () => {
    const t = await setup();
    const legacy = await legacyConversation(t);
    const sizeBefore = (await storedRow(t.screenId)).messagesJson.length;
    const image = await encodeImageFromStorage(t.imagePath, 'uploads');
    await callClaude(t.projectId, 'new question', 'system', { videoScreenId: t.screenId, image });
    const stored = JSON.parse((await storedRow(t.screenId)).messagesJson);
    expect(stored.slice(0, 2)).toEqual(legacy);
    expect(stored[2].content[0].type).toBe('soma_image_ref');
    expect((await storedRow(t.screenId)).messagesJson.length - sizeBefore).toBeLessThan(1000); // the new turn adds a few hundred bytes
  });

  it('does not need storage to read a legacy conversation', async () => {
    const t = await setup();
    await legacyConversation(t);
    holder.failDownloads = true;
    await callClaude(t.projectId, 'text only follow-up', 'system', { videoScreenId: t.screenId });
    expect(holder.downloads).toEqual([]);
    expect(holder.sent).toHaveLength(1);
  });
});

describe('failures', () => {
  it('stops without calling Claude when a referenced image cannot be loaded, and leaves the conversation as it was', async () => {
    const t = await setup();
    const image = await encodeImageFromStorage(t.imagePath, 'uploads');
    await callClaude(t.projectId, 'first', 'system', { videoScreenId: t.screenId, image });
    const before = (await storedRow(t.screenId)).messagesJson;
    holder.files.delete(t.imagePath);
    holder.sent = [];
    // A fresh process (no in-memory cache) is what a new serverless invocation looks like.
    vi.resetModules();
    const fresh = await import('@/services/anthropic');
    await expect(fresh.callClaude(t.projectId, 'second', 'system', { videoScreenId: t.screenId })).rejects.toBeInstanceOf((await import('@/lib/conversation-images')).ConversationImageError);
    expect(holder.sent).toHaveLength(0);
    expect((await storedRow(t.screenId)).messagesJson).toBe(before);
  });

  it('refuses a stored reference that points outside the uploads bucket or at a non-image path', async () => {
    const t = await setup();
    for (const bad of [
      { type: 'soma_image_ref', bucket: 'videos', path: t.imagePath, mediaType: 'image/png' },
      { type: 'soma_image_ref', bucket: 'uploads', path: `${USER}/../secret.png`, mediaType: 'image/png' },
      { type: 'soma_image_ref', bucket: 'uploads', path: `${USER}/broll/${'0'.repeat(8)}-0000-4000-8000-000000000000.mp4`, mediaType: 'image/png' },
    ]) {
      await db.delete(schema.claudeConversations).where(eq(schema.claudeConversations.videoScreenId, t.screenId));
      await db.insert(schema.claudeConversations).values({ videoProjectId: t.projectId, videoScreenId: t.screenId, messagesJson: JSON.stringify([{ role: 'user', content: [bad, { type: 'text', text: 'x' }] }]), updatedAt: 1 });
      await expect(callClaude(t.projectId, 'next', 'system', { videoScreenId: t.screenId })).rejects.toBeInstanceOf(ConversationImageError);
    }
    expect(holder.sent).toHaveLength(0);
    expect(holder.downloads).toEqual([]);
  });
});

describe('converting a legacy conversation (assessment only; no migration is run by the app)', () => {
  it('shrinks the row, reopens, and Claude receives a request identical to the one it would have received before', async () => {
    const t = await setup();
    const legacy = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: t.base64 } }, { type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: t.base64 } }, { type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ];
    const legacyJson = JSON.stringify(legacy);

    // Request with the legacy row as stored.
    await db.insert(schema.claudeConversations).values({ videoProjectId: t.projectId, videoScreenId: t.screenId, messagesJson: legacyJson, updatedAt: 1 });
    await callClaude(t.projectId, 'next', 'system', { videoScreenId: t.screenId, fresh: false, image: await encodeImageFromStorage(t.imagePath, 'uploads') });
    const before = holder.sent[0].messages;

    // Same conversation after conversion (on a copy; the legacy row above is not modified by this).
    const converted = convertLegacyImages(legacy, { bucket: 'uploads', path: t.imagePath, mediaType: 'image/png', bytes: t.bytes });
    expect(converted).toMatchObject({ replaced: 2, kept: 0 });
    const convertedJson = JSON.stringify(converted.messages);
    expect(convertedJson.length).toBeLessThan(legacyJson.length / 10);
    await db.delete(schema.claudeConversations).where(eq(schema.claudeConversations.videoScreenId, t.screenId));
    await db.insert(schema.claudeConversations).values({ videoProjectId: t.projectId, videoScreenId: t.screenId, messagesJson: convertedJson, updatedAt: 1 });
    holder.sent = [];
    await callClaude(t.projectId, 'next', 'system', { videoScreenId: t.screenId, fresh: false, image: await encodeImageFromStorage(t.imagePath, 'uploads') });
    expect(holder.sent[0].messages).toEqual(before);
  });

  it('keeps any embedded image that is not identical to the stored original', () => {
    const original = { bucket: 'uploads', path: `${USER}/00000000-0000-4000-8000-0000000000ff.png`, mediaType: 'image/png' as const, bytes: Buffer.from('original-bytes') };
    const other = { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('different').toString('base64') } }] };
    const wrongType = { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: original.bytes.toString('base64') } }] };
    const out = convertLegacyImages([other, wrongType], original);
    expect(out).toMatchObject({ replaced: 0, kept: 2 });
    expect(out.messages).toEqual([other, wrongType]);
  });
});
