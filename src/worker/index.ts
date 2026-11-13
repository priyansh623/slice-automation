import * as path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
// provider.ts uses STORAGE_DIR ?? './storage'; Vercel/GH Actions cwd is read-only so we default to /tmp
process.env.STORAGE_DIR ??= '/tmp';

import { acquireLock, releaseLock, closeLockConnection } from './lock';
import { processPendingCompilation, recoverStaleCompilations } from './compilation';
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
import { PermanentDownloadError, OutputExpiredError, AuthenticationError } from '../providers/useapi/errors';
import {
  extractAndStoreCreativeBrief,
  generateInitialScreenPrompt,
  submitQueuedGeneration,
} from '../services/video-workflow';
import { storeGeneratedVideo as uploadVideoToStorage } from '../lib/object-store/generated-video';

const POLL_INTERVAL_MS = 5_000;
const PROMPT_TASK_LEASE_MS = 10 * 60 * 1000;   // 10 min — enough for a Claude call
const VIDEO_GEN_LEASE_MS  = 2 * 60 * 60 * 1000; // 2 hr  — enough for a slow generation
const HEARTBEAT_MS = 2 * 60 * 1000;              // renew lease every 2 min

async function main(): Promise<void> {
  validateEnv();

  const acquired = await acquireLock();
  if (!acquired) {
    console.log('[worker] Another worker holds the advisory lock. Exiting.');
    process.exit(0);
  }

  console.log('[worker] Lock acquired.');

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  await recoverStaleTasks();
  await recoverStaleCompilations();
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

  // Video generations stuck in processing past lease
  const staleVideoThreshold = now - VIDEO_GEN_LEASE_MS;
  await db
    .update(videoGenerations)
    .set({ status: 'queued', updatedAt: now })
    .where(
      and(
        eq(videoGenerations.status, 'processing'),
        lt(videoGenerations.claimedAt, staleVideoThreshold),
      ),
    );

  console.log('[worker] Stale task recovery complete.');
}

async function runLoop(): Promise<void> {
  console.log('[worker] Polling loop started.');
  while (true) {
    await tick();
    await sleep(POLL_INTERVAL_MS);
  }
}

async function tick(): Promise<void> {
  await processPromptTasks();
  await processQueuedGenerations();

  if (process.env.MOCK_USEAPI === 'true') return;

  await pollInFlightGenerations();
  await processPendingCompilation();
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
    await db
      .update(promptGenerationTasks)
      .set({ status: 'processing', claimedAt: now, updatedAt: now })
      .where(eq(promptGenerationTasks.id, task.id));

    // Heartbeat interval: renew claimedAt while Claude is running
    const heartbeat = setInterval(async () => {
      await db
        .update(promptGenerationTasks)
        .set({ claimedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(promptGenerationTasks.id, task.id));
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

export async function processQueuedGenerations(): Promise<void> {
  const queued = await db
    .select()
    .from(videoGenerations)
    .where(eq(videoGenerations.status, 'queued'));

  if (queued.length === 0) return;
  console.log(`[worker] Submitting ${queued.length} queued generation(s)…`);

  for (const gen of queued) {
    try {
      await submitQueuedGeneration(gen.id, useapiProvider);
      console.log(`[worker] Queued gen ${gen.id} submitted`);
    } catch (err: unknown) {
      console.error(`[worker] Error submitting queued gen ${gen.id}:`, err);
    }
  }
}

async function pollInFlightGenerations(): Promise<void> {
  const pending = await db
    .select()
    .from(videoGenerations)
    .where(inArray(videoGenerations.status, ['pending', 'processing']));

  if (pending.length === 0) return;
  console.log(`[worker] Polling ${pending.length} job(s)…`);

  for (const gen of pending) {
    if (!gen.jobId) continue;
    try {
      const result = await useapiProvider.pollJob(gen.jobId);
      const now = Date.now();

      if (typeof result.remainingCredits === 'number') {
        db.update(adminSettings)
          .set({ lastSeenCredits: result.remainingCredits, lastSeenCreditsAt: now })
          .where(eq(adminSettings.id, 1))
          .catch(() => {});
      }

      if (result.status === 'completed' && result.videoUrl) {
        try {
          const downloaded = await useapiProvider.downloadVideo({
            jobId: gen.jobId,
            signedUrl: result.videoUrl,
            outputMediaGenerationId: result.outputMediaGenerationId ?? null,
            jobCompletedAt: now,
          });
          let storagePath: string;
          try {
            storagePath = await uploadVideoToStorage(downloaded.tempPath, gen.videoScreenId, gen.id);
          } catch (uploadErr: unknown) {
            const fsP = await import('node:fs/promises');
            await fsP.unlink(downloaded.tempPath).catch(() => {});
            throw uploadErr;
          }
          await db
            .update(videoGenerations)
            .set({ status: 'completed', videoStoragePath: storagePath, mediaGenerationId: result.outputMediaGenerationId ?? null, claimedAt: null, updatedAt: now })
            .where(eq(videoGenerations.id, gen.id));
          console.log(`[worker] Gen ${gen.id} completed → ${storagePath}`);
        } catch (dlErr: unknown) {
          if (
            dlErr instanceof PermanentDownloadError ||
            dlErr instanceof OutputExpiredError ||
            dlErr instanceof AuthenticationError
          ) {
            await db
              .update(videoGenerations)
              .set({ status: 'failed', errorMessage: (dlErr as Error).message, claimedAt: null, updatedAt: now })
              .where(eq(videoGenerations.id, gen.id));
            console.error(`[worker] Gen ${gen.id} download permanently failed: ${(dlErr as Error).message}`);
          } else {
            console.error(`[worker] Gen ${gen.id} download transient error (will retry):`, dlErr);
          }
        }
      } else if (result.status === 'completed' && !result.videoUrl) {
        if (gen.videoStoragePath) {
          // The synchronous submit path already downloaded and stored the video.
          // The poll saw 'completed' but no URL because the signed URL expired.
          // Trust the stored path and mark it done.
          await db
            .update(videoGenerations)
            .set({ status: 'completed', errorMessage: null, claimedAt: null, updatedAt: now })
            .where(eq(videoGenerations.id, gen.id));
          console.log(`[worker] Gen ${gen.id} already stored at ${gen.videoStoragePath}, marking completed`);
        } else {
          await db
            .update(videoGenerations)
            .set({ status: 'failed', errorMessage: 'Video completed but URL was not returned by provider', claimedAt: null, updatedAt: now })
            .where(eq(videoGenerations.id, gen.id));
        }
      } else if (result.status === 'failed') {
        await db
          .update(videoGenerations)
          .set({ status: 'failed', errorMessage: result.errorMessage ?? 'Provider reported failure', claimedAt: null, updatedAt: now })
          .where(eq(videoGenerations.id, gen.id));
        console.log(`[worker] Gen ${gen.id} failed: ${result.errorMessage}`);
      } else if (result.status === 'started' && gen.status === 'pending') {
        await db
          .update(videoGenerations)
          .set({ status: 'processing', claimedAt: now, updatedAt: now })
          .where(eq(videoGenerations.id, gen.id));
      }
    } catch (err: unknown) {
      console.error(`[worker] Error polling gen ${gen.id}:`, err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received. Releasing lock and exiting.`);
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
