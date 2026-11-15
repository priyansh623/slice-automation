/**
 * Adding and deleting scenes, on the existing `video_screens` rows.
 *
 * Deleting a scene is a soft delete. A scene's prompts, generated videos, feedback and compilation selections all
 * point at its row, and the generated videos live in storage that other records may share, so the row is never removed
 * and nothing in storage is touched. A deleted scene is marked by moving it out of the sequence:
 *   screenNumber = -id, position = -id
 * Both are unique per scene (the table has unique(project, screenNumber)), a non-positive number is never a real
 * scene, and every query that lists a project's scenes keeps only screenNumber > 0 (see isActiveScreen). This needs no
 * schema change, so it is safe to deploy in any order. The scene's original number is encoded in the marker
 * (see deletedMarker), so it can be restored to the place it was deleted from (restoreScene).
 *
 * One authoritative order: `position`. `screenNumber` is only the scene's display number and is always rederived from
 * the order (1..n by position) by renumber(). A scene's identity is its row id: compilations, prompts and videos
 * reference the id, never the number, so renumbering changes nothing about a scene or its history.
 *
 * Every operation locks the project row first, so rapid or concurrent adds and deletes take turns and the numbering
 * can never be left with a gap or a duplicate.
 */
import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  videoProjects,
  videoScreens,
  videoGenerations,
  videoCompilations,
  screenPromptVersions,
  promptGenerationTasks,
  analyticsEvents,
} from '@/db/schema.pg';

/** Deleted scenes carry their original number in the marker: -(original * DELETED_STRIDE + id). Legacy marker: -id. */
const DELETED_STRIDE = 10_000_000;
export function deletedMarker(originalNumber: number, screenId: number): number {
  return -(originalNumber * DELETED_STRIDE + screenId);
}
/** The number a deleted scene had in the sequence when it was deleted (null if unknown). */
export function originalNumberOf(screenNumber: number): number | null {
  if (screenNumber > 0) return screenNumber;
  const magnitude = -screenNumber;
  return magnitude >= DELETED_STRIDE ? Math.floor(magnitude / DELETED_STRIDE) : null;
}

export class SceneError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'SceneError';
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ScreenRow = typeof videoScreens.$inferSelect;

async function lockProject(tx: Tx, projectId: number): Promise<void> {
  const rows = await tx.select({ id: videoProjects.id }).from(videoProjects).where(eq(videoProjects.id, projectId)).for('update');
  if (!rows[0]) throw new SceneError('Project not found', 404, 'project_not_found');
}

async function activeScreens(tx: Tx, projectId: number): Promise<ScreenRow[]> {
  return tx
    .select()
    .from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, projectId), gt(videoScreens.screenNumber, 0)))
    .orderBy(asc(videoScreens.position), asc(videoScreens.screenNumber));
}

/**
 * Makes the screen numbers 1..n in position order. The unique (project, screenNumber) constraint is checked row by
 * row, so rows are moved in an order in which the target number is always free: upwards moves from the last row down,
 * downwards moves from the first row up.
 */
async function renumber(tx: Tx, projectId: number, now: number): Promise<void> {
  const screens = await activeScreens(tx, projectId);
  const moves = screens.map((s, i) => ({ s, to: i + 1 })).filter((m) => m.s.screenNumber !== m.to);
  const down = moves.filter((m) => m.to < m.s.screenNumber);
  const up = moves.filter((m) => m.to > m.s.screenNumber).reverse();
  for (const m of [...down, ...up]) {
    await tx.update(videoScreens).set({ screenNumber: m.to, updatedAt: now }).where(eq(videoScreens.id, m.s.id));
  }
}

