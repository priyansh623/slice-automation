/**
 * FFmpeg integration tests — uses the real ffmpeg-static and ffprobe-static
 * binaries to create synthetic test clips and verify the compiled output.
 *
 * These tests do NOT require a database or network. They only require the
 * ffmpeg-static and ffprobe-static npm packages (already in dependencies).
 *
 * What is tested:
 *  - Clip with short audio (2s audio in a 4s video) → audio padded to 4s
 *  - Clip with long audio (6s audio in a 3s video)  → audio trimmed to 3s
 *  - Clip with no audio stream (silent)             → anullsrc injected
 *  - Output audio/video duration difference < 100 ms
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStaticModule from 'ffprobe-static';

// ffprobe-static exports { path: string } on some versions, plain string on others
const ffprobeStaticPath: string =
  typeof ffprobeStaticModule === 'string'
    ? (ffprobeStaticModule as string)
    : (ffprobeStaticModule as unknown as { path: string }).path;

// ── Helpers ───────────────────────────────────────────────────────────────────

function probeDuration(filePath: string, streamSpec: 'v:0' | 'a:0'): number | null {
  const result = spawnSync(
    ffprobeStaticPath,
    [
      '-v', 'quiet',
      '-select_streams', streamSpec,
      '-show_entries', 'stream=duration',
      '-of', 'csv=p=0',
      filePath,
    ],
    { stdio: 'pipe' },
  );
  if (result.status !== 0) return null;
  const raw = result.stdout?.toString().trim() ?? '';
  if (!raw) return null;
  const d = parseFloat(raw);
  return isNaN(d) ? null : d;
}

/** Create a synthetic clip using ffmpeg lavfi sources. */
function createTestClip(opts: {
  outPath: string;
  videoDuration: number;  // seconds
  audioDuration?: number; // seconds — omit for a video-only (silent) clip
}): void {
  if (!ffmpegStaticPath) throw new Error('ffmpeg-static not found');

  const { outPath, videoDuration, audioDuration } = opts;

  const args: string[] = ['-y'];

  if (audioDuration !== undefined) {
    // Audio source: sine wave, exactly audioDuration long
    args.push(
      '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${audioDuration}`,
    );
  }

  // Video source: colour bars, exactly videoDuration long
  args.push(
    '-f', 'lavfi',
    '-i', `color=c=blue:size=128x72:rate=24:duration=${videoDuration}`,
  );

  if (audioDuration !== undefined) {
    // Map both streams
    args.push('-map', '1:v', '-map', '0:a');
  } else {
    // Map only video
    args.push('-map', '0:v');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '40',
    ...(audioDuration !== undefined ? ['-c:a', 'aac', '-b:a', '64k'] : []),
    outPath,
  );

  const result = spawnSync(ffmpegStaticPath!, args, { stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed creating ${outPath}: ${result.stderr?.toString().slice(-400)}`,
    );
  }
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ffmpeg-utils integration — real binary synthesis and probing', () => {
  it('creates a synthetic clip with video and audio streams', () => {
    const outPath = path.join(tmpDir, 'test-clip.mp4');
    createTestClip({ outPath, videoDuration: 3, audioDuration: 3 });

    expect(fs.existsSync(outPath)).toBe(true);

    const vDur = probeDuration(outPath, 'v:0');
    const aDur = probeDuration(outPath, 'a:0');

    expect(vDur).not.toBeNull();
    expect(aDur).not.toBeNull();
    expect(vDur!).toBeGreaterThan(2.9);
    expect(aDur!).toBeGreaterThan(2.9);
  });

  it('creates a silent (video-only) clip with no audio stream', () => {
    const outPath = path.join(tmpDir, 'silent-clip.mp4');
    createTestClip({ outPath, videoDuration: 3 }); // no audioDuration

    const vDur = probeDuration(outPath, 'v:0');
    const aDur = probeDuration(outPath, 'a:0');

    expect(vDur).not.toBeNull();
    expect(vDur!).toBeGreaterThan(2.9);
    // No audio stream
    expect(aDur).toBeNull();
  });
});

describe('ffmpeg-utils integration — concat with mixed audio', () => {
  let shortAudioClip: string; // 4s video, 2s audio
  let longAudioClip: string;  // 3s video, 5s audio
  let silentClip: string;     // 3s video, no audio
  let outputPath: string;

  beforeAll(() => {
    shortAudioClip = path.join(tmpDir, 'clip-short-audio.mp4');
    longAudioClip  = path.join(tmpDir, 'clip-long-audio.mp4');
    silentClip     = path.join(tmpDir, 'clip-silent.mp4');
    outputPath     = path.join(tmpDir, 'concat-output.mp4');

    // Create the three test clips
    createTestClip({ outPath: shortAudioClip, videoDuration: 4, audioDuration: 2 });
    createTestClip({ outPath: longAudioClip,  videoDuration: 3, audioDuration: 5 });
    createTestClip({ outPath: silentClip,     videoDuration: 3 }); // no audio
  });

  it('concatenates three clips with mixed audio types without error', async () => {
    // Import lazily so module cache is fresh
    const { runFfmpegFilterComplex } = await import('../worker/ffmpeg-utils.js');

    expect(() => {
      runFfmpegFilterComplex(
        [shortAudioClip, longAudioClip, silentClip],
        outputPath,
        /* crf */ 40,
      );
    }).not.toThrow();

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);
  });

  it('output has both video and audio streams', async () => {
    const vDur = probeDuration(outputPath, 'v:0');
    const aDur = probeDuration(outputPath, 'a:0');

    expect(vDur).not.toBeNull();
    expect(aDur).not.toBeNull();
  });

  it('output video duration is approximately 10 seconds (4 + 3 + 3)', async () => {
    const vDur = probeDuration(outputPath, 'v:0');
    expect(vDur).not.toBeNull();
    // Allow ±0.5s for encoder/frame rounding
    expect(vDur!).toBeGreaterThan(9.5);
    expect(vDur!).toBeLessThan(10.5);
  });

  it('audio/video stream durations differ by less than 100 ms', async () => {
    const vDur = probeDuration(outputPath, 'v:0');
    const aDur = probeDuration(outputPath, 'a:0');

    expect(vDur).not.toBeNull();
    expect(aDur).not.toBeNull();

    const diffMs = Math.abs(vDur! - aDur!) * 1000;
    expect(diffMs).toBeLessThan(100);
  });

  it('short-audio clip: audio was padded up to video duration in the output', async () => {
    /**
     * In the concat output, the first 4 seconds should have continuous audio
     * (padded from the 2s original). We verify indirectly: the full output
     * audio duration covers the expected total, so no early truncation occurred.
     */
    const aDur = probeDuration(outputPath, 'a:0');
    expect(aDur).not.toBeNull();
    // If short audio was not padded, total audio would stop at 2+3+0=5s instead of 10s
    expect(aDur!).toBeGreaterThan(9.5);
  });

  it('long-audio clip: audio was trimmed to video duration in the output', async () => {
    /**
     * If audio from clip 2 (5s) were not trimmed, the total would be
     * 4 + 5 + 3 = 12s instead of 10s. Verify the total is ≈ 10s.
     */
    const aDur = probeDuration(outputPath, 'a:0');
    expect(aDur).not.toBeNull();
    expect(aDur!).toBeLessThan(10.5);
  });

  it('silent clip: anullsrc generates valid audio in the output', async () => {
    /**
     * The silent clip has no audio stream. The worker injects anullsrc.
     * Verify the final output has continuous audio by checking total duration.
     * If anullsrc injection failed, the concat filter would error.
     */
    const aDur = probeDuration(outputPath, 'a:0');
    expect(aDur).not.toBeNull();
    expect(aDur!).toBeGreaterThan(9.5);
  });
});
