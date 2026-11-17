/**
 * Character B-roll end to end on an in-memory Postgres (real migrations), real routes and services, the real Studio generation round
 * with its mock image provider, the real clip worker with a mock video provider, and real FFmpeg. Nothing external is called and
 * nothing is paid for.
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
import { probeJson } from './helpers/ffmpeg-fixtures';

const USER = '00000000-0000-4000-8000-00000000000a';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { POST as actionPost } from '@/app/api/v1/video-projects/[id]/character-broll/[cid]/[action]/route';
import { GET as itemsGet } from '@/app/api/v1/video-projects/[id]/character-broll/route';
import { approveImage, createCharacterItem, getItem, regenerateImage, rejectImage, setMotionPrompt, startClip, suggestMotionPrompt } from '@/lib/overlays/character';
import { generationRound, type GenerationDeps } from '@/lib/studio/generation';
import { MockReplacementProvider } from '@/lib/studio/mock-provider';
import { MockClipProvider } from '@/lib/overlays/mock-clip-provider';
import { ClipProviderError, type ClipProvider } from '@/lib/overlays/clip-provider';
import { processCharacterClips, SUBMITTING_STALE_MS, type ClipDeps } from '@/worker/character-clips';
import { ObjectExistsError } from '@/lib/object-store/types';

/** FakeR2 plus the plain storage calls the video side uses. One shared object map, keyed bucket/key. */
class Store extends FakeR2 {
  async download(b: string, k: string) { const o = this.objects.get(`${b}/${k}`); if (!o) throw new Error(`missing ${b}/${k}`); return o.buf; }
  async put(b: string, k: string, buf: Buffer, opts: { contentType: string }) { this.objects.set(`${b}/${k}`, { buf, contentType: opts.contentType }); }
}

let pg: PGlite; let db: ReturnType<typeof drizzle<typeof schema>>; let store: Store; let dir: string;
const now = 1_700_000_000_000;
let seq = 0;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-cbroll-'));
  pg = new PGlite(); await migrate(pg); db = drizzle(pg, { schema }); holder.db = db;
}, 180_000);
afterAll(async () => { await pg.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  store = new Store(); holder.store = store;
  process.env.BROLL_OVERLAYS_ENABLED = 'true'; process.env.STUDIO_PROVIDER = 'mock';
  await pg.exec(`truncate character_broll_items, video_compilation_overlays, video_overlays, studio_outputs, studio_jobs, studio_batches, studio_selections, studio_project_packs, studio_asset_metadata, studio_assets, studio_packs, studio_projects, studio_deleted_keys, studio_upload_intents, studio_worker_status, studio_budget_usage restart identity cascade`);
  await reportFakeWorker(pg);
});
afterEach(() => { delete process.env.BROLL_OVERLAYS_ENABLED; delete process.env.STUDIO_PROVIDER; });

