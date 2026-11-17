/**
 * Compositing B-roll overlays onto the finished Google Flow video.
 *
 * The base video (all Flow scenes joined, with their own embedded voiceover) is produced by the existing compile path, unchanged.
 * This pass only runs when a compilation has overlays. It never concatenates B-roll into the sequence: it draws each overlay over
 * the base for its window, and the base shows through again when the window ends.
 *
 * What it guarantees, and how:
 *  - The narration is untouched: overlay inputs are read with -an and never mapped, and the base's audio is a stream COPY (only if
 *    the base's audio is not AAC is it re-encoded, which still never involves an overlay). Tests compare the audio before and after.
 *  - Duration is the base's: the output is cut at the base's video length.
 *  - A/V sync: the base video's own timestamps are never altered (no setpts on the base), so the offset between its video and
 *    audio is exactly what it was. Overlay windows are placed on the base video's own clock (including a non-zero start_time).
 *  - Memory: one process, every input single-threaded, one base input plus the overlays (each a small normalised 720p clip).
 *    More overlays than `MAX_OVERLAYS_PER_PASS` are composited in successive passes so the number of open inputs stays bounded.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStaticModule from 'ffprobe-static';
import { runWithKillTimeout, FFMPEG_TIMEOUT_MS } from './ffmpeg-utils';

const ffprobePath: string = typeof ffprobeStaticModule === 'string' ? (ffprobeStaticModule as string) : (ffprobeStaticModule as unknown as { path: string }).path;

/** The most overlays drawn in one FFmpeg process. Each is an extra open decoder; more are done in successive passes. Raise only after measuring. */
export const MAX_OVERLAYS_PER_PASS = 4;

export interface ClipInfo {
  width: number; height: number; fps: number;
  /** Video stream duration in seconds. */
  durationSec: number;
  /** The video stream's start time on the container clock, in seconds. */
  videoStartSec: number;
  hasAudio: boolean;
  audioCodec: string | null;
  audioStartSec: number | null;
  audioDurationSec: number | null;
}

/** Everything the compositor needs to know about a file, from one ffprobe call. */
export function probeClip(file: string): ClipInfo {
  const r = spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,start_time,duration:format=duration', '-of', 'json', file], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`ffprobe failed for ${path.basename(file)}: ${r.stderr?.toString().slice(-200)}`);
  const j = JSON.parse(r.stdout.toString()) as { streams?: Array<Record<string, string | number>>; format?: { duration?: string } };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`${path.basename(file)} has no video stream`);
  const rate = (s: string | number | undefined) => { const [n, d] = String(s ?? '0/1').split('/').map(Number); return d ? n / d : n; };
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate);
  const dur = parseFloat(String(v.duration ?? j.format?.duration ?? '0'));
  if (!(dur > 0) || !(fps > 0) || !v.width || !v.height) throw new Error(`${path.basename(file)} could not be measured (${dur}s, ${fps}fps)`);
  return {
    width: Number(v.width), height: Number(v.height), fps, durationSec: dur,
    videoStartSec: parseFloat(String(v.start_time ?? '0')) || 0,
    hasAudio: !!a, audioCodec: a ? String(a.codec_name) : null,
    audioStartSec: a ? parseFloat(String(a.start_time ?? '0')) || 0 : null,
    audioDurationSec: a ? parseFloat(String(a.duration ?? '0')) || null : null,
  };
}

export interface CompositeOverlay {
  id: number;
  track: number;
  /** On the base video's clock, in milliseconds, measured from the start of the base video. */
  startMs: number;
  endMs: number;
  /** Where in the overlay clip it starts playing. */
  sourceStartMs: number;
  file: string;
}

const sec = (ms: number): string => (ms / 1000).toFixed(6);

/** The filter graph for one pass. Pure, so it can be tested as a string. */
export function buildOverlayFilterComplex(base: Pick<ClipInfo, 'width' | 'height' | 'fps' | 'videoStartSec'>, overlays: readonly CompositeOverlay[]): string {
  const { width: W, height: H, fps } = base;
  const parts: string[] = [];
  let last = '0:v';
  overlays.forEach((o, i) => {
    const input = i + 1;
    // Cover the whole frame (crop what overflows), match the base's frame rate and pixel format, and start its first frame at the
    // start of its window on the base video's own clock.
    const start = base.videoStartSec + o.startMs / 1000;
    const end = base.videoStartSec + o.endMs / 1000;
    parts.push(`[${input}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS+${start.toFixed(6)}/TB[ov${i}]`);
    const out = i === overlays.length - 1 ? 'vout' : `v${i}`;
    parts.push(`[${last}][ov${i}]overlay=0:0:enable='between(t,${start.toFixed(6)},${end.toFixed(6)})':eof_action=pass:format=yuv420[${out}]`);
    last = out;
  });
  return parts.join(';');
}

export function buildOverlayArgs(base: ClipInfo, overlays: readonly CompositeOverlay[], basePath: string, outputPath: string, crf: number): string[] {
  const inputs: string[] = ['-threads', '1', '-i', basePath];
  for (const o of overlays) {
    // -an: the overlay's audio is never even decoded. -ss/-t cut the part that is shown.
    inputs.push('-an', '-threads', '1', '-ss', sec(o.sourceStartMs), '-t', sec(o.endMs - o.startMs), '-i', o.file);
  }
  const audio = !base.hasAudio ? ['-an'] : base.audioCodec === 'aac' ? ['-map', '0:a', '-c:a', 'copy'] : ['-map', '0:a', '-c:a', 'aac', '-b:a', '128k'];
  return [
    '-y', '-nostdin', '-nostats', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', buildOverlayFilterComplex(base, overlays),
    '-map', '[vout]', ...audio,
    '-c:v', 'libx264', '-crf', String(crf), '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', '-x264-params', 'rc-lookahead=5',
    '-fps_mode', 'cfr', '-t', base.durationSec.toFixed(6),
    '-movflags', '+faststart',
    outputPath,
  ];
}

