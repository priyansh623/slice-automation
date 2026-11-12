import type { brollClips } from '@/db/schema.pg';
import type { ApiBrandAssociation } from './broll-brands';
import { brollClassificationStatus } from './broll-visibility';

// One shared library, two kinds of viewer. Administrators and everyone else see the same clips; the only
// difference is how much of each clip they receive. Internal data is not sent to non-admins: the classifier's
// and reviewers' notes, the uploader's id, who reviewed a clip, storage paths and processing internals.

type ClipRow = typeof brollClips.$inferSelect;

const ADMIN_ONLY_CLIP_FIELDS = [
  'notes', 'userId', 'reviewedBy', 'reviewedAt', 'storagePath', 'thumbnailStoragePath', 'processingError', 'claimedAt',
] as const;

export function stripAdminOnlyClipFields<T extends Record<string, unknown>>(clip: T): Omit<T, (typeof ADMIN_ONLY_CLIP_FIELDS)[number]> {
  const out: Record<string, unknown> = { ...clip };
  for (const field of ADMIN_ONLY_CLIP_FIELDS) delete out[field];
  return out as Omit<T, (typeof ADMIN_ONLY_CLIP_FIELDS)[number]>;
}

// Brand names and roles help everyone find footage. Unnamed observations and the notes about them are
// internal, so non-admins only receive named brands, without notes.
export function publicBrands(brands: ApiBrandAssociation[]) {
  return brands.filter((b) => b.brandName !== null).map((b) => ({ brandName: b.brandName, role: b.role }));
}

// Builds the API representation of a clip for the viewer.
export function clipForViewer(
  clip: ClipRow,
  extras: { categoryIds?: number[]; categoryCount: number; brands: ApiBrandAssociation[]; signedUrl: string | null },
  isAdmin: boolean,
) {
  const base = {
    ...clip,
    signedUrl: extras.signedUrl,
    ...(extras.categoryIds ? { categoryIds: extras.categoryIds } : {}),
    classificationStatus: brollClassificationStatus(extras.categoryCount),
  };
  if (isAdmin) return { ...base, brands: extras.brands };
  return { ...stripAdminOnlyClipFields(base), brands: publicBrands(extras.brands) };
}

// Only administrators change the library: upload, edit, classify, archive, restore and delete. Other users
// browse, search, preview, trim and download. Owning an upload gives no extra rights.
export function canManageClip(isAdmin: boolean): boolean {
  return isAdmin;
}
