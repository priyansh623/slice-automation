/**
 * Small display copies of the base character images, for the Projects tab.
 *
 * The original upload is never touched: it stays exactly as uploaded and is what Claude and Google Flow receive (they
 * read `video_projects.base_image_path`, which this file never changes). A thumbnail is a separate object next to it:
 *
 *   <user>/<uuid>.<ext>          the original (source of truth)
 *   <user>/thumbs/<uuid>.webp    the thumbnail
 * (the oldest projects have no <user>/ folder: <uuid>.<ext> and thumbs/<uuid>.webp)
 *
 * The thumbnail's name follows from the original's, so no database column is needed: whether one exists is simply
 * whether that object exists. It is generated once, when the project is created (and by the backfill script for older
 * projects), never when the Projects tab is opened. Failing to make one is never an error for the caller: the tab falls
 * back to the original, exactly as before.
 */
import sharp from 'sharp';
import { ObjectExistsError, type BucketName, type ObjectInfo, type PutOptions } from '@/lib/object-store/types';

/** Longest sides of a thumbnail. The tab shows the image at 34x50 px; this is enough for 4x density and larger cards. */
export const THUMB_MAX_WIDTH = 240;
export const THUMB_MAX_HEIGHT = 360;
const THUMB_QUALITY = 78;

/**
 * The thumbnail's storage key for an original's key, or null for a key that is not an image path. An original with no
 * folder (the oldest projects store just `<uuid>.jpg`) gets `thumbs/<uuid>.webp`.
 */
export function thumbnailKeyFor(originalKey: string | null | undefined): string | null {
  if (!originalKey) return null;
  const m = /^(?:(.*)\/)?([^/]+)\.[A-Za-z0-9]+$/.exec(originalKey);
  if (!m) return null;
  const dir = m[1];
  if (dir === 'thumbs' || dir?.endsWith('/thumbs')) return null; // never a thumbnail of a thumbnail
  return dir ? `${dir}/thumbs/${m[2]}.webp` : `thumbs/${m[2]}.webp`;
}

/** Resizes (never enlarges), honours the photo's rotation, and encodes as WebP. Does not modify its input. */
export async function makeThumbnail(original: Buffer): Promise<Buffer> {
  return sharp(original, { failOn: 'none' })
    .rotate()
    .resize({ width: THUMB_MAX_WIDTH, height: THUMB_MAX_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
}

/** The part of the application's Storage this file uses. */
export interface ThumbnailStore {
  download(bucket: BucketName, key: string): Promise<Buffer>;
  head(bucket: BucketName, key: string): Promise<ObjectInfo | null>;
  put(bucket: BucketName, key: string, body: Buffer, opts: PutOptions): Promise<unknown>;
}
export type ThumbnailResult =
  | { status: 'created'; key: string; bytes: number; originalBytes: number }
  | { status: 'exists'; key: string }
  | { status: 'failed'; reason: string };

/**
 * Makes the thumbnail for one original if it does not exist yet. Only ever reads the original and writes the new
 * thumbnail object; it never throws.
 */
export async function ensureThumbnail(store: ThumbnailStore, originalKey: string): Promise<ThumbnailResult> {
  const key = thumbnailKeyFor(originalKey);
  if (!key) return { status: 'failed', reason: 'not a plain image path' };
  try {
    if (await store.head('uploads', key)) return { status: 'exists', key };
    const original = await store.download('uploads', originalKey);
    const thumb = await makeThumbnail(original);
    try {
      await store.put('uploads', key, thumb, { contentType: 'image/webp' });
    } catch (err) {
      if (err instanceof ObjectExistsError) return { status: 'exists', key };
      throw err;
    }
    return { status: 'created', key, bytes: thumb.length, originalBytes: original.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[thumbnail] could not make a thumbnail for ${originalKey}:`, reason.slice(0, 160));
    return { status: 'failed', reason: reason.slice(0, 160) };
  }
}
