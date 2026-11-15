import * as crypto from 'node:crypto';
import sharp from 'sharp';
import { getStorage } from '@/lib/object-store';
import { STUDIO_MAX_PIXELS } from './keys';

/** Longest side of a grid thumbnail. The Repository and Studio grids show images at a few hundred pixels. */
export const GRID_THUMB_MAX = 480;
/** How long a signed read URL lives. Signing R2 is a local computation, so URLs are cheap to make fresh. */
export const STUDIO_URL_TTL_S = 3600;

export const sha256Of = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

export type ImageFormat = 'jpeg' | 'png' | 'webp';
export interface ImageInfo { width: number; height: number; format: ImageFormat }

/** Reads the real type and size from the bytes. Throws if the bytes are not a JPEG, PNG or WEBP image. Never modifies them. */
export async function inspectImage(buf: Buffer): Promise<ImageInfo> {
  const meta = await sharp(buf, { failOn: 'error' }).metadata();
  if ((meta.format !== 'jpeg' && meta.format !== 'png' && meta.format !== 'webp') || !meta.width || !meta.height) {
    throw new Error('Not a JPEG, PNG or WEBP image');
  }
  return { width: meta.width, height: meta.height, format: meta.format };
}

/** A small WebP copy for grids. Honours the photo's rotation, never enlarges. The original is not touched. */
export async function makeGridThumbnail(original: Buffer): Promise<Buffer> {
  return sharp(original, { failOn: 'none', limitInputPixels: STUDIO_MAX_PIXELS, sequentialRead: true })
    .rotate()
    .resize({ width: GRID_THUMB_MAX, height: GRID_THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
}

/** Signed read URLs for many keys at once. Keys with no URL are left out. */
export async function signKeys(keys: string[], ttl = STUDIO_URL_TTL_S): Promise<Map<string, string>> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return new Map();
  return getStorage().signedReadUrls('uploads', unique, ttl).catch(() => new Map<string, string>());
}
