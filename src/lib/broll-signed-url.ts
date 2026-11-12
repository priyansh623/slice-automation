import { createClient as createServiceClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';

const ONE_HOUR_MS = 3_600_000;
export const BROLL_URL_TTL_S = 24 * 3600;

// Creates a fresh signed URL for a stored clip, or null if the storage service cannot provide one.
export async function refreshSignedUrl(storagePath: string): Promise<{ url: string; expiresAt: number } | null> {
  if (!storagePath) return null;
  try {
    const service = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const bucket = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';
    const { data } = await service.storage.from(bucket).createSignedUrl(storagePath, BROLL_URL_TTL_S);
    if (!data?.signedUrl) return null;
    return { url: data.signedUrl, expiresAt: Date.now() + BROLL_URL_TTL_S * 1000 };
  } catch {
    return null;
  }
}

// Returns the clip's signed URL, refreshing and storing a new one when it is missing or about to expire.
export async function currentSignedUrl(clip: { id: number; storagePath: string; signedUrl: string | null; signedUrlExpiresAt: number | null }): Promise<string | null> {
  const now = Date.now();
  if (clip.signedUrl && clip.signedUrlExpiresAt && clip.signedUrlExpiresAt >= now + ONE_HOUR_MS) return clip.signedUrl;
  const fresh = await refreshSignedUrl(clip.storagePath);
  if (!fresh) return clip.signedUrl;
  await db.update(brollClips).set({ signedUrl: fresh.url, signedUrlExpiresAt: fresh.expiresAt, updatedAt: now }).where(eq(brollClips.id, clip.id));
  return fresh.url;
}
