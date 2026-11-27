/**
 * Worker startup order: interrupted compilations may only be recovered AFTER this worker holds the advisory lock.
 * Only one worker can hold the lock, which is what makes "any compilation still processing is orphaned" true. Recovering
 * before the lock is held, or when the lock is refused, could fail a job that another live worker is still running.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls = vi.hoisted(() => ({ order: [] as string[], lock: true }));

vi.mock('@/worker/lock', () => ({
  acquireLock: async () => { calls.order.push('acquireLock'); return calls.lock; },
  releaseLock: async () => undefined,
  closeLockConnection: async () => undefined,
}));
vi.mock('@/worker/compilation', () => ({
  processPendingCompilation: async () => false,
  recoverStaleCompilations: async () => { calls.order.push('recoverStaleCompilations'); throw new Error('stop after recovery'); },
}));
vi.mock('@/lib/startup-checks', () => ({ validateEnv: () => { calls.order.push('validateEnv'); } }));
vi.mock('@/db', () => {
  // Any query chain resolves to an empty result: this test is only about the order of the startup steps.
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? (resolve: (v: unknown) => void) => resolve([]) : chain),
    apply: () => chain,
  });
  return { db: chain };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ storage: { from: () => ({}) } }) }));
vi.mock('@/services/video-workflow', () => ({
  extractAndStoreCreativeBrief: async () => undefined,
  generateInitialScreenPrompt: async () => undefined,
  submitQueuedGeneration: async () => undefined,
}));

import { main } from '@/worker/index';

class ExitCalled extends Error { constructor(readonly code: number | undefined) { super(`process.exit(${code})`); } }

beforeEach(() => {
  calls.order = [];
  calls.lock = true;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitCalled(code); }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('worker startup', () => {
  it('recovers interrupted compilations only after the advisory lock has been acquired', async () => {
    await expect(main()).rejects.toThrow('stop after recovery');
    expect(calls.order).toEqual(['validateEnv', 'acquireLock', 'recoverStaleCompilations']);
  });

  it('waits for the lock without recovering anything, then carries on once the old worker lets go', async () => {
    vi.useFakeTimers();
    calls.lock = false;
    const run = expect(main()).rejects.toThrow('stop after recovery');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(calls.order).not.toContain('recoverStaleCompilations');
    calls.lock = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    expect(calls.order.at(-1)).toBe('recoverStaleCompilations');
    vi.useRealTimers();
  });

  it('gives up and exits, having recovered nothing, if the lock is never released', async () => {
    vi.useFakeTimers();
    calls.lock = false;
    const run = expect(main()).rejects.toBeInstanceOf(ExitCalled);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await run;
    expect(calls.order).not.toContain('recoverStaleCompilations');
    vi.useRealTimers();
  });
});
