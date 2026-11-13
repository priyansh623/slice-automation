import { describe, it, expect, vi } from 'vitest';
import { ConversationImageError, containsImageRefs, hydrateConversationImages, makeImageRef, validateImageRef } from '@/lib/conversation-images';

const UID = '11111111-2222-4333-8444-555555555555';
const FILE = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PATH = `${UID}/${FILE}.png`;
const BUCKETS = ['uploads'];
const image = { base64: 'QUJD', mimeType: 'image/png' as const };

describe('validateImageRef', () => {
  it('accepts a normal upload path, with or without the user prefix', () => {
    expect(validateImageRef(makeImageRef('uploads', PATH, 'image/png'), BUCKETS)).toBeNull();
    expect(validateImageRef(makeImageRef('uploads', `${FILE}.jpg`, 'image/jpeg'), BUCKETS)).toBeNull();
  });

  it.each([
    ['another bucket', { bucket: 'videos' }],
    ['path traversal', { path: `${UID}/../${FILE}.png` }],
    ['absolute path', { path: `/${UID}/${FILE}.png` }],
    ['a non-image path', { path: `${UID}/broll/${FILE}.mp4` }],
    ['an arbitrary file', { path: 'secrets.txt' }],
    ['an unsupported media type', { mediaType: 'image/svg+xml' }],
    ['an empty path', { path: '' }],
  ])('rejects %s', (_label, override) => {
    const ref = { ...makeImageRef('uploads', PATH, 'image/png'), ...override } as never;
    expect(validateImageRef(ref, BUCKETS)).not.toBeNull();
  });
});

describe('hydrateConversationImages', () => {
  const ref = makeImageRef('uploads', PATH, 'image/png');

  it('replaces a reference with the image block Claude originally saw', async () => {
    const fetchImage = vi.fn(async () => image);
    const out = await hydrateConversationImages([{ role: 'user', content: [ref, { type: 'text', text: 'hi' }] }], fetchImage, BUCKETS);
    expect(out[0].content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'hi' }]);
    expect(containsImageRefs(out)).toBe(false);
  });

  it('fetches an image shared by several messages once', async () => {
    const fetchImage = vi.fn(async () => image);
    const msgs = [
      { role: 'user', content: [ref, { type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [ref, { type: 'text', text: 'c' }] },
    ];
    await hydrateConversationImages(msgs, fetchImage, BUCKETS);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('leaves legacy base64 messages and text messages exactly as they are', async () => {
    const legacy = { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'LEGACY' } }, { type: 'text', text: 'old' }] };
    const plain = { role: 'user', content: 'plain string' };
    const fetchImage = vi.fn();
    const out = await hydrateConversationImages([legacy, plain], fetchImage, BUCKETS);
    expect(out[0]).toBe(legacy);
    expect(out[1]).toBe(plain);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('does not change the stored messages', async () => {
    const msgs = [{ role: 'user', content: [ref] }];
    await hydrateConversationImages(msgs, async () => image, BUCKETS);
    expect(msgs[0].content[0]).toBe(ref);
  });

  it('refuses an invalid reference without fetching anything', async () => {
    const fetchImage = vi.fn();
    const bad = { ...ref, bucket: 'videos' };
    await expect(hydrateConversationImages([{ role: 'user', content: [bad] }], fetchImage, BUCKETS)).rejects.toBeInstanceOf(ConversationImageError);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('turns a storage failure into a ConversationImageError', async () => {
    const fetchImage = async () => { throw new Error('object not found'); };
    await expect(hydrateConversationImages([{ role: 'user', content: [ref] }], fetchImage, BUCKETS)).rejects.toThrow(/object not found/);
  });
});
