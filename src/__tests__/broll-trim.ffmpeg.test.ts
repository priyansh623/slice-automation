/**
 * Real FFmpeg tests for B-roll trimming. Fixtures are generated with the same bundled ffmpeg-static binary the
 * route uses. A zero exit code is not accepted as proof: every output is probed (streams, codecs, durations),
 * fully decoded with no errors, and, where audio matters, checked to actually contain sound.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultRunner, ffmpegArgs, planTrim, probeMedia, trimMedia, validateTrimRange, type Runner } from '@/lib/broll-trim';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FFMPEG = require('ffmpeg-static') as string;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeModule = require('ffprobe-static') as string | { path: string };
const FFPROBE = typeof ffprobeModule === 'string' ? ffprobeModule : ffprobeModule.path;

let dir: string;
const f = (name: string) => path.join(dir, name);

function make(name: string, args: string[]): string {
  const out = f(name);
  const r = defaultRunner(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30',
    ...(args.includes('--no-audio') ? [] : ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']),
    '-t', '8', ...args.filter((a) => a !== '--no-audio'), out]);
  if (r.status !== 0) throw new Error(`fixture ${name} failed: ${r.stderr}`);
  return out;
}

/** Decodes the whole file; any decoder error makes stderr non-empty. */
function decodeErrors(file: string): string {
  const r = defaultRunner(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-']);
  return r.status === 0 ? r.stderr.trim() : `exit ${r.status}: ${r.stderr}`;
}

/** Width x height and the average frame size in bytes (rounded), a fingerprint of "the same encoded video". */
function videoStats(file: string, fromSource = false): { size: string; avgFrameBytes: number } {
  const r = defaultRunner(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size', '-show_entries', 'stream=width,height', '-of', 'json', file]);
  const j = JSON.parse(r.stdout) as { packets: { size: string }[]; streams: { width: number; height: number }[] };
  // The source is 8 s and the trim starts at 0, so compare the first 4 s worth of packets (120 frames at 30 fps).
  const sizes = j.packets.slice(0, fromSource ? 120 : undefined).map((p) => Number(p.size));
  const frames = sizes.slice(0, 120);
  return { size: `${j.streams[0].width}x${j.streams[0].height}`, avgFrameBytes: Math.round(frames.reduce((x, y) => x + y, 0) / frames.length) };
}

/** Mean loudness of the audio track in dB; silence is about -91. */
function meanVolume(file: string): number {
  const r = defaultRunner(FFMPEG, ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr);
  if (!m) throw new Error('no audio to measure');
  return Number(m[1]);
}

function trim(input: string, mimeType: string, inPoint: number, outPoint: number, run?: Runner) {
  const outputPath = f(`out-${path.basename(input)}-${inPoint}-${outPoint}-${Math.random().toString(36).slice(2, 6)}.mp4`);
  const outcome = trimMedia({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, inputPath: input, outputPath, mimeType, inPoint, outPoint, run });
  return { outcome, outputPath, info: probeMedia(FFPROBE, outputPath)! };
}

// Keyframes every 0.5 s, so stream-copy start/end drift is bounded and testable.
const H264 = ['-c:v', 'libx264', '-g', '15', '-pix_fmt', 'yuv420p'];

let mp4Aac: string; let mp4Opus: string; let mp4Silent: string; let movAac: string; let webmOpus: string; let aviMp3: string; let fragOpus: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-trim-test-'));
  mp4Aac = make('aac.mp4', [...H264, '-c:a', 'aac']);
  mp4Opus = make('opus.mp4', [...H264, '-c:a', 'libopus']);
  mp4Silent = make('silent.mp4', [...H264, '--no-audio']);
  movAac = make('aac.mov', [...H264, '-c:a', 'aac']);
  webmOpus = make('opus.webm', ['-c:v', 'libvpx-vp9', '-c:a', 'libopus']);
  aviMp3 = make('mp3.avi', ['-c:v', 'mpeg4', '-c:a', 'libmp3lame']);
  fragOpus = make('frag-opus.mp4', [...H264, '-c:a', 'libopus', '-movflags', 'frag_keyframe+empty_moov']);
}, 120_000);

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('fixtures are what the tests say they are', () => {
  it('has the codecs under test', () => {
    expect(probeMedia(FFPROBE, mp4Opus)).toMatchObject({ videoCodec: 'h264', audioCodec: 'opus' });
    expect(probeMedia(FFPROBE, mp4Aac)).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(probeMedia(FFPROBE, mp4Silent)).toMatchObject({ videoCodec: 'h264', audioCodec: null });
    expect(probeMedia(FFPROBE, webmOpus)).toMatchObject({ videoCodec: 'vp9', audioCodec: 'opus' });
    expect(probeMedia(FFPROBE, aviMp3)).toMatchObject({ videoCodec: 'mpeg4', audioCodec: 'mp3' });
  });
});

