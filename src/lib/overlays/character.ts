/**
 * Character B-roll for a video project: a Scene Pack image -> a personalised image (the Studio's replacement job, reusing its
 * provider, worker and review) -> EXPLICIT approval -> an editable motion prompt -> one image-to-video job -> a silent clip.
 *
 * THE PAID STEP: no video job can exist until a person has approved the personalised image. This is enforced three times: the
 * API (startClip), this module, and a CHECK constraint in the database (character_broll_video_needs_approved_image).
 */
import * as crypto from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { characterBrollItems, studioAssets, studioJobs, studioOutputs, studioProjectLinks, studioProjects, videoOverlays, videoProjects, studioSelections } from '@/db/schema.pg';
import { getStorage } from '@/lib/object-store';
import { registerObjectIfAbsent } from '@/lib/object-store/registry';
import { approvePacks, listProjectPacks } from '@/lib/studio/approvals';
import { createBatch, retryJob } from '@/lib/studio/batches';
import { aiConfigured, getStudioClient, type StudioMessagesClient } from '@/lib/studio/ai-client';
import { studioAnalysisModel } from '@/lib/studio/analysis-schema';
import { reserveBudget, refundBudget } from '@/lib/studio/budget';
import { inspectImage, sha256Of, signKeys } from '@/lib/studio/image-store';
import { newCharacterKey } from '@/lib/studio/keys';
import { reviewOutput } from '@/lib/studio/outputs';
import { StudioError } from '@/lib/studio/repository';
import { addToSelection } from '@/lib/studio/selection';
import { OverlayError, overlayLimit, planningSpans } from './service';
import { videoGenerationReadiness } from './readiness';
import { checkPlacement, firstFreePlacement } from './timeline';

export const CLIP_SECONDS = 5;
export type ItemRow = typeof characterBrollItems.$inferSelect;
const EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const err = (status: number, code: string, message: string) => new OverlayError(status, code, message);

/** The Studio project that holds this video project's Character B-roll jobs. Created on first use, with the project's own base image as the character. */
export async function ensureStudioProject(videoProjectId: number, userId: string): Promise<number> {
  const [existing] = await db.select({ id: studioProjectLinks.id }).from(studioProjectLinks).where(eq(studioProjectLinks.videoProjectId, videoProjectId)).limit(1);
  if (existing) return existing.id;
  const [vp] = await db.select().from(videoProjects).where(eq(videoProjects.id, videoProjectId)).limit(1);
  if (!vp) throw err(404, 'project_not_found', 'Project not found.');
  const storage = getStorage();
  const original = await storage.download('uploads', vp.baseImagePath).catch(() => { throw err(409, 'no_base_image', 'This project has no base image to use as the character.'); });
  let info;
  try { info = await inspectImage(original); } catch { throw err(422, 'bad_base_image', 'The project base image could not be read.'); }
  const now = Date.now();
  // One creator at a time per video project (the project row lock), so two requests cannot make two Studio projects.
  const studioId = await db.transaction(async (tx) => {
    await tx.select({ id: videoProjects.id }).from(videoProjects).where(eq(videoProjects.id, videoProjectId)).for('update');
    const [again] = await tx.select({ id: studioProjectLinks.id }).from(studioProjectLinks).where(eq(studioProjectLinks.videoProjectId, videoProjectId)).limit(1);
    if (again) return { id: again.id, created: false };
    const [row] = await tx.insert(studioProjects).values({ name: `B-roll · ${vp.name ?? `Project ${vp.id}`}`.slice(0, 120), createdBy: userId, createdAt: now, updatedAt: now }).returning({ id: studioProjects.id });
    await tx.update(studioProjectLinks).set({ videoProjectId }).where(eq(studioProjectLinks.id, row.id));
    return { id: row.id, created: true };
  });
  if (!studioId.created) return studioId.id;
  const key = newCharacterKey(studioId.id, EXT[info.format]);
  await storage.putR2Only('uploads', key, original, { contentType: MIME[info.format] });
  await registerObjectIfAbsent({ bucket: 'uploads', key, provider: 'r2', sizeBytes: original.length, contentType: MIME[info.format], sha256: sha256Of(original), verifiedAt: now });
  await db.update(studioProjects).set({ characterKey: key, characterMime: MIME[info.format], updatedAt: now }).where(eq(studioProjects.id, studioId.id));
  return studioId.id;
}

