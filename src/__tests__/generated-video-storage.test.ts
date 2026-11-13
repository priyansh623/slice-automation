import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const put = vi.hoisted(() => vi.fn(async () => ({ provider: 'supabase' as const })));
vi.mock('@/lib/object-store', () => ({ getStorage: () => ({ put }) }));
vi.mock('../lib/object-store', () => ({ getStorage: () => ({ put }) }));

import { storeGeneratedVideo } from '@/lib/object-store/generated-video';

describe('storeGeneratedVideo', () => {
  it('stores the file under the existing key format in the videos bucket and removes the temp file', async () => {
    const tmp = path.join(os.tmpdir(), `gen-test-${Date.now()}.mp4`);
    fs.writeFileSync(tmp, Buffer.from('video-bytes'));
    const key = await storeGeneratedVideo(tmp, 12, 345);
    expect(key).toMatch(/^screen-12\/\d+-gen-345\.mp4$/);
    expect(put).toHaveBeenCalledWith('videos', key, Buffer.from('video-bytes'), { contentType: 'video/mp4' });
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('does not delete the temp file or return a key when storing fails', async () => {
    put.mockRejectedValueOnce(new Error('storage down'));
    const tmp = path.join(os.tmpdir(), `gen-test-fail-${Date.now()}.mp4`);
    fs.writeFileSync(tmp, Buffer.from('x'));
    await expect(storeGeneratedVideo(tmp, 1, 2)).rejects.toThrow('storage down');
    expect(fs.existsSync(tmp)).toBe(true);
    fs.unlinkSync(tmp);
  });
});