const png = (color: string) => sharp({ create: { width: 400, height: 300, channels: 3, background: color } }).png().toBuffer();
async function world() {
  seq += 1;
  const base = `base-${seq}.png`; store.objects.set(`uploads/${base}`, { buf: await png('#aa5533'), contentType: 'image/png' });
  const [vp] = await db.insert(schema.videoProjects).values({ userId: USER, name: 'Proj', baseImagePath: base, originalScript: 's', createdAt: now, updatedAt: now } as never).returning();
  const screens: number[] = [];
  for (let i = 0; i < 2; i++) { const [s] = await db.insert(schema.videoScreens).values({ videoProjectId: vp.id, screenNumber: i + 1, dialogue: 'Hi', position: i, durationSeconds: 8, createdAt: now, updatedAt: now } as never).returning(); screens.push(s.id); }
  const [pack] = await db.insert(schema.studioPacks).values({ name: `Pack ${seq}`, createdBy: USER, createdAt: now, updatedAt: now }).returning();
  const key = `studio/assets/00000000-0000-4000-8000-${String(seq).padStart(12, '0')}.png`;
  store.objects.set(`uploads/${key}`, { buf: await png('#3366cc'), contentType: 'image/png' });
  const [asset] = await db.insert(schema.studioAssets).values({ packId: pack.id, storageKey: key, mime: 'image/png', sizeBytes: 10, sha256: `h${seq}`, createdBy: USER, createdAt: now, updatedAt: now }).returning();
  return { p: vp.id, screens, assetId: asset.id, params: { id: String(vp.id) } };
}
const imgDeps = (provider = new MockReplacementProvider({ pollsBeforeDone: 0 })): GenerationDeps => ({
  provider: () => provider,
  read: async (k) => store.downloadR2Only('uploads', k),
  put: async (k, b, m) => { try { await store.putR2Only('uploads', k, b, { contentType: m }); return 'created'; } catch (e) { if (e instanceof ObjectExistsError) return 'exists'; throw e; } },
});
const runStudio = async (provider = new MockReplacementProvider({ pollsBeforeDone: 0 })) => { for (let i = 0; i < 4; i++) { await pg.exec(`update studio_jobs set next_poll_at = 0 where status = 'processing'`); await generationRound(imgDeps(provider), { submit: 2, poll: 2 }); } };
/** Runs the Studio worker until the personalised image exists. */
async function makeImage(w: Awaited<ReturnType<typeof world>>, provider = new MockReplacementProvider({ pollsBeforeDone: 0 })) {
  const item = await createCharacterItem(w.p, USER, { studioAssetId: w.assetId, intendedAction: 'She picks up her coffee and smiles' });
  await runStudio(provider);
  const jobs = await db.select().from(schema.studioJobs);
  if (process.env.DBG) console.log('JOBS', JSON.stringify(jobs.map((j) => ({ s: j.status, e: j.errorMessage, c: j.errorCode, n: j.nextPollAt, p: j.pollCount }))));
  return { item, provider, ready: await getItem(w.p, item.id) };
}
const clipDeps = (provider: ClipProvider | null, over: Partial<ClipDeps> = {}): ClipDeps => ({
  provider, readImage: (k) => store.downloadR2Only('uploads', k),
  writeClip: async (k, b) => { await store.put('videos', k, b, { contentType: 'video/mp4' }); }, now: () => Date.now(), ...over,
});
const fakeClaude = (text = 'She lifts the cup and smiles; slow push-in.') => ({ messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text }] })) } }) as never;
const item = async (id: number) => (await db.select().from(schema.characterBrollItems).where(eq(schema.characterBrollItems.id, id)))[0];
async function approved(w: Awaited<ReturnType<typeof world>>) {
  const { item: it, ready } = await makeImage(w);
  expect(ready.imageStatus).toBe('ready');
  await approveImage(w.p, it.id, USER);
  await suggestMotionPrompt(w.p, it.id, { client: fakeClaude() });
  return it.id;
}
async function runClip(provider: ClipProvider, ticks = 8) { const d = clipDeps(provider); for (let i = 0; i < ticks; i++) { await processCharacterClips(d); await new Promise((r) => setTimeout(r, 2)); } }
const fastForward = () => pg.exec(`update character_broll_items set next_poll_at = 0 where next_poll_at is not null`);

