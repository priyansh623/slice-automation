/**
 * Library filters, kept apart from search so they stay strict: a search ranks and drops clips from the list the
 * filters leave, it never brings a filtered-out clip back.
 */
import type { SearchClip } from './broll-search';

export interface FilterableClip extends SearchClip {
  subject?: string | null;
  activity?: string | null;
  setting?: string | null;
  brand?: string | null;
}

export type MetadataField = 'userTags' | 'subject' | 'activity' | 'setting' | 'brand';

export function parseClipTags(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

/**
 * @param metadata selected metadata filters (an empty value means "not selected")
 * @param activeCategoryIds ids a clip must be in (any of); null means no category filter is selected
 */
export function applyLibraryFilters<T extends FilterableClip>(
  clips: T[],
  metadata: Partial<Record<MetadataField, string>>,
  activeCategoryIds: Set<number> | null,
): T[] {
  return clips.filter((c) => {
    for (const [field, value] of Object.entries(metadata) as [MetadataField, string | undefined][]) {
      if (!value) continue;
      if (field === 'userTags') {
        if (!parseClipTags(c.userTags).includes(value)) return false;
      } else if (c[field] !== value) {
        return false;
      }
    }
    if (activeCategoryIds !== null && !(c.categoryIds ?? []).some((id) => activeCategoryIds.has(id))) return false;
    return true;
  });
}
