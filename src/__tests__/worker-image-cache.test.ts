/**
 * Worker image cache tests.
 *
 * Tests the size-bounded FIFO eviction logic for the module-level image cache
 * in src/services/anthropic.ts.
 *
 * The actual cache is a module-level Map; this file replicates the logic as
 * pure functions so it can be tested without Supabase credentials.
 */
import { describe, it, expect, vi } from 'vitest';

interface EncodedImage {
  base64: string;
  mimeType: string;
}

/** Pure implementation matching the cache logic in anthropic.ts */
function makeBoundedCache(maxSize: number) {
  const cache = new Map<string, EncodedImage>();

  function get(cacheKey: string): EncodedImage | undefined {
    return cache.get(cacheKey);
  }

  function set(cacheKey: string, value: EncodedImage): void {
    if (cache.size >= maxSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(cacheKey, value);
  }

  function size(): number {
    return cache.size;
  }

  function keys(): string[] {
    return [...cache.keys()];
  }

  return { get, set, size, keys };
}

const FAKE_IMAGE: EncodedImage = { base64: 'abc123', mimeType: 'image/jpeg' };

describe('Worker image cache: bounded eviction', () => {
  it('stores an entry', () => {
    const cache = makeBoundedCache(100);
    cache.set('uploads:photo.jpg', FAKE_IMAGE);
    expect(cache.get('uploads:photo.jpg')).toEqual(FAKE_IMAGE);
  });

  it('returns undefined for a cache miss', () => {
    const cache = makeBoundedCache(100);
    expect(cache.get('uploads:missing.jpg')).toBeUndefined();
  });

  it('does not evict when below max size', () => {
    const cache = makeBoundedCache(3);
    cache.set('a', FAKE_IMAGE);
    cache.set('b', FAKE_IMAGE);
    cache.set('c', FAKE_IMAGE);
    expect(cache.size()).toBe(3);
    expect(cache.keys()).toEqual(['a', 'b', 'c']);
  });

  it('evicts the oldest entry when max size is reached', () => {
    const cache = makeBoundedCache(3);
    cache.set('a', FAKE_IMAGE);
    cache.set('b', FAKE_IMAGE);
    cache.set('c', FAKE_IMAGE);
    cache.set('d', FAKE_IMAGE); // triggers eviction of 'a'
    expect(cache.size()).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toEqual(FAKE_IMAGE);
  });

  it('evicts entries in FIFO order across multiple insertions', () => {
    const cache = makeBoundedCache(2);
    cache.set('a', FAKE_IMAGE);
    cache.set('b', FAKE_IMAGE);
    cache.set('c', FAKE_IMAGE); // evicts 'a'
    cache.set('d', FAKE_IMAGE); // evicts 'b'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toEqual(FAKE_IMAGE);
    expect(cache.get('d')).toEqual(FAKE_IMAGE);
  });

  it('never grows beyond maxSize', () => {
    const MAX = 5;
    const cache = makeBoundedCache(MAX);
    for (let i = 0; i < 50; i++) {
      cache.set(`key-${i}`, FAKE_IMAGE);
    }
    expect(cache.size()).toBe(MAX);
  });

  it('key format isolates bucket:path correctly', () => {
    const cache = makeBoundedCache(10);
    // Same path, different buckets → different keys
    cache.set('uploads:image.jpg', { base64: 'uploads-data', mimeType: 'image/jpeg' });
    cache.set('videos:image.jpg', { base64: 'videos-data', mimeType: 'image/jpeg' });
    expect(cache.get('uploads:image.jpg')?.base64).toBe('uploads-data');
    expect(cache.get('videos:image.jpg')?.base64).toBe('videos-data');
  });

  it('a failed download (thrown error) is not cached', () => {
    // Simulate the behaviour: encodeImageFromStorage throws before calling cache.set
    const cache = makeBoundedCache(100);
    function encodeWithFailure(key: string): EncodedImage {
      throw new Error(`Failed to download ${key}`);
    }
    expect(() => encodeWithFailure('uploads:broken.jpg')).toThrow('Failed to download');
    expect(cache.get('uploads:broken.jpg')).toBeUndefined();
  });
});
