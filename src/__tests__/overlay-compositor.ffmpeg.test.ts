/**
 * The B-roll compositor, against REAL FFmpeg and synthetic video and audio. Solid colours prove which video is on screen at a time;
 * every overlay carries its own tone so a leak of overlay audio would change the audio hash.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { audioHash, isColor, makeSolid, pixelAt, probeJson } from './helpers/ffmpeg-fixtures';
import { buildOverlayFilterComplex, compositeOverlaysSync, MAX_OVERLAYS_PER_PASS, normaliseOverlayClipSync, probeClip, type CompositeOverlay } from '@/worker/compilation-overlay';

let dir: string;
let base: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-overlay-test-'));
  base = makeSolid({ file: path.join(dir, 'base.mp4'), color: 'blue', width: 720, height: 1280, fps: 24, seconds: 12, audioHz: 440 });
}, 120_000);
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ov = (id: number, file: string, startMs: number, endMs: number, over: Partial<CompositeOverlay> = {}): CompositeOverlay => ({ id, track: 0, startMs, endMs, sourceStartMs: 0, file, ...over });
const out = (name: string) => path.join(dir, name);
const frame = 1 / 24;

describe('one overlay', () => {
  it('shows over its window and reveals the base again, to the frame; the narration is bit-for-bit unchanged', () => {
    // A landscape 30 fps clip with its OWN tone: it must be cropped to fill, matched to 24 fps, and its sound must never appear.
    const red = makeSolid({ file: out('red.mp4'), color: 'red', width: 1920, height: 1080, fps: 30, seconds: 6, audioHz: 880 });
    const result = compositeOverlaysSync(base, out('one.mp4'), [ov(1, red, 3000, 5000)], 23);
    expect(result.passes).toBe(1);
    const f = out('one.mp4');
    expect(isColor(pixelAt(f, 2.9), 'blue')).toBe(true);
    expect(isColor(pixelAt(f, 3.0 + 2 * frame), 'red')).toBe(true);   // inside, just after it begins
    expect(isColor(pixelAt(f, 4.5), 'red')).toBe(true);
    expect(isColor(pixelAt(f, 5.0 - 2 * frame), 'red')).toBe(true);   // inside, just before it ends
    expect(isColor(pixelAt(f, 5.0 + 2 * frame), 'blue')).toBe(true);  // the Flow footage is back
    expect(isColor(pixelAt(f, 8), 'blue')).toBe(true);
    // Narration: identical audio, one audio stream only, same duration.
    expect(audioHash(f)).toBe(audioHash(base));
    expect(probeJson(f).streams.filter((s) => s.codec_type === 'audio')).toHaveLength(1);
    const a = probeClip(base); const b = probeClip(f);
    expect(Math.abs(b.durationSec - a.durationSec)).toBeLessThanOrEqual(frame + 1e-6);
    expect(b.width).toBe(720); expect(b.height).toBe(1280);
    expect(Math.abs((b.audioDurationSec ?? 0) - (a.audioDurationSec ?? 0))).toBeLessThan(0.001);
    expect(Math.abs((b.audioStartSec ?? 0) - (a.audioStartSec ?? 0))).toBeLessThan(0.001);          // audio did not shift
    expect(Math.abs(b.videoStartSec - a.videoStartSec)).toBeLessThan(0.001);                          // and neither did the video: A/V offset is what it was
  }, 120_000);

  it('plays the overlay from its trim-in point, not from its start', () => {
    // 4 s clip: red for the first 2 s, green for the rest. Trimmed in by 2.5 s, the window must show green.
    const split = out('split.mp4');
    const r = makeSolid({ file: out('s1.mp4'), color: 'red', width: 720, height: 1280, fps: 24, seconds: 2, audioHz: null });
    const g = makeSolid({ file: out('s2.mp4'), color: 'green', width: 720, height: 1280, fps: 24, seconds: 2, audioHz: null });
    fs.writeFileSync(out('list.txt'), `file '${r}'\nfile '${g}'\n`);
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const ff = require('ffmpeg-static') as string;
    expect(spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', out('list.txt'), '-c', 'copy', split]).status).toBe(0);
    compositeOverlaysSync(base, out('trim.mp4'), [ov(1, split, 2000, 3000, { sourceStartMs: 2500 })], 23);
    expect(isColor(pixelAt(out('trim.mp4'), 1.9), 'blue')).toBe(true);
    expect(isColor(pixelAt(out('trim.mp4'), 2.0 + 3 * frame), 'green')).toBe(true);
    expect(isColor(pixelAt(out('trim.mp4'), 2.9), 'green')).toBe(true);
    expect(isColor(pixelAt(out('trim.mp4'), 3.2), 'blue')).toBe(true);
  }, 120_000);
});

describe('several overlays', () => {
  it('draws them all at their own windows (different sizes and frame rates), including one that spans most of the video, and keeps the narration', () => {
    const red = makeSolid({ file: out('m-red.mp4'), color: 'red', width: 640, height: 360, fps: 25, seconds: 3, audioHz: 660 });
    const green = makeSolid({ file: out('m-green.mp4'), color: 'green', width: 1080, height: 1920, fps: 30, seconds: 2, audioHz: null });
    const yellow = makeSolid({ file: out('m-yellow.mp4'), color: 'yellow', width: 720, height: 1280, fps: 24, seconds: 4, audioHz: 990 });
    compositeOverlaysSync(base, out('multi.mp4'), [ov(1, red, 1000, 3500), ov(2, green, 4000, 5500), ov(3, yellow, 8000, 11800)], 23);
    const f = out('multi.mp4');
    const expected: Array<[number, 'red' | 'blue' | 'green' | 'yellow']> = [[0.5, 'blue'], [2.0, 'red'], [3.7, 'blue'], [4.5, 'green'], [5.8, 'blue'], [7.9, 'blue'], [9.0, 'yellow'], [11.5, 'yellow']];
    for (const [t, c] of expected) expect(isColor(pixelAt(f, t), c), `t=${t} should be ${c}`).toBe(true);
    expect(audioHash(f)).toBe(audioHash(base));
    expect(Math.abs(probeClip(f).durationSec - 12)).toBeLessThanOrEqual(frame + 1e-6);
  }, 180_000);

  it('uses successive passes beyond the per-pass limit and still gives the same result and the same narration', () => {
    const files = ['red', 'green', 'yellow'].map((c, i) => makeSolid({ file: out(`p-${c}.mp4`), color: c, width: 720, height: 1280, fps: 24, seconds: 1, audioHz: null }));
    const overlays = Array.from({ length: MAX_OVERLAYS_PER_PASS + 2 }, (_, i) => ov(i + 1, files[i % 3], 500 + i * 1500, 1300 + i * 1500));
    const result = compositeOverlaysSync(base, out('many.mp4'), overlays, 23);
    expect(result.passes).toBe(2);
    const f = out('many.mp4');
    const colours = ['red', 'green', 'yellow'] as const;
    overlays.forEach((o, i) => expect(isColor(pixelAt(f, (o.startMs + o.endMs) / 2000), colours[i % 3]), `overlay ${i}`).toBe(true));
    expect(isColor(pixelAt(f, 11.5), 'blue')).toBe(true);
    expect(audioHash(f)).toBe(audioHash(base));
  }, 240_000);

  it('draws a higher track on top where two overlap', () => {
    const red = makeSolid({ file: out('t-red.mp4'), color: 'red', width: 720, height: 1280, fps: 24, seconds: 4, audioHz: null });
    const green = makeSolid({ file: out('t-green.mp4'), color: 'green', width: 720, height: 1280, fps: 24, seconds: 2, audioHz: null });
    compositeOverlaysSync(base, out('tracks.mp4'), [ov(1, green, 3000, 5000, { track: 1 }), ov(2, red, 2000, 6000, { track: 0 })], 23);
    expect(isColor(pixelAt(out('tracks.mp4'), 2.5), 'red')).toBe(true);
    expect(isColor(pixelAt(out('tracks.mp4'), 4.0), 'green')).toBe(true);
    expect(isColor(pixelAt(out('tracks.mp4'), 5.5), 'red')).toBe(true);
  }, 120_000);
});

describe('other bases', () => {
  it('keeps a base with no audio free of audio', () => {
    const mute = makeSolid({ file: out('mute.mp4'), color: 'blue', width: 720, height: 1280, fps: 24, seconds: 4, audioHz: null });
    const red = makeSolid({ file: out('mute-red.mp4'), color: 'red', width: 720, height: 1280, fps: 24, seconds: 2, audioHz: 880 });
    compositeOverlaysSync(mute, out('mute-out.mp4'), [ov(1, red, 1000, 2000)], 23);
    expect(probeJson(out('mute-out.mp4')).streams.filter((s) => s.codec_type === 'audio')).toHaveLength(0);
  }, 120_000);

  it('places windows on the base\'s own clock when its video does not start at zero', () => {
    const shifted = makeSolid({ file: out('shift.mp4'), color: 'blue', width: 720, height: 1280, fps: 24, seconds: 6, audioHz: 440, startOffset: 0 });
    const info = probeClip(shifted);
    const g = buildOverlayFilterComplex({ ...info, videoStartSec: 0.5 }, [ov(1, 'x.mp4', 1000, 2000)]);
    expect(g).toContain('setpts=PTS-STARTPTS+1.500000/TB');
    expect(g).toContain("between(t,1.500000,2.500000)");
  });
});

describe('the project copy of a library clip', () => {
  it('is silent, fills 720x1280 at 30 fps and keeps its length; the original is not modified', async () => {
    const src = makeSolid({ file: out('lib.mp4'), color: 'red', width: 1920, height: 1080, fps: 25, seconds: 3, audioHz: 880 });
    const before = fs.readFileSync(src);
    const r = await normaliseOverlayClipSync(src, out('lib-norm.mp4'));
    expect(r).toMatchObject({ width: 720, height: 1280 });
    expect(Math.round(r.fps)).toBe(30);
    expect(Math.abs(r.durationMs - 3000)).toBeLessThan(100);
    expect(probeClip(out('lib-norm.mp4')).hasAudio).toBe(false);
    expect(fs.readFileSync(src).equals(before)).toBe(true);
  }, 120_000);

  it('a Grok-sized portrait video (1504x2752, not exactly 9:16) is covered to 720x1280 without stretching: a square stays square, no bars', async () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const ff = require('ffmpeg-static') as string;
    const src = out('grok-ratio.mp4');
    // a white 600x600 square centred on a mid-grey 1504x2752 frame
    expect(spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=1504x2752:r=24:d=1', '-vf', 'drawbox=x=452:y=1076:w=600:h=600:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status).toBe(0);
    const r = await normaliseOverlayClipSync(src, out('grok-ratio-norm.mp4'));
    expect(r).toMatchObject({ width: 720, height: 1280 });
    const png = spawnSync(ff, ['-loglevel', 'error', '-i', out('grok-ratio-norm.mp4'), '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 20_000_000 }).stdout;
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[y * info.width + x] > 200) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const w = maxX - minX + 1; const h = maxY - minY + 1;
    expect(Math.abs(w - h)).toBeLessThanOrEqual(3);                        // not stretched
    expect(Math.abs(w - 600 * (720 / 1504))).toBeLessThanOrEqual(4);       // uniform scale 720/1504 (the width is what is covered)
    for (const [x, y] of [[2, 2], [717, 2], [2, 1277], [717, 1277]]) expect(Math.abs(data[y * info.width + x] - 128)).toBeLessThan(12);   // the corners are picture, not black bars
  }, 120_000);

  it('rejects a file that is not a video with a readable message', async () => {
    fs.writeFileSync(out('not.mp4'), 'this is not a video');
    await expect(normaliseOverlayClipSync(out('not.mp4'), out('not-out.mp4'))).rejects.toThrow(/ffprobe failed|no video stream/);
  });
});