describe('the personalised image comes first, and nothing paid can start before it is approved', () => {
  it('creating Character B-roll makes ONLY an image job; the video provider is never asked', async () => {
    const w = await world();
    const clip = new MockClipProvider();
    const { item: it, ready } = await makeImage(w);
    expect(ready).toMatchObject({ imageStatus: 'ready', clipStatus: 'not_started' });
    await runClip(clip, 3);
    expect(clip.submitted).toHaveLength(0);
    expect((await item(it.id)).clipStatus).toBe('not_started');
    // The master character used is the project's own base image.
    const [sp] = await db.select().from(schema.studioProjects);
    const [link] = await db.select().from(schema.studioProjectLinks).where(eq(schema.studioProjectLinks.id, sp.id));
    expect(link.videoProjectId).toBe(w.p);
    expect(store.objects.get(`uploads/${sp.characterKey}`)).toBeTruthy();
  });

  it('refuses to start the video for an unapproved image (API, service and database), and a rejected image cannot be used either', async () => {
    const w = await world();
    const { item: it } = await makeImage(w);
    await expect(startClip(w.p, it.id)).rejects.toMatchObject({ code: 'image_not_approved' });
    const viaApi = await call(actionPost, { method: 'POST', params: { ...w.params, cid: String(it.id), action: 'generate' } });
    expect(viaApi.status).toBe(409); expect(viaApi.json.code).toBe('image_not_approved');
    // Even code that skips the checks cannot do it: the database refuses a video job without an approved image.
    await expect(pg.query(`update character_broll_items set clip_status = 'queued' where id = $1`, [it.id])).rejects.toThrow(/character_broll_video_needs_approved_image/);
    await rejectImage(w.p, it.id, USER);
    await expect(startClip(w.p, it.id)).rejects.toMatchObject({ code: 'image_not_approved' });
    await expect(suggestMotionPrompt(w.p, it.id, { client: fakeClaude() })).rejects.toMatchObject({ code: 'image_not_approved' });
  });

  it('approval saves the Studio output; rejecting and regenerating makes a new image job; a prompt needs an approved image', async () => {
    const w = await world();
    const { item: it, ready } = await makeImage(w);
    await rejectImage(w.p, it.id, USER);
    const [out] = await db.select().from(schema.studioOutputs).where(eq(schema.studioOutputs.id, ready.studioOutputId!));
    expect(out.reviewStatus).toBe('rejected');
    const again = await regenerateImage(w.p, it.id, USER);
    expect(again).toMatchObject({ imageStatus: 'generating', studioOutputId: null });
    expect(again.studioJobId).not.toBe(ready.studioJobId);
    await runStudio();
    const second = await getItem(w.p, it.id);
    expect(second.imageStatus).toBe('ready');
    const ok = await approveImage(w.p, it.id, USER);
    expect(ok).toMatchObject({ imageStatus: 'approved' }); expect(ok.imageApprovedAt).toBeGreaterThan(0);
    const [out2] = await db.select().from(schema.studioOutputs).where(eq(schema.studioOutputs.id, second.studioOutputId!));
    expect(out2.reviewStatus).toBe('saved');
  });
});

describe('the motion prompt', () => {
  it('is written from the actual approved image and the intended action, is editable, and is not sent anywhere paid', async () => {
    const w = await world();
    const { item: it } = await makeImage(w);
    await approveImage(w.p, it.id, USER);
    const client = fakeClaude('She lifts the coffee cup toward the camera and smiles.');
    const s = await suggestMotionPrompt(w.p, it.id, { client });
    expect(s).toMatchObject({ motionPrompt: 'She lifts the coffee cup toward the camera and smiles.', promptEdited: false });
    const sent = (client as unknown as { messages: { create: { mock: { calls: Array<[{ messages: Array<{ content: Array<{ type: string; text?: string }> }>; system: string }]> } } } }).messages.create.mock.calls[0][0];
    expect(sent.messages[0].content.some((c) => c.type === 'image')).toBe(true);          // the actual image
    expect(sent.messages[0].content.find((c) => c.type === 'text')?.text).toContain('She picks up her coffee and smiles');   // and the intended action
    expect(sent.system).toContain('Generate a video where the model is cooking');           // Soma's own prompts are the examples
    expect(sent.system).toContain('no speaking'); expect(sent.system).toContain('keep the camera static');
    expect(sent.system).toMatch(/INTENDED ACTION ALWAYS WINS/);                                 // the person's action is never replaced
    expect(sent.system).toMatch(/KEEP IT SHORT AND SIMPLE/); expect(sent.system).toMatch(/no emotional build-up/);   // short, simple, like the examples
    expect(sent.system).toMatch(/FIRST FRAME/); expect(sent.system).toMatch(/do not use @ references/i);   // written for the frame; no @ tags (one image only)
    expect(sent.system).not.toMatch(/always add|append/i);                                  // the camera line is chosen per image, never pasted on
    const edited = await setMotionPrompt(w.p, it.id, '  Slow dolly in as she smiles.  ');
    expect(edited).toMatchObject({ motionPrompt: 'Slow dolly in as she smiles.', promptEdited: true });
    await expect(setMotionPrompt(w.p, it.id, '   ')).rejects.toMatchObject({ code: 'empty_prompt' });
  });
});