// ── Scene creation records ───────────────────────────────────────────────────
//
// Adding a scene is two steps: the scene row is created, then its prompt is written (a model call that can fail or be
// cut off by the request time limit). A creation record keeps what the person typed, a retry key, and how far the second
// step got, so a failed or interrupted scene can be retried from its card without typing anything again and without
// ever creating a second scene.
//
// The record is a row in the existing `analytics_events` table (event type 'scene_creation', payload below). That table
// is an append-only event log nothing else reads, so no schema change is needed and nothing can interfere with the
// scene's own fields (an earlier version kept the retry key in the scene's duration note; that field belongs to the
// script breakdown, which writes it back wholesale, so a dedicated record is safer). The record only drives what the
// scene card shows. Whether a scene can be approved or compiled never depends on it: that needs a generated video, which
// needs a prompt.
export const SCENE_CREATION_EVENT = 'scene_creation';
/** How long a "generating" record is believed: the request is cut off after 60 seconds, so past this it is dead. */
export const ADD_SCENE_LEASE_MS = 90_000;

export interface SceneBrief { description: string; visualInstructions: string }
export type CreationStatus = 'generating' | 'failed' | 'done';
interface CreationPayload extends SceneBrief {
  requestId: string;
  screenId: number;
  dialogue: string;
  status: CreationStatus;
  error?: string;
  at: number;
}
export interface CreationRecord extends CreationPayload { eventId: number }
/** What a scene card shows for a scene whose prompt is not finished. */
export type CreationState = 'generating' | 'interrupted' | 'failed';

function stateOf(rec: Pick<CreationPayload, 'status' | 'at'>, now: number): CreationState | null {
  if (rec.status === 'done') return null;
  if (rec.status === 'failed') return 'failed';
  return now - rec.at < ADD_SCENE_LEASE_MS ? 'generating' : 'interrupted';
}

async function creationRecords(executor: Pick<typeof db, 'select'>, projectId: number, extra?: ReturnType<typeof sql>): Promise<CreationRecord[]> {
  const rows = await executor
    .select({ id: analyticsEvents.id, payload: analyticsEvents.payload })
    .from(analyticsEvents)
    .where(and(eq(analyticsEvents.videoProjectId, projectId), eq(analyticsEvents.eventType, SCENE_CREATION_EVENT), ...(extra ? [extra] : [])));
  return rows.map((r) => ({ ...(r.payload as CreationPayload), eventId: r.id }));
}

/**
 * For each scene of the project whose prompt is not finished, how far its creation got. A scene that has a prompt
 * (or no creation record, like every scene from the script breakdown) is not in the map.
 */
export async function incompleteScenes(projectId: number): Promise<Map<number, { state: CreationState; error?: string; brief: SceneBrief & { dialogue: string } }>> {
  const records = await creationRecords(db, projectId);
  const out = new Map<number, { state: CreationState; error?: string; brief: SceneBrief & { dialogue: string } }>();
  const candidates = records.filter((r) => r.status !== 'done');
  if (candidates.length === 0) return out;
  const withPrompt = new Set((await db
    .select({ id: screenPromptVersions.videoScreenId })
    .from(screenPromptVersions)
    .where(inArray(screenPromptVersions.videoScreenId, candidates.map((r) => r.screenId)))).map((r) => r.id));
  const now = Date.now();
  for (const r of candidates) {
    if (withPrompt.has(r.screenId)) continue; // finished, whatever the record says (e.g. the update was lost)
    const state = stateOf(r, now);
    if (state) out.set(r.screenId, { state, error: r.error, brief: { description: r.description, visualInstructions: r.visualInstructions, dialogue: r.dialogue } });
  }
  return out;
}

export async function markCreation(eventId: number, status: CreationStatus, error?: string): Promise<void> {
  const patch: Partial<CreationPayload> = { status, at: Date.now(), ...(error ? { error } : {}) };
  await db.update(analyticsEvents).set({ payload: sql`coalesce(${analyticsEvents.payload}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` }).where(eq(analyticsEvents.id, eventId));
}

export interface AddSceneInput {
  dialogue: string;
  durationSeconds?: number | null;
  /** Put the new scene right after this scene (by screen id). Omit to add it at the end. */
  afterScreenId?: number | null;
  /** Identifies one "Add scene" attempt (the form keeps it until the scene exists). */
  requestId: string;
  brief: SceneBrief;
  userId: string;
}

