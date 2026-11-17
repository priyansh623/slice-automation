/**
 * The Character B-roll video job (the paid step), run by the worker. Each tick does at most one unit of work:
 *   queued          -> submit once (idempotency key stored), persist the provider request id          -> processing
 *   processing      -> poll with backoff; on success download IMMEDIATELY (provider links expire), probe, make the silent
 *                      720x1280 copy in our own storage                                                   -> ready
 *   submit_unknown  -> the request may have been accepted. Resent ONLY with the SAME idempotency key (the provider returns the
 *                      first request, so it cannot be charged twice); never with a new key.
 * All state is in the database, so a restarted worker simply carries on: processing items are polled again, an item stuck
 * 'submitting' (the worker died mid-call) is treated as an unknown submission.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { and, asc, eq, inArray, lte, or, isNull, lt } from 'drizzle-orm';
import { db } from '../db';
import { characterBrollItems, studioOutputs } from '../db/schema.pg';
import { getStorage } from '../lib/object-store';
import { configFromEnv, HiggsfieldClient, higgsfieldConfigured } from '../lib/higgsfield/client';
import { ClipProviderError, HiggsfieldKlingProvider, KLING_STANDARD_ENDPOINT, type ClipProvider } from '../lib/overlays/clip-provider';
import { MockClipProvider } from '../lib/overlays/mock-clip-provider';
import { CLIP_SECONDS } from '../lib/overlays/character';
import { overlaysEnabled } from '../lib/overlays/service';
import { makeWorkDir, normaliseOverlayClipSync } from './compilation-overlay';

export const POLL_BACKOFF_MS = [5_000, 8_000, 12_000, 20_000, 30_000];
export const SUBMITTING_STALE_MS = 5 * 60 * 1000;
export const MAX_REPLAYS = 3;
export const REPLAY_AFTER_MS = 30_000;
export const GIVE_UP_AFTER_MS = 45 * 60 * 1000;

export interface ClipDeps {
  provider: ClipProvider | null;
  readImage: (key: string) => Promise<Buffer>;
  writeClip: (key: string, body: Buffer) => Promise<void>;
  now: () => number;
}

/** The provider the worker uses. 'mock' only when explicitly asked for (labelled test output); real needs HF_CREDENTIALS. Never anything else. */
export function clipProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ClipProvider | null {
  const wanted = (env.CHARACTER_CLIP_PROVIDER ?? (higgsfieldConfigured(env) ? 'higgsfield' : '')).toLowerCase();
  if (wanted === 'mock') return new MockClipProvider();
  if (wanted === 'higgsfield' && higgsfieldConfigured(env)) return new HiggsfieldKlingProvider(new HiggsfieldClient(configFromEnv(env)), env.HIGGSFIELD_VIDEO_ENDPOINT || KLING_STANDARD_ENDPOINT);
  return null;
}
// One provider object for the life of the worker (a real provider is stateless; the mock keeps its poll counters here).
let cached: { sig: string; provider: ClipProvider | null } | null = null;
const providerForWorker = (): ClipProvider | null => {
  const sig = `${process.env.CHARACTER_CLIP_PROVIDER ?? ''}|${process.env.HF_CREDENTIALS ? 'hf' : ''}|${process.env.HIGGSFIELD_VIDEO_ENDPOINT ?? ''}`;
  if (!cached || cached.sig !== sig) cached = { sig, provider: clipProviderFromEnv() };
  return cached.provider;
};
const defaults = (): ClipDeps => ({
  provider: providerForWorker(),
  readImage: (k) => getStorage().downloadR2Only('uploads', k),
  writeClip: async (k, b) => { await getStorage().put('videos', k, b, { contentType: 'video/mp4' }); },
  now: () => Date.now(),
});

type Item = typeof characterBrollItems.$inferSelect;
const sends = (i: Item): number => Number((i.clipProbe as { submitSends?: number } | null)?.submitSends ?? 0);

export async function processCharacterClips(deps: ClipDeps = defaults()): Promise<boolean> {
  if (!overlaysEnabled()) return false;
  const now = deps.now();
  // A worker that died during a submit leaves 'submitting': the request may have been accepted.
  await db.update(characterBrollItems).set({ clipStatus: 'submit_unknown', claimedAt: null, updatedAt: now })
    .where(and(eq(characterBrollItems.clipStatus, 'submitting'), lt(characterBrollItems.claimedAt, now - SUBMITTING_STALE_MS)));
  if (!deps.provider) return false;
  return (await submitOne(deps)) || (await pollOne(deps));
}

