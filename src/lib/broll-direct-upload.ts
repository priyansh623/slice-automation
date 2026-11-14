import * as crypto from 'node:crypto';

/**
 * Rules for B-roll files that go from the browser straight to R2 (the video never passes through the application server).
 * The server decides the bucket, the key, the type and the size limit; the browser only supplies a type, a size and a name.
 */
export const DIRECT_UPLOAD_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
};

/** Largest file accepted by the direct flow: 500 MiB (a single R2 PUT allows up to 5 GiB; this is a product limit). */
export const DIRECT_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

/** How long an upload authorisation stays valid. */
export const DIRECT_UPLOAD_TTL_S = 900;

const EXT_TO_TYPE: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo' };

export type InitCheck = { ok: true; contentType: string; ext: string; size: number } | { ok: false; status: number; error: string };

/** Validates what the browser says it will upload. Nothing here trusts the file itself; the server re-checks R2 afterwards. */
export function checkInit(input: { contentType?: unknown; fileSize?: unknown; fileName?: unknown }): InitCheck {
  const contentType = typeof input.contentType === 'string' ? input.contentType.toLowerCase().trim() : '';
  const ext = DIRECT_UPLOAD_TYPES[contentType];
  if (!ext) return { ok: false, status: 415, error: `Unsupported video type: ${contentType || 'unknown'}. Use MP4, MOV, WEBM or AVI.` };
  const size = input.fileSize;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return { ok: false, status: 400, error: 'fileSize must be a positive whole number of bytes.' };
  if (size > DIRECT_UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: `File is too large. The limit is ${DIRECT_UPLOAD_MAX_BYTES / 1024 / 1024} MB.` };
  if (typeof input.fileName === 'string' && input.fileName.includes('.')) {
    const nameExt = input.fileName.split('.').pop()!.toLowerCase();
    if (!EXT_TO_TYPE[nameExt]) return { ok: false, status: 415, error: `Unsupported file extension .${nameExt}. Use MP4, MOV, WEBM or AVI.` };
  }
  return { ok: true, contentType, ext, size };
}

/** A new, unique key inside the user's own B-roll folder. The browser never chooses it. */
export function newBrollKey(userId: string, ext: string): string {
  return `${userId}/broll/${crypto.randomUUID()}.${ext}`;
}

/** True only for a key this flow could have issued to this user. */
export function isOwnBrollKey(userId: string, key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const prefix = `${userId}/broll/`;
  if (!key.startsWith(prefix)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|webm|avi)$/.test(key.slice(prefix.length));
}

export const extOfKey = (key: string): string => key.slice(key.lastIndexOf('.') + 1);
export const typeOfExt = (ext: string): string | undefined => EXT_TO_TYPE[ext];

export type VerifyResult = { ok: true; size: number; contentType: string } | { ok: false; status: number; error: string; discard: boolean };

/** Judges what R2 really holds for a key. `discard` means the object is unusable and may be removed (if nothing references it). */
export function verifyStoredObject(key: string, head: { size: number; contentType: string | null } | null): VerifyResult {
  if (!head) return { ok: false, status: 409, error: 'The upload was not found in storage. It may have been interrupted or the link may have expired; please upload again.', discard: false };
  if (head.size <= 0) return { ok: false, status: 422, error: 'The uploaded file is empty.', discard: true };
  if (head.size > DIRECT_UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: `The uploaded file is larger than the ${DIRECT_UPLOAD_MAX_BYTES / 1024 / 1024} MB limit.`, discard: true };
  const ct = (head.contentType ?? '').toLowerCase().trim();
  if (!DIRECT_UPLOAD_TYPES[ct] || DIRECT_UPLOAD_TYPES[ct] !== extOfKey(key)) {
    return { ok: false, status: 415, error: 'The stored file is not an allowed video type.', discard: true };
  }
  return { ok: true, size: head.size, contentType: ct };
}
