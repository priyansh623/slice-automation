/**
 * Character B-roll Studio's background work, kept apart from the video loop in index.ts: its own loop, its own bounded
 * concurrency, its own kill switch. A slow image analysis can never delay video generation, and the other way round,
 * because nothing here runs inside (or waits for) tick().
 *
 *   STUDIO_WORKER=off                   turns all Studio background work off (checked on every pass)
 *   STUDIO_ANALYSIS_CONCURRENCY         images analysed at once (default 1, at most 2: the worker has 512 MiB and shares it with video)
 *   STUDIO_ANALYSIS_BUDGET_PER_HOUR     most images started for analysis per UTC hour, across ALL workers and restarts, counted in
 *                                       PostgreSQL (default 600, 0 = no limit; see lib/studio/budget.ts)
 *   STUDIO_PROVIDER                     must be the same value on the web app and here (this worker reports its value to the database,
 *                                       and the web app refuses to queue work when they differ or no worker is running)
 *   STUDIO_JOB_CONCURRENCY              generation jobs sent at once (default 2, 1 to 4)
 */
import { getStorage } from '../lib/object-store';
import { analyseImage, analysisConfigured, configureSharpForWorker, prepareForAnalysis } from '../lib/studio/analyzer';
import { claimNextAsset, completeAnalysis, failAnalysis, heartbeat, recoverStaleAnalysis, releaseClaim, type ClaimedAsset } from '../lib/studio/analysis-queue';
import type { MetadataRecord } from '../lib/studio/metadata';
import { generationRound, reconcileAmbiguousJobs, recoverStaleJobs, type GenerationDeps } from '../lib/studio/generation';
import { generationConfig, getProvider } from '../lib/studio/mock-provider';
import { ANALYSIS_KIND, budgetStatus, pruneBudgetHistory, recordBudgetOutcome, refundBudget, reserveBudget, type BudgetSlot } from '../lib/studio/budget';
import { retryPendingRemovals, sweepAbandonedUploads } from '../lib/studio/references';
import { publishWorkerStatus, pruneStaleWorkers, removeWorkerStatus, WORKER_REPORT_EVERY_MS } from '../lib/studio/worker-status';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ObjectExistsError } from '../lib/object-store';

export const STUDIO_POLL_MS = 3_000;
const HEARTBEAT_MS = 2 * 60 * 1000;
const RECOVERY_EVERY_MS = 60 * 1000;

export const jobConcurrency = (): number => {
  const n = parseInt(process.env.STUDIO_JOB_CONCURRENCY ?? '2', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 4) : 2;
};
const POLL_LIMIT = 4;

export const studioWorkerEnabled = (): boolean => process.env.STUDIO_WORKER !== 'off';
/** Decoding an image can take well over 100 MB at once, so by default one image at a time, and never more than two. */
export const analysisConcurrency = (): number => {
  const n = parseInt(process.env.STUDIO_ANALYSIS_CONCURRENCY ?? '1', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 2) : 1;
};

/** Most images started for analysis per UTC hour. The count lives in PostgreSQL (budget.ts), shared by every worker. */
export const analysisBudgetPerHour = (): number => {
  const n = parseInt(process.env.STUDIO_ANALYSIS_BUDGET_PER_HOUR ?? '600', 10);
  return Number.isFinite(n) && n >= 0 ? n : 600;
};

/** Claims currently being analysed by this process, so a shutdown can hand them back instead of leaving them to a 10-minute lease. */
const inFlight = new Map<number, ClaimedAsset>();
let stopping = false;

export interface AnalysisDeps {
  /** Reads an original from R2. */
  read: (key: string) => Promise<Buffer>;
  /** Looks at the image bytes and returns metadata. */
  analyse: (original: Buffer) => Promise<{ metadata: MetadataRecord; model: string }>;
  heartbeatMs?: number;
  /** Whether R2 can be reached right now. Without it, images stay pending instead of being claimed and failed. Defaults to the real check. */
  r2Ready?: () => boolean;
  /** The hourly limit (0 = none). Defaults to STUDIO_ANALYSIS_BUDGET_PER_HOUR. */
  budgetPerHour?: () => number;
}

export const defaultAnalysisDeps = (): AnalysisDeps => ({
  r2Ready: () => getStorage().r2Configured(),
  read: (key) => getStorage().downloadR2Only('uploads', key),
  analyse: async (original) => {
    // Failing to make the reduced copy happens BEFORE anything is sent to the model, so it is not charged against the budget.
    const copy = await prepareForAnalysis(original).catch((err) => { throw Object.assign(err instanceof Error ? err : new Error(String(err)), { notCharged: true }); });
    return analyseImage(copy);
  },
});

