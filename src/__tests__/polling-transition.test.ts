/**
 * Polling transition detection tests.
 *
 * Tests the logic that determines whether the project page should:
 *   (a) skip the full project fetch (only tasks active, no transition yet), or
 *   (b) fetch the full project (a task just completed/failed, or gens are active).
 *
 * This logic lives in the polling useEffect in [id]/page.tsx and is extracted
 * here as pure functions for unit testing.
 */
import { describe, it, expect } from 'vitest';

type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface PromptTask {
  id: number;
  status: TaskStatus;
}

function hasActiveTasks(tasks: PromptTask[]): boolean {
  return tasks.some((t) => t.status === 'pending' || t.status === 'processing');
}

/** Detects whether any task transitioned from active → terminal since last check. */
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

/** Builds a status map from a task list (for prevTaskStatusesRef). */
function buildStatusMap(tasks: PromptTask[]): Record<number, string> {
  const map: Record<number, string> = {};
  for (const t of tasks) map[t.id] = t.status;
  return map;
}

describe('hasActiveTasks', () => {
  it('returns true when at least one task is pending', () => {
    expect(hasActiveTasks([{ id: 1, status: 'pending' }])).toBe(true);
  });

  it('returns true when at least one task is processing', () => {
    expect(hasActiveTasks([{ id: 1, status: 'processing' }])).toBe(true);
  });

  it('returns false when all tasks are terminal', () => {
    expect(hasActiveTasks([
      { id: 1, status: 'completed' },
      { id: 2, status: 'failed' },
    ])).toBe(false);
  });

  it('returns false for an empty task list', () => {
    expect(hasActiveTasks([])).toBe(false);
  });
});

describe('detectTransition', () => {
  it('detects pending → completed transition', () => {
    const prev = buildStatusMap([{ id: 1, status: 'pending' }]);
    const newTasks: PromptTask[] = [{ id: 1, status: 'completed' }];
    expect(detectTransition(newTasks, prev)).toBe(true);
  });

  it('detects processing → completed transition', () => {
    const prev = buildStatusMap([{ id: 1, status: 'processing' }]);
    const newTasks: PromptTask[] = [{ id: 1, status: 'completed' }];
    expect(detectTransition(newTasks, prev)).toBe(true);
  });

  it('detects pending → failed transition', () => {
    const prev = buildStatusMap([{ id: 1, status: 'pending' }]);
    const newTasks: PromptTask[] = [{ id: 1, status: 'failed' }];
    expect(detectTransition(newTasks, prev)).toBe(true);
  });

  it('does not trigger when task stays pending', () => {
    const prev = buildStatusMap([{ id: 1, status: 'pending' }]);
    const newTasks: PromptTask[] = [{ id: 1, status: 'pending' }];
    expect(detectTransition(newTasks, prev)).toBe(false);
  });

  it('does not trigger when task stays processing', () => {
    const prev = buildStatusMap([{ id: 1, status: 'processing' }]);
    const newTasks: PromptTask[] = [{ id: 1, status: 'processing' }];
    expect(detectTransition(newTasks, prev)).toBe(false);
  });

  it('does not trigger when prev is empty (first poll cycle)', () => {
    const prev: Record<number, string> = {};
    const newTasks: PromptTask[] = [{ id: 1, status: 'completed' }];
    expect(detectTransition(newTasks, prev)).toBe(false);
  });

  it('detects one transition among multiple tasks', () => {
    const prev = buildStatusMap([
      { id: 1, status: 'processing' },
      { id: 2, status: 'pending' },
    ]);
    const newTasks: PromptTask[] = [
      { id: 1, status: 'processing' }, // still active
      { id: 2, status: 'completed' },  // just finished
    ];
    expect(detectTransition(newTasks, prev)).toBe(true);
  });

  it('does not trigger for completed → completed (already terminal)', () => {
    const prev = buildStatusMap([{ id: 1, status: 'completed' }]);
    const newTasks: PromptTask[] = [{ id: 1, status: 'completed' }];
    expect(detectTransition(newTasks, prev)).toBe(false);
  });
});

describe('buildStatusMap', () => {
  it('maps task id to status', () => {
    const tasks: PromptTask[] = [
      { id: 1, status: 'pending' },
      { id: 2, status: 'processing' },
    ];
    const map = buildStatusMap(tasks);
    expect(map[1]).toBe('pending');
    expect(map[2]).toBe('processing');
  });

  it('returns empty map for empty task list', () => {
    expect(buildStatusMap([])).toEqual({});
  });
});
