/**
 * Breakdown rollback tests.
 *
 * These test the V7-corrected BreakdownBlockedError logic:
 * - Two independent boolean queries (prompt versions + generations)
 * - Either being true → 409
 * - Neither true → proceed
 */
import { describe, it, expect } from 'vitest';

class BreakdownBlockedError extends Error {
  screenNumbers: number[];
  constructor(screenNumbers: number[]) {
    super(`Cannot remove screens with existing history: ${screenNumbers.join(', ')}`);
    this.name = 'BreakdownBlockedError';
    this.screenNumbers = screenNumbers;
  }
}

function checkRollback(
  removedScreenIds: number[],
  hasPromptVersions: boolean,
  hasGenerations: boolean,
): { blocked: true; error: BreakdownBlockedError } | { blocked: false } {
  if (removedScreenIds.length === 0) return { blocked: false };
  if (hasPromptVersions || hasGenerations) {
    return { blocked: true, error: new BreakdownBlockedError(removedScreenIds) };
  }
  return { blocked: false };
}

describe('BreakdownBlockedError rollback logic', () => {
  it('blocks when only prompt versions exist', () => {
    const result = checkRollback([3], true, false);
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.error).toBeInstanceOf(BreakdownBlockedError);
      expect(result.error.screenNumbers).toContain(3);
    }
  });

  it('blocks when only generations exist', () => {
    const result = checkRollback([7], false, true);
    expect(result.blocked).toBe(true);
  });

  it('blocks when both prompt versions and generations exist', () => {
    const result = checkRollback([1, 2], true, true);
    expect(result.blocked).toBe(true);
  });

  it('does not block when neither prompt versions nor generations exist', () => {
    const result = checkRollback([4], false, false);
    expect(result.blocked).toBe(false);
  });

  it('does not block when no screens are being removed', () => {
    const result = checkRollback([], true, true);
    expect(result.blocked).toBe(false);
  });

  it('includes all removed screen numbers in the error', () => {
    const result = checkRollback([2, 5, 9], true, false);
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.error.screenNumbers).toEqual([2, 5, 9]);
    }
  });

  it('BreakdownBlockedError has correct name and message', () => {
    const err = new BreakdownBlockedError([1, 3]);
    expect(err.name).toBe('BreakdownBlockedError');
    expect(err.message).toContain('1, 3');
    expect(err).toBeInstanceOf(Error);
  });
});
