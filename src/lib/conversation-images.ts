/**
 * Image references for stored Claude conversations.
 *
 * A conversation used to store the project image as base64 inside every user message (megabytes per turn).
 * New messages store a small reference to the image file that already sits in Supabase Storage (the project's
 * base image) and the image is fetched again whenever a request to Claude is built.
 *
 * Both formats are supported when a conversation is loaded:
 *   legacy  { type: 'image', source: { type: 'base64', ... } }   left exactly as stored, sent as-is
 *   new     { type: 'soma_image_ref', bucket, path, mediaType }   replaced by the real image before sending
 *
 * Nothing here touches the database or storage by itself: the caller supplies `fetchImage`.
 */

export const IMAGE_REF_TYPE = 'soma_image_ref' as const;

export const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

export interface ImageRefBlock {
  type: typeof IMAGE_REF_TYPE;
  bucket: string;
  path: string;
  mediaType: SupportedMediaType;
}

export interface FetchedImage {
  base64: string;
  mimeType: SupportedMediaType;
}

export type ImageFetcher = (bucket: string, path: string) => Promise<FetchedImage>;

// Upload paths are "<user id>/<uuid>.<ext>"; two early projects use a bare "<uuid>.<ext>".
const PATH_PATTERN = /^([0-9a-f-]{36}\/)?[0-9a-f-]{36}\.(jpg|jpeg|png|gif|webp)$/i;

export class ConversationImageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ConversationImageError';
  }
}

export function makeImageRef(bucket: string, path: string, mediaType: SupportedMediaType): ImageRefBlock {
  return { type: IMAGE_REF_TYPE, bucket, path, mediaType };
}

export function isImageRefBlock(block: unknown): block is ImageRefBlock {
  return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === IMAGE_REF_TYPE;
}

/** Returns a problem description when the reference must not be used, or null when it is safe to fetch. */
export function validateImageRef(ref: Partial<ImageRefBlock>, allowedBuckets: readonly string[]): string | null {
  if (typeof ref.bucket !== 'string' || !allowedBuckets.includes(ref.bucket)) return 'the bucket is not an allowed image bucket';
  if (typeof ref.path !== 'string' || ref.path.length === 0) return 'the path is missing';
  if (ref.path.includes('..') || ref.path.startsWith('/') || ref.path.includes('\\')) return 'the path is not a plain object path';
  if (!PATH_PATTERN.test(ref.path)) return 'the path is not an uploaded image path';
  if (!(SUPPORTED_MEDIA_TYPES as readonly string[]).includes(ref.mediaType as string)) return 'the media type is not supported';
  return null;
}

type AnyBlock = Record<string, unknown>;
type AnyMessage = { role: string; content: unknown };

/**
 * Returns a copy of `messages` in which every image reference is replaced by the image Claude originally saw.
 * Legacy base64 blocks and all other content pass through untouched. Each distinct image is fetched once per call.
 * Throws ConversationImageError for an invalid reference or a failed fetch: sending a conversation with an image
 * silently missing would change what Claude sees.
 */
export async function hydrateConversationImages<T extends AnyMessage>(
  messages: readonly T[],
  fetchImage: ImageFetcher,
  allowedBuckets: readonly string[],
): Promise<T[]> {
  const pending = new Map<string, Promise<FetchedImage>>();
  const fetchOnce = (ref: ImageRefBlock) => {
    const key = `${ref.bucket}:${ref.path}`;
    let p = pending.get(key);
    if (!p) {
      p = fetchImage(ref.bucket, ref.path).catch((err: unknown) => {
        throw new ConversationImageError(`Could not load image ${ref.path} for the conversation: ${err instanceof Error ? err.message : String(err)}`, err);
      });
      pending.set(key, p);
    }
    return p;
  };

  const out: T[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content) || !(message.content as unknown[]).some(isImageRefBlock)) {
      out.push(message);
      continue;
    }
    const content: unknown[] = [];
    for (const block of message.content as unknown[]) {
      if (!isImageRefBlock(block)) { content.push(block); continue; }
      const problem = validateImageRef(block, allowedBuckets);
      if (problem) throw new ConversationImageError(`Invalid image reference in conversation: ${problem}`);
      const image = await fetchOnce(block);
      content.push({ type: 'image', source: { type: 'base64', media_type: block.mediaType, data: image.base64 } } satisfies AnyBlock);
    }
    out.push({ ...message, content } as T);
  }
  return out;
}

/** True when any message still contains a reference (used to assert nothing unresolved reaches the API). */
export function containsImageRefs(messages: readonly AnyMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && (m.content as unknown[]).some(isImageRefBlock));
}

export interface OriginalImage {
  bucket: string;
  path: string;
  mediaType: SupportedMediaType;
  bytes: Buffer;
}

/**
 * For migrating a stored legacy conversation (not run anywhere yet): replaces an embedded base64 image with a
 * reference only when its bytes and media type are identical to the stored original. Any block that differs is kept
 * as it is. The input is never modified; the caller decides whether to save the result.
 */
export function convertLegacyImages<T extends AnyMessage>(
  messages: readonly T[],
  original: OriginalImage,
): { messages: T[]; replaced: number; kept: number } {
  let replaced = 0;
  let kept = 0;
  const out = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = (message.content as unknown[]).map((block) => {
      const b = block as { type?: string; source?: { type?: string; media_type?: string; data?: unknown } };
      if (b?.type !== 'image' || b.source?.type !== 'base64') return block;
      const same = b.source.media_type === original.mediaType
        && typeof b.source.data === 'string'
        && Buffer.from(b.source.data, 'base64').equals(original.bytes);
      if (!same) { kept++; return block; }
      replaced++;
      return makeImageRef(original.bucket, original.path, original.mediaType);
    });
    return { ...message, content } as T;
  });
  return { messages: out, replaced, kept };
}
