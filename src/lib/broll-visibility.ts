import { and, notInArray, sql, type SQL } from 'drizzle-orm';
import { brollClipCategories, brollClips } from '../db/schema.pg';

// The shared B-roll library is one library for everyone. A clip is in it when
//   1. it is classified: it has at least one category, and
//   2. its review status is not on_hold, archived or rejected.
// Nothing else affects visibility: there is no clearance or approval step, and the viewer's role never
// changes which clips are in the library (administrators additionally manage clips that are not in it).

// Review statuses that keep a clip out of the library. The record and its storage object are left untouched.
//   on_hold    parked by an admin; returns when released
//   archived   retired by an admin; returns when restored
//   rejected   kept for history from before the library was simplified
export const HIDDEN_BROLL_REVIEW_STATUSES = ['on_hold', 'archived', 'rejected'];

// Statuses an admin has closed out. The unclassified management view hides these unless asked.
export const CLOSED_BROLL_REVIEW_STATUSES = ['archived', 'rejected'];

// The status a clip returns to when an admin restores it from on hold or archived.
export const ACTIVE_BROLL_REVIEW_STATUS = 'unreviewed';

export type BrollClassificationStatus = 'classified' | 'unclassified';

export function brollClassificationStatus(categoryCount: number): BrollClassificationStatus {
  return categoryCount > 0 ? 'classified' : 'unclassified';
}

export function isInActiveBrollLibrary(reviewStatus: string, categoryCount: number): boolean {
  return categoryCount > 0 && !HIDDEN_BROLL_REVIEW_STATUSES.includes(reviewStatus);
}

// SQL form of isInActiveBrollLibrary, for queries over broll_clips.
export function activeBrollLibraryCondition(): SQL {
  return and(
    notInArray(brollClips.reviewStatus, HIDDEN_BROLL_REVIEW_STATUSES),
    sql`exists (select 1 from ${brollClipCategories} where ${brollClipCategories.clipId} = ${brollClips.id})`,
  )!;
}

// Clips with no category. Used by the admin management view, never by the library.
export function unclassifiedBrollCondition(): SQL {
  return sql`not exists (select 1 from ${brollClipCategories} where ${brollClipCategories.clipId} = ${brollClips.id})`;
}