export type SceneCreation =
  | { state: 'created' | 'resumed'; screen: ScreenRow; eventId: number }
  /** This attempt already finished: the scene exists and has its prompt. */
  | { state: 'done'; screen: ScreenRow }
  /** Another request for this attempt is still working on it. */
  | { state: 'busy'; screen: ScreenRow };

/**
 * Creates the scene row at the requested place, renumbers the scenes after it, and writes the creation record. A
 * repeated attempt (same requestId) never creates a second scene: it returns the first one, finished, in progress, or
 * failed or abandoned (taken over, with the person's current text).
 */
export async function createSceneRow(projectId: number, input: AddSceneInput): Promise<SceneCreation> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const screens = await activeScreens(tx, projectId);
    const now = Date.now();

    const earlier = (await creationRecords(tx, projectId, sql`${analyticsEvents.payload}->>'requestId' = ${input.requestId}`))[0];
    const earlierScreen = earlier ? screens.find((s) => s.id === earlier.screenId) : undefined;
    if (earlier && earlierScreen) {
      const hasPrompt = await tx.select({ id: screenPromptVersions.id }).from(screenPromptVersions).where(eq(screenPromptVersions.videoScreenId, earlierScreen.id)).limit(1);
      if (hasPrompt[0] || earlier.status === 'done') return { state: 'done' as const, screen: earlierScreen };
      if (stateOf(earlier, now) === 'generating') return { state: 'busy' as const, screen: earlierScreen };
      // Failed, or cut off before the prompt was written: take the same scene over, with the text as it is now.
      const [taken] = await tx.update(videoScreens).set({ dialogue: input.dialogue, updatedAt: now }).where(eq(videoScreens.id, earlierScreen.id)).returning();
      await tx.update(analyticsEvents).set({
        payload: { ...earlier, ...input.brief, dialogue: input.dialogue, status: 'generating', at: now, error: undefined },
      }).where(eq(analyticsEvents.id, earlier.eventId));
      return { state: 'resumed' as const, screen: taken, eventId: earlier.eventId };
    }

    let index = screens.length; // the new scene goes at this index
    if (input.afterScreenId != null) {
      const after = screens.findIndex((s) => s.id === input.afterScreenId);
      if (after === -1) throw new SceneError('The scene to insert after no longer exists. Reload and try again.', 409, 'scene_gone');
      index = after + 1;
    }

    const previous = screens[index - 1];
    const position = previous ? previous.position + 1 : (screens[0]?.position ?? 1);

    // Make room: every later scene moves one place on (highest first so no number is used twice).
    for (let i = screens.length - 1; i >= index; i--) {
      await tx
        .update(videoScreens)
        .set({ screenNumber: i + 2, position: screens[i].position + 1, updatedAt: now })
        .where(eq(videoScreens.id, screens[i].id));
    }

    const [created] = await tx
      .insert(videoScreens)
      .values({
        videoProjectId: projectId,
        screenNumber: index + 1,
        dialogue: input.dialogue,
        position,
        durationSeconds: input.durationSeconds ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const payload: CreationPayload = { requestId: input.requestId, screenId: created.id, ...input.brief, dialogue: input.dialogue, status: 'generating', at: now };
    const [event] = await tx.insert(analyticsEvents).values({ userId: input.userId, videoProjectId: projectId, eventType: SCENE_CREATION_EVENT, payload, createdAt: now }).returning({ id: analyticsEvents.id });
    return { state: 'created' as const, screen: created, eventId: event.id };
  });
}

/**
 * Starts a retry of an interrupted or failed scene from its saved text: returns the scene and its brief, or throws if
 * the scene does not need one (finished, or another request is still writing it).
 */