/** A short message safe to store and show: provider errors can quote request details, so only the class and status are kept. */
export function describeFailure(err: unknown): string {
  const e = err as { name?: string; status?: number; message?: string };
  if (e?.name === 'ObjectNotFoundError') return 'The original image was not found in storage.';
  if (typeof e?.message === 'string' && /Input image exceeds pixel limit|pixel limit/i.test(e.message)) return 'The image is too large to analyse.';
  if (typeof e?.message === 'string' && /did not return|no usable metadata|could not be reduced/i.test(e.message)) return e.message.slice(0, 200);
  return `Analysis failed (${e?.status ?? e?.name ?? 'error'}). Press re-analyse to try again.`;
}

/** Analyses one claimed image. Never throws: a failure is recorded on that image and nothing else is affected. */
export async function analyseClaimed(asset: ClaimedAsset, deps: AnalysisDeps, slot: BudgetSlot | null = null): Promise<'completed' | 'failed'> {
  const beat = setInterval(() => { void heartbeat(asset.id).catch(() => {}); }, deps.heartbeatMs ?? HEARTBEAT_MS);
  inFlight.set(asset.id, asset);
  let read = false;
  try {
    const original = await deps.read(asset.storageKey);
    read = true;
    const { metadata, model } = await deps.analyse(original);
    await completeAnalysis(asset, metadata, model);
    if (slot) await recordBudgetOutcome(slot, 'succeeded').catch(() => {});
    return 'completed';
  } catch (err) {
    // Budget accounting: nothing was sent to the model if the original could not be read or reduced, so the unit is given back;
    // a model call that failed may still have been billed, so it stays counted.
    if (slot) {
      if (!read || (err as { notCharged?: boolean })?.notCharged === true) await refundBudget(slot).catch(() => {});
      else await recordBudgetOutcome(slot, 'failed').catch(() => {});
    }
    console.error(`[studio-worker] analysis of asset ${asset.id} failed:`, (err as { name?: string }).name ?? 'Error', (err as { status?: number }).status ?? '');
    await failAnalysis(asset, describeFailure(err)).catch((e) => console.error('[studio-worker] could not record a failure:', e));
    return 'failed';
  } finally {
    clearInterval(beat);
    inFlight.delete(asset.id);
  }
}

/**
 * Claims and analyses up to `concurrency` images at the same time. A budget unit is reserved (atomically, in the database) BEFORE
 * each image is claimed; when none is left the images stay pending and nothing is claimed. Returns how many it handled.
 */
