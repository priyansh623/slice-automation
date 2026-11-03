/**
 * Extracted FFmpeg/ffprobe utilities — kept separate so they can be imported
 * by integration tests without pulling in the full worker (DB connections, etc.).
 */

import { spawnSync } from 'node:child_process';
import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStaticModule from 'ffprobe-static';

// ffprobe-static exports { path: string } on some versions, a plain string on others
const ffprobeStaticPath: string =
  typeof ffprobeStaticModule === 'string'
    ? (ffprobeStaticModule as string)
    : (ffprobeStaticModule as unknown as { path: string }).path;

// ── Probing ───────────────────────────────────────────────────────────────────

/**
 * Probe the video-stream duration of a local file with ffprobe-static.
 * Returns seconds as a float. Throws if the file cannot be probed.
 */
export function probeVideoDuration(filePath: string): number {
  if (!ffprobeStaticPath) throw new Error('ffprobe-static binary not found');

  const result = spawnSync(
    ffprobeStaticPath,
    ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', filePath],
    { stdio: 'pipe' },
  );

  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${result.stderr?.toString().slice(-200)}`);
  }

  const raw = result.stdout?.toString().trim() ?? '';
  const duration = parseFloat(raw);
  if (isNaN(duration) || duration <= 0) {
    throw new Error(`ffprobe returned invalid duration "${raw}" for ${filePath}`);
  }
  return duration;
}

/**
 * Probe whether a file has an audio stream.
 * Returns the audio-stream duration in seconds, or null if no audio stream exists.
 */
export function probeAudioDuration(filePath: string): number | null {
  if (!ffprobeStaticPath) throw new Error('ffprobe-static binary not found');

  const result = spawnSync(
    ffprobeStaticPath,
    ['-v', 'quiet', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', filePath],
    { stdio: 'pipe' },
  );

  if (result.status !== 0) return null;
  const raw = result.stdout?.toString().trim() ?? '';
  if (!raw) return null;
  const duration = parseFloat(raw);
  return isNaN(duration) ? null : duration;
}

// ── Filter building ───────────────────────────────────────────────────────────

/**
 * Build a filter_complex string that concatenates n clips with normalised
 * timestamps and audio padding.
 *
 * Handles three audio cases:
 *  - clip has audio exactly matching video    → trim/pad to video duration (no-op)
 *  - clip has audio shorter than video        → apad extends it
 *  - clip has no audio stream                 → anullsrc generates silence
 *
 * When a clip has no audio, pass the FFmpeg input-index of the paired anullsrc
 * source in `audioInputIndices`; otherwise pass the clip's own input index.
 *
 * @param clipInputIndices   FFmpeg input index of each clip's video stream
 * @param audioInputIndices  FFmpeg input index of each clip's audio source
 * @param videoDurations     Video-stream duration (s) for each clip
 */
export function buildFilterComplex(
  clipInputIndices: number[],
  audioInputIndices: number[],
  videoDurations: number[],
): string {
  const n = clipInputIndices.length;
  const filterParts: string[] = [];

  for (let i = 0; i < n; i++) {
    const dur = videoDurations[i].toFixed(6);
    filterParts.push(`[${clipInputIndices[i]}:v]setpts=PTS-STARTPTS[v${i}]`);
    filterParts.push(
      `[${audioInputIndices[i]}:a]asetpts=PTS-STARTPTS,atrim=end=${dur},apad=whole_dur=${dur}[a${i}]`,
    );
  }

  const concatInputs = Array.from({ length: n }, (_, i) => `[v${i}][a${i}]`).join('');
  filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=1[outv][outa]`);
  return filterParts.join(';');
}

// ── Main concat function ──────────────────────────────────────────────────────

/**
 * Concatenate MP4 clips using filter_complex with ffmpeg-static.
 *
 * For clips without an audio stream, a paired anullsrc input is injected
 * so the filter_complex always has a valid audio source for every clip.
 */
export function runFfmpegFilterComplex(
  inputPaths: string[],
  outputPath: string,
  crf: number,
): void {
  if (!ffmpegStaticPath) throw new Error('ffmpeg-static binary not found');

  const n = inputPaths.length;

  // Probe audio/video for each clip
  const videoDurations = inputPaths.map(probeVideoDuration);
  const hasAudio = inputPaths.map((p) => probeAudioDuration(p) !== null);

  // Build FFmpeg input list, inserting anullsrc before any video-only clip
  const inputArgs: string[] = [];
  const clipInputIndices: number[] = [];
  const audioInputIndices: number[] = [];
  let idx = 0;

  for (let i = 0; i < n; i++) {
    if (!hasAudio[i]) {
      // Inject a long-enough silence source before the clip
      inputArgs.push('-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`);
      audioInputIndices.push(idx++);
    }
    inputArgs.push('-i', inputPaths[i]);
    clipInputIndices.push(idx);
    if (hasAudio[i]) {
      audioInputIndices.push(idx); // clip provides its own audio
    }
    idx++;
  }

  const filterComplex = buildFilterComplex(clipInputIndices, audioInputIndices, videoDurations);

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-preset', 'fast',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];

  const result = spawnSync(ffmpegStaticPath, args, { stdio: 'pipe' });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    throw new Error(`FFmpeg exited with code ${result.status}: ${stderr.slice(-800)}`);
  }
}
