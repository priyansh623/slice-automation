import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { decodeConcatAnswer } from '@/worker/concat-stream';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-concat-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const stream = (text: string, size: number) => {
  const buf = Buffer.from(text); const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) chunks.push(buf.subarray(i, i + size));
  return Readable.toWeb(Readable.from(chunks)) as unknown as ReadableStream<Uint8Array>;
};
const video = Buffer.from(Array.from({ length: 5003 }, (_, i) => (i * 31 + 7) % 256));

describe('concatenation answers are decoded as a stream', () => {
  it('gives the same bytes whatever the chunk boundaries, including escaped slashes split across chunks', async () => {
    for (const json of [`{"a":1,"encodedVideo":"${video.toString('base64')}"}`, `{"encodedVideo":"${video.toString('base64').replace(/\//g, '\\/')}"}`, `{"video":"${video.toString('base64')}"}`]) {
      for (const size of [1, 3, 7, 64, 1000, json.length]) {
        const out = path.join(dir, `o-${size}.mp4`);
        expect((await decodeConcatAnswer(stream(json, size), out)).bytes).toBe(video.length);
        expect(fs.readFileSync(out).equals(video), `chunk ${size}`).toBe(true);
      }
    }
  });
  it('rejects an answer cut off in the middle of the video instead of keeping half a file', async () => {
    await expect(decodeConcatAnswer(stream(`{"encodedVideo":"${video.toString('base64').slice(0, 400)}`, 50), path.join(dir, 't.mp4'))).rejects.toThrow(/middle of the video/);
  });
  it('hands back an answer without a video (a URL or an error) for the caller to read', async () => {
    const r = await decodeConcatAnswer(stream('{"videoUrl":"https://x/y.mp4"}', 5), path.join(dir, 'u.mp4'));
    expect(r.bytes).toBe(-1);
    expect(JSON.parse(r.rest).videoUrl).toBe('https://x/y.mp4');
  });
});