export interface CreateItem { studioAssetId: number; intendedAction?: string }

/** Starts the personalised-image step for one Scene Pack image. No paid video work happens here. */
export async function createCharacterItem(videoProjectId: number, userId: string, input: CreateItem): Promise<ItemRow> {
  const [asset] = await db.select().from(studioAssets).where(eq(studioAssets.id, input.studioAssetId)).limit(1);
  if (!asset || asset.archivedAt) throw err(404, 'asset_not_found', 'That Scene Pack image is not available.');
  const studioId = await ensureStudioProject(videoProjectId, userId);
  const approved = new Set((await listProjectPacks(studioId)).map((p) => p.packId));
  if (!approved.has(asset.packId)) await approvePacks(studioId, [asset.packId], userId);
  await addToSelection(studioId, [asset.id], userId);
  const slot = await reserveBudget(IMAGE_BUDGET_KIND, imageBudgetPerHour());
  if (!slot.ok) throw err(429, 'budget_reached', 'The hourly limit for personalised images was reached. Try again later.');
  let batchJobs;
  try { batchJobs = await createBatch(studioId, userId, { assetIds: [asset.id] }); }
  catch (e) { await refundBudget(slot); if (e instanceof StudioError) throw err(e.status, e.code, e.message); throw e; }
  const now = Date.now();
  const [row] = await db.insert(characterBrollItems).values({ videoProjectId, studioAssetId: asset.id, intendedAction: (input.intendedAction ?? '').slice(0, 1000), studioJobId: batchJobs.jobs[0].id, imageStatus: 'generating', createdBy: userId, createdAt: now, updatedAt: now }).returning();
  return row;
}

async function load(videoProjectId: number, itemId: number): Promise<ItemRow> {
  const [row] = await db.select().from(characterBrollItems).where(and(eq(characterBrollItems.id, itemId), eq(characterBrollItems.videoProjectId, videoProjectId))).limit(1);
  if (!row) throw err(404, 'not_found', 'Character B-roll not found.');
  return row;
}

/** Brings the image step up to date from the Studio job (the worker does the generating; this only reads). */
export async function syncImage(item: ItemRow): Promise<ItemRow> {
  if (!item.studioJobId || !['generating', 'pending'].includes(item.imageStatus)) return item;
  const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, item.studioJobId)).limit(1);
  if (!job) return item;
  const set = (v: Partial<typeof characterBrollItems.$inferInsert>) => db.update(characterBrollItems).set({ ...v, updatedAt: Date.now() }).where(and(eq(characterBrollItems.id, item.id), eq(characterBrollItems.imageStatus, item.imageStatus))).returning().then((r) => r[0] ?? item);
  if (job.status === 'succeeded') {
    const [out] = await db.select().from(studioOutputs).where(eq(studioOutputs.jobId, job.id)).orderBy(desc(studioOutputs.id)).limit(1);
    if (out) return set({ imageStatus: 'ready', studioOutputId: out.id, imageError: null });
  }
  if (job.status === 'failed' || job.status === 'canceled') return set({ imageStatus: 'failed', imageError: job.errorMessage ?? 'The personalised image could not be made.' });
  return item;
}

/** What leaves the server about an item. Never the idempotency key or `clipProbe` (it holds the provider-side image URL and file names). */
export type PublicItem = Omit<ItemRow, 'clipProbe' | 'idempotencyKey'>;
export function publicItem<T extends ItemRow>(row: T): Omit<T, 'clipProbe' | 'idempotencyKey'> {
  const { clipProbe: _probe, idempotencyKey: _key, ...rest } = row; void _probe; void _key;
  return rest;
}

