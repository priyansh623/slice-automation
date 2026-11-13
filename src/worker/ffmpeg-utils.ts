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

export interface VideoGeometry { width: number; height: number; fps: number }

/**
 * Probe a clip's frame size and frame rate. Returns null if it cannot be read (the caller then skips normalisation
 * rather than failing: the plain concat still works when all clips happen to match).
 */
export function probeVideoGeometry(filePath: string): VideoGeometry | null {
  if (!ffprobeStaticPath) return null;
  const result = spawnSync(
    ffprobeStaticPath,
    ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', filePath],
    { stdio: 'pipe' },
  );
  if (result.status !== 0) return null;
  try {
    const stream = (JSON.parse(result.stdout?.toString() ?? '{}') as { streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }> }).streams?.[0];
    if (!stream?.width || !stream.height || !stream.r_frame_rate) return null;
    const [n, d] = stream.r_frame_rate.split('/').map(Number);
    const fps = d ? n / d : n;
    return fps > 0 && isFinite(fps) ? { width: stream.width, height: stream.height, fps } : null;
  } catch {
    return null;
  }
}

const sameGeometry = (a: VideoGeometry, b: VideoGeometry) => a.width === b.width && a.height === b.height && Math.abs(a.fps - b.fps) < 0.01;

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
  /**
   * Only when the clips differ in frame size or frame rate: every clip is scaled to fit this size (keeping its
   * proportions, padded with black) and set to this frame rate so the concat filter accepts them. Omitted when the
   * clips already match, which leaves the filter exactly as it always was.
   */
  normalizeTo?: VideoGeometry,
): string {
  const n = clipInputIndices.length;
  const filterParts: string[] = [];

  for (let i = 0; i < n; i++) {
    const dur = videoDurations[i].toFixed(6);
    const normalize = normalizeTo
      ? `scale=${normalizeTo.width}:${normalizeTo.height}:force_original_aspect_ratio=decrease,pad=${normalizeTo.width}:${normalizeTo.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${normalizeTo.fps.toFixed(3)},`
      : '';
    filterParts.push(`[${clipInputIndices[i]}:v]${normalize}setpts=PTS-STARTPTS[v${i}]`);
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
export const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

export function runFfmpegFilterComplex(
  inputPaths: string[],
  outputPath: string,
  crf: number,
  /** FFmpeg is killed if it runs longer than this. Without a limit a hung encode would freeze the whole worker. */
  timeoutMs: number = FFMPEG_TIMEOUT_MS,
): void {
  if (!ffmpegStaticPath) throw new Error('ffmpeg-static binary not found');

  const n = inputPaths.length;

  // Probe audio/video for each clip
  const videoDurations = inputPaths.map(probeVideoDuration);
  const hasAudio = inputPaths.map((p) => probeAudioDuration(p) !== null);

  // Clips made at different sizes or frame rates cannot go straight into the concat filter. Normalise only then.
  const geometries = inputPaths.map(probeVideoGeometry);
  const known = geometries.filter((g): g is VideoGeometry => g !== null);
  const normalizeTo = known.length > 0 && known.some((g) => !sameGeometry(g, known[0])) ? known[0] : undefined;

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
    // One decoder thread per input: all clips are open at once, and decoder threads multiply memory on a small worker.
    inputArgs.push('-threads', '1', '-i', inputPaths[i]);
    clipInputIndices.push(idx);
    if (hasAudio[i]) {
      audioInputIndices.push(idx); // clip provides its own audio
    }
    idx++;
  }

  const filterComplex = buildFilterComplex(clipInputIndices, audioInputIndices, videoDurations, normalizeTo);

  const args = [
    '-y',
    // No stdin, no progress lines, errors only: keeps the captured output small and the error message useful.
    '-nostdin', '-nostats', '-loglevel', 'error',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-preset', 'veryfast',
    // The worker is a small instance (512 MB). Measured peak memory for 8 clips of 720x1280: 217 MiB with 2 encoder
    // threads, 195 MiB with 1, 179 MiB with 1 plus a short rate-control lookahead. Extra threads do not make it faster
    // on a fraction of a CPU, so keep everything single-threaded.
    '-threads', '1',
    '-filter_threads', '1',
    '-filter_complex_threads', '1',
    '-x264-params', 'rc-lookahead=5',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ];

  const result = spawnSync(ffmpegStaticPath, args, { stdio: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') throw new Error(`FFmpeg ran for more than ${Math.round(timeoutMs / 1000)} s and was stopped`);
    throw new Error(`FFmpeg could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    throw new Error(`FFmpeg exited with code ${result.status}: ${stderr.slice(-800)}`);
  }
}
