import * as crypto from 'node:crypto';

/**
 * R2 keys for Character B-roll Studio, all inside the existing 'uploads' bucket. The server chooses every key; the
 * browser only ever supplies a type, a size and a file name.
 *
 *   studio/assets/<uuid>.<ext>                                   Scene Pack source image (immutable original)
 *   studio/assets/thumbs/<uuid>.webp                              its thumbnail
 *   studio/projects/<projectId>/character/<uuid>.<ext>           the project's base character image
 *   studio/projects/<projectId>/character/thumbs/<uuid>.webp
 *   studio/projects/<projectId>/outputs/<jobId>-a<attempt>.<ext> a generated image
 *   studio/projects/<projectId>/outputs/thumbs/<jobId>-a<attempt>.webp
 *
 * Asset keys do not contain the pack id, so an image's key never depends on a pack.
 */

export const STUDIO_IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const EXT_TO_TYPE: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Largest image accepted (a product limit, not a storage limit). */
export const STUDIO_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
/**
 * Largest image, in pixels, that the Studio accepts (24 megapixels, for example 6000x4000). Decoding an image takes memory in
 * proportion to its pixels, not its file size, and the worker that analyses images shares 512 MiB with video generation, so an
 * image above this is refused at upload instead of failing (or crashing the worker) later. The file is never resized.
 */
export const STUDIO_MAX_PIXELS = 24_000_000;
/** How long an upload authorisation stays valid. */
export const STUDIO_UPLOAD_TTL_S = 900;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export type InitCheck = { ok: true; contentType: string; ext: string; size: number } | { ok: false; status: number; error: string };

/** Validates what the browser says it will upload. It does not trust the file; the server re-checks storage afterwards. */
export function checkImageInit(input: { contentType?: unknown; fileSize?: unknown; fileName?: unknown }): InitCheck {
  const contentType = typeof input.contentType === 'string' ? input.contentType.toLowerCase().trim() : '';
  const ext = STUDIO_IMAGE_TYPES[contentType];
  if (!ext) return { ok: false, status: 415, error: `Unsupported image type: ${contentType || 'unknown'}. Use JPEG, PNG or WEBP.` };
  const size = input.fileSize;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return { ok: false, status: 400, error: 'fileSize must be a positive whole number of bytes.' };
  if (size > STUDIO_IMAGE_MAX_BYTES) return { ok: false, status: 413, error: `The image is too large. The limit is ${STUDIO_IMAGE_MAX_BYTES / 1024 / 1024} MB.` };
  if (typeof input.fileName === 'string' && input.fileName.includes('.')) {
    const nameExt = input.fileName.split('.').pop()!.toLowerCase();
    if (!EXT_TO_TYPE[nameExt]) return { ok: false, status: 415, error: `Unsupported file extension .${nameExt}. Use JPEG, PNG or WEBP.` };
  }
  return { ok: true, contentType, ext, size };
}

export const newAssetKey = (ext: string): string => `studio/assets/${crypto.randomUUID()}.${ext}`;
export const isStudioAssetKey = (key: unknown): key is string => typeof key === 'string' && new RegExp(`^studio/assets/${UUID}\\.(jpg|png|webp)$`).test(key);
export const assetThumbKey = (assetKey: string): string | null => {
  const m = new RegExp(`^studio/assets/(${UUID})\\.(jpg|png|webp)$`).exec(assetKey);
  return m ? `studio/assets/thumbs/${m[1]}.webp` : null;
};

export const newCharacterKey = (projectId: number, ext: string): string => `studio/projects/${projectId}/character/${crypto.randomUUID()}.${ext}`;
export const isStudioCharacterKey = (projectId: number, key: unknown): key is string =>
  typeof key === 'string' && new RegExp(`^studio/projects/${projectId}/character/${UUID}\\.(jpg|png|webp)$`).test(key);
export const characterThumbKey = (key: string): string | null => {
  const m = new RegExp(`^(studio/projects/\\d+/character)/(${UUID})\\.(jpg|png|webp)$`).exec(key);
  return m ? `${m[1]}/thumbs/${m[2]}.webp` : null;
};

export const outputKey = (projectId: number, jobId: number, attempt: number, ext: string): string => `studio/projects/${projectId}/outputs/${jobId}-a${attempt}.${ext}`;
export const outputThumbKey = (projectId: number, jobId: number, attempt: number): string => `studio/projects/${projectId}/outputs/thumbs/${jobId}-a${attempt}.webp`;

export const extOfKey = (key: string): string => key.slice(key.lastIndexOf('.') + 1);
export const typeOfExt = (ext: string): string | undefined => EXT_TO_TYPE[ext];

export type VerifyResult = { ok: true; size: number; contentType: string } | { ok: false; status: number; error: string };

/** Judges what R2 really holds for a key against what was authorised. */
export function verifyStoredImage(head: { size: number; contentType: string | null } | null, expected: { size: number; contentType: string }): VerifyResult {
  if (!head) return { ok: false, status: 409, error: 'The upload was not found in storage. It may have been interrupted or the link may have expired; please upload again.' };
  if (head.size <= 0) return { ok: false, status: 422, error: 'The uploaded file is empty.' };
  if (head.size > STUDIO_IMAGE_MAX_BYTES) return { ok: false, status: 413, error: 'The uploaded file is too large.' };
  if (head.size !== expected.size) return { ok: false, status: 422, error: 'The uploaded file is not the size that was authorised.' };
  const ct = (head.contentType ?? '').toLowerCase();
  if (ct && ct !== expected.contentType) return { ok: false, status: 422, error: 'The uploaded file is not the type that was authorised.' };
  return { ok: true, size: head.size, contentType: expected.contentType };
}
