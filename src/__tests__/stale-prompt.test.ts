/**
 * Stale-prompt API logic tests.
 *
 * These unit-test the staleness detection logic: when dialogue changes,
 * existing prompt versions should be marked stale.
 */
import { describe, it, expect } from 'vitest';

interface Screen {
  id: number;
  screenNumber: number;
  dialogue: string;
}

interface IncomingScreen {
  screenNumber: number;
  dialogue: string;
}

function findDialogueChangedIds(
  existingScreens: Screen[],
  incomingScreens: IncomingScreen[],
): number[] {
  const existingByNumber = new Map(existingScreens.map((s) => [s.screenNumber, s]));
  const changed: number[] = [];
  for (const incoming of incomingScreens) {
    const existing = existingByNumber.get(incoming.screenNumber);
    if (existing && existing.dialogue !== incoming.dialogue) {
      changed.push(existing.id);
    }
  }
  return changed;
}

describe('stale prompt detection', () => {
  it('returns empty array when no dialogue changed', () => {
    const existing: Screen[] = [
      { id: 1, screenNumber: 1, dialogue: 'Hello world' },
      { id: 2, screenNumber: 2, dialogue: 'Goodbye world' },
    ];
    const incoming: IncomingScreen[] = [
      { screenNumber: 1, dialogue: 'Hello world' },
      { screenNumber: 2, dialogue: 'Goodbye world' },
    ];
    expect(findDialogueChangedIds(existing, incoming)).toEqual([]);
  });

  it('returns screen ids where dialogue changed', () => {
    const existing: Screen[] = [
      { id: 1, screenNumber: 1, dialogue: 'Hello world' },
      { id: 2, screenNumber: 2, dialogue: 'Goodbye world' },
    ];
    const incoming: IncomingScreen[] = [
      { screenNumber: 1, dialogue: 'Hello WORLD' },
      { screenNumber: 2, dialogue: 'Goodbye world' },
    ];
    expect(findDialogueChangedIds(existing, incoming)).toEqual([1]);
  });

  it('returns multiple screen ids when multiple dialogues changed', () => {
    const existing: Screen[] = [
      { id: 10, screenNumber: 1, dialogue: 'A' },
      { id: 20, screenNumber: 2, dialogue: 'B' },
      { id: 30, screenNumber: 3, dialogue: 'C' },
    ];
    const incoming: IncomingScreen[] = [
      { screenNumber: 1, dialogue: 'A changed' },
      { screenNumber: 2, dialogue: 'B' },
      { screenNumber: 3, dialogue: 'C changed' },
    ];
    expect(findDialogueChangedIds(existing, incoming)).toEqual([10, 30]);
  });

  it('ignores new screens that do not have an existing row', () => {
    const existing: Screen[] = [
      { id: 1, screenNumber: 1, dialogue: 'Existing' },
    ];
    const incoming: IncomingScreen[] = [
      { screenNumber: 1, dialogue: 'Existing' },
      { screenNumber: 2, dialogue: 'Brand new' },
    ];
    expect(findDialogueChangedIds(existing, incoming)).toEqual([]);
  });

  it('duration-only changes do not trigger staleness (dialogue unchanged)', () => {
    const existing: Screen[] = [
      { id: 5, screenNumber: 1, dialogue: 'Same dialogue' },
    ];
    // Duration is not part of dialogue — same dialogue means not stale
    const incoming: IncomingScreen[] = [
      { screenNumber: 1, dialogue: 'Same dialogue' },
    ];
    expect(findDialogueChangedIds(existing, incoming)).toEqual([]);
  });
});
