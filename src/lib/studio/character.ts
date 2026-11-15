/**
 * The project's ONE base character image (V1). Uploaded straight to R2 like pack images and verified the same way. The
 * original is never modified. Changing the character stores a new image and points the project at it; the earlier image stays
 * in R2 untouched, because batches that already used it keep a snapshot of its key.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { studioProjects } from '@/db/schema.pg';
import { getStorage, ObjectExistsError } from '@/lib/object-store';
import { registerObjectIfAbsent } from '@/lib/object-store/registry';
import { characterThumbKey, checkImageInit, isStudioCharacterKey, newCharacterKey, STUDIO_IMAGE_MAX_BYTES, STUDIO_IMAGE_TYPES, STUDIO_MAX_PIXELS, STUDIO_UPLOAD_TTL_S, verifyStoredImage } from './keys';
import { discardIfUnreferenced, isKeyReferenced } from './references';
import { inspectImage, makeGridThumbnail, sha256Of } from './image-store';
import { getProject } from './projects';
import { StudioError } from './repository';

const FORMAT_TYPE: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export async function prepareCharacterUpload(projectId: number, input: { contentType?: unknown; fileSize?: unknown; fileName?: unknown }) {
  await getProject(projectId);
  const check = checkImageInit(input);
  if (!check.ok) throw new StudioError(check.error, check.status, 'invalid_upload');
  const storage = getStorage();
  if (!storage.directUploadAvailable()) throw new StudioError('Image uploads need Cloudflare R2, which is not available right now. Nothing was uploaded (Studio images are never stored anywhere else).', 503, 'r2_unavailable');
  const storageKey = newCharacterKey(projectId, check.ext);
  try {
    const upload = await storage.signedDirectUpload('uploads', storageKey, check.contentType, check.size, STUDIO_UPLOAD_TTL_S);
    return { storageKey, uploadUrl: upload.url, method: upload.method, headers: upload.headers, expiresInSeconds: STUDIO_UPLOAD_TTL_S, maxBytes: STUDIO_IMAGE_MAX_BYTES };
  } catch (err) {
    console.error('[studio/character] could not sign an upload:', (err as Error).message);
    throw new StudioError('Could not prepare the upload.', 503, 'r2_unavailable');
  }
}

export async function completeCharacterUpload(projectId: number, input: { storageKey: unknown; contentType: unknown; fileSize: unknown }) {
  const project = await getProject(projectId);
  const key = input.storageKey;
  if (!isStudioCharacterKey(projectId, key)) throw new StudioError('Invalid storageKey.', 403, 'invalid_key');
  const contentType = typeof input.contentType === 'string' ? input.contentType.toLowerCase().trim() : '';
  const size = input.fileSize;
  if (!STUDIO_IMAGE_TYPES[contentType] || typeof size !== 'number' || !Number.isInteger(size)) throw new StudioError('contentType and fileSize are required.', 400, 'invalid_upload');
  if (project.characterKey === key) return project; // completing twice is harmless
  // A key that something already uses (an earlier character that batches and jobs refer to) is never verified, replaced or removed here.
  if (await isKeyReferenced(key)) throw new StudioError('That image was already used for this project. Upload it again as a new image if you want it back.', 409, 'key_in_use');

  const storage = getStorage();
  if (!storage.r2Configured()) throw new StudioError('Cloudflare R2 is not available right now.', 503, 'r2_unavailable');
  const head = await storage.headR2('uploads', key);
  const verdict = verifyStoredImage(head, { size, contentType });
  const discard = () => discardIfUnreferenced(key);
  if (!verdict.ok) { if (head && verdict.status !== 409) await discard(); throw new StudioError(verdict.error, verdict.status, 'upload_rejected'); }

  const original = await storage.downloadR2Only('uploads', key);
  let info;
  try { info = await inspectImage(original); } catch { await discard(); throw new StudioError('That file is not a readable JPEG, PNG or WEBP image.', 422, 'not_an_image'); }
  if (FORMAT_TYPE[info.format] !== contentType) { await discard(); throw new StudioError('The image is not the type it was declared as.', 422, 'type_mismatch'); }
  if (info.width * info.height > STUDIO_MAX_PIXELS) { await discard(); throw new StudioError(`That image has ${(info.width * info.height / 1_000_000).toFixed(0)} megapixels. The limit is ${STUDIO_MAX_PIXELS / 1_000_000} megapixels. Resize it and upload it again (nothing was changed).`, 422, 'too_many_pixels'); }

  await registerObjectIfAbsent({ bucket: 'uploads', key, provider: 'r2', sizeBytes: original.length, contentType, sha256: sha256Of(original), verifiedAt: Date.now() });
  const wanted = characterThumbKey(key);
  if (wanted) {
    try {
      try { await storage.putR2Only('uploads', wanted, await makeGridThumbnail(original), { contentType: 'image/webp' }); } catch (err) { if (!(err instanceof ObjectExistsError)) throw err; }
    } catch (err) { console.warn(`[studio/character] no thumbnail for ${key}:`, (err as Error).message.slice(0, 120)); }
  }
  const [row] = await db.update(studioProjects).set({ characterKey: key, characterMime: contentType, updatedAt: Date.now() }).where(eq(studioProjects.id, projectId)).returning();
  return row;
}
