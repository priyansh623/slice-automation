/**
 * What the Studio worker says it can do, kept in the database, so the web application can tell whether a batch it is about to
 * queue will actually be processed. The web app and the worker are separate deployments with separate environment variables
 * (STUDIO_PROVIDER, R2 settings); nothing else makes a mismatch visible.
 */
import { eq, lt, gt } from 'drizzle-orm';
import { db } from '@/db';
import { studioWorkerStatus } from '@/db/schema.pg';
import type { GenerationMode } from './mock-provider';

/** A worker that has not reported for this long is treated as not running. It reports every 30 seconds. */
export const WORKER_STALE_MS = 90_000;
export const WORKER_REPORT_EVERY_MS = 30_000;

export interface WorkerReport {
  workerId: string;
  provider: string | null;
  mode: GenerationMode;
  generationReady: boolean;
  r2Ready: boolean;
  workerEnabled: boolean;
  analysisReady: boolean;
  details?: Record<string, unknown>;
  startedAt: number;
}

export async function publishWorkerStatus(r: WorkerReport, now = Date.now()): Promise<void> {
  const row = { provider: r.provider, mode: r.mode, generationReady: r.generationReady, r2Ready: r.r2Ready, workerEnabled: r.workerEnabled, analysisReady: r.analysisReady, details: r.details ?? {}, lastSeenAt: now };
  await db.insert(studioWorkerStatus).values({ workerId: r.workerId, startedAt: r.startedAt, ...row }).onConflictDoUpdate({ target: studioWorkerStatus.workerId, set: row });
}

export async function removeWorkerStatus(workerId: string): Promise<void> {
  await db.delete(studioWorkerStatus).where(eq(studioWorkerStatus.workerId, workerId));
}

/** Drops reports of workers that stopped reporting long ago. */
export async function pruneStaleWorkers(now = Date.now()): Promise<number> {
  return (await db.delete(studioWorkerStatus).where(lt(studioWorkerStatus.lastSeenAt, now - 10 * WORKER_STALE_MS)).returning({ id: studioWorkerStatus.workerId })).length;
}

export type WorkerCheckStatus = 'ok' | 'no_worker' | 'provider_mismatch' | 'not_ready';
export interface WorkerCheck {
  status: WorkerCheckStatus;
  /** Provider ids the running workers report (null = none configured). */
  workerProviders: Array<string | null>;
  message: string | null;
}

/**
 * Can a job for `webProvider` be processed right now? ok only if a worker reported recently, every reporting worker uses the
 * same provider as the web app, and at least one of them is ready (provider usable, R2 configured, worker switched on).
 */
export async function checkWorkerForProvider(webProvider: string | null, now = Date.now()): Promise<WorkerCheck> {
  const rows = await db.select().from(studioWorkerStatus).where(gt(studioWorkerStatus.lastSeenAt, now - WORKER_STALE_MS));
  const providers = [...new Set(rows.map((r) => r.provider))];
  if (rows.length === 0) return { status: 'no_worker', workerProviders: [], message: 'No Studio worker is running (none has reported in the last minute and a half), so nothing queued now would be processed.' };
  const different = rows.filter((r) => r.provider !== webProvider);
  if (different.length > 0) {
    const show = (p: string | null) => (p ? `"${p}"` : 'no provider');
    return { status: 'provider_mismatch', workerProviders: providers, message: `The web app is set to ${show(webProvider)} but the worker is set to ${providers.map(show).join(' and ')}. Set STUDIO_PROVIDER to the same value on both, or nothing queued now would be processed.` };
  }
  if (!rows.some((r) => r.generationReady)) {
    const why = !rows.some((r) => r.workerEnabled) ? 'the worker has Studio switched off (STUDIO_WORKER=off)' : !rows.some((r) => r.r2Ready) ? 'the worker cannot reach Cloudflare R2' : 'the worker cannot use the provider (its credentials are probably missing)';
    return { status: 'not_ready', workerProviders: providers, message: `The Studio worker is running but is not ready to generate: ${why}.` };
  }
  return { status: 'ok', workerProviders: providers, message: null };
}