describe('plan selection', () => {
  it('keeps the fast copy path for MP4 and QuickTime with AAC or no audio', () => {
    expect(planTrim('video/mp4', probeMedia(FFPROBE, mp4Aac)).plan).toBe('copy');
    expect(planTrim('video/mp4', probeMedia(FFPROBE, mp4Silent)).plan).toBe('copy');
    expect(planTrim('video/quicktime', probeMedia(FFPROBE, movAac)).plan).toBe('copy');
  });
  it('converts only the audio for Opus in MP4', () => {
    expect(planTrim('video/mp4', probeMedia(FFPROBE, mp4Opus)).plan).toBe('copy-video-reencode-audio');
  });
  it('re-encodes WebM and AVI, and files that cannot be inspected', () => {
    expect(planTrim('video/webm', probeMedia(FFPROBE, webmOpus)).plan).toBe('reencode');
    expect(planTrim('video/x-msvideo', probeMedia(FFPROBE, aviMp3)).plan).toBe('reencode');
    expect(planTrim('video/mp4', null).plan).toBe('reencode');
  });
});

describe('MP4 with AAC audio (compatible: stays on the copy path)', () => {
  it('copies, keeps both streams, decodes cleanly and has the right length', () => {
    const { outcome, outputPath, info } = trim(mp4Aac, 'video/mp4', 2, 5);
    expect(outcome).toMatchObject({ plan: 'copy', fellBack: false });
    expect(info).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(info.duration!).toBeGreaterThan(2.9);
    expect(info.duration!).toBeLessThan(3.7); // copy cuts on keyframes (0.5 s apart here)
    expect(decodeErrors(outputPath)).toBe('');
    expect(meanVolume(outputPath)).toBeGreaterThan(-40);
  });

  it('does not re-encode the video: its bitrate and frame size match the source exactly', () => {
    const { info, outputPath } = trim(mp4Aac, 'video/mp4', 0, 4);
    expect(info.videoCodec).toBe('h264');
    expect(videoStats(outputPath)).toEqual(videoStats(mp4Aac, true));
  });
});

describe('MP4 with Opus audio', () => {
  it('copies the video, converts the audio to AAC, and the result plays with the right length', () => {
    const { outcome, outputPath, info } = trim(mp4Opus, 'video/mp4', 2, 5);
    expect(outcome).toMatchObject({ plan: 'copy-video-reencode-audio', fellBack: false });
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
    expect(info.duration!).toBeGreaterThan(2.9);
    expect(info.duration!).toBeLessThan(3.7);
    expect(Math.abs((info.audioDuration ?? 0) - (info.videoDuration ?? 0))).toBeLessThan(0.6);
    expect(decodeErrors(outputPath)).toBe('');
  });

  it('keeps the video untouched (copied, not re-encoded) while converting the audio', () => {
    const { outputPath } = trim(mp4Opus, 'video/mp4', 0, 4);
    expect(videoStats(outputPath)).toEqual(videoStats(mp4Opus, true));
  });

  it('preserves the audio: the converted track is audible, not silent', () => {
    const { outputPath } = trim(mp4Opus, 'video/mp4', 1, 4);
    expect(meanVolume(outputPath)).toBeGreaterThan(-40);
  });

  it('handles fragmented MP4 with Opus (the source that makes FFmpeg warn "codec frame size is not set")', () => {
    const { outcome, outputPath, info } = trim(fragOpus, 'video/mp4', 1, 4);
    expect(outcome.plan).toBe('copy-video-reencode-audio');
    expect(info).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(info.duration!).toBeGreaterThan(2.9);
    expect(decodeErrors(outputPath)).toBe('');
    expect(meanVolume(outputPath)).toBeGreaterThan(-40);
  });

  it('falls back to a full re-encode when a copy-based attempt fails (e.g. an older FFmpeg refusing Opus in MP4)', () => {
    const calls: string[][] = [];
    const run: Runner = (binary, args) => {
      if (binary === FFMPEG) {
        calls.push(args);
        // Behave like an FFmpeg that cannot copy: fail whenever any stream is copied.
        if (args.includes('copy')) return { status: 1, stdout: '', stderr: 'opus in MP4 support is experimental, add -strict -2' };
      }
      return defaultRunner(binary, args);
    };
    const { outcome, outputPath, info } = trim(mp4Opus, 'video/mp4', 1, 4, run);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('libx264');
    expect(outcome).toMatchObject({ plan: 'reencode', fellBack: true });
    expect(info).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(Math.abs(info.duration! - 3)).toBeLessThan(0.3); // a re-encode is frame accurate
    expect(decodeErrors(outputPath)).toBe('');
    expect(meanVolume(outputPath)).toBeGreaterThan(-40);
  });

  it('throws when even the re-encode fails, instead of returning a broken file', () => {
    const run: Runner = (binary, args) => (binary === FFMPEG ? { status: 1, stdout: '', stderr: 'boom' } : defaultRunner(binary, args));
    expect(() => trim(mp4Opus, 'video/mp4', 1, 4, run)).toThrow(/FFmpeg trim failed/);
  });
});