export interface ItemView extends PublicItem {
  /** Thumbnail of the personalised image (small). */
  imageUrl: string | null;
  /** The original personalised image, unmodified, for review and approval. */
  fullImageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  /** The Studio job behind the image step ('submit_unknown' = the provider may or may not have started it). */
  imageJobStatus: string | null;
  imageNote: string | null;
  isTestImage: boolean;
}

export async function listItems(videoProjectId: number): Promise<ItemView[]> {
  const rows = await db.select().from(characterBrollItems).where(eq(characterBrollItems.videoProjectId, videoProjectId)).orderBy(desc(characterBrollItems.id));
  const synced: ItemRow[] = [];
  for (const r of rows) synced.push(await syncImage(r));
  const outIds = synced.map((r) => r.studioOutputId).filter((v): v is number => v != null);
  const jobIds = synced.map((r) => r.studioJobId).filter((v): v is number => v != null);
  const outs = outIds.length ? await db.select().from(studioOutputs).where(inArray(studioOutputs.id, outIds)) : [];
  const jobs = jobIds.length ? await db.select().from(studioJobs).where(inArray(studioJobs.id, jobIds)) : [];
  const outById = new Map(outs.map((o) => [o.id, o])); const jobById = new Map(jobs.map((j) => [j.id, j]));
  const keys = outs.flatMap((o) => [o.thumbKey ?? o.storageKey, o.storageKey]);
  const signed = keys.length ? await signKeys(keys).catch(() => new Map<string, string>()) : new Map<string, string>();
  return synced.map((r) => {
    const o = outById.get(r.studioOutputId ?? -1); const j = jobById.get(r.studioJobId ?? -1);
    return {
      ...publicItem(r),
      imageUrl: o ? signed.get(o.thumbKey ?? o.storageKey) ?? null : null,
      fullImageUrl: o ? signed.get(o.storageKey) ?? null : null,
      imageWidth: o?.width ?? null, imageHeight: o?.height ?? null,
      imageJobStatus: j?.status ?? null,
      imageNote: j && (j.status === 'submit_unknown' || j.status === 'failed') ? j.errorMessage : null,
      isTestImage: j?.provider === 'mock',
    };
  });
}

export async function getItem(videoProjectId: number, itemId: number): Promise<ItemRow> { return syncImage(await load(videoProjectId, itemId)); }

/** Generates the personalised image again (a new Studio job). Only before approval; an approved image is replaced by rejecting it first. */
export async function regenerateImage(videoProjectId: number, itemId: number, userId: string, opts: { confirmDuplicate?: boolean } = {}): Promise<ItemRow> {
  const item = await getItem(videoProjectId, itemId);
  if (item.clipStatus !== 'not_started') throw err(409, 'clip_started', 'A video was already made from this image. Create a new Character B-roll instead.');
  if (!item.studioJobId) throw err(409, 'no_job', 'There is no image job to repeat.');
  const [current] = await db.select({ status: studioJobs.status }).from(studioJobs).where(eq(studioJobs.id, item.studioJobId)).limit(1);
  // The provider may already be making the image (the answer to the request never arrived). It is never repeated automatically: only a
  // person who has seen that warning can choose to generate it again, accepting that it may be charged twice.
  const unknown = current?.status === 'submit_unknown';
  if (unknown && !opts.confirmDuplicate) throw err(409, 'outcome_unknown', 'We could not confirm whether the image request was accepted. Generating again could be charged twice. Check the Higgsfield history first, then confirm to generate it again anyway.');
  if (item.imageStatus === 'generating' && !unknown) throw err(409, 'already_generating', 'An image is already being made.');
  const slot = await reserveBudget(IMAGE_BUDGET_KIND, imageBudgetPerHour());
  if (!slot.ok) throw err(429, 'budget_reached', 'The hourly limit for personalised images was reached. Try again later.');
  let res;
  try { res = await retryJob(item.studioJobId, userId, unknown ? { confirmDuplicate: true } : { allowSucceeded: true, confirmDuplicate: true }); }
  catch (e) { await refundBudget(slot); if (e instanceof StudioError) throw err(e.status, e.code, e.message); throw e; }
  const jobId = res.id;
  const [row] = await db.update(characterBrollItems).set({ studioJobId: jobId, studioOutputId: null, imageStatus: 'generating', imageError: null, imageApprovedAt: null, imageApprovedBy: null, motionPrompt: null, promptEdited: false, updatedAt: Date.now() }).where(eq(characterBrollItems.id, item.id)).returning();
  return row;
}

