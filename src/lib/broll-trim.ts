/**
 * B-roll trimming with FFmpeg.
 *
 * The output is always an MP4 that plays in a browser. Three plans, cheapest first:
 *   copy                     stream-copy everything (no quality loss, near instant)
 *   copy-video-reencode-audio  copy the video, re-encode only the audio to AAC
 *   reencode                 H.264 + AAC
 *
 * Plan choice comes from what is actually inside the file (ffprobe), not from the MIME type alone, because a file
 * labelled video/mp4 can carry audio MP4 players do not handle. Opus in MP4 is the known case: FFmpeg can copy
 * it, but older FFmpeg builds refuse without `-strict -2`, fragmented sources produce "codec frame size is not
 * set", and Safari / QuickTime-class players do not reliably play it. Opus audio is therefore re-encoded to AAC
 * while the video is still copied.
 *
 * If a copy-based plan fails, or its output does not pass validation, the trim is retried once with a full
 * re-encode. The result is checked with ffprobe (video stream present, audio present when the source had it,
 * sensible duration) before it is returned.
 */
import { spawnSync } from 'node:child_process';

export type TrimPlan = 'copy' | 'copy-video-reencode-audio' | 'reencode';

export interface MediaInfo {
  videoCodec: string | null;
  audioCodec: string | null;
  duration: number | null;
  videoDuration: number | null;
  audioDuration: number | null;
}

export interface RunResult { status: number | null; stdout: string; stderr: string }
export type Runner = (binary: string, args: string[]) => RunResult;

export const defaultRunner: Runner = (binary, args) => {
  const r = spawnSync(binary, args, { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '' };
};

// Containers whose streams can be remuxed into an MP4 with `-c copy`.
const COPY_CONTAINER_MIMES = new Set(['video/mp4', 'video/quicktime']);
// Codecs that are safe to stream-copy into an MP4 that has to play in a browser.
const COPY_SAFE_VIDEO = new Set(['h264', 'hevc', 'mpeg4']);
const COPY_SAFE_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);

export const MIN_TRIM_SECONDS = 0.1;

export function validateTrimRange(inPoint: unknown, outPoint: unknown, knownDurationSeconds?: number | null): string | null {
  if (typeof inPoint !== 'number' || typeof outPoint !== 'number' || !Number.isFinite(inPoint) || !Number.isFinite(outPoint)) {
    return 'inPoint and outPoint must be finite numbers';
  }
  if (inPoint < 0) return 'inPoint cannot be negative';
  if (outPoint <= inPoint) return 'outPoint must be greater than inPoint';
  if (outPoint - inPoint < MIN_TRIM_SECONDS) return `The trimmed section must be at least ${MIN_TRIM_SECONDS} seconds`;
  if (typeof knownDurationSeconds === 'number' && knownDurationSeconds > 0 && inPoint >= knownDurationSeconds) {
    return 'inPoint is beyond the end of the clip';
  }
  return null;
}

