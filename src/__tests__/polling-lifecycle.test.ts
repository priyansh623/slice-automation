/**
 * Polling lifecycle tests.
 *
 * The React polling useEffect in src/app/video-projects/[id]/page.tsx makes
 * three branching decisions on every 4-second tick:
 *
 *   1. shouldPoll  — are there active tasks OR active video generations?
 *   2. pollMode    — 'full' (gens active) | 'lightweight' (tasks only) | 'none'
 *   3. transition  — did any task move from active → terminal this tick?
 *                    (determines whether the lightweight path fetches the full project)
 *
 * These pure functions mirror the logic exactly, allowing all lifecycle
 * scenarios to be tested without React Testing Library.
 */
import { describe, it, expect } from 'vitest';

// ── Types ─────────────────────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';
type GenStatus  = 'queued' | 'pending' | 'processing' | 'completed' | 'failed';

interface PromptTask { id: number; status: TaskStatus; }
interface Gen        { status: GenStatus; }
interface Screen     { latestGen: Gen | null; }
interface Project    { screens: Screen[]; }

// ── Pure functions extracted from the polling useEffect ───────────────────────

function hasActiveTasks(tasks: PromptTask[]): boolean {
  return tasks.some((t) => t.status === 'pending' || t.status === 'processing');
}

function hasActiveGens(project: Project): boolean {
  return project.screens.some((s) => {
    const g = s.latestGen;
    return g && (g.status === 'queued' || g.status === 'pending' || g.status === 'processing');
  });
}

function shouldPoll(tasks: PromptTask[], project: Project): boolean {
  return hasActiveTasks(tasks) || hasActiveGens(project);
}

type PollMode = 'none' | 'lightweight' | 'full';

function pollMode(tasks: PromptTask[], project: Project): PollMode {
  if (!shouldPoll(tasks, project)) return 'none';
  if (hasActiveGens(project)) return 'full';
  return 'lightweight';
}

function detectTransition(
  newTasks: PromptTask[],
  prevStatuses: Record<number, string>,
): boolean {
  return newTasks.some(
    (t) =>
      (t.status === 'completed' || t.status === 'failed') &&
      prevStatuses[t.id] !== undefined &&
      (prevStatuses[t.id] === 'pending' || prevStatuses[t.id] === 'processing'),
  );
}