export async function beginRetry(projectId: number, screenId: number): Promise<{ screen: ScreenRow; brief: SceneBrief; eventId: number }> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const screen = (await tx.select().from(videoScreens).where(and(eq(videoScreens.id, screenId), eq(videoScreens.videoProjectId, projectId), gt(videoScreens.screenNumber, 0))))[0];
    if (!screen) throw new SceneError('This scene no longer exists. Reload the page.', 404, 'scene_gone');
    const rec = (await creationRecords(tx, projectId, sql`(${analyticsEvents.payload}->>'screenId')::int = ${screenId}`))[0];
    const hasPrompt = await tx.select({ id: screenPromptVersions.id }).from(screenPromptVersions).where(eq(screenPromptVersions.videoScreenId, screenId)).limit(1);
    if (!rec || hasPrompt[0]) throw new SceneError('This scene already has its prompt.', 409, 'nothing_to_retry');
    if (stateOf(rec, Date.now()) === 'generating') throw new SceneError('This scene is still being written. Wait a moment, then try again.', 409, 'in_progress');
    await tx.update(analyticsEvents).set({ payload: { ...rec, status: 'generating', at: Date.now(), error: undefined } }).where(eq(analyticsEvents.id, rec.eventId));
    return { screen, brief: { description: rec.description, visualInstructions: rec.visualInstructions }, eventId: rec.eventId };
  });
}

async function softDelete(tx: Tx, projectId: number, screen: ScreenRow): Promise<void> {
  const now = Date.now();
  await tx
    .update(videoScreens)
    .set({ screenNumber: deletedMarker(screen.screenNumber, screen.id), position: -screen.id, updatedAt: now })
    .where(eq(videoScreens.id, screen.id));
  await renumber(tx, projectId, now);
}

export interface DeleteSceneResult {
  deletedScreenId: number;
  /** The scene's number before it was deleted. */
  deletedScreenNumber: number;
  remaining: number;
  /** Counts of what was left in place, so nothing is silently lost. */
  keptGenerations: number;
}

/**
 * Takes a scene out of the sequence and renumbers the rest. Its prompts, videos and stored files are left exactly as
 * they are. Refused while a video for it is being made or a compilation is running, because either would then finish
 * for a scene the user can no longer see.
 */
export async function deleteScene(projectId: number, screenId: number, expectedScreenNumber?: number): Promise<DeleteSceneResult> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);

    const rows = await tx.select().from(videoScreens).where(and(eq(videoScreens.id, screenId), eq(videoScreens.videoProjectId, projectId)));
    const screen = rows[0];
    if (!screen || screen.screenNumber <= 0) throw new SceneError('This scene no longer exists. Reload the page.', 404, 'scene_gone');
    if (expectedScreenNumber !== undefined && screen.screenNumber !== expectedScreenNumber) {
      throw new SceneError('The scenes changed since this page loaded. Reload the page and try again.', 409, 'scene_renumbered');
    }

    const running = await tx
      .select({ id: videoCompilations.id })
      .from(videoCompilations)
      .where(and(eq(videoCompilations.videoProjectId, projectId), inArray(videoCompilations.status, ['pending', 'processing'])))
      .limit(1);
    if (running[0]) {
      throw new SceneError('A compilation is running. Wait for it to finish before deleting a scene.', 409, 'compilation_running');
    }

    const creating = (await creationRecords(tx, projectId, sql`(${analyticsEvents.payload}->>'screenId')::int = ${screenId}`))[0];
    if (creating && stateOf(creating, Date.now()) === 'generating') {
      throw new SceneError(`Scene ${screen.screenNumber} is still being written. Wait a moment, then try again.`, 409, 'generation_running');
    }

    const gens = await tx
      .select({ id: videoGenerations.id, status: videoGenerations.status })
      .from(videoGenerations)
      .where(eq(videoGenerations.videoScreenId, screenId));
    if (gens.some((g) => ['queued', 'pending', 'processing'].includes(g.status))) {
      throw new SceneError(`Scene ${screen.screenNumber} is generating a video. Wait for it to finish before deleting it.`, 409, 'generation_running');
    }

    // A prompt still waiting in the queue for this scene would only spend a model call on a hidden scene.
    await tx
      .update(promptGenerationTasks)
      .set({ status: 'failed', errorMessage: 'Scene deleted', claimedAt: null, updatedAt: Date.now() })
      .where(and(eq(promptGenerationTasks.videoScreenId, screenId), eq(promptGenerationTasks.status, 'pending')));

    await softDelete(tx, projectId, screen);
    const remaining = await activeScreens(tx, projectId);
    return { deletedScreenId: screen.id, deletedScreenNumber: screen.screenNumber, remaining: remaining.length, keptGenerations: gens.length };
  });
}

