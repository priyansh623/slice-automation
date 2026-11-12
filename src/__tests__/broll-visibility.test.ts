import { describe, it, expect } from 'vitest';
import {
  brollClassificationStatus,
  effectiveClearance,
  isBrollClearanceStatus,
  isInActiveBrollLibrary,
  isUsableFootage,
  type UsabilityInput,
} from '@/lib/broll-visibility';

describe('B-roll active library visibility', () => {
  it('hides an unclassified clip whatever its review status', () => {
    for (const status of ['unreviewed', 'approved']) {
      expect(isInActiveBrollLibrary(status, 0)).toBe(false);
    }
  });

  it('shows a classified clip that is unreviewed or approved', () => {
    expect(isInActiveBrollLibrary('unreviewed', 1)).toBe(true);
    expect(isInActiveBrollLibrary('approved', 3)).toBe(true);
  });

  it('hides on-hold, archived and rejected clips even when classified', () => {
    for (const status of ['on_hold', 'archived', 'rejected']) {
      expect(isInActiveBrollLibrary(status, 2)).toBe(false);
    }
  });

  it('derives classification from category count alone', () => {
    expect(brollClassificationStatus(0)).toBe('unclassified');
    expect(brollClassificationStatus(1)).toBe('classified');
  });
});

describe('B-roll clearance', () => {
  it('recognises exactly the three clearance statuses', () => {
    for (const status of ['unresolved', 'cleared', 'not_cleared']) expect(isBrollClearanceStatus(status)).toBe(true);
    for (const status of ['approved', 'Cleared', '', null, undefined, 1]) expect(isBrollClearanceStatus(status)).toBe(false);
  });

  it('decides library visibility without reading clearance', () => {
    // isInActiveBrollLibrary has no clearance input, so every clearance status gets the same answer.
    expect(isInActiveBrollLibrary('unreviewed', 1)).toBe(true);
  });
});

describe('effectiveClearance', () => {
  it('is cleared only when the clip and every brand are cleared', () => {
    expect(effectiveClearance('cleared', [])).toBe('cleared');
    expect(effectiveClearance('cleared', ['cleared', 'cleared'])).toBe('cleared');
  });

  it('is unresolved when the clip or any brand is unresolved, and never cleared by default', () => {
    expect(effectiveClearance('unresolved', [])).toBe('unresolved');
    expect(effectiveClearance('unresolved', ['cleared'])).toBe('unresolved');
    expect(effectiveClearance('cleared', ['cleared', 'unresolved'])).toBe('unresolved');
  });

  it('is not_cleared when the clip or any brand is not cleared, even if the rest are cleared', () => {
    expect(effectiveClearance('not_cleared', [])).toBe('not_cleared');
    expect(effectiveClearance('not_cleared', ['cleared'])).toBe('not_cleared');
    expect(effectiveClearance('cleared', ['cleared', 'not_cleared'])).toBe('not_cleared');
    expect(effectiveClearance('unresolved', ['not_cleared', 'unresolved'])).toBe('not_cleared');
  });

  it('never treats an unknown value as cleared', () => {
    expect(effectiveClearance('approved', [])).toBe('unresolved');
    expect(effectiveClearance('cleared', ['approved'])).toBe('unresolved');
  });
});

describe('isUsableFootage', () => {
  const usable: UsabilityInput = { reviewStatus: 'unreviewed', categoryCount: 2, clearanceStatus: 'cleared', brandClearanceStatuses: ['cleared'] };

  it('is true when classified, not hidden, and cleared at clip and brand level', () => {
    expect(isUsableFootage(usable)).toBe(true);
    expect(isUsableFootage({ ...usable, reviewStatus: 'approved', brandClearanceStatuses: [] })).toBe(true);
  });

  it('is false for an unclassified clip', () => {
    expect(isUsableFootage({ ...usable, categoryCount: 0 })).toBe(false);
  });

  it('is false while the clip is on hold, archived or rejected', () => {
    for (const reviewStatus of ['on_hold', 'archived', 'rejected']) expect(isUsableFootage({ ...usable, reviewStatus })).toBe(false);
  });

  it('is false unless the clip itself is cleared', () => {
    for (const clearanceStatus of ['unresolved', 'not_cleared']) expect(isUsableFootage({ ...usable, clearanceStatus })).toBe(false);
  });

  it('is false if even one brand is unresolved or not cleared', () => {
    expect(isUsableFootage({ ...usable, brandClearanceStatuses: ['cleared', 'unresolved'] })).toBe(false);
    expect(isUsableFootage({ ...usable, brandClearanceStatuses: ['cleared', 'not_cleared'] })).toBe(false);
  });
});
