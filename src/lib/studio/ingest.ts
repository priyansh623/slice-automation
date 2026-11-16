/**
 * Adding an image to a Scene Pack, in two steps like the existing B-roll direct upload:
 *   1. prepareUpload  the server checks the request, chooses the R2 key and returns a short-lived presigned PUT;
 *   2. completeUpload the browser says it finished; the server does not take its word for it. It asks R2 what is really
 *      stored, reads the bytes once to hash and inspect them, makes a thumbnail, records the file and creates the asset.
 *
 * Studio originals live in R2 only (never Supabase): if R2 cannot take the upload, it fails with a clear error.
 * The original is read, never written to again.
 */
import { getStorage, ObjectExistsError } from '@/lib/object-store';
import { registerObjectIfAbsent } from '@/lib/object-store/registry';
import { assetThumbKey, checkImageInit, isStudioAssetKey, newAssetKey, STUDIO_MAX_PIXELS, STUDIO_UPLOAD_TTL_S, STUDIO_IMAGE_MAX_BYTES, STUDIO_IMAGE_TYPES, verifyStoredImage } from './keys';
import { discardIfUnreferenced, isRemovedKeyError, recordUploadIntent } from './references';
import { inspectImage, makeGridThumbnail, sha256Of } from './image-store';
import { findExistingAsset, getPack, registerAsset, StudioError, type RegisterResult } from './repository';

export interface PreparedUpload {
  storageKey: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSeconds: number;
  maxBytes: number;
}

export async function prepareUpload(packId: number, input: { contentType?: unknown; fileSize?: unknown; fileName?: unknown }, userId: string | null = null): Promise<PreparedUpload> {
  const pack = await getPack(packId);
  if (pack.archivedAt) throw new StudioError('This Scene Pack is archived. Restore it before adding images.', 409, 'pack_archived');
  const check = checkImageInit(input);
  if (!check.ok) throw new StudioError(check.error, check.status, 'invalid_upload');
  const storage = getStorage();
  if (!storage.directUploadAvailable()) {
    throw new StudioError('Image uploads need Cloudflare R2, which is not available right now. Nothing was uploaded (Studio images are never stored anywhere else).', 503, 'r2_unavailable');
  }
  const storageKey = newAssetKey(check.ext);
  // Recorded BEFORE the link exists, so an upload that is never completed can be found and cleaned up later.
  await recordUploadIntent(storageKey, 'asset', { packId, userId });
  try {
    const upload = await storage.signedDirectUpload('uploads', storageKey, check.contentType, check.size, STUDIO_UPLOAD_TTL_S);
    return { storageKey, uploadUrl: upload.url, method: upload.method, headers: upload.headers, expiresInSeconds: STUDIO_UPLOAD_TTL_S, maxBytes: STUDIO_IMAGE_MAX_BYTES };
  } catch (err) {
    console.error('[studio/upload] could not sign an upload:', (err as Error).message);
    throw new StudioError('Could not prepare the upload.', 503, 'r2_unavailable');
  }
}

export interface CompleteInput {
  packId: number;
  storageKey: unknown;
  contentType: unknown;
  fileSize: unknown;
  fileName?: unknown;
  ingestGroup?: unknown;
}

const FORMAT_TYPE: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Removes the object of a rejected upload, but only if nothing references it (a registered original is never deleted). */
const discard = (key: string, reason = 'rejected upload'): Promise<boolean> => discardIfUnreferenced(key, reason);