export function probeMedia(ffprobePath: string, file: string, run: Runner = defaultRunner): MediaInfo | null {
  const r = run(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration:format=duration', '-of', 'json', file]);
  if (r.status !== 0) return null;
  try {
    const json = JSON.parse(r.stdout) as { streams?: { codec_type?: string; codec_name?: string; duration?: string }[]; format?: { duration?: string } };
    const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
    const video = json.streams?.find((s) => s.codec_type === 'video');
    const audio = json.streams?.find((s) => s.codec_type === 'audio');
    return {
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      duration: num(json.format?.duration),
      videoDuration: num(video?.duration),
      audioDuration: num(audio?.duration),
    };
  } catch {
    return null;
  }
}

export function planTrim(mimeType: string, info: MediaInfo | null): { plan: TrimPlan; reason: string } {
  if (!COPY_CONTAINER_MIMES.has(mimeType)) return { plan: 'reencode', reason: `${mimeType} cannot be stream-copied into an MP4` };
  if (!info || !info.videoCodec) return { plan: 'reencode', reason: 'the file could not be inspected' };
  if (!COPY_SAFE_VIDEO.has(info.videoCodec)) return { plan: 'reencode', reason: `video codec ${info.videoCodec} is not safe to copy into an MP4` };
  if (info.audioCodec === null || COPY_SAFE_AUDIO.has(info.audioCodec)) return { plan: 'copy', reason: 'video and audio are MP4-compatible' };
  return { plan: 'copy-video-reencode-audio', reason: `${info.audioCodec} audio is not reliably playable in an MP4; copying the video and converting the audio to AAC` };
}

export function ffmpegArgs(plan: TrimPlan, inputPath: string, outputPath: string, inPoint: number, outPoint: number): string[] {
  const codec =
    plan === 'copy' ? ['-c', 'copy']
      : plan === 'copy-video-reencode-audio' ? ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k']
        : ['-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k'];
  return ['-y', '-ss', String(inPoint), '-i', inputPath, '-t', String(outPoint - inPoint), ...codec, '-movflags', '+faststart', outputPath];
}

export interface TrimOptions {
  ffmpegPath: string;
  ffprobePath: string;
  inputPath: string;
  outputPath: string;
  mimeType: string;
  inPoint: number;
  outPoint: number;
  run?: Runner;
}

export interface TrimOutcome {
  plan: TrimPlan;
  reason: string;
  /** True when a copy-based plan failed or failed validation and a full re-encode produced the output. */
  fellBack: boolean;
  output: MediaInfo;
}

// Stream copy can only cut on keyframes, so the output may run a little long. A re-encode is frame accurate.
const COPY_DURATION_SLACK_S = 2.5;
const REENCODE_DURATION_SLACK_S = 0.5;

/** Returns a reason the output is not acceptable, or null when it is. */
export function validateOutput(source: MediaInfo | null, output: MediaInfo | null, requestedSeconds: number, plan: TrimPlan): string | null {
  if (!output || !output.videoCodec) return 'the output has no video stream';
  if (source?.audioCodec && !output.audioCodec) return 'the source has audio but the output does not';
  const duration = output.duration ?? output.videoDuration;
  if (duration === null || duration <= 0) return 'the output has no duration';
  const slack = plan === 'reencode' ? REENCODE_DURATION_SLACK_S : COPY_DURATION_SLACK_S;
  // A clip shorter than the requested range ends early; anything longer than request + slack is wrong.
  if (duration > requestedSeconds + slack) return `the output is ${duration.toFixed(2)}s, longer than the ${requestedSeconds.toFixed(2)}s requested`;
  return null;
}

export function trimMedia(opts: TrimOptions): TrimOutcome {
  const run = opts.run ?? defaultRunner;
  const requested = opts.outPoint - opts.inPoint;
  const source = probeMedia(opts.ffprobePath, opts.inputPath, run);
  const first = planTrim(opts.mimeType, source);

  const attempt = (plan: TrimPlan): { ok: boolean; why: string; output: MediaInfo | null } => {
    const r = run(opts.ffmpegPath, ffmpegArgs(plan, opts.inputPath, opts.outputPath, opts.inPoint, opts.outPoint));
    if (r.status !== 0) return { ok: false, why: `ffmpeg exited with ${r.status}: ${r.stderr.slice(-300)}`, output: null };
    const output = probeMedia(opts.ffprobePath, opts.outputPath, run);
    const problem = validateOutput(source, output, requested, plan);
    return problem ? { ok: false, why: problem, output } : { ok: true, why: '', output };
  };

  const a = attempt(first.plan);
  if (a.ok) return { plan: first.plan, reason: first.reason, fellBack: false, output: a.output! };

  if (first.plan !== 'reencode') {
    const b = attempt('reencode');
    if (b.ok) return { plan: 'reencode', reason: `${first.plan} failed (${a.why}); re-encoded instead`, fellBack: true, output: b.output! };
    throw new Error(`FFmpeg trim failed: ${b.why}`);
  }
  throw new Error(`FFmpeg trim failed: ${a.why}`);
}
