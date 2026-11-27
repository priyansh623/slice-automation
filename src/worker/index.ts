import * as path from 'node:path';
import { isVideoProjectDeleted, PROJECT_DELETED_MESSAGE } from '../lib/project-deletion';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
// provider.ts uses STORAGE_DIR ?? './storage'; Vercel/GH Actions cwd is read-only so we default to /tmp
process.env.STORAGE_DIR ??= '/tmp';

import { acquireLock, releaseLock, closeLockConnection } from './lock';
import { activeCompilationId, processPendingCompilation, recoverStaleCompilations } from './compilation';
import { logStartupMemory, safely } from './container-memory';
import { validateEnv } from '../lib/startup-checks';
import { db } from '../db';
import {
  videoGenerations,
  promptGenerationTasks,
  videoScreens,
  screenPromptVersions,
  adminSettings,
} from '../db/schema.pg';
import { eq, inArray, isNull, lt, and } from 'drizzle-orm';
import { useapiProvider } from '../providers/useapi/provider';
import { pollInFlightGenerations, recoverAbandonedGenerations } from '../services/generation-polling';
import { mapLimit, roundRobin, RULES } from '../services/job-rules';
import {
  extractAndStoreCreativeBrief,
  generateInitialScreenPrompt,
  submitQueuedGeneration,
} from '../services/video-workflow';
import { startStudioWorker, stopStudioWorker, withTimeout } from './studio';
import { processOverlayIngest } from './overlay-ingest';
import { processCharacterClips } from './character-clips';

const POLL_INTERVAL_MS = 5_000;
const PROMPT_TASK_LEASE_MS = 10 * 60 * 1000;   // 10 min — enough for a Claude call
const HEARTBEAT_MS = 2 * 60 * 1000;              // renew lease every 2 min
const HEARTBEAT_LOG_MS = 5 * 60 * 1000;           // one status line every 5 min

export async function main(): Promise<void> {
  validateEnv();

  const acquired = await acquireLock();
  if (!acquired) {
    console.log('[worker] Another worker holds the advisory lock. Exiting.');
    process.exit(0);
  }

  console.log('[worker] Lock acquired.');
  safely(() => logStartupMemory()); // measurement only

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  installCrashLogging();

  await recoverStaleTasks();
  await recoverStaleCompilations();
  // Character B-roll Studio's own loops: independent of the video loop below (they never run inside tick()).
  startStudioWorker();
  // B-roll's own loop too: a Flow step that stops answering must never hold up library clips or Character videos.
  void runBrollLoop();
  await runLoop();
}

async function recoverStaleTasks(): Promise<void> {
  const now = Date.now();

  // Prompt generation tasks claimed but not progressed past their lease
  const stalePromptThreshold = now - PROMPT_TASK_LEASE_MS;
  await db
    .update(promptGenerationTasks)
    .set({ status: 'pending', claimedAt: null, updatedAt: now })
    .where(
      and(
        eq(promptGenerationTasks.status, 'processing'),
        lt(promptGenerationTasks.claimedAt, stalePromptThreshold),
      ),
    );

  // Video generations: a job the provider accepted is simply followed again; one that may or may not have been sent is never sent again.
  await recoverAbandonedGenerations();

  console.log('[worker] Stale task recovery complete.');
}

// ── Independent loops ───────────────────────────────────────────────────────────
// Each kind of work has its own loop, so a slow compilation or a slow provider call holds up only itself. Job claiming in the database
// (compare-and-set) is what makes this, and a second worker process, safe.

const lastPass = new Map<string, number>();

