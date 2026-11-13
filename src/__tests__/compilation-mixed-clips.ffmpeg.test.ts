/**
 * Real FFmpeg: joining clips of different sizes and frame rates (an older clip and a newer clip need not match).
 * Uses only synthetic clips made in a temp folder; no network, no database.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegStaticPath from 'ffmpeg-static';
import { buildFilterComplex, probeVideoDuration, probeVideoGeometry, runFfmpegFilterComplex } from '@/worker/ffmpeg-utils';
import { compileWithFfmpeg } from '@/worker/compilation-ffmpeg';

let dir: string;
let privateTmp: string;
const realTmp = process.env.TMPDIR;
beforeAll(() => {
  // A temp directory of this file's own, so counting leftover compile folders cannot be disturbed by other test files
  // that run at the same time and also create and remove their own.
  privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-clips-private-'));
  process.env.TMPDIR = privateTmp;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-clips-'));
});
afterAll(() => {
  if (realTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = realTmp;
  fs.rmSync(privateTmp, { recursive: true, force: true });
});

function makeClip(name: string, size: string, fps: number, seconds: number, withAudio = true): string {
  const out = path.join(dir, name);
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=blue:size=${size}:rate=${fps}:duration=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '64k');
  args.push(out);
  const r = spawnSync(ffmpegStaticPath!, args, { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr?.toString().slice(-300)}`);
  return out;
}

describe('buildFilterComplex', () => {
  it('is unchanged when the clips match (no normalisation argument)', () => {
    const plain = buildFilterComplex([0, 1], [0, 1], [2, 3]);
    expect(plain).toBe('[0:v]setpts=PTS-STARTPTS[v0];[0:a]asetpts=PTS-STARTPTS,atrim=end=2.000000,apad=whole_dur=2.000000[a0];[1:v]setpts=PTS-STARTPTS[v1];[1:a]asetpts=PTS-STARTPTS,atrim=end=3.000000,apad=whole_dur=3.000000[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]');
  });
  it('scales, pads and sets the frame rate of every clip when a target is given', () => {
    const f = buildFilterComplex([0, 1], [0, 1], [2, 3], { width: 720, height: 1280, fps: 24 });
    expect(f).toContain('[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24.000,setpts=PTS-STARTPTS[v0]');
    expect(f).toContain('[1:v]scale=720:1280');
  });
});

describe('real FFmpeg join', () => {
  it('joins clips of different size and frame rate into one playable video at the first clip\'s size', () => {
    const a = makeClip('a.mp4', '128x72', 24, 2);
    const b = makeClip('b.mp4', '160x90', 30, 2);
    const out = path.join(dir, 'mixed.mp4');
    runFfmpegFilterComplex([a, b], out, 35);
    expect(probeVideoGeometry(out)).toMatchObject({ width: 128, height: 72 });
    expect(probeVideoDuration(out)).toBeGreaterThan(3.8);
    expect(probeVideoDuration(out)).toBeLessThan(4.3);
  }, 60_000);

  it('still joins matching clips, a silent clip among them, with no normalisation', () => {
    const a = makeClip('c.mp4', '128x72', 24, 2);
    const b = makeClip('d.mp4', '128x72', 24, 2, false);
    const out = path.join(dir, 'same.mp4');
    runFfmpegFilterComplex([a, b], out, 35);
    expect(probeVideoDuration(out)).toBeGreaterThan(3.8);
  }, 60_000);

  it('compileWithFfmpeg joins stored clips, returns the bytes and cleans up its temp files', async () => {
    const stored = new Map([['x/1.mp4', fs.readFileSync(makeClip('e.mp4', '128x72', 24, 1))], ['x/2.mp4', fs.readFileSync(makeClip('f.mp4', '160x90', 25, 1))]]);
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('soma-compile-')).length;
    const bytes = await compileWithFfmpeg([{ storagePath: 'x/1.mp4' }, { storagePath: 'x/2.mp4' }], 35, { download: async (p) => stored.get(p)! });
    expect(bytes.length).toBeGreaterThan(1000);
    const probe = path.join(dir, 'result.mp4');
    fs.writeFileSync(probe, bytes);
    expect(probeVideoDuration(probe)).toBeGreaterThan(1.8);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('soma-compile-')).length).toBe(before);
  }, 60_000);

  it('stops FFmpeg that runs past the time limit, reports it clearly, and still cleans up its temp files', async () => {
    const stored = new Map([['x/1.mp4', fs.readFileSync(makeClip('g.mp4', '128x72', 24, 1))], ['x/2.mp4', fs.readFileSync(makeClip('h.mp4', '128x72', 24, 1))]]);
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('soma-compile-')).length;
    await expect(compileWithFfmpeg([{ storagePath: 'x/1.mp4' }, { storagePath: 'x/2.mp4' }], 35, {
      download: async (p) => stored.get(p)!,
      run: (inputs, output, crf) => runFfmpegFilterComplex(inputs, output, crf, 1), // 1 ms: cannot finish
    })).rejects.toThrow(/was stopped/);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('soma-compile-')).length).toBe(before);
  }, 60_000);

  it('reports a clear error when FFmpeg itself fails (unreadable clip), with the useful part of its message', async () => {
    const bad = path.join(dir, 'not-a-video.mp4');
    fs.writeFileSync(bad, 'this is not a video');
    expect(() => runFfmpegFilterComplex([bad, bad], path.join(dir, 'never.mp4'), 35)).toThrow(/ffprobe failed|FFmpeg exited/);
  }, 60_000);

  it('compileWithFfmpeg reports which clip could not be read and still cleans up', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('soma-compile-')).length;
    await expect(compileWithFfmpeg([{ storagePath: 'nope.mp4' }], 35, { download: async () => { throw new Error('not found'); } })).rejects.toThrow(/clip 1.*not found/);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('soma-compile-')).length).toBe(before);
  });
});