export interface CompositeResult { passes: number; overlays: number; durationSec: number; elapsedMs: number }

/** Draws the overlays over `basePath`, writing `outputPath`. The base file is never modified. */
export function compositeOverlaysSync(basePath: string, outputPath: string, overlays: readonly CompositeOverlay[], crf: number, timeoutMs = FFMPEG_TIMEOUT_MS, workDir?: string): CompositeResult {
  if (!ffmpegStaticPath) throw new Error('ffmpeg-static binary not found');
  if (overlays.length === 0) throw new Error('compositeOverlays needs at least one overlay');
  const began = Date.now();
  const sorted = [...overlays].sort((a, b) => a.track - b.track || a.startMs - b.startMs || a.id - b.id);
  const dir = workDir ?? path.dirname(outputPath);
  // Overlays are drawn in track order; passes keep that order (a later pass draws on top of an earlier one).
  const groups: CompositeOverlay[][] = [];
  for (let i = 0; i < sorted.length; i += MAX_OVERLAYS_PER_PASS) groups.push(sorted.slice(i, i + MAX_OVERLAYS_PER_PASS));
  let current = basePath;
  const temps: string[] = [];
  try {
    groups.forEach((group, i) => {
      const info = probeClip(current);
      const out = i === groups.length - 1 ? outputPath : path.join(dir, `composite-pass-${i}-${process.pid}.mp4`);
      if (out !== outputPath) temps.push(out);
      const run = runWithKillTimeout(ffmpegStaticPath as string, buildOverlayArgs(info, group, current, out, crf), timeoutMs);
      if (run.timedOut) throw new Error(`FFmpeg ran for more than ${Math.round(timeoutMs / 1000)} s while adding B-roll and was stopped`);
      if (run.spawnError) throw new Error(`FFmpeg could not be run: ${run.spawnError}`);
      if (run.status !== 0) throw new Error(`FFmpeg exited with code ${run.status} while adding B-roll: ${run.stderr.slice(-800)}`);
      current = out;
    });
  } finally {
    for (const t of temps) void fs.rm(t, { force: true }).catch(() => {});
  }
  return { passes: groups.length, overlays: overlays.length, durationSec: probeClip(outputPath).durationSec, elapsedMs: Date.now() - began };
}

// ── Making the silent, normalised project copy of a clip ─────────────────────────────────────────

export const NORMALISED_WIDTH = 720;
export const NORMALISED_HEIGHT = 1280;
export const NORMALISED_FPS = 30;

export interface NormaliseResult { width: number; height: number; fps: number; durationMs: number; bytes: number }

/**
 * Writes a silent H.264 copy of `inputPath` that fills 720x1280 (cropping what overflows), at 30 fps, with a keyframe every second so
 * cutting into it is exact. The input is only read. Audio is dropped here, so a project copy can never carry sound.
 */
export async function normaliseOverlayClipSync(inputPath: string, outputPath: string, timeoutMs = FFMPEG_TIMEOUT_MS): Promise<NormaliseResult> {
  if (!ffmpegStaticPath) throw new Error('ffmpeg-static binary not found');
  probeClip(inputPath); // fails early, with a readable message, for a file that is not a video
  const args = [
    '-y', '-nostdin', '-nostats', '-loglevel', 'error', '-threads', '1', '-i', inputPath,
    '-an', '-sn', '-dn',
    '-vf', `scale=${NORMALISED_WIDTH}:${NORMALISED_HEIGHT}:force_original_aspect_ratio=increase,crop=${NORMALISED_WIDTH}:${NORMALISED_HEIGHT},setsar=1,fps=${NORMALISED_FPS},format=yuv420p`,
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-g', String(NORMALISED_FPS), '-keyint_min', String(NORMALISED_FPS), '-sc_threshold', '0',
    '-threads', '1', '-filter_threads', '1', '-x264-params', 'rc-lookahead=5', '-movflags', '+faststart', outputPath,
  ];
  const run = runWithKillTimeout(ffmpegStaticPath, args, timeoutMs);
  if (run.timedOut) throw new Error(`FFmpeg ran for more than ${Math.round(timeoutMs / 1000)} s while preparing the clip and was stopped`);
  if (run.spawnError) throw new Error(`FFmpeg could not be run: ${run.spawnError}`);
  if (run.status !== 0) throw new Error(`FFmpeg could not prepare the clip: ${run.stderr.slice(-600)}`);
  const info = probeClip(outputPath);
  if (info.hasAudio) throw new Error('The prepared clip unexpectedly has an audio stream');
  const stat = await fs.stat(outputPath);
  return { width: info.width, height: info.height, fps: info.fps, durationMs: Math.round(info.durationSec * 1000), bytes: stat.size };
}

/** A scratch directory under the OS temp dir. The caller removes it. */
export const makeWorkDir = (label: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), `soma-${label}-`));