export async function runAnalysisRound(concurrency: number, deps: AnalysisDeps): Promise<number> {
  const limit = (deps.budgetPerHour ?? analysisBudgetPerHour)();
  const work: Array<{ asset: ClaimedAsset; slot: BudgetSlot }> = [];
  for (let i = 0; i < concurrency && !stopping; i++) {
    const slot = await reserveBudget(ANALYSIS_KIND, limit);
    if (!slot.ok) break;
    const asset = await claimNextAsset();
    if (!asset) { await refundBudget(slot); break; }   // nothing to analyse: the unit was never used
    work.push({ asset, slot });
  }
  await Promise.all(work.map((w) => analyseClaimed(w.asset, deps, w.slot)));
  return work.length;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface TickState { lastRecovery: number; warnedNoKey: boolean; warnedNoR2?: boolean; warnedBudget?: boolean; /** Recovery runs on its own timer, not inside the loop. */ noRecovery?: boolean; /** Why the last pass did or did not analyse anything (for the periodic log line). */ lastReason?: string }

/**
 * One pass of the Studio loop: recover stale work now and then, then analyse a round of images. Returns what happened so the
 * loop knows how long to rest. Without an API key nothing is claimed, so images stay pending instead of all being failed.
 */
export async function studioTick(deps: AnalysisDeps, state: TickState, now = Date.now()): Promise<'waiting' | 'idle' | 'worked'> {
  if (!studioWorkerEnabled() || stopping) { state.lastReason = stopping ? 'stopping' : 'STUDIO_WORKER is off'; return 'waiting'; }
  if (!state.noRecovery && now - state.lastRecovery >= RECOVERY_EVERY_MS) {
    const r = await recoverStaleAnalysis(now);
    if (r.requeued || r.failed) console.log(`[studio-worker] stale analysis recovered: ${r.requeued} requeued, ${r.failed} failed`);
    state.lastRecovery = now;
  }
  if (!analysisConfigured()) {
    if (!state.warnedNoKey) { console.warn('[studio-worker] ANTHROPIC_API_KEY is not set: image analysis is waiting'); state.warnedNoKey = true; }
    state.lastReason = 'ANTHROPIC_API_KEY is not set';
    return 'waiting';
  }
  // R2 must be reachable BEFORE an image is claimed: otherwise every claim would fail on the read and be marked failed.
  if (!(deps.r2Ready ? deps.r2Ready() : true)) {
    if (!state.warnedNoR2) { console.warn('[studio-worker] Cloudflare R2 is not configured: image analysis is waiting'); state.warnedNoR2 = true; }
    state.lastReason = 'R2 is not configured';
    return 'waiting';
  }
  state.warnedNoR2 = false;
  const limit = (deps.budgetPerHour ?? analysisBudgetPerHour)();
  if ((await budgetStatus(ANALYSIS_KIND, limit, now)).exhausted) {
    if (!state.warnedBudget) { console.warn(`[studio-worker] hourly analysis budget (${limit}) is used up: images stay pending until the next hour`); state.warnedBudget = true; }
    state.lastReason = `hourly budget used up (${limit})`;
    return 'waiting';
  }
  state.warnedBudget = false;
  const handled = await runAnalysisRound(analysisConcurrency(), deps);
  state.lastReason = handled > 0 ? `analysed ${handled} image(s)` : 'no pending images';
  return handled > 0 ? 'worked' : 'idle';
}

export const defaultGenerationDeps = (): GenerationDeps => ({
  provider: getProvider,
  // Queued jobs wait (they are not failed) while R2 is unreachable or no provider is enabled.
  canSubmit: () => getStorage().r2Configured() && generationConfig().enabled,
  read: (key) => getStorage().downloadR2Only('uploads', key),
  put: async (key, body, mime) => {
    try { await getStorage().putR2Only('uploads', key, body, { contentType: mime }); return 'created'; }
    catch (err) { if (err instanceof ObjectExistsError) return 'exists'; throw err; }
  },
});

export interface GenerationTickState { lastRecovery: number; noRecovery?: boolean }

/** One pass of the generation loop: recover stale jobs now and then, then submit queued and poll running jobs. */
export async function generationTick(deps: GenerationDeps, state: GenerationTickState, now = Date.now()): Promise<'idle' | 'worked'> {
  if (!studioWorkerEnabled() || stopping) return 'idle';
  if (!state.noRecovery && now - state.lastRecovery >= RECOVERY_EVERY_MS) {
    const r = await recoverStaleJobs(now);
    if (r.interrupted || r.timedOut) console.log(`[studio-worker] stale jobs: ${r.interrupted} now unknown, ${r.timedOut} timed out`);
    state.lastRecovery = now;
  }
  return (await generationRound(deps, { submit: jobConcurrency(), poll: POLL_LIMIT })) > 0 ? 'worked' : 'idle';
}

const SWEEP_EVERY_MS = 15 * 60 * 1000;
let lastSweep = 0;

/**
 * Housekeeping on its own timer, so a slow or stuck round can never stop it: stale analysis and jobs are recovered, jobs whose
 * submission outcome is unknown are reconciled (only ever in ways that cannot pay twice), and every 15 minutes abandoned uploads
 * are cleaned up (only keys this server issued and nothing uses), unfinished removals are retried, and old rows are pruned.
 */
export async function recoverStudioWork(genDeps?: GenerationDeps, now = Date.now()): Promise<void> {
  if (!studioWorkerEnabled() || stopping) return;
  try {
    const a = await recoverStaleAnalysis();
    if (a.requeued || a.failed) console.log(`[studio-worker] stale analysis recovered: ${a.requeued} requeued, ${a.failed} failed`);
  } catch (err) { console.error('[studio-worker] analysis recovery error:', (err as Error).message); }
  try {
    const r = await recoverStaleJobs();
    if (r.interrupted || r.timedOut) console.log(`[studio-worker] stale jobs: ${r.interrupted} now unknown, ${r.timedOut} timed out`);
  } catch (err) { console.error('[studio-worker] job recovery error:', (err as Error).message); }
  try {
    const r = await reconcileAmbiguousJobs(genDeps ?? defaultGenerationDeps());
    if (r.adopted || r.requeued) console.log(`[studio-worker] unknown submissions: ${r.adopted} found at the provider, ${r.requeued} safely re-sent (idempotent)`);
  } catch (err) { console.error('[studio-worker] reconcile error:', (err as Error).message); }
  if (now - lastSweep >= SWEEP_EVERY_MS) {
    lastSweep = now;
    try {
      const sw = await sweepAbandonedUploads(now);
      const again = await retryPendingRemovals();
      await pruneBudgetHistory(now); await pruneStaleWorkers(now);
      if (sw.removed || again) console.log(`[studio-worker] cleaned up ${sw.removed} abandoned upload(s), finished ${again} pending removal(s)`);
    } catch (err) { console.error('[studio-worker] clean-up error:', (err as Error).message); }
  }
}

const workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const workerStartedAt = Date.now();

/** What this worker can do right now, as the web app will see it. */
export async function reportWorkerStatus(now = Date.now()): Promise<void> {
  if (stopping) return; // a worker that is shutting down is not reported again after it removed itself
  const cfg = generationConfig();
  const enabled = studioWorkerEnabled();
  const r2Ready = (() => { try { return getStorage().r2Configured(); } catch { return false; } })();
  const budget = await budgetStatus(ANALYSIS_KIND, analysisBudgetPerHour(), now).catch(() => null);
  await publishWorkerStatus({
    workerId, provider: cfg.provider, mode: cfg.mode, generationReady: enabled && cfg.enabled && r2Ready, r2Ready, workerEnabled: enabled,
    analysisReady: enabled && analysisConfigured() && r2Ready, startedAt: workerStartedAt,
    details: { analysisConcurrency: analysisConcurrency(), analysisBudget: budget, stopping },
  }, now);
}

/**
 * Starts the Studio loops: image analysis and generation, each in its own loop, plus a recovery timer. Returns immediately (the
 * loops run in the background and never throw out of it), so the video loop in index.ts is untouched. Safe to call once, after the
 * worker holds its lock. The kill switch (STUDIO_WORKER=off) is checked on every pass, not only here.
 */
export function startStudioWorker(deps: AnalysisDeps = defaultAnalysisDeps(), genDeps: GenerationDeps = defaultGenerationDeps()): void {
  if (!studioWorkerEnabled()) console.log('[studio-worker] disabled (STUDIO_WORKER=off); it stays idle until the setting is changed');
  configureSharpForWorker();
  console.log('[studio-worker] started');
  stopping = false;
  const analysisState: TickState = { lastRecovery: 0, warnedNoKey: false, noRecovery: true };
  const genState: GenerationTickState = { lastRecovery: 0, noRecovery: true };
  const recovery = setInterval(() => { void recoverStudioWork(genDeps); }, RECOVERY_EVERY_MS);
  recovery.unref?.();
  void recoverStudioWork(genDeps);
  // Tell the database what this worker can do (provider, R2, switches) so the web app can refuse work nobody would process.
  const report = () => reportWorkerStatus().catch((err) => console.error('[studio-worker] could not report status:', (err as Error).message));
  void report();
  const reporter = setInterval(() => { void report(); }, WORKER_REPORT_EVERY_MS);
  reporter.unref?.();
  let lastLogged: string | undefined; let lastLoggedAt = 0;
  void (async () => {
    while (!stopping) {
      try {
        const outcome = await studioTick(deps, analysisState);
        // One line a minute (or when the reason changes) so the log shows what this loop is doing, even when it is idle.
        const nowMs = Date.now();
        if (analysisState.lastReason !== lastLogged || nowMs - lastLoggedAt >= 60_000) {
          console.log(`[studio-worker] analysis loop: ${analysisState.lastReason ?? 'running'}`);
          lastLogged = analysisState.lastReason; lastLoggedAt = nowMs;
        }
        await sleep(outcome === 'worked' ? 250 : outcome === 'waiting' ? STUDIO_POLL_MS * 10 : STUDIO_POLL_MS);
      } catch (err) {
        console.error('[studio-worker] analysis loop error (continuing):', (err as Error).name, (err as Error).message);
        await sleep(STUDIO_POLL_MS * 2);
      }
    }
  })();
  void (async () => {
    while (!stopping) {
      try {
        const outcome = await generationTick(genDeps, genState);
        await sleep(outcome === 'worked' ? 500 : STUDIO_POLL_MS);
      } catch (err) {
        console.error('[studio-worker] generation loop error (continuing):', (err as Error).message);
        await sleep(STUDIO_POLL_MS * 2);
      }
    }
  })();
}

/**
 * Called on SIGTERM/SIGINT: stops taking new work and hands back the images this process had claimed, so they are analysed again
 * right away by the next worker instead of sitting "processing" until their lease runs out. (A job already sent to a provider needs
 * no release: it keeps its provider id and is simply polled by whoever runs next.)
 */
export async function stopStudioWorker(): Promise<number> {
  stopping = true;
  await removeWorkerStatus(workerId).catch(() => {}); // stop being counted as a worker that can process new work
  let released = 0;
  for (const id of [...inFlight.keys()]) {
    try { if (await releaseClaim(id)) released++; } catch (err) { console.error('[studio-worker] could not release a claim on shutdown:', (err as Error).message); }
  }
  if (released) console.log(`[studio-worker] released ${released} claimed image(s) on shutdown`);
  return released;
}

/** Tests only: lets a test start from a clean state. */
export function resetStudioWorkerForTests(): void { stopping = false; inFlight.clear(); }