describe('the video job', () => {
  it('submits once with the approved image, the edited prompt, 5 s, then polls, stores a silent 720x1280 clip in our storage, and it can be placed on the timeline', async () => {
    const w = await world();
    const id = await approved(w);
    await setMotionPrompt(w.p, id, 'Slow dolly in as she smiles.');
    const q = await startClip(w.p, id);
    expect(q).toMatchObject({ clipStatus: 'queued', clipAttempt: 1 });
    const provider = new MockClipProvider({ pollsBeforeDone: 1 });
    const d = clipDeps(provider);
    await processCharacterClips(d);
    expect(provider.submitted).toHaveLength(1);
    expect(provider.submitted[0]).toMatchObject({ prompt: 'Slow dolly in as she smiles.', durationSeconds: 5, idempotencyKey: q.idempotencyKey });
    const s1 = await item(id);
    expect(s1).toMatchObject({ clipStatus: 'processing', clipProvider: 'mock', clipEndpoint: 'mock-image-to-video' });
    expect(s1.providerRequestId).toBeTruthy();                   // persisted before anything else
    for (let i = 0; i < 4; i++) { await fastForward(); await processCharacterClips(d); }
    expect(provider.submitted).toHaveLength(1);                  // never submitted again
    const done = await item(id);
    expect(done).toMatchObject({ clipStatus: 'ready', clipWidth: 720, clipHeight: 1280 });
    const f = path.join(dir, `clip-${id}.mp4`); fs.writeFileSync(f, store.objects.get(`videos/${done.clipStoragePath}`)!.buf);
    expect(probeJson(f).streams.some((s) => s.codec_type === 'audio')).toBe(false);   // the raw clip had a tone; ours is silent
    expect(store.objects.has(`videos/${(done.clipProbe as { sourceKey: string }).sourceKey}`)).toBe(true);   // provider file kept as it arrived
    expect(Math.abs((done.clipDurationMs ?? 0) - 5000)).toBeLessThan(150);
  }, 180_000);

  it('a rejected submission fails the item without charging a second time; retry uses a NEW idempotency key and the same approval', async () => {
    const w = await world(); const id = await approved(w);
    const provider = new MockClipProvider({ failSubmit: () => ({ code: 'forbidden_or_balance', message: 'Balance too low', retryable: false }) });
    const q = await startClip(w.p, id);
    await processCharacterClips(clipDeps(provider));
    expect(await item(id)).toMatchObject({ clipStatus: 'failed', clipErrorCode: 'forbidden_or_balance', clipRetryable: false });
    const q2 = await startClip(w.p, id);
    expect(q2.clipAttempt).toBe(2); expect(q2.idempotencyKey).not.toBe(q.idempotencyKey);
  });

  it('an unknown submission is replayed ONLY with the same idempotency key, a limited number of times, never with a new key', async () => {
    const w = await world(); const id = await approved(w);
    let n = 0;
    const provider = new MockClipProvider({ failSubmit: () => (++n === 1 ? { code: 'unknown', message: 'no answer', retryable: true, outcome: 'unknown' } : null) });
    const q = await startClip(w.p, id);
    const d = clipDeps(provider);
    await processCharacterClips(d);
    expect((await item(id)).clipStatus).toBe('submit_unknown');
    await processCharacterClips(d);                              // too soon: waits
    expect(provider.submitted).toHaveLength(1);
    await fastForward(); await processCharacterClips(d);
    expect(provider.submitted).toHaveLength(2);
    expect(new Set(provider.submitted.map((s) => s.idempotencyKey))).toEqual(new Set([q.idempotencyKey]));
    expect((await item(id)).clipStatus).toBe('processing');
  });

  it('a provider that is NOT idempotent is never resent automatically; a person must confirm the possible double charge', async () => {
    const w = await world(); const id = await approved(w);
    const provider = new MockClipProvider({ idempotent: false, failSubmit: () => ({ code: 'unknown', message: 'no answer', retryable: true, outcome: 'unknown' }) });
    await startClip(w.p, id);
    const d = clipDeps(provider);
    await processCharacterClips(d); await fastForward(); await processCharacterClips(d); await processCharacterClips(d);
    expect(provider.submitted).toHaveLength(1);
    await expect(startClip(w.p, id)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect((await startClip(w.p, id, { confirmDuplicate: true })).clipAttempt).toBe(2);
  });

  it('respects Retry-After on a rate limit: the item goes back to the queue and is not failed', async () => {
    const w = await world(); const id = await approved(w);
    const provider: ClipProvider = { id: 'mock', model: 'm', idempotentSubmit: true, async submit() { throw new ClipProviderError('busy', 'rate_limited', true, 'rejected', 20_000); }, async poll() { return { status: 'processing' }; } };
    await startClip(w.p, id);
    const t0 = Date.now(); await processCharacterClips(clipDeps(provider, { now: () => t0 }));
    const row = await item(id);
    expect(row.clipStatus).toBe('queued'); expect(Number(row.nextPollAt)).toBe(t0 + 20_000);
  });

  it('survives a worker restart: a processing item is simply polled again by a new worker, with no second submission', async () => {
    const w = await world(); const id = await approved(w);
    await startClip(w.p, id);
    const before = new MockClipProvider({ pollsBeforeDone: 5 });
    await processCharacterClips(clipDeps(before));
    const requestId = (await item(id)).providerRequestId;
    // a brand-new worker with a brand-new provider object: it knows nothing except the database
    const after = new MockClipProvider({ pollsBeforeDone: 0 });
    for (let i = 0; i < 3; i++) { await fastForward(); await processCharacterClips(clipDeps(after)); }
    expect(after.submitted).toHaveLength(0);
    expect(await item(id)).toMatchObject({ clipStatus: 'ready', providerRequestId: requestId });
  }, 120_000);

  it('a worker that died in the middle of a submit leaves the item as an UNKNOWN submission, not as failed and not as queued', async () => {
    const w = await world(); const id = await approved(w);
    await startClip(w.p, id);
    await pg.query(`update video_overlays set id = id where false`);
    await pg.exec(`alter table character_broll_items disable trigger all; update character_broll_items set clip_status = 'submitting', claimed_at = ${Date.now() - SUBMITTING_STALE_MS - 1000} where id = ${id}; alter table character_broll_items enable trigger all;`);
    await processCharacterClips(clipDeps(new MockClipProvider(), {}));
    expect((await item(id)).clipStatus).not.toBe('queued');
    expect(['submit_unknown', 'submitting', 'processing']).toContain((await item(id)).clipStatus);
  });

  it('a provider failure after submission is shown with its message, and a corrupt result fails ingest without touching anything else', async () => {
    const w = await world(); const id = await approved(w);
    await startClip(w.p, id);
    const failing = new MockClipProvider({ pollsBeforeDone: 0, failPoll: () => ({ code: 'nsfw', message: 'Blocked by the content check. You are not charged.', retryable: false }) });
    const d = clipDeps(failing);
    await processCharacterClips(d); await fastForward(); await processCharacterClips(d);
    expect(await item(id)).toMatchObject({ clipStatus: 'failed', clipErrorCode: 'nsfw', clipRetryable: false });
    const w2 = await world(); const id2 = await approved(w2);
    await startClip(w2.p, id2);
    const corrupt: ClipProvider = { id: 'mock', model: 'm', idempotentSubmit: true, async submit() { return { providerRequestId: 'r' }; }, async poll() { return { status: 'succeeded', video: Buffer.from('not a video'), mime: 'video/mp4' }; } };
    const d2 = clipDeps(corrupt);
    await processCharacterClips(d2); await fastForward(); await processCharacterClips(d2);
    const bad = await item(id2);
    expect(bad.clipStatus).toBe('failed'); expect(bad.clipErrorCode).toBe('ingest_failed');
    expect(bad.imageStatus).toBe('approved');                    // the approved image is untouched, so a retry needs no new approval
  });

  it('refuses to start more videos than the hourly limit', async () => {
    const a = await world(); const idA = await approved(a);
    const b = await world(); const idB = await approved(b);
    process.env.HIGGSFIELD_BUDGET_PER_HOUR = '1';
    try {
      await startClip(a.p, idA);
      await expect(startClip(b.p, idB)).rejects.toMatchObject({ code: 'budget_reached', status: 429 });
      expect((await item(idB)).clipStatus).toBe('not_started');
    } finally { delete process.env.HIGGSFIELD_BUDGET_PER_HOUR; }
  });

  it('with no provider configured the item simply waits; nothing is submitted and nothing fails', async () => {
    const w = await world(); const id = await approved(w);
    await startClip(w.p, id);
    expect(await processCharacterClips(clipDeps(null))).toBe(false);
    expect((await item(id)).clipStatus).toBe('queued');
  });

  it('is invisible when the feature flag is off', async () => {
    const w = await world();
    process.env.BROLL_OVERLAYS_ENABLED = 'false';
    expect((await call(itemsGet, { params: w.params })).status).toBe(404);
  });
});
