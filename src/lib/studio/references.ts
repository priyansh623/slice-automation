/**
 * Whether anything in the Studio still points at a stored file. A file may only be removed from R2 when nothing does: this is the
 * one guard in front of every deletion, so a registered original (a pack image, a project's character image, an output, or an
 * image a job or batch used) can never be deleted by a failed or repeated upload request.
 */
import { eq, or } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssets, studioBatches, studioJobs, studioOutputs, studioProjects } from '@/db/schema.pg';
import { getStorage } from '@/lib/object-store';

export async function isKeyReferenced(key: string): Promise<boolean> {
  const checks = [
    db.select({ id: studioAssets.id }).from(studioAssets).where(or(eq(studioAssets.storageKey, key), eq(studioAssets.thumbKey, key))).limit(1),
    db.select({ id: studioProjects.id }).from(studioProjects).where(eq(studioProjects.characterKey, key)).limit(1),
    db.select({ id: studioBatches.id }).from(studioBatches).where(eq(studioBatches.characterKey, key)).limit(1),
    db.select({ id: studioJobs.id }).from(studioJobs).where(or(eq(studioJobs.sourceKey, key), eq(studioJobs.characterKey, key))).limit(1),
    db.select({ id: studioOutputs.id }).from(studioOutputs).where(or(eq(studioOutputs.storageKey, key), eq(studioOutputs.thumbKey, key))).limit(1),
  ];
  for (const rows of await Promise.all(checks)) if (rows.length > 0) return true;
  return false;
}

/**
 * Removes a file from R2 only if nothing references it (an upload that was rejected, or an extra copy of an image the pack
 * already holds). Returns whether it was removed. A referenced file is never touched, whatever the caller asked for.
 */
export async function discardIfUnreferenced(key: string): Promise<boolean> {
  if (await isKeyReferenced(key)) return false;
  try {
    await getStorage().deleteFromR2('uploads', key);
    return true;
  } catch (err) {
    console.warn('[studio] could not remove an unusable upload:', (err as Error).message.slice(0, 120));
    return false;
  }
}