async function submitOne(deps: ClipDeps): Promise<boolean> {
  const now = deps.now();
  const provider = deps.provider!;
  // An unknown submission is only ever picked up again if the provider can guarantee a replay is harmless. Otherwise it is left for a
  // person, and (importantly) does not hold up the items queued behind it.
  const [c] = await db.select().from(characterBrollItems)
    .where(provider.idempotentSubmit
      ? or(and(eq(characterBrollItems.clipStatus, 'queued'), or(isNull(characterBrollItems.nextPollAt), lte(characterBrollItems.nextPollAt, now))), and(eq(characterBrollItems.clipStatus, 'submit_unknown'), lte(characterBrollItems.nextPollAt, now)))
      : and(eq(characterBrollItems.clipStatus, 'queued'), or(isNull(characterBrollItems.nextPollAt), lte(characterBrollItems.nextPollAt, now))))
    .orderBy(asc(characterBrollItems.id)).limit(1);
  if (!c) return false;
  const replay = c.clipStatus === 'submit_unknown';
  if (replay && sends(c) >= MAX_REPLAYS) return false;
  const claimed = await db.update(characterBrollItems).set({ clipStatus: 'submitting', claimedAt: now, clipProvider: provider.id, clipEndpoint: provider.model, updatedAt: now })
    .where(and(eq(characterBrollItems.id, c.id), eq(characterBrollItems.clipStatus, c.clipStatus), eq(characterBrollItems.imageStatus, 'approved'))).returning({ id: characterBrollItems.id });
  if (claimed.length === 0) return true;
  const probe = { ...((c.clipProbe as object | null) ?? {}), submitSends: sends(c) + 1 };
  try {
    if (!c.studioOutputId || !c.motionPrompt || !c.idempotencyKey) throw new ClipProviderError('The approved image or prompt is missing.', 'incomplete', false);
    const [out] = await db.select().from(studioOutputs).where(eq(studioOutputs.id, c.studioOutputId)).limit(1);
    if (!out) throw new ClipProviderError('The approved image is missing.', 'incomplete', false);
    // The image is read from R2 and uploaded to the provider ONCE per attempt. The uploaded URL is saved before submitting, so a resend of the
    // same request (same idempotency key) carries the identical body: the provider refuses the same key with a different body.
    let imageUrl = (c.clipProbe as { inputImageUrl?: string } | null)?.inputImageUrl;
    let image: Buffer = Buffer.alloc(0);
    if (!imageUrl) {
      image = await deps.readImage(out.storageKey);
      if (provider.uploadImage) {
        imageUrl = await provider.uploadImage(image, out.mime);
        (probe as Record<string, unknown>).inputImageUrl = imageUrl;
        await db.update(characterBrollItems).set({ clipProbe: probe, updatedAt: deps.now() }).where(eq(characterBrollItems.id, c.id));
      }
    }
    const res = await provider.submit({ idempotencyKey: c.idempotencyKey, image, imageMime: out.mime, imageUrl, prompt: c.motionPrompt, durationSeconds: CLIP_SECONDS });
    // The request id is persisted before anything else, so a restart can only ever poll it, never submit again.
    await db.update(characterBrollItems).set({ clipStatus: 'processing', providerRequestId: res.providerRequestId, submittedAt: now, claimedAt: null, pollCount: 0, nextPollAt: now + POLL_BACKOFF_MS[0], clipProbe: probe, updatedAt: deps.now() }).where(eq(characterBrollItems.id, c.id));
  } catch (e) {
    const pe = e instanceof ClipProviderError ? e : new ClipProviderError((e as Error).message, 'error', true, 'unknown');
    if (pe.outcome === 'unknown') {
      await db.update(characterBrollItems).set({ clipStatus: 'submit_unknown', claimedAt: null, nextPollAt: now + REPLAY_AFTER_MS, clipProbe: probe, clipErrorCode: pe.code, clipErrorMessage: `${pe.message} ${provider.ambiguousHint ?? ''}`.trim().slice(0, 500), updatedAt: deps.now() }).where(eq(characterBrollItems.id, c.id));
    } else if (pe.code === 'rate_limited' || pe.code === 'model_blocked') {
      // Not accepted: put it back in the queue and respect Retry-After.
      await db.update(characterBrollItems).set({ clipStatus: 'queued', claimedAt: null, nextPollAt: now + (pe.retryAfterMs ?? 30_000), clipErrorCode: pe.code, clipErrorMessage: pe.message.slice(0, 400), updatedAt: deps.now() }).where(eq(characterBrollItems.id, c.id));
    } else {
      await fail(c.id, pe.code, pe.message, pe.retryable, deps.now());
    }
  }
  return true;
}

