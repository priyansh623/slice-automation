import { and, eq, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { brollClipBrands, brollClipCategories, brollClips } from '../db/schema.pg';

// Three independent concepts decide how a clip is treated:
//   classification  derived: a clip is classified once it has at least one category
//   review          broll_clips.review_status (unreviewed, approved, rejected, on_hold, archived)
//   clearance       broll_clips.clearance_status plus the clearance of each brand association
//
// Library visibility depends on classification and review only. Being visible never means a
// clip is cleared. A clip is usable only when all four of these hold:
//   1. it is classified
//   2. its review status is not on_hold, archived or rejected
//   3. its clip-level clearance is 'cleared'
//   4. every brand association on it is 'cleared'

// Review statuses that keep a clip out of the active B-roll library.
// The record and its storage object are left untouched.
export const HIDDEN_BROLL_REVIEW_STATUSES = ['on_hold', 'archived', 'rejected'];

// Statuses an admin has closed out. The unclassified management view hides these unless asked.
export const CLOSED_BROLL_REVIEW_STATUSES = ['archived', 'rejected'];

export const BROLL_CLEARANCE_STATUSES = ['unresolved', 'cleared', 'not_cleared'] as const;
export type BrollClearanceStatus = (typeof BROLL_CLEARANCE_STATUSES)[number];

export function isBrollClearanceStatus(value: unknown): value is BrollClearanceStatus {
  return typeof value === 'string' && (BROLL_CLEARANCE_STATUSES as readonly string[]).includes(value);
}

export type BrollClassificationStatus = 'classified' | 'unclassified';

export function brollClassificationStatus(categoryCount: number): BrollClassificationStatus {
  return categoryCount > 0 ? 'classified' : 'unclassified';
}

export function isInActiveBrollLibrary(reviewStatus: string, categoryCount: number): boolean {
  return categoryCount > 0 && !HIDDEN_BROLL_REVIEW_STATUSES.includes(reviewStatus);
}

// The clearance of a clip once its brands are taken into account:
//   not_cleared  the clip, or any brand on it, is not cleared
//   cleared      the clip and every brand on it are cleared
//   unresolved   anything else, including a clip with a cleared clip-level status but an unresolved brand
// A clip with no brand associations is judged on its own clearance. Unknown values never count as cleared.
export function effectiveClearance(clipStatus: string, brandStatuses: readonly string[]): BrollClearanceStatus {
  if (clipStatus === 'not_cleared' || brandStatuses.includes('not_cleared')) return 'not_cleared';
  if (clipStatus === 'cleared' && brandStatuses.every((s) => s === 'cleared')) return 'cleared';
  return 'unresolved';
}

export interface UsabilityInput {
  reviewStatus: string;
  categoryCount: number;
  clearanceStatus: string;
  brandClearanceStatuses: readonly string[];
}

// True only when the footage is classified, not on hold, archived or rejected, and cleared at
// both clip and brand level. Unresolved clearance is never permission to use footage.
export function isUsableFootage(input: UsabilityInput): boolean {
  return isInActiveBrollLibrary(input.reviewStatus, input.categoryCount)
    && effectiveClearance(input.clearanceStatus, input.brandClearanceStatuses) === 'cleared';
}

// SQL form of isInActiveBrollLibrary, for queries over broll_clips.
export function activeBrollLibraryCondition(): SQL {
  return and(
    notInArray(brollClips.reviewStatus, HIDDEN_BROLL_REVIEW_STATUSES),
    sql`exists (select 1 from ${brollClipCategories} where ${brollClipCategories.clipId} = ${brollClips.id})`,
  )!;
}

const brandNotCleared = () =>
  sql`exists (select 1 from ${brollClipBrands} where ${brollClipBrands.clipId} = ${brollClips.id} and ${brollClipBrands.clearanceStatus} = 'not_cleared')`;
const brandNotAllCleared = () =>
  sql`exists (select 1 from ${brollClipBrands} where ${brollClipBrands.clipId} = ${brollClips.id} and ${brollClipBrands.clearanceStatus} <> 'cleared')`;

// SQL form of effectiveClearance(). Does not check visibility; combine with activeBrollLibraryCondition().
export function effectiveClearanceCondition(status: BrollClearanceStatus): SQL {
  const notCleared = or(eq(brollClips.clearanceStatus, 'not_cleared'), brandNotCleared())!;
  const cleared = and(eq(brollClips.clearanceStatus, 'cleared'), sql`not ${brandNotAllCleared()}`)!;
  if (status === 'not_cleared') return notCleared;
  if (status === 'cleared') return and(cleared, sql`not ${brandNotCleared()}`)!;
  return and(sql`not (${notCleared})`, sql`not (${cleared})`)!;
}

// SQL form of isUsableFootage(): the clips a search for cleared footage may return.
export function usableBrollCondition(): SQL {
  return and(activeBrollLibraryCondition(), effectiveClearanceCondition('cleared'))!;
}

// Clips with no category. Used by the admin management view, never by the library.
export function unclassifiedBrollCondition(): SQL {
  return sql`not exists (select 1 from ${brollClipCategories} where ${brollClipCategories.clipId} = ${brollClips.id})`;
}