function buildStatusMap(tasks: PromptTask[]): Record<number, string> {
  const map: Record<number, string> = {};
  for (const t of tasks) map[t.id] = t.status;
  return map;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const noGens: Project = { screens: [] };
function projectWith(gens: GenStatus[]): Project {
  return { screens: gens.map((s) => ({ latestGen: { status: s } })) };
}

// ── shouldPoll ────────────────────────────────────────────────────────────────

describe('shouldPoll', () => {
  it('returns false with no tasks and no gens', () => {
    expect(shouldPoll([], noGens)).toBe(false);
  });

  it('returns false when all tasks are terminal and no gens are active', () => {
    const tasks: PromptTask[] = [
      { id: 1, status: 'completed' },
      { id: 2, status: 'failed' },
    ];
    expect(shouldPoll(tasks, noGens)).toBe(false);
  });

  it('returns true when any task is pending', () => {
    expect(shouldPoll([{ id: 1, status: 'pending' }], noGens)).toBe(true);
  });

  it('returns true when any gen is active (queued)', () => {
    expect(shouldPoll([], projectWith(['queued']))).toBe(true);
  });

  it('polling stops exactly when the last active task completes and no gens are active', () => {
    const tasks: PromptTask[] = [{ id: 1, status: 'processing' }];
    expect(shouldPoll(tasks, noGens)).toBe(true);
    // Task completes:
    const after: PromptTask[] = [{ id: 1, status: 'completed' }];
    expect(shouldPoll(after, noGens)).toBe(false);
  });
});

// ── pollMode ──────────────────────────────────────────────────────────────────

describe('pollMode', () => {
  it('none when inactive', () => {
    expect(pollMode([], noGens)).toBe('none');
  });

  it('lightweight when only tasks are active (no gens)', () => {
    expect(pollMode([{ id: 1, status: 'pending' }], noGens)).toBe('lightweight');
  });

  it('full when any gen is active regardless of task state', () => {
    expect(pollMode([], projectWith(['processing']))).toBe('full');
  });

  it('full when both tasks and gens are active (gens take priority)', () => {
    expect(pollMode([{ id: 1, status: 'pending' }], projectWith(['pending']))).toBe('full');
  });

  it('generation polling continues independently even after all tasks complete', () => {
    const completedTasks: PromptTask[] = [{ id: 1, status: 'completed' }];
    expect(pollMode(completedTasks, projectWith(['queued']))).toBe('full');
  });

  it('switches from full to lightweight once all gens finish but tasks remain', () => {
    const activeTasks: PromptTask[] = [{ id: 1, status: 'processing' }];
    expect(pollMode(activeTasks, projectWith(['processing']))).toBe('full');
    // Gen finishes:
    expect(pollMode(activeTasks, projectWith(['completed']))).toBe('lightweight');
  });
});

// ── Task lifecycle scenarios ───────────────────────────────────────────────────

describe('Task completing between polling intervals', () => {
  it('transition detected when a task moves from pending to completed', () => {
    const prev = buildStatusMap([{ id: 1, status: 'pending' }]);
    const tick1: PromptTask[] = [{ id: 1, status: 'completed' }];
    expect(detectTransition(tick1, prev)).toBe(true);
  });

  it('transition detected when a task moves from processing to completed', () => {
    const prev = buildStatusMap([{ id: 1, status: 'processing' }]);
    const tick1: PromptTask[] = [{ id: 1, status: 'completed' }];
    expect(detectTransition(tick1, prev)).toBe(true);
  });

  it('no transition when task stays in pending', () => {
    const prev = buildStatusMap([{ id: 1, status: 'pending' }]);
    expect(detectTransition([{ id: 1, status: 'pending' }], prev)).toBe(false);
  });
});

describe('Multiple tasks completing in succession', () => {
  it('transition triggers on first completion even if another task is still active', () => {
    const prev = buildStatusMap([
      { id: 1, status: 'processing' },
      { id: 2, status: 'pending' },
    ]);
    const tick: PromptTask[] = [
      { id: 1, status: 'completed' }, // just finished
      { id: 2, status: 'pending' },   // still active
    ];
    expect(detectTransition(tick, prev)).toBe(true);
    expect(hasActiveTasks(tick)).toBe(true); // still polling
  });

  it('transition triggers again on second task completion', () => {
    const prev = buildStatusMap([
      { id: 1, status: 'completed' },
      { id: 2, status: 'pending' },
    ]);
    const tick: PromptTask[] = [
      { id: 1, status: 'completed' },
      { id: 2, status: 'completed' }, // now finishes
    ];
    expect(detectTransition(tick, prev)).toBe(true);
    expect(hasActiveTasks(tick)).toBe(false); // polling stops after this
  });

  it('no transition when both tasks were already completed last tick', () => {
    const prev = buildStatusMap([
      { id: 1, status: 'completed' },
      { id: 2, status: 'completed' },
    ]);
    const tick: PromptTask[] = [
      { id: 1, status: 'completed' },
      { id: 2, status: 'completed' },
    ];
    expect(detectTransition(tick, prev)).toBe(false);
  });
});

describe('Newly appearing tasks (not in prevStatuses)', () => {
  it('a brand-new task appearing as completed does NOT trigger a transition', () => {
    // This prevents spurious full-project fetches for tasks that completed before
    // the first poll tick initialised prevStatuses.
    const prev: Record<number, string> = {}; // first tick — empty
    const tick: PromptTask[] = [{ id: 99, status: 'completed' }];
    expect(detectTransition(tick, prev)).toBe(false);
  });

  it('a new task appearing as pending is active but not a transition', () => {
    const prev: Record<number, string> = {};
    const tick: PromptTask[] = [{ id: 5, status: 'pending' }];
    expect(detectTransition(tick, prev)).toBe(false);
    expect(hasActiveTasks(tick)).toBe(true);
  });
});

describe('Failed tasks', () => {
  it('a task moving from pending to failed triggers a transition', () => {
    const prev = buildStatusMap([{ id: 1, status: 'pending' }]);
    expect(detectTransition([{ id: 1, status: 'failed' }], prev)).toBe(true);
  });

  it('a task moving from processing to failed triggers a transition', () => {
    const prev = buildStatusMap([{ id: 1, status: 'processing' }]);
    expect(detectTransition([{ id: 1, status: 'failed' }], prev)).toBe(true);
  });

  it('a failed task does not trigger a transition if it was already failed', () => {
    const prev = buildStatusMap([{ id: 1, status: 'failed' }]);
    expect(detectTransition([{ id: 1, status: 'failed' }], prev)).toBe(false);
  });

  it('polling stops after all tasks fail', () => {
    const tasks: PromptTask[] = [{ id: 1, status: 'failed' }];
    expect(shouldPoll(tasks, noGens)).toBe(false);
  });
});

describe('Generation polling continues independently', () => {
  it('when only gens are active, pollMode is full regardless of task state', () => {
    expect(pollMode([], projectWith(['processing']))).toBe('full');
    expect(pollMode([{ id: 1, status: 'completed' }], projectWith(['queued']))).toBe('full');
    expect(pollMode([{ id: 1, status: 'failed' }], projectWith(['pending']))).toBe('full');
  });

  it('when all three gen statuses are active, all require full polling', () => {
    for (const s of ['queued', 'pending', 'processing'] as GenStatus[]) {
      expect(pollMode([], projectWith([s]))).toBe('full');
    }
  });

  it('completed and failed gens do NOT keep polling alive', () => {
    expect(shouldPoll([], projectWith(['completed']))).toBe(false);
    expect(shouldPoll([], projectWith(['failed']))).toBe(false);
  });

  it('a mix of active and finished gens keeps full polling alive', () => {
    const project: Project = {
      screens: [
        { latestGen: { status: 'completed' } },
        { latestGen: { status: 'processing' } }, // still active
      ],
    };
    expect(pollMode([], project)).toBe('full');
  });
});

describe('No unnecessary full-project requests during prompt generation', () => {
  it('lightweight path: does not trigger full-project fetch while tasks are still active', () => {
    const tasks: PromptTask[] = [
      { id: 1, status: 'processing' },
      { id: 2, status: 'pending' },
    ];
    const prev = buildStatusMap(tasks);
    // After one tick with no status change:
    const tick: PromptTask[] = [
      { id: 1, status: 'processing' },
      { id: 2, status: 'pending' },
    ];
    expect(pollMode(tick, noGens)).toBe('lightweight');
    expect(detectTransition(tick, prev)).toBe(false); // no full-project fetch
  });

  it('full-project fetch happens ONLY on a detected transition', () => {
    const tasks: PromptTask[] = [{ id: 1, status: 'processing' }];
    const prev = buildStatusMap(tasks);

    // Tick 1: no change → lightweight, no full fetch
    const tick1: PromptTask[] = [{ id: 1, status: 'processing' }];
    expect(detectTransition(tick1, prev)).toBe(false);

    // Tick 2: task completes → lightweight, WITH full fetch
    const tick2: PromptTask[] = [{ id: 1, status: 'completed' }];
    expect(pollMode(tick2, noGens)).toBe('none'); // polling stops
    expect(detectTransition(tick2, prev)).toBe(true); // full fetch was triggered
  });
});