/** The scene's order as the pages show it. */
export async function listActiveScreens(projectId: number): Promise<ScreenRow[]> {
  return db.transaction(async (tx) => activeScreens(tx, projectId));
}

export interface DeletedScene {
  id: number;
  dialogue: string;
  /** The number it had when it was deleted. */
  originalNumber: number | null;
  deletedAt: number;
  approved: boolean;
}

/** Scenes taken out of the sequence by a delete, newest first. They still hold all their prompts and videos. */
export async function listDeletedScreens(projectId: number): Promise<DeletedScene[]> {
  const rows = await db.select().from(videoScreens).where(and(eq(videoScreens.videoProjectId, projectId), lt(videoScreens.screenNumber, 1)));
  return rows
    .map((r) => ({ id: r.id, dialogue: r.dialogue, originalNumber: originalNumberOf(r.screenNumber), deletedAt: r.updatedAt, approved: r.approvedGenerationId != null }))
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Puts a deleted scene back where it was (its original number, or the end if the sequence is now shorter), renumbers
 * the scenes after it, and leaves everything attached to it (prompts, videos, approval) exactly as it was.
 */
export async function restoreScene(projectId: number, screenId: number): Promise<{ screenId: number; screenNumber: number }> {
  return db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const rows = await tx.select().from(videoScreens).where(and(eq(videoScreens.id, screenId), eq(videoScreens.videoProjectId, projectId)));
    const screen = rows[0];
    if (!screen) throw new SceneError('Scene not found.', 404, 'scene_not_found');
    if (screen.screenNumber > 0) throw new SceneError('This scene is already in the sequence.', 409, 'already_active');

    const screens = await activeScreens(tx, projectId);
    const original = originalNumberOf(screen.screenNumber) ?? screens.length + 1;
    const index = Math.min(Math.max(original - 1, 0), screens.length);
    const now = Date.now();

    const previous = screens[index - 1];
    const position = previous ? previous.position + 1 : (screens[0]?.position ?? 1);
    for (let i = screens.length - 1; i >= index; i--) {
      await tx
        .update(videoScreens)
        .set({ screenNumber: i + 2, position: screens[i].position + 1, updatedAt: now })
        .where(eq(videoScreens.id, screens[i].id));
    }
    await tx.update(videoScreens).set({ screenNumber: index + 1, position, updatedAt: now }).where(eq(videoScreens.id, screen.id));
    return { screenId: screen.id, screenNumber: index + 1 };
  });
}

/**
 * The one place a scene's approval is withdrawn because its content changed. Every path that changes what a scene will
 * produce (its dialogue, duration, or prompt) calls this, so the rule cannot drift between components. Only the approval
 * pointer is cleared: the approved video, its prompt version and all other history stay, so the clip is still listed
 * on the scene and can be approved again with one click. Scenes that are not approved are left alone.
 */
export async function invalidateSceneApproval(screenIds: number[]): Promise<number[]> {
  if (screenIds.length === 0) return [];
  const cleared = await db
    .update(videoScreens)
    .set({ approvedGenerationId: null, updatedAt: Date.now() })
    .where(and(inArray(videoScreens.id, screenIds), isNotNull(videoScreens.approvedGenerationId)))
    .returning({ id: videoScreens.id });
  return cleared.map((r) => r.id);
}