/** A person looked at the personalised image and accepts it. The ONLY way to unlock the paid video step. */
export async function approveImage(videoProjectId: number, itemId: number, userId: string): Promise<ItemRow> {
  const item = await getItem(videoProjectId, itemId);
  if (item.imageStatus !== 'ready' || !item.studioOutputId) throw err(409, 'image_not_ready', 'There is no finished image to approve yet.');
  await reviewOutput(item.studioOutputId, 'saved', userId);
  const now = Date.now();
  const [row] = await db.update(characterBrollItems).set({ imageStatus: 'approved', imageApprovedAt: now, imageApprovedBy: userId, updatedAt: now }).where(and(eq(characterBrollItems.id, item.id), eq(characterBrollItems.imageStatus, 'ready'))).returning();
  if (!row) throw err(409, 'state_changed', 'The image changed while you were approving it. Look at it again.');
  return row;
}

export async function rejectImage(videoProjectId: number, itemId: number, userId: string): Promise<ItemRow> {
  const item = await getItem(videoProjectId, itemId);
  if (item.clipStatus !== 'not_started') throw err(409, 'clip_started', 'A video was already made from this image.');
  if (!['ready', 'approved'].includes(item.imageStatus)) throw err(409, 'image_not_ready', 'There is no finished image to reject.');
  if (item.studioOutputId) await reviewOutput(item.studioOutputId, 'rejected', userId);
  const [row] = await db.update(characterBrollItems).set({ imageStatus: 'rejected', imageApprovedAt: null, imageApprovedBy: null, motionPrompt: null, promptEdited: false, updatedAt: Date.now() }).where(eq(characterBrollItems.id, item.id)).returning();
  return row;
}

// ── Motion prompt ────────────────────────────────────────────────────────────

const PROMPT_SYSTEM = `You write the motion prompt for a 5-second image-to-video model. The image is the first frame. Describe only what should MOVE and how, grounded in what is visibly in the image and the intended action. Rules: be concrete about the subject's action and any camera movement the action needs; never add elements that are not in the image; keep the subject's identity, clothing and setting unchanged; no dialogue and no sound (the clip is silent); do not add generic filler such as "static camera" or "gentle expression" unless the image and action call for it. Answer with the prompt text only, in 1 to 3 sentences.`;

export interface PromptDeps { client?: StudioMessagesClient; readImage?: (key: string) => Promise<Buffer> }

/** Suggests a motion prompt from the ACTUAL approved image and the intended action. Stored as editable text; never sent anywhere paid. */
export async function suggestMotionPrompt(videoProjectId: number, itemId: number, deps: PromptDeps = {}): Promise<ItemRow> {
  const item = await getItem(videoProjectId, itemId);
  if (item.imageStatus !== 'approved' || !item.studioOutputId) throw err(409, 'image_not_approved', 'Approve the personalised image first. The prompt is written from the approved image.');
  if (item.clipStatus !== 'not_started') throw err(409, 'clip_started', 'The video was already requested; its prompt can no longer change.');
  if (!deps.client && !aiConfigured()) throw err(503, 'ai_unavailable', 'Prompt suggestions are not available (no AI key configured). You can write the prompt yourself.');
  const [out] = await db.select().from(studioOutputs).where(eq(studioOutputs.id, item.studioOutputId)).limit(1);
  if (!out) throw err(404, 'output_missing', 'The approved image is missing.');
  const bytes = await (deps.readImage ?? ((k) => getStorage().downloadR2Only('uploads', k)))(out.storageKey);
  const action = item.intendedAction.trim();
  const reply = await (deps.client ?? getStudioClient()).messages.create({
    model: studioAnalysisModel(), max_tokens: 400, system: PROMPT_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: out.mime as 'image/png', data: bytes.toString('base64') } }, { type: 'text', text: action ? `Intended action: ${action}` : 'No intended action was given: describe the most natural short movement for this moment.' }] }],
  }, { timeout: 60_000, maxRetries: 1 });
  const text = reply.content.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw err(502, 'empty_prompt', 'No prompt was suggested. Write one yourself.');
  const [row] = await db.update(characterBrollItems).set({ motionPrompt: text.slice(0, 2500), promptEdited: false, updatedAt: Date.now() }).where(eq(characterBrollItems.id, item.id)).returning();
  return row;
}