async function runLoopOf(name: string, pass: () => Promise<unknown>): Promise<void> {
  console.log(`[worker] ${name} loop started.`);
  while (true) {
    // Say which loop is slow, so work that stops answering is named in the log instead of freezing silently.
    const watchdog = setInterval(() => console.warn(`[worker] ${name} pass still running after 60 s`), 60_000);
    try { await pass(); lastPass.set(name, Date.now()); }
    catch (err) { console.error(`[worker] ${name} loop error (continuing):`, (err as Error).message); }
    finally { clearInterval(watchdog); }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Nothing should wait long unnoticed: queued for 10 minutes, or unfinished for an hour, is written to the log as a warning. */
export async function reportStuckWork(now = Date.now()): Promise<{ queued: number[]; unfinished: number[] }> {
  try {
    const rows = await db.select({ id: videoGenerations.id, status: videoGenerations.status, createdAt: videoGenerations.createdAt }).from(videoGenerations).where(inArray(videoGenerations.status, ['queued', 'pending', 'processing']));
    const queued = rows.filter((r) => r.status === 'queued' && now - r.createdAt > 10 * 60_000).map((r) => r.id);
    const unfinished = rows.filter((r) => r.status !== 'queued' && now - r.createdAt > 60 * 60_000).map((r) => r.id);
    if (queued.length || unfinished.length) console.warn(`[worker] STUCK_WORK queued>10m=[${queued.join(',')}] unfinished>1h=[${unfinished.join(',')}]`);
    return { queued, unfinished };
  } catch (err) {
    console.warn('[worker] could not check for stuck work:', (err as Error).message);
    return { queued: [], unfinished: [] };
  }
}

function startHeartbeat(): void {
  setInterval(() => {
    const ages = [...lastPass].map(([name, at]) => `${name}=${Math.round((Date.now() - at) / 1000)}s`).join(' ');
    void reportStuckWork();
    console.log(`[worker] heartbeat rss=${Math.round(process.memoryUsage().rss / 1048576)}MB submitting=${submitting.size} last-completed-pass: ${ages}`);
  }, HEARTBEAT_LOG_MS).unref();
}

let lastRecovery = 0;
async function submissionPass(): Promise<void> {
  if (Date.now() - lastRecovery > 60_000) { lastRecovery = Date.now(); await recoverAbandonedGenerations(); }
  await startQueuedSubmissions();
}

async function runLoop(): Promise<void> {
  startHeartbeat();
  const mock = process.env.MOCK_USEAPI === 'true';
  await Promise.all([
    runLoopOf('prompt', () => processPromptTasks()),
    runLoopOf('submit', submissionPass),
    ...(mock ? [] : [
      runLoopOf('poll', () => pollInFlightGenerations()),
      runLoopOf('compile', () => processPendingCompilation()),
    ]),
  ]);
}

/**
 * Library clips (prepared for the timeline) and Character B-roll videos (sent to the video model, polled, stored). They run on their own loop,
 * and each pass has a time limit, so one database call that never answers becomes a logged error and the next pass tries again.
 */
async function runBrollLoop(): Promise<void> {
  console.log('[worker] B-roll loop started.');
  let lastLogged: string | undefined; let lastLoggedAt = 0;
  while (true) {
    let reason = 'idle (nothing to do)';
    if (process.env.MOCK_USEAPI === 'true') { await sleep(POLL_INTERVAL_MS * 6); continue; }
    try {
      const prepared = await withTimeout(processOverlayIngest(), 'preparing library clips', 120_000);
      const handled = await withTimeout(processCharacterClips(), 'the Character video pass', 120_000);
      if (prepared || handled) reason = 'handled work';
    } catch (err) {
      reason = `error: ${(err as Error).message}`;
      console.error('[worker] B-roll loop error (continuing):', (err as Error).message);
    }
    const t = Date.now();
    if (reason !== lastLogged || t - lastLoggedAt >= 60_000) { console.log(`[worker] B-roll loop: ${reason}`); lastLogged = reason; lastLoggedAt = t; }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function processPromptTasks(): Promise<void> {
  const allPending = await db
    .select()
    .from(promptGenerationTasks)
    .where(eq(promptGenerationTasks.status, 'pending'));

  if (allPending.length === 0) return;

  // Round-robin by project so one project's backlog can't starve newer ones.
  // Within each project, tasks still run oldest-first (ID order).
  const byProject = new Map<number, typeof allPending>();
  for (const t of allPending) {
    if (!byProject.has(t.videoProjectId)) byProject.set(t.videoProjectId, []);
    byProject.get(t.videoProjectId)!.push(t);
  }
  for (const group of byProject.values()) group.sort((a, b) => a.id - b.id);
  const projectOrder = [...byProject.keys()].sort(
    (a, b) => byProject.get(a)![0].id - byProject.get(b)![0].id,
  );
  const tasks: typeof allPending = [];
  let i = 0;
  while (tasks.length < allPending.length) {
    const pid = projectOrder[i % projectOrder.length];
    const group = byProject.get(pid)!;
    if (group.length > 0) tasks.push(group.shift()!);
    i++;
  }

  for (const task of tasks) {
    if (task.taskType === 'generate_prompt') {
      const blockedByExtract = await db
        .select()
        .from(promptGenerationTasks)
        .where(
          and(
            eq(promptGenerationTasks.videoProjectId, task.videoProjectId),
            eq(promptGenerationTasks.taskType, 'extract_brief'),
          ),
        )
        .then((rows) => rows.some((t) => t.status !== 'completed' && t.status !== 'failed'));
      if (blockedByExtract) continue;
    }

    const now = Date.now();
    const claimed = await db
      .update(promptGenerationTasks)
      .set({ status: 'processing', claimedAt: now, updatedAt: now })
      .where(and(eq(promptGenerationTasks.id, task.id), eq(promptGenerationTasks.status, 'pending')))
      .returning({ id: promptGenerationTasks.id });
    if (claimed.length === 0) continue;

    // Never spend an AI call on a deleted project (a request that was already on its way can queue a task just after the delete).
    if (await isVideoProjectDeleted(task.videoProjectId)) {
      await db.update(promptGenerationTasks).set({ status: 'failed', claimedAt: null, errorMessage: PROJECT_DELETED_MESSAGE, updatedAt: Date.now() }).where(eq(promptGenerationTasks.id, task.id));
      continue;
    }

    // Heartbeat interval: renew claimedAt while Claude is running
    const heartbeat = setInterval(async () => {
      await db
        .update(promptGenerationTasks)
        .set({ claimedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(promptGenerationTasks.id, task.id))
        .catch((err) => console.warn(`[worker] prompt task ${task.id} lease renewal failed:`, (err as Error).message));
    }, HEARTBEAT_MS);

    try {
      if (task.taskType === 'extract_brief') {
        const screen1Rows = task.videoScreenId
          ? await db.select().from(videoScreens).where(eq(videoScreens.id, task.videoScreenId)).limit(1)
          : [];
        const screen1 = screen1Rows[0];
        const approvedGenId = screen1?.approvedGenerationId;

        let approvedPromptText: string | null = null;
        if (approvedGenId) {
          const genRows = await db.select().from(videoGenerations).where(eq(videoGenerations.id, approvedGenId)).limit(1);
          const gen = genRows[0];
          if (gen) {
            const pvRows = await db.select().from(screenPromptVersions).where(eq(screenPromptVersions.id, gen.promptVersionId)).limit(1);
            approvedPromptText = pvRows[0]?.promptText ?? null;
          }
        }

        if (!approvedPromptText) {
          throw new Error('No approved prompt found for Screen 1 — cannot extract creative brief');
        }

        await extractAndStoreCreativeBrief(task.videoProjectId, approvedPromptText, task.videoScreenId ?? undefined);
        console.log(`[worker] extract_brief task ${task.id} completed for project ${task.videoProjectId}`);

      } else if (task.taskType === 'generate_prompt') {
        if (!task.videoScreenId) throw new Error('generate_prompt task missing videoScreenId');
        await generateInitialScreenPrompt(task.videoProjectId, task.videoScreenId);
        console.log(`[worker] generate_prompt task ${task.id} completed for screen ${task.videoScreenId}`);

        // Generating a prompt never queues a video. Video generation (and its provider credits) starts only when a
        // user clicks Generate Video / Generate all scenes, which queue it through the API.
      }

      clearInterval(heartbeat);
      await db
        .update(promptGenerationTasks)
        .set({ status: 'completed', updatedAt: Date.now() })
        .where(eq(promptGenerationTasks.id, task.id));

    } catch (err: unknown) {
      clearInterval(heartbeat);
      await db
        .update(promptGenerationTasks)
        .set({
          status: 'failed',
          claimedAt: null,
          errorMessage: (err instanceof Error ? err.message : String(err)),
          updatedAt: Date.now(),
        })
        .where(eq(promptGenerationTasks.id, task.id));
      console.error(`[worker] prompt task ${task.id} (${task.taskType}) failed:`, err);
    }

    break; // one task per tick
  }
}

/** Queued jobs that may be sent now (not waiting out a "busy" delay), oldest first, projects taking turns. */
async function readyToSubmit(): Promise<number[]> {
  const queued = await db
    .select()
    .from(videoGenerations)
    .where(eq(videoGenerations.status, 'queued'));
  const now = Date.now();
  const ready = queued.filter((g) => !g.jobId && (!g.claimedAt || g.claimedAt <= now)).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  if (ready.length === 0) return [];
  const screens = await db.select({ id: videoScreens.id, projectId: videoScreens.videoProjectId }).from(videoScreens).where(inArray(videoScreens.id, ready.map((g) => g.videoScreenId)));
  const projectOf = new Map(screens.map((sc) => [sc.id, sc.projectId]));
  return roundRobin(ready, (g) => projectOf.get(g.videoScreenId) ?? 0).map((g) => g.id);
}

const submitOne = async (id: number) => {
  try { await submitQueuedGeneration(id, useapiProvider); }
  catch (err: unknown) { console.error(`[worker] Error submitting queued gen ${id}:`, err); }
};

const submitting = new Set<number>();
/** Fills the free submission slots without waiting for them: a submission can take minutes and must not hold up the ones behind it. */
export async function startQueuedSubmissions(): Promise<Promise<void>[]> {
  const free = RULES.submitConcurrency() - submitting.size;
  if (stopping || free <= 0) return [];
  const ids = (await readyToSubmit()).filter((id) => !submitting.has(id)).slice(0, free);
  return ids.map((id) => {
    submitting.add(id);
    console.log(`[worker] Submitting gen ${id}`);
    const run = submitOne(id).finally(() => { submitting.delete(id); inFlightSubmissions.delete(run); });
    inFlightSubmissions.add(run);
    return run;
  });
}

/** One complete pass over the queue (used by tests and for a single run). */
export async function processQueuedGenerations(): Promise<void> {
  await mapLimit(await readyToSubmit(), RULES.submitConcurrency(), submitOne);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A crash still ends the process (the host restarts it), but never silently: what was running and how much memory it held are written first. */
function installCrashLogging(): void {
  const report = (kind: string, err: unknown) => {
    const loops = [...lastPass].map(([name, at]) => `${name}=${Math.round((Date.now() - at) / 1000)}s`).join(' ');
    console.error(`[worker] FATAL ${kind}: ${(err as Error)?.stack ?? String(err)}\n[worker] at crash: rss=${Math.round(process.memoryUsage().rss / 1048576)}MB submitting=[${[...submitting].join(',')}] compiling=${activeCompilationId ?? 'none'} ${loops}`);
    process.exit(1);
  };
  process.on('uncaughtException', (err) => report('uncaughtException', err));
  process.on('unhandledRejection', (reason) => report('unhandledRejection', reason));
}

let stopping = false;
/** How long a shutdown waits for submissions already with the provider, so their job ids get saved. Render allows 30 s after SIGTERM. */
const SHUTDOWN_DRAIN_MS = 25_000;
const inFlightSubmissions = new Set<Promise<void>>();

/** Stops taking new submissions and waits (bounded) for the ones already sent. Returns how many were still unanswered. */
export async function drainSubmissions(limitMs = SHUTDOWN_DRAIN_MS): Promise<number> {
  stopping = true;
  await Promise.race([Promise.allSettled([...inFlightSubmissions]), new Promise((r) => setTimeout(r, limitMs).unref?.())]);
  return inFlightSubmissions.size;
}
export const resumeSubmissionsForTests = () => { stopping = false; };

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;                                  // a second signal must not cut the wait short
  shuttingDown = true;
  console.log(`[worker] ${signal} received. Finishing in-flight submissions, then exiting.`);
  const left = await drainSubmissions();
  if (left > 0) console.warn(`[worker] ${left} submission(s) had no answer yet (gens ${[...submitting].join(',')}). They will be marked "could not confirm" and not re-sent.`);
  // Hand back claimed Studio images before the process ends, but never let that hold up the shutdown (at most 5 s).
  await Promise.race([stopStudioWorker().catch(() => {}), sleep(5_000)]);
  await releaseLock();
  await closeLockConnection();
  process.exit(0);
}

// Tests import this module to exercise the queue processing; they must not start the polling loop.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error('[worker] Fatal error:', err);
    process.exit(1);
  });
}
