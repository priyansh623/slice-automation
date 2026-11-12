import type { brollClips } from '@/db/schema.pg';
import type { ApiBrandAssociation } from './broll-brands';
import { brollClassificationStatus } from './broll-visibility';

// One shared library, one kind of user. Every signed-in user receives the same, complete representation of a clip
// and can use every library action (upload, edit, classify, archive, restore, delete, trim, download).

type ClipRow = typeof brollClips.$inferSelect;

export function clipForViewer(
  clip: ClipRow,
  extras: { categoryIds?: number[]; categoryCount: number; brands: ApiBrandAssociation[]; signedUrl: string | null },
) {
  return {
    ...clip,
    signedUrl: extras.signedUrl,
    ...(extras.categoryIds ? { categoryIds: extras.categoryIds } : {}),
    classificationStatus: brollClassificationStatus(extras.categoryCount),
    brands: extras.brands,
  };
}