export async function setMotionPrompt(videoProjectId: number, itemId: number, text: string): Promise<ItemRow> {
  const item = await getItem(videoProjectId, itemId);
  if (item.clipStatus !== 'not_started' && item.clipStatus !== 'failed') throw err(409, 'clip_started', 'The video is already being made; its prompt can no longer change.');
  const clean = text.trim();
  if (!clean) throw err(422, 'empty_prompt', 'The prompt cannot be empty.');
  if (clean.length > 2500) throw err(422, 'prompt_too_long', 'The prompt can be at most 2500 characters.');
  const [row] = await db.update(characterBrollItems).set({ motionPrompt: clean, promptEdited: true, updatedAt: Date.now() }).where(eq(characterBrollItems.id, item.id)).returning();
  return row;
}

// ── The paid step ────────────────────────────────────────────────────────────

export const clipBudgetPerHour = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env.HIGGSFIELD_BUDGET_PER_HOUR); return Number.isFinite(n) && n >= 0 && env.HIGGSFIELD_BUDGET_PER_HOUR !== undefined ? n : 20; };
export const CLIP_BUDGET_KIND = 'character_clip';
/** Personalised images cost credits too (about 2.5 per Grok image), so starting them is capped per hour as well. */
export const IMAGE_BUDGET_KIND = 'character_image';
export const imageBudgetPerHour = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env.HIGGSFIELD_IMAGE_BUDGET_PER_HOUR); return Number.isFinite(n) && n >= 0 && env.HIGGSFIELD_IMAGE_BUDGET_PER_HOUR !== undefined ? n : 30; };

/** Queues the one image-to-video job. Requires an APPROVED image and a prompt. The worker submits it; this spends nothing by itself. */
export async function startClip(videoProjectId: number, itemId: number, opts: { confirmDuplicate?: boolean } = {}): Promise<ItemRow> {
  const item = await getItem(videoProjectId, itemId);
  if (item.imageStatus !== 'approved' || !item.imageApprovedAt) throw err(409, 'image_not_approved', 'Approve the personalised image before making the video. Nothing is charged until you do.');
  if (!item.motionPrompt?.trim()) throw err(422, 'prompt_required', 'Add a motion prompt first.');
  if (item.clipStatus === 'submit_unknown' && !opts.confirmDuplicate) throw err(409, 'outcome_unknown', 'We could not confirm whether the last video request was accepted. Retrying could be charged twice. Confirm to try again anyway.');
  if (!['not_started', 'failed', 'submit_unknown'].includes(item.clipStatus)) throw err(409, 'already_started', 'The video is already being made.');
  const ready = await videoGenerationReadiness();
  if (!ready.ready) throw err(503, 'video_unavailable', ready.message ?? 'Video generation is not available right now.');
  const slot = await reserveBudget(CLIP_BUDGET_KIND, clipBudgetPerHour());
  if (!slot.ok) throw err(429, 'budget_reached', 'The hourly limit for B-roll videos was reached. Try again later.');
  const attempt = item.clipAttempt + 1;
  try {
    const [row] = await db.update(characterBrollItems).set({
      clipStatus: 'queued', clipAttempt: attempt, idempotencyKey: `cbroll-${item.id}-${attempt}-${crypto.randomBytes(4).toString('hex')}`, providerRequestId: null, submittedAt: null, claimedAt: null, pollCount: 0, nextPollAt: null,
      clipErrorCode: null, clipErrorMessage: null, clipRetryable: null, clipProbe: null, updatedAt: Date.now(),
    }).where(and(eq(characterBrollItems.id, item.id), eq(characterBrollItems.imageStatus, 'approved'))).returning();
    if (!row) throw err(409, 'state_changed', 'The image changed. Look at it again.');
    return row;
  } catch (e) { await refundBudget(slot); throw e; }
}