async function fail(id: number, code: string, message: string, retryable: boolean, at: number) {
  await db.update(characterBrollItems).set({ clipStatus: 'failed', claimedAt: null, clipErrorCode: code, clipErrorMessage: message.slice(0, 500), clipRetryable: retryable, updatedAt: at }).where(eq(characterBrollItems.id, id));
}

async function pollOne(deps: ClipDeps): Promise<boolean> {
  const now = deps.now();
  const [c] = await db.select().from(characterBrollItems).where(and(eq(characterBrollItems.clipStatus, 'processing'), or(isNull(characterBrollItems.nextPollAt), lte(characterBrollItems.nextPollAt, now)))).orderBy(asc(characterBrollItems.nextPollAt)).limit(1);
  if (!c || !c.providerRequestId) return false;
  const provider = deps.provider!;
  const next = (n: number, extra = 0) => now + Math.max(extra, POLL_BACKOFF_MS[Math.min(n, POLL_BACKOFF_MS.length - 1)]);
  try {
    const r = await provider.poll(c.providerRequestId);
    if (r.status === 'processing') {
      if (c.submittedAt && now - c.submittedAt > GIVE_UP_AFTER_MS) { await fail(c.id, 'timed_out', `The video did not finish in time. Provider request ${c.providerRequestId} may still complete; check with the provider before retrying.`, true, deps.now()); return true; }
      await db.update(characterBrollItems).set({ pollCount: c.pollCount + 1, nextPollAt: next(c.pollCount + 1), updatedAt: now }).where(eq(characterBrollItems.id, c.id));
    } else if (r.status === 'failed') {
      await fail(c.id, r.code, r.message, r.retryable, deps.now());
    } else {
      await finishClip(c, r.video, deps);
    }
  } catch (e) {
    // A failed READ says nothing about the job: keep polling later (respecting Retry-After), give up only after repeated failures.
    const pe = e instanceof ClipProviderError ? e : new ClipProviderError((e as Error).message, 'error', true);
    if (!pe.retryable || c.pollCount > 40) await fail(c.id, pe.code, pe.message, pe.retryable, deps.now());
    else await db.update(characterBrollItems).set({ pollCount: c.pollCount + 1, nextPollAt: next(c.pollCount + 1, pe.retryAfterMs ?? 0), updatedAt: now }).where(eq(characterBrollItems.id, c.id));
  }
  return true;
}

/** Stores the finished video in our own storage straight away, probes it, and makes the silent normalised copy the compositor uses. */
async function finishClip(c: Item, video: Buffer, deps: ClipDeps) {
  const dir = await makeWorkDir(`cbroll-${c.id}`);
  try {
    const input = path.join(dir, 'raw.mp4'); const output = path.join(dir, 'norm.mp4');
    await fs.writeFile(input, video);
    const rawKey = `character-broll/${c.videoProjectId}/${c.id}-${c.clipAttempt}-source.mp4`;
    await deps.writeClip(rawKey, video);   // the provider's own file, kept as it arrived
    const r = await normaliseOverlayClipSync(input, output);
    const key = `character-broll/${c.videoProjectId}/${c.id}-${c.clipAttempt}.mp4`;
    await deps.writeClip(key, await fs.readFile(output));
    const providerRequest = c.providerRequestId;
    await db.update(characterBrollItems).set({ clipStatus: 'ready', clipStoragePath: key, clipWidth: r.width, clipHeight: r.height, clipDurationMs: r.durationMs, clipProbe: { ...((c.clipProbe as object | null) ?? {}), sourceKey: rawKey, sourceBytes: video.length, normalisedBytes: r.bytes }, clipErrorCode: null, clipErrorMessage: null, updatedAt: deps.now() }).where(and(eq(characterBrollItems.id, c.id), inArray(characterBrollItems.clipStatus, ['processing'])));
    // Both files are ours now: let the provider drop its copy (best effort; never changes the outcome).
    if (providerRequest && deps.provider?.afterStored) await deps.provider.afterStored(providerRequest).catch((e) => console.warn(`[character-clips] item ${c.id}: could not remove the provider's copy:`, (e as Error).message?.slice(0, 120)));
  } catch (e) {
    await fail(c.id, 'ingest_failed', `The video was made but could not be prepared: ${(e as Error).message}`, true, deps.now());
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