describe('MP4 without audio', () => {
  it('copies and produces a video-only file', () => {
    const { outcome, outputPath, info } = trim(mp4Silent, 'video/mp4', 1, 4);
    expect(outcome).toMatchObject({ plan: 'copy', fellBack: false });
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBeNull();
    expect(info.duration!).toBeGreaterThan(2.9);
    expect(decodeErrors(outputPath)).toBe('');
  });
});

describe('existing formats', () => {
  it('QuickTime (.mov) is stream-copied into an MP4', () => {
    const { outcome, outputPath, info } = trim(movAac, 'video/quicktime', 2, 5);
    expect(outcome.plan).toBe('copy');
    expect(info).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    const format = defaultRunner(FFPROBE, ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', outputPath]).stdout;
    expect(format).toContain('mp4');
    expect(decodeErrors(outputPath)).toBe('');
  });

  it('WebM (VP9 + Opus) is re-encoded to H.264 + AAC, frame accurate', () => {
    const { outcome, outputPath, info } = trim(webmOpus, 'video/webm', 2, 5);
    expect(outcome).toMatchObject({ plan: 'reencode', fellBack: false });
    expect(info).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(Math.abs(info.duration! - 3)).toBeLessThan(0.3);
    expect(decodeErrors(outputPath)).toBe('');
    expect(meanVolume(outputPath)).toBeGreaterThan(-40);
  });

  it('AVI (MPEG-4 + MP3) is re-encoded to H.264 + AAC, frame accurate', () => {
    const { outcome, outputPath, info } = trim(aviMp3, 'video/x-msvideo', 1, 4);
    expect(outcome).toMatchObject({ plan: 'reencode', fellBack: false });
    expect(info).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(Math.abs(info.duration! - 3)).toBeLessThan(0.3);
    expect(decodeErrors(outputPath)).toBe('');
  });
});

describe('trim range handling', () => {
  it('starts the output at the requested point (checked by picture, not just length)', () => {
    // testsrc draws a running clock. A re-encoded trim from 3 s must open on the source's 3 s frame, not 0 s.
    const { outputPath } = trim(webmOpus, 'video/webm', 3, 5);
    const psnr = (a: string, aSs: number, b: string, bSs: number) => {
      const r = defaultRunner(FFMPEG, ['-hide_banner', '-ss', String(aSs), '-i', a, '-ss', String(bSs), '-i', b, '-frames:v', '1', '-lavfi', 'psnr', '-f', 'null', '-']);
      const m = /average:([\d.]+|inf)/.exec(r.stderr);
      if (!m) throw new Error(r.stderr.slice(-300));
      return m[1] === 'inf' ? 100 : Number(m[1]);
    };
    expect(psnr(outputPath, 0, webmOpus, 3)).toBeGreaterThan(psnr(outputPath, 0, webmOpus, 0) + 5);
  });

  it('builds copy, audio-only and re-encode argument lists that all end with the output path', () => {
    for (const plan of ['copy', 'copy-video-reencode-audio', 'reencode'] as const) {
      const args = ffmpegArgs(plan, 'in.mp4', 'out.mp4', 1.5, 4);
      expect(args[args.length - 1]).toBe('out.mp4');
      expect(args).toContain('+faststart');
      expect(args[args.indexOf('-t') + 1]).toBe('2.5');
    }
  });

  it('rejects invalid ranges', () => {
    expect(validateTrimRange(5, 5)).toMatch(/greater/);
    expect(validateTrimRange(5, 2)).toMatch(/greater/);
    expect(validateTrimRange(-1, 2)).toMatch(/negative/);
    expect(validateTrimRange(1, 1.05)).toMatch(/at least/);
    expect(validateTrimRange(Number.NaN, 2)).toMatch(/finite/);
    expect(validateTrimRange(0, Number.POSITIVE_INFINITY)).toMatch(/finite/);
    expect(validateTrimRange('1', 2)).toMatch(/finite/);
    expect(validateTrimRange(undefined, undefined)).toMatch(/finite/);
    expect(validateTrimRange(12, 15, 10)).toMatch(/beyond/);
  });

  it('accepts valid ranges', () => {
    expect(validateTrimRange(0, 3)).toBeNull();
    expect(validateTrimRange(2, 5, 10)).toBeNull();
    expect(validateTrimRange(9, 15, 10)).toBeNull(); // out point past the end is simply the end
  });

  it('a trim that starts past the real end of the file fails instead of returning an empty file', () => {
    expect(() => trim(mp4Aac, 'video/mp4', 20, 25)).toThrow(/FFmpeg trim failed/);
  });
});