// ── Putting a ready clip on the timeline ─────────────────────────────────────

export interface PlaceCharacter { anchorScreenId?: number; startOffsetMs?: number; durationMs?: number; sourceStartMs?: number; track?: number }

export async function createCharacterOverlay(videoProjectId: number, userId: string, itemId: number, place: PlaceCharacter = {}) {
  return db.transaction(async (tx) => {
    await tx.select({ id: videoProjects.id }).from(videoProjects).where(eq(videoProjects.id, videoProjectId)).for('update');
    const [item] = await tx.select().from(characterBrollItems).where(and(eq(characterBrollItems.id, itemId), eq(characterBrollItems.videoProjectId, videoProjectId))).limit(1);
    if (!item) throw err(404, 'not_found', 'Character B-roll not found.');
    if (item.clipStatus !== 'ready' || !item.clipStoragePath) throw err(409, 'clip_not_ready', 'The video is not ready yet.');
    const existing = await tx.select().from(videoOverlays).where(eq(videoOverlays.videoProjectId, videoProjectId));
    if (existing.length >= overlayLimit()) throw err(409, 'overlay_limit', `A video can have at most ${overlayLimit()} B-roll overlays.`);
    if (existing.some((o) => o.characterItemId === item.id)) throw err(409, 'already_placed', 'This clip is already on the timeline.');
    const { spans } = await planningSpans(tx, videoProjectId);
    if (spans.length === 0) throw err(422, 'no_scenes', 'Add Flow scenes before adding B-roll.');
    const track = place.track ?? 0; const sourceStart = Math.max(0, Math.round(place.sourceStartMs ?? 0));
    const clipMs = item.clipDurationMs ?? CLIP_SECONDS * 1000;
    const duration = Math.max(500, Math.min(Math.round(place.durationMs ?? clipMs), clipMs - sourceStart));
    let anchor = place.anchorScreenId; let offset = place.startOffsetMs;
    const timing = existing.map((o) => ({ id: o.id, track: o.track, anchorScreenId: o.anchorScreenId, startOffsetMs: o.startOffsetMs, durationMs: o.durationMs, sourceStartMs: o.sourceStartMs, assetDurationMs: o.assetDurationMs }));
    if (anchor == null) {
      const free = firstFreePlacement(spans, timing, duration, track);
      if (!free) throw err(409, 'no_room', 'There is no free space on the B-roll track for this clip.');
      anchor = free.anchorScreenId; offset = free.startOffsetMs;
    }
    const cand = { id: -1, track, anchorScreenId: anchor, startOffsetMs: Math.round(offset ?? 0), durationMs: duration, sourceStartMs: sourceStart, assetDurationMs: clipMs };
    const problems = checkPlacement(spans, timing, cand);
    if (problems.length) throw err(409, problems[0].code, problems[0].message);
    const now = Date.now();
    const [row] = await tx.insert(videoOverlays).values({ videoProjectId, kind: 'character', track, anchorScreenId: cand.anchorScreenId, startOffsetMs: cand.startOffsetMs, durationMs: duration, sourceStartMs: sourceStart, assetStoragePath: item.clipStoragePath, assetWidth: item.clipWidth, assetHeight: item.clipHeight, assetDurationMs: clipMs, characterItemId: item.id, status: 'ready', createdBy: userId, createdAt: now, updatedAt: now }).returning();
    return row;
  });
}

export { studioSelections };
