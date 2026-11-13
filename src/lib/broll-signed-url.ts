import { getStorage } from '@/lib/object-store';
import { locate } from '@/lib/object-store/registry';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';

const ONE_HOUR_MS = 3_600_000;
export const BROLL_URL_TTL_S = 24 * 3600;

// Creates a fresh signed URL for a stored clip, or null if the storage service cannot provide one.
// Storage calls have no timeout of their own. One stalled call must not hold up the whole library, so every
// refresh gives up after this long and the clip keeps the URL it already has.
export const REFRESH_TIMEOUT_MS = 4000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

export async function refreshSignedUrl(storagePath: string, timeoutMs = REFRESH_TIMEOUT_MS): Promise<{ url: string; expiresAt: number } | null> {
  if (!storagePath) return null;
  return withTimeout(createFreshUrl(storagePath), timeoutMs);
}

async function createFreshUrl(storagePath: string): Promise<{ url: string; expiresAt: number } | null> {
  try {
    const url = await getStorage().signedReadUrl('uploads', storagePath, BROLL_URL_TTL_S);
    if (!url) return null;
    return { url, expiresAt: Date.now() + BROLL_URL_TTL_S * 1000 };
  } catch {
    return null;
  }
}

// Returns the clip's signed URL, refreshing and storing a new one when it is missing or about to expire.
export async function currentSignedUrl(
  clip: { id: number; storagePath: string; signedUrl: string | null; signedUrlExpiresAt: number | null },
  timeoutMs = REFRESH_TIMEOUT_MS,
): Promise<string | null> {
  const now = Date.now();
  // A clip stored on R2 never uses the saved URL: signing there is local and instant, and a saved URL may still point
  // at the old Supabase copy (which would keep costing Supabase egress).
  const onR2 = (await locate('uploads', [clip.storagePath]).catch(() => new Map())).get(clip.storagePath) === 'r2';
  if (!onR2 && clip.signedUrl && clip.signedUrlExpiresAt && clip.signedUrlExpiresAt >= now + ONE_HOUR_MS) return clip.signedUrl;
  const fresh = await refreshSignedUrl(clip.storagePath, timeoutMs);
  if (!fresh) return clip.signedUrl;
  if (onR2) return fresh.url;
  // Saving the new URL is a convenience for the next request; failing or stalling here must not fail this one.
  await withTimeout(
    Promise.resolve(db.update(brollClips).set({ signedUrl: fresh.url, signedUrlExpiresAt: fresh.expiresAt, updatedAt: now }).where(eq(brollClips.id, clip.id))),
    timeoutMs,
  );
  return fresh.url;
}