export async function completeUpload(input: CompleteInput, userId: string): Promise<RegisterResult> {
  const key = input.storageKey;
  // Only a key this flow could have issued: not an arbitrary path, not another folder.
  if (!isStudioAssetKey(key)) throw new StudioError('Invalid storageKey.', 403, 'invalid_key');
  const contentType = typeof input.contentType === 'string' ? input.contentType.toLowerCase().trim() : '';
  const size = input.fileSize;
  if (!STUDIO_IMAGE_TYPES[contentType] || typeof size !== 'number' || !Number.isInteger(size)) throw new StudioError('contentType and fileSize are required.', 400, 'invalid_upload');
  const pack = await getPack(input.packId);
  if (pack.archivedAt) throw new StudioError('This Scene Pack is archived. Restore it before adding images.', 409, 'pack_archived');

  // Completing the same upload again returns the asset that already exists. This comes FIRST: nothing below (verification,
  // rejection, removal of a bad upload) may ever run against a key that is already a registered asset.
  const same = await findExistingAsset(input.packId, key);
  if (same) return { asset: same.asset, created: false, duplicate: false };

  const storage = getStorage();
  if (!storage.r2Configured()) throw new StudioError('Cloudflare R2 is not available right now.', 503, 'r2_unavailable');

  const head = await storage.headR2('uploads', key);
  const verdict = verifyStoredImage(head, { size, contentType });
  // A request that merely DESCRIBES the stored file wrongly (size, type) is refused and removes nothing: the file may be a good upload
  // that a different request is completing right now. Unused uploads are cleaned up later by sweepAbandonedUploads.
  if (!verdict.ok) throw new StudioError(verdict.error, verdict.status, 'upload_rejected');

  const original = await storage.downloadR2Only('uploads', key);
  const sha256 = sha256Of(original);

  let info;
  try { info = await inspectImage(original); } catch {
    await discard(key, 'not an image');
    throw new StudioError('That file is not a readable JPEG, PNG or WEBP image.', 422, 'not_an_image');
  }
  if (FORMAT_TYPE[info.format] !== contentType) {
    throw new StudioError('The image is not the type it was declared as.', 422, 'type_mismatch'); // describes the file wrongly: nothing is removed
  }
  if (info.width * info.height > STUDIO_MAX_PIXELS) {
    await discard(key, 'too many pixels');
    throw new StudioError(`That image has ${(info.width * info.height / 1_000_000).toFixed(0)} megapixels. The limit is ${STUDIO_MAX_PIXELS / 1_000_000} megapixels. Resize it and upload it again (nothing was changed).`, 422, 'too_many_pixels');
  }

  // The pack already holds this exact image: return that asset and drop the extra copy that was just uploaded.
  const dup = await findExistingAsset(input.packId, key, sha256);
  if (dup) {
    await discard(key, 'duplicate copy');
    return { asset: dup.asset, created: false, duplicate: true };
  }

  // Record where the original lives (R2) before anything reads it back through the storage layer.
  await registerObjectIfAbsent({ bucket: 'uploads', key, provider: 'r2', sizeBytes: original.length, contentType, sha256, verifiedAt: Date.now() });

  // A grid thumbnail, also in R2. If it cannot be made the asset is still created and the grid shows the original.
  let thumbKey: string | null = null;
  const wanted = assetThumbKey(key);
  if (wanted) {
    try {
      const thumb = await makeGridThumbnail(original);
      try { await storage.putR2Only('uploads', wanted, thumb, { contentType: 'image/webp' }); } catch (err) { if (!(err instanceof ObjectExistsError)) throw err; }
      thumbKey = wanted;
    } catch (err) {
      console.warn(`[studio/upload] no thumbnail for ${key}:`, (err as Error).message.slice(0, 120));
    }
  }

  const name = typeof input.fileName === 'string' && input.fileName.trim() ? input.fileName.trim().slice(0, 200) : null;
  const group = typeof input.ingestGroup === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(input.ingestGroup) ? input.ingestGroup : null;
  try {
    return await registerAsset({
      packId: input.packId, storageKey: key, thumbKey, originalFilename: name, mime: contentType, sizeBytes: original.length, sha256,
      width: info.width, height: info.height, ingestGroup: group,
    }, userId);
  } catch (err) {
    // The database refuses a key that was already removed (for example by the clean-up of an abandoned upload).
    if (isRemovedKeyError(err)) throw new StudioError('This upload was removed before it could be saved. Please upload the image again.', 409, 'upload_removed');
    throw err;
  }
}
