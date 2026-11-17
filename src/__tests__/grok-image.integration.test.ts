/**
 * The real Higgsfield image and video providers (Grok Imagine 2.0 and Kling 3.0 Standard) end to end through the Studio worker lifecycle and
 * the Character B-roll flow, against a LOCAL FAKE of the documented Higgsfield API. Real routes, services, workers and FFmpeg; in-memory
 * Postgres from the real migrations. Nothing here reaches Higgsfield and nothing is paid for: it proves our side of the contract.
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
import { FakeHiggsfield } from './helpers/fake-higgsfield';
import { probeJson } from './helpers/ffmpeg-fixtures';

const USER = '00000000-0000-4000-8000-00000000000a';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { POST as actionPost } from '@/app/api/v1/video-projects/[id]/character-broll/[cid]/[action]/route';
import { approveImage, createCharacterItem, getItem, listItems, publicItem, regenerateImage, setMotionPrompt, startClip } from '@/lib/overlays/character';
import { generationRound, reconcileAmbiguousJobs, recoverStaleJobs, AMBIGUOUS_RESEND_AFTER_MS, type GenerationDeps } from '@/lib/studio/generation';
import { getProvider } from '@/lib/studio/mock-provider';
import { GROK_IMAGE_ENDPOINT, HiggsfieldGrokProvider, PERSONALISE_PROMPT } from '@/lib/studio/higgsfield-provider';
import { HiggsfieldClient, configFromEnv } from '@/lib/higgsfield/client';
import { HiggsfieldKlingProvider, KLING_STANDARD_ENDPOINT } from '@/lib/overlays/clip-provider';
import { processCharacterClips, type ClipDeps } from '@/worker/character-clips';
import { ObjectExistsError } from '@/lib/object-store/types';

class Store extends FakeR2 {
  async download(b: string, k: string) { const o = this.objects.get(`${b}/${k}`); if (!o) throw new Error(`missing ${b}/${k}`); return o.buf; }
  async put(b: string, k: string, buf: Buffer, opts: { contentType: string }) { this.objects.set(`${b}/${k}`, { buf, contentType: opts.contentType }); }
}

let pg: PGlite; let db: ReturnType<typeof drizzle<typeof schema>>; let store: Store; let fake: FakeHiggsfield;
const now = 1_700_000_000_000; let seq = 0;
beforeAll(async () => {
  fake = await new FakeHiggsfield().start();
  pg = new PGlite(); await migrate(pg); db = drizzle(pg, { schema }); holder.db = db;
}, 180_000);
afterAll(async () => { fake.stop(); await pg.close(); });
beforeEach(async () => {
  store = new Store(); holder.store = store; fake.reset();
  process.env.BROLL_OVERLAYS_ENABLED = 'true'; process.env.STUDIO_PROVIDER = 'higgsfield';
  process.env.HF_CREDENTIALS = 'kid:ksecret'; process.env.HIGGSFIELD_BASE_URL = fake.base;
  await pg.exec(`truncate character_broll_items, video_compilation_overlays, video_overlays, studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects, studio_deleted_keys, studio_upload_intents, studio_worker_status, studio_budget_usage restart identity cascade`);
  await reportFakeWorker(pg, { provider: 'higgsfield', mode: 'real' });
});
afterEach(() => { for (const k of ['BROLL_OVERLAYS_ENABLED', 'STUDIO_PROVIDER', 'HF_CREDENTIALS', 'HIGGSFIELD_BASE_URL', 'HIGGSFIELD_IMAGE_BUDGET_PER_HOUR']) delete process.env[k]; });

const png = (color: string) => sharp({ create: { width: 400, height: 300, channels: 3, background: color } }).png().toBuffer();
let SCENE: Buffer; let BASE: Buffer;
async function world() {
  seq += 1; SCENE = await png('#3366cc'); BASE = await png('#aa5533');
  const base = `base-${seq}.png`; store.objects.set(`uploads/${base}`, { buf: BASE, contentType: 'image/png' });
  const [vp] = await db.insert(schema.videoProjects).values({ userId: USER, name: 'Proj', baseImagePath: base, originalScript: 's', createdAt: now, updatedAt: now } as never).returning();
  const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: vp.id, screenNumber: 1, dialogue: 'Hi', position: 0, durationSeconds: 8, createdAt: now, updatedAt: now } as never).returning();
  const [pack] = await db.insert(schema.studioPacks).values({ name: `Pack ${seq}`, createdBy: USER, createdAt: now, updatedAt: now }).returning();
  const key = `studio/assets/00000000-0000-4000-8000-${String(seq).padStart(12, '0')}.png`;
  store.objects.set(`uploads/${key}`, { buf: SCENE, contentType: 'image/png' });
  const [asset] = await db.insert(schema.studioAssets).values({ packId: pack.id, storageKey: key, mime: 'image/png', sizeBytes: 10, sha256: `h${seq}`, createdBy: USER, createdAt: now, updatedAt: now }).returning();
  return { p: vp.id, screen: s.id, assetId: asset.id, params: { id: String(vp.id) } };
}
const genDeps = (over: Partial<GenerationDeps> = {}): GenerationDeps => ({
  provider: getProvider,
  read: async (k) => store.downloadR2Only('uploads', k),
  put: async (k, b, m) => { try { await store.putR2Only('uploads', k, b, { contentType: m }); return 'created'; } catch (e) { if (e instanceof ObjectExistsError) return 'exists'; throw e; } },
  ...over,
});
const forward = () => pg.exec(`update studio_jobs set next_poll_at = 0 where next_poll_at is not null`);
async function rounds(n = 4, deps = genDeps()) { for (let i = 0; i < n; i++) { await forward(); await generationRound(deps, { submit: 2, poll: 2 }); } }
const job = async () => (await db.select().from(schema.studioJobs).orderBy(schema.studioJobs.id))[0];
const GROK_PATH = `/${GROK_IMAGE_ENDPOINT}`;

describe('Grok Imagine 2.0: the request', () => {
  it('uploads the scene then the character, and submits exactly the documented body to the documented endpoint', async () => {
    const w = await world();
    const it = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId, intendedAction: 'x' });
    await rounds(1);
    const subs = fake.submits(GROK_IMAGE_ENDPOINT);
    expect(subs).toHaveLength(1);
    const j = await job();
    expect(subs[0].path).toBe('/xai/grok-imagine-image-2.0');
    expect(subs[0].auth).toBe('Key kid:ksecret');
    expect(subs[0].idem).toBe(`studio-job-${j.id}`);
    const body = JSON.parse(subs[0].body);
    expect(body).toEqual({ prompt: 'Image 1 is the master image.\nImage 2 is the master model.\nReplace the model in the master image with the master model.', image_urls: expect.any(Array), resolution: '2k', aspect_ratio: 'auto', quality: 'medium' });
    expect(body.prompt).toBe(PERSONALISE_PROMPT);
    expect(body.image_urls).toHaveLength(2);
    // image 1 = the Scene Pack image, image 2 = the master character (the project's base image), in that order
    const urlPath = (u: string) => new URL(u).pathname;
    expect(fake.uploads.get(urlPath(body.image_urls[0]))!.equals(SCENE)).toBe(true);
    expect(fake.uploads.get(urlPath(body.image_urls[1]))!.equals(BASE)).toBe(true);
    // the presigned storage PUT carries the documented headers and NO API credentials
    const puts = fake.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    for (const p of puts) { expect(p.headers['x-amz-tagging']).toBe('retention=temporary'); expect(p.auth).toBeUndefined(); }
    expect(it.imageStatus).toBe('generating');
    expect((await job()).providerJobId).toMatch(/^req-/);        // the request id is persisted
    expect(((await job()).request as { higgsfield: { imageUrls: string[] } }).higgsfield.imageUrls).toEqual(body.image_urls);
  });
});

describe('Grok Imagine 2.0: the result', () => {
  it('downloads the finished image at once into our own R2 storage and the item is ready for review', async () => {
    const w = await world();
    const it = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    await rounds(4);
    const j = await job();
    expect(j.status).toBe('succeeded');
    const [out] = await db.select().from(schema.studioOutputs);
    expect(out).toMatchObject({ width: 1504, height: 2752, mime: 'image/png' });
    expect(store.objects.has(`uploads/${out.storageKey}`)).toBe(true);        // stored in R2 ('uploads' bucket), not referenced by a Higgsfield URL
    expect(out.storageKey).not.toMatch(/^http/);
    expect(fake.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/cdn/'))).toHaveLength(1);   // downloaded once
    expect(fake.calls.filter((c) => c.path.startsWith('/cdn/')).every((c) => !c.auth)).toBe(true);        // the CDN link gets no credentials
    expect((await getItem(w.p, it.id)).imageStatus).toBe('ready');
    // a later read never touches Higgsfield again
    const before = fake.calls.length; await getItem(w.p, it.id); expect(fake.calls.length).toBe(before);
  });

  it('nsfw, failed and canceled end the job without a result and say that nothing is charged', async () => {
    for (const final of ['nsfw', 'failed', 'canceled'] as const) {
      const w = await world(); fake.reset(); fake.finalStatus = final;
      const it = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
      await rounds(4);
      const j = (await db.select().from(schema.studioJobs).orderBy(schema.studioJobs.id)).pop()!;
      expect(j.status).toBe('failed'); expect(j.errorMessage).toMatch(/not charged/i);
      expect(j.errorRetryable).toBe(final !== 'nsfw');
      expect((await getItem(w.p, it.id)).imageStatus).toBe('failed');
      expect(await db.select().from(schema.studioOutputs)).toHaveLength(0);
      await pg.exec('truncate character_broll_items, studio_jobs, studio_batches, studio_selections, studio_project_packs restart identity cascade');
    }
  });
});

describe('no duplicate paid generations', () => {
  it('a lost answer leaves the job UNKNOWN and it is never repeated automatically; only a person, warned about a double charge, can generate again', async () => {
    const w = await world();
    const it = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    fake.submitScript = ['lose'];                                  // accepted and recorded at Higgsfield, but the answer never arrives
    await rounds(1);
    expect((await job()).status).toBe('submit_unknown');
    expect((await job()).errorMessage).toMatch(/Higgsfield generation history/);       // tells the person what to check
    expect(fake.requests.size).toBe(1);
    // no automatic resend, however long it waits
    const r = await reconcileAmbiguousJobs(genDeps(), { now: Date.now() + 10 * 60 * 60 * 1000 });
    expect(r).toMatchObject({ requeued: 0, waiting: 1 });
    await rounds(3);
    expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(1);
    // the item says so, and refuses to generate again without an explicit confirmation
    const view = (await listItems(w.p))[0];
    expect(view).toMatchObject({ imageStatus: 'generating', imageJobStatus: 'submit_unknown' });
    expect(view.imageNote).toMatch(/charged twice|history/i);
    await expect(regenerateImage(w.p, it.id, USER)).rejects.toMatchObject({ code: 'outcome_unknown', status: 409 });
    expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(1);
    // the person confirms: the old job is closed (never deleted) and a NEW job (new key, new uploads) is made. This is the accepted risk.
    const again = await regenerateImage(w.p, it.id, USER, { confirmDuplicate: true });
    expect(again.studioJobId).not.toBe(view.studioJobId);
    const jobs = await db.select().from(schema.studioJobs).orderBy(schema.studioJobs.id);
    expect(jobs.map((j) => j.status)).toEqual(['failed', 'queued']);
    expect(jobs[0].errorCode).toBe('submit_unknown_abandoned');
    await rounds(4);
    expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(2);
    expect(new Set(fake.submits(GROK_IMAGE_ENDPOINT).map((c) => c.idem)).size).toBe(2);   // two different keys: not claimed to be deduplicated
  });

  it('a 5xx, a timeout and a dropped connection on submit are all "unknown", not failures and not resent', async () => {
    for (const step of ['503', 'hang'] as const) {
      fake.reset(); await pg.exec('truncate character_broll_items, studio_jobs, studio_batches, studio_selections, studio_project_packs restart identity cascade');
      const w = await world(); await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
      fake.submitScript = [step];
      await rounds(1, genDeps({ providerTimeoutMs: 200 }));
      expect((await job()).status).toBe('submit_unknown');
      await rounds(2);
      expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(1);
    }
  });

  it('persists what was prepared BEFORE submitting: uploaded urls, endpoint, a hash of the exact body and the time', async () => {
    const w = await world();
    await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    fake.submitScript = ['lose'];
    await rounds(1);
    const rec = ((await job()).request as { higgsfield: { imageUrls: string[]; endpoint: string; bodySha256: string; preparedAt: number } }).higgsfield;
    const sent = fake.submits(GROK_IMAGE_ENDPOINT)[0].body;
    expect(rec.endpoint).toBe('xai/grok-imagine-image-2.0');
    expect(rec.imageUrls).toHaveLength(2);
    expect(rec.preparedAt).toBeGreaterThan(0);
    expect(rec.bodySha256).toBe(require('node:crypto').createHash('sha256').update(JSON.stringify(JSON.parse(sent))).digest('hex'));
  });

  it('a worker restart while the image is processing only polls the stored request id: no second submission', async () => {
    const w = await world();
    await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    fake.pollsBeforeDone = 3;
    await rounds(1);
    const requestId = (await job()).providerJobId;
    expect(await recoverStaleJobs()).toEqual({ interrupted: 0, timedOut: 0 });
    // a brand-new worker: new client, new provider object, knows only the database
    const fresh = new HiggsfieldGrokProvider(new HiggsfieldClient(configFromEnv(process.env)));
    await rounds(6, genDeps({ provider: () => fresh }));
    expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(1);
    expect((await job())).toMatchObject({ status: 'succeeded', providerJobId: requestId });
  });

  it('a job stuck "submitting" when the worker died is treated as unknown, never silently resent', async () => {
    const w = await world();
    await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    await pg.exec(`update studio_jobs set status = 'submitting', claimed_at = 1`);
    expect((await recoverStaleJobs()).interrupted).toBe(1);
    expect((await job()).status).toBe('submit_unknown');
    expect(fake.submits()).toHaveLength(0);
  });
});

describe('rate limits and errors', () => {
  it('429 account_queue_full waits for Retry-After and then sends the same job; it is not failed', async () => {
    const w = await world();
    await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    fake.submitScript = ['429']; fake.retryAfter = 12;
    const t0 = Date.now();
    await rounds(1);
    const j = await job();
    expect(j.status).toBe('queued');
    expect(Number(j.nextPollAt) - t0).toBeGreaterThanOrEqual(11_000);
    await generationRound(genDeps(), { submit: 2, poll: 2 });         // not due yet: nothing is sent
    expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(1);
    await rounds(4);                                                  // due: sent again, same job, then finished
    expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(2);
    expect((await job()).status).toBe('succeeded');
  });

  it('403 (balance) and 422 are clean rejections: the job fails once, with a readable message, and nothing is polled', async () => {
    const w = await world();
    await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    fake.submitScript = ['403'];
    await rounds(2);
    const j = await job();
    expect(j).toMatchObject({ status: 'failed', errorCode: 'forbidden_or_balance', errorRetryable: false });
    expect(j.errorMessage).toMatch(/balance/i);
    expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(1);
  });

  it('is capped per hour, and the cap is returned when the batch could not be made', async () => {
    process.env.HIGGSFIELD_IMAGE_BUDGET_PER_HOUR = '1';
    const a = await world(); const b = await world();
    await createCharacterItem(a.p, USER, { studioAssetId: a.assetId });
    await expect(createCharacterItem(b.p, USER, { studioAssetId: b.assetId })).rejects.toMatchObject({ code: 'budget_reached' });
  });
});

describe('approval gate, then Kling 3.0 Standard', () => {
  const clipDeps = (): ClipDeps => ({
    provider: new HiggsfieldKlingProvider(new HiggsfieldClient(configFromEnv(process.env))),
    readImage: (k) => store.downloadR2Only('uploads', k),
    writeClip: async (k, b) => { await store.put('videos', k, b, { contentType: 'video/mp4' }); }, now: () => Date.now(),
  });
  const ff = () => pg.exec(`update character_broll_items set next_poll_at = 0 where next_poll_at is not null`);

  it('no Kling request can be made from an unapproved image (API, service, database); after approval the approved image becomes the first frame, 5 s, sound off', async () => {
    const w = await world();
    const it = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId, intendedAction: 'smiles' });
    await rounds(4);
    expect((await getItem(w.p, it.id)).imageStatus).toBe('ready');
    await expect(startClip(w.p, it.id)).rejects.toMatchObject({ code: 'image_not_approved' });
    const viaApi = await call(actionPost, { method: 'POST', params: { ...w.params, cid: String(it.id), action: 'generate' } });
    expect(viaApi.status).toBe(409);
    await expect(pg.query(`update character_broll_items set clip_status = 'queued' where id = $1`, [it.id])).rejects.toThrow(/character_broll_video_needs_approved_image/);
    await processCharacterClips(clipDeps());
    expect(fake.submits(KLING_STANDARD_ENDPOINT)).toHaveLength(0);       // nothing was sent to the video model

    await approveImage(w.p, it.id, USER);
    await setMotionPrompt(w.p, it.id, 'She smiles and glances up.');
    const q = await startClip(w.p, it.id);
    const d = clipDeps();
    await processCharacterClips(d);
    const sub = fake.submits(KLING_STANDARD_ENDPOINT);
    expect(sub).toHaveLength(1);
    expect(sub[0].path).toBe('/kling-video/v3.0/std/image-to-video');
    expect(sub[0].path).not.toMatch(/turbo/);
    expect(sub[0].idem).toBe(q.idempotencyKey);
    const body = JSON.parse(sub[0].body);
    expect(body).toEqual({ image_url: expect.stringContaining('/public/'), prompt: 'She smiles and glances up.', duration: 5, sound: 'off' });
    // the image Kling got is the APPROVED personalised image (the stored Grok output)
    const [out] = await db.select().from(schema.studioOutputs);
    expect(fake.uploads.get(new URL(body.image_url).pathname)!.equals(store.objects.get(`uploads/${out.storageKey}`)!.buf)).toBe(true);
    for (let i = 0; i < 6; i++) { await ff(); await processCharacterClips(d); }
    const done = (await db.select().from(schema.characterBrollItems))[0];
    expect(done).toMatchObject({ clipStatus: 'ready', clipWidth: 720, clipHeight: 1280, clipProvider: 'higgsfield', clipEndpoint: KLING_STANDARD_ENDPOINT });
    const f = path.join(os.tmpdir(), `grok-test-clip-${process.pid}.mp4`); fs.writeFileSync(f, store.objects.get(`videos/${done.clipStoragePath}`)!.buf);
    expect(probeJson(f).streams.some((s) => s.codec_type === 'audio')).toBe(false);   // silent after normalisation
    fs.rmSync(f, { force: true });
    expect(fake.submits(KLING_STANDARD_ENDPOINT)).toHaveLength(1);
  }, 180_000);

  it('a lost answer on the Kling submit is NOT repeated automatically and does not block the items behind it; a person can try again, knowing it may be charged twice', async () => {
    const w = await world(); const w2 = await world();
    const it1 = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    const it2 = await createCharacterItem(w2.p, USER, { studioAssetId: w2.assetId });
    await rounds(4);
    for (const [pid, it] of [[w.p, it1], [w2.p, it2]] as const) { await approveImage(pid, it.id, USER); await setMotionPrompt(pid, it.id, 'Slow push-in.'); await startClip(pid, it.id); }
    const d = clipDeps();
    fake.submitScript = ['lose'];
    await processCharacterClips(d);                                    // item 1: answer lost
    const [a1] = await db.select().from(schema.characterBrollItems).where(eq(schema.characterBrollItems.id, it1.id));
    expect(a1.clipStatus).toBe('submit_unknown'); expect(a1.clipErrorMessage).toMatch(/Higgsfield generation history/);
    for (let i = 0; i < 3; i++) { await ff(); await processCharacterClips(d); }
    const rows = await db.select().from(schema.characterBrollItems).orderBy(schema.characterBrollItems.id);
    expect(rows[0].clipStatus).toBe('submit_unknown');                 // never picked up again by itself
    expect(['processing', 'ready']).toContain(rows[1].clipStatus);     // item 2 was not held up
    expect(fake.submits(KLING_STANDARD_ENDPOINT).filter((c) => c.idem === a1.idempotencyKey)).toHaveLength(1);
    await expect(startClip(w.p, it1.id)).rejects.toMatchObject({ code: 'outcome_unknown' });
    const retry = await startClip(w.p, it1.id, { confirmDuplicate: true });
    expect(retry.clipAttempt).toBe(2); expect(retry.idempotencyKey).not.toBe(a1.idempotencyKey);
  }, 180_000);
});

describe('423 and cleanup', () => {
  it('a temporarily blocked model (423) waits and is sent again; it is not failed and not a duplicate', async () => {
    const w = await world(); await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    fake.submitScript = ['423'];
    await rounds(1);
    expect((await job()).status).toBe('queued');
    await rounds(4);
    expect((await job()).status).toBe('succeeded'); expect(fake.requests.size).toBe(1);
  });

  it('a rate-limited job is bounded: after too many "busy" answers it fails instead of waiting for ever', async () => {
    const w = await world(); await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    await pg.exec(`update studio_jobs set submit_attempts = 19`);
    fake.submitScript = ['429'];
    await rounds(1);
    expect((await job()).status).toBe('failed');
  });

  it('after the result is stored in R2 the provider copy is deleted (best effort); a failing or disabled cleanup never changes the result', async () => {
    const w = await world(); await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    await rounds(4);
    expect((await job()).status).toBe('succeeded');
    expect([...fake.deleted]).toEqual([(await job()).providerJobId]);
    fake.reset(); fake.deleteStatus = 503;
    await pg.exec('truncate character_broll_items, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_outputs restart identity cascade');
    const w2 = await world(); await createCharacterItem(w2.p, USER, { studioAssetId: w2.assetId });
    await rounds(4);
    expect((await job()).status).toBe('succeeded');                   // the delete failed (503) and nothing else noticed
    expect((await db.select().from(schema.studioOutputs))).toHaveLength(1);
    process.env.HIGGSFIELD_DELETE_AFTER_STORE = 'off'; fake.reset();
    try {
      await pg.exec('truncate character_broll_items, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_outputs restart identity cascade');
      const w3 = await world(); await createCharacterItem(w3.p, USER, { studioAssetId: w3.assetId });
      await rounds(4);
      expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    } finally { delete process.env.HIGGSFIELD_DELETE_AFTER_STORE; }
  });
});

describe('what the browser can see', () => {
  it('never receives the provider-side image URLs, the idempotency key or the internal probe, from the list or from any action', async () => {
    const w = await world();
    const it = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    await rounds(4); await approveImage(w.p, it.id, USER); await setMotionPrompt(w.p, it.id, 'Slow push-in.'); await startClip(w.p, it.id);
    const d = { provider: new HiggsfieldKlingProvider(new HiggsfieldClient(configFromEnv(process.env))), readImage: (k: string) => store.downloadR2Only('uploads', k), writeClip: async (k: string, b: Buffer) => { await store.put('videos', k, b, { contentType: 'video/mp4' }); }, now: () => Date.now() };
    await processCharacterClips(d);
    const [row] = await db.select().from(schema.characterBrollItems);
    expect(JSON.stringify(row.clipProbe)).toContain('/public/');        // it IS stored server-side (needed to repeat a request identically)...
    const seen = JSON.stringify([await listItems(w.p), publicItem(row)]);
    expect(seen).not.toContain(fake.base);                              // ...but never leaves the server
    expect(seen).not.toContain('/public/');
    expect(seen).not.toContain(row.idempotencyKey!);
    expect(seen).not.toContain('clipProbe'); expect(seen).not.toContain('inputImageUrl');
    const viaApi = await call(actionPost, { method: 'POST', params: { ...w.params, cid: String(it.id), action: 'prompt' }, body: { motionPrompt: 'x' } });
    expect(JSON.stringify(viaApi.json)).not.toContain(fake.base);
  }, 180_000);
});

describe('image dimensions and aspect ratio', () => {
  it('keeps the original Grok image byte-for-byte (1504x2752), reviews it whole, and sends Kling that same file', async () => {
    const w = await world();
    const it = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    await rounds(4);
    const [out] = await db.select().from(schema.studioOutputs);
    const original = store.objects.get(`uploads/${out.storageKey}`)!.buf;
    const fromHiggsfield = await (await fetch(`${fake.base}/cdn/${(await job()).providerJobId}.png`)).arrayBuffer();
    expect(Buffer.from(fromHiggsfield).equals(original)).toBe(true);        // stored exactly as received: no resize, crop, re-encode
    expect(await sharp(original).metadata()).toMatchObject({ width: 1504, height: 2752 });
    const view = (await listItems(w.p))[0];
    expect(view).toMatchObject({ imageWidth: 1504, imageHeight: 2752 });
    expect(view.fullImageUrl).toBeTruthy(); expect(view.imageUrl).toBeTruthy();
    const thumb = await sharp(store.objects.get(`uploads/${out.thumbKey}`)!.buf).metadata();   // the review thumbnail keeps the proportions (not stretched, not cropped)
    expect(Math.abs(thumb.width! / thumb.height! - 1504 / 2752)).toBeLessThan(0.01);
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(480);
    // Kling receives the approved original file
    await approveImage(w.p, it.id, USER); await setMotionPrompt(w.p, it.id, 'Slow push-in.'); await startClip(w.p, it.id);
    await processCharacterClips({ provider: new HiggsfieldKlingProvider(new HiggsfieldClient(configFromEnv(process.env))), readImage: (k) => store.downloadR2Only('uploads', k), writeClip: async () => undefined, now: () => Date.now() });
    const body = JSON.parse(fake.submits(KLING_STANDARD_ENDPOINT)[0].body);
    expect(fake.uploads.get(new URL(body.image_url).pathname)!.equals(original)).toBe(true);
  });
});

describe('a worker without credentials never fails work that is already running', () => {
  it('a paid image in progress stays in progress while a worker without credentials runs, then completes when one with credentials returns', async () => {
    const w = await world(); await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    fake.pollsBeforeDone = 3;
    await rounds(1);
    const requestId = (await job()).providerJobId;
    expect((await job()).status).toBe('processing');
    const { ProviderError } = await import('@/lib/studio/provider');
    const noCreds = genDeps({ provider: () => { throw new ProviderError('Higgsfield is not configured on this worker (HF_CREDENTIALS is missing).', 'provider_not_configured', false); } });
    for (let i = 0; i < 3; i++) { await forward(); await generationRound(noCreds, { submit: 2, poll: 2 }); }
    expect(await job()).toMatchObject({ status: 'processing', providerJobId: requestId });     // not failed, not re-queued, not re-submitted
    expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(1);
    await rounds(6);                                                                          // a worker with credentials comes back
    expect(await job()).toMatchObject({ status: 'succeeded', providerJobId: requestId });
    expect(fake.submits(GROK_IMAGE_ENDPOINT)).toHaveLength(1);
  });

  it('a queued job claimed by a worker that cannot use the provider goes back to the queue instead of failing', async () => {
    const w = await world(); await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    const { ProviderError } = await import('@/lib/studio/provider');
    await generationRound(genDeps({ provider: () => { throw new ProviderError('missing', 'provider_not_configured', false); } }), { submit: 2, poll: 0 });
    expect((await job()).status).toBe('queued');
    expect(fake.calls).toHaveLength(0);
    await rounds(4);
    expect((await job()).status).toBe('succeeded');
  });
});

describe('provider configuration and credentials (continued)', () => {
  it('real getProvider reports missing credentials as "not configured" (waits), and an unknown provider as "unavailable" (fails)', async () => {
    const { getProvider: gp } = await import('@/lib/studio/mock-provider');
    delete process.env.HF_CREDENTIALS;
    try { gp('higgsfield'); throw new Error('should have thrown'); } catch (e) { expect(e).toMatchObject({ code: 'provider_not_configured' }); }
    try { gp('nanobanana'); throw new Error('should have thrown'); } catch (e) { expect(e).toMatchObject({ code: 'provider_unavailable' }); }
  });
});

describe('provider configuration and credentials', () => {
  it('without HF_CREDENTIALS the worker is not ready and nothing is submitted or uploaded', async () => {
    delete process.env.HF_CREDENTIALS;
    const { workerProviderReady, getProvider: gp } = await import('@/lib/studio/mock-provider');
    expect(workerProviderReady()).toBe(false);
    await reportFakeWorker(pg, { provider: 'higgsfield', mode: 'real', ready: false });   // what such a worker reports
    const w = await world();
    await expect(createCharacterItem(w.p, USER, { studioAssetId: w.assetId })).rejects.toMatchObject({ code: 'worker_not_ready', status: 503 });
    expect(() => gp('higgsfield')).toThrow(/HF_CREDENTIALS is missing/);
    expect(fake.calls).toHaveLength(0);
    // and a job that somehow exists is not submitted by a worker without credentials
    await reportFakeWorker(pg, { provider: 'higgsfield', mode: 'real' });
    await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    await generationRound({ ...genDeps(), canSubmit: () => false }, { submit: 2, poll: 2 });
    expect(fake.calls).toHaveLength(0);
    expect((await job()).status).toBe('queued');
  });

  it('a video cannot be requested when the worker has no video provider (missing credentials): clear message, nothing charged or queued', async () => {
    const w = await world();
    const it = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId });
    await rounds(4); await approveImage(w.p, it.id, USER); await setMotionPrompt(w.p, it.id, 'Slow push-in.');
    await reportFakeWorker(pg, { provider: 'higgsfield', mode: 'real', clipProvider: null });
    await expect(startClip(w.p, it.id)).rejects.toMatchObject({ code: 'video_unavailable', status: 503 });
    expect((await getItem(w.p, it.id)).clipStatus).toBe('not_started');
    const { videoGenerationReadiness } = await import('@/lib/overlays/readiness');
    expect(await videoGenerationReadiness()).toMatchObject({ ready: false });
  });

  it('web code never touches the provider or the credentials; they exist only in worker-side modules', () => {
    const root = path.resolve(__dirname, '..');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));
    const needles = /HF_CREDENTIALS|higgsfieldConfigured|configFromEnv|getProvider\(|workerProviderReady|clipProviderFromEnv/;
    // readiness.ts only names the variable in a message; it reads the worker's reported status from the database, never the environment
    const allowed = ['lib/higgsfield/client.ts', 'lib/studio/mock-provider.ts', 'worker/character-clips.ts', 'worker/studio.ts', 'lib/overlays/readiness.ts'];
    const hits = walk(root).filter((f) => !f.includes('__tests__') && !allowed.some((a) => f.endsWith(a))).filter((f) => needles.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
    expect(hits).toEqual([]);                                                   // nothing in src/app, src/components or any other web library
    expect(fs.readFileSync(path.join(root, 'worker/index.ts'), 'utf8')).not.toMatch(/HF_CREDENTIALS/);
    // no NEXT_PUBLIC_ variable can carry the credentials into the browser bundle
    expect(walk(root).filter((f) => !f.includes('__tests__')).some((f) => /NEXT_PUBLIC_HF|NEXT_PUBLIC_HIGGSFIELD/.test(fs.readFileSync(f, 'utf8')))).toBe(false);
  });
});
