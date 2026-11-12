import { describe, it, expect } from 'vitest';
import {
  ACTIVE_BROLL_REVIEW_STATUS,
  brollClassificationStatus,
  CLOSED_BROLL_REVIEW_STATUSES,
  HIDDEN_BROLL_REVIEW_STATUSES,
  isInActiveBrollLibrary,
} from '@/lib/broll-visibility';

describe('shared B-roll library visibility', () => {
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

  it('restores a held or archived clip to a status that is visible', () => {
    expect(HIDDEN_BROLL_REVIEW_STATUSES).not.toContain(ACTIVE_BROLL_REVIEW_STATUS);
    expect(isInActiveBrollLibrary(ACTIVE_BROLL_REVIEW_STATUS, 1)).toBe(true);
  });

  it('treats archived and rejected as closed out, and on hold as still open', () => {
    expect(CLOSED_BROLL_REVIEW_STATUSES).toEqual(['archived', 'rejected']);
    expect(CLOSED_BROLL_REVIEW_STATUSES).not.toContain('on_hold');
  });
});
