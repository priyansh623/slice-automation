/** Synthetic video and audio made with the bundled FFmpeg, for compositor tests: solid colours so a pixel proves which video is showing. */
import { spawnSync } from 'node:child_process';
import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStaticModule from 'ffprobe-static';

const ffmpeg = ffmpegStaticPath as string;
const ffprobe: string = typeof ffprobeStaticModule === 'string' ? (ffprobeStaticModule as string) : (ffprobeStaticModule as unknown as { path: string }).path;

export function run(args: string[], opts: { binary?: string; input?: Buffer } = {}): Buffer {
  const r = spawnSync(opts.binary ?? ffmpeg, args, { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, input: opts.input });
  if (r.status !== 0) throw new Error(`${opts.binary ?? 'ffmpeg'} ${args.slice(0, 6).join(' ')} failed: ${r.stderr?.toString().slice(-400)}`);
  return r.stdout;
}

export interface SolidSpec { file: string; color: string; width: number; height: number; fps: number; seconds: number; audioHz?: number | null; startOffset?: number }
/** A solid-colour H.264 clip, optionally with a sine tone (AAC). `audioHz: null` = no audio stream. */
export function makeSolid(s: SolidSpec): string {
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${s.color}:s=${s.width}x${s.height}:r=${s.fps}:d=${s.seconds}`];
  if (s.audioHz != null) args.push('-f', 'lavfi', '-i', `sine=frequency=${s.audioHz}:sample_rate=44100:duration=${s.seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', String(s.fps));
  if (s.audioHz != null) args.push('-c:a', 'aac', '-b:a', '128k');
  if (s.startOffset) args.push('-output_ts_offset', String(s.startOffset));
  args.push('-shortest', s.file);
  run(args);
  return s.file;
}

/** The colour of the pixel at the middle of the frame at time `t` (seconds), as [r, g, b]. */
export function pixelAt(file: string, t: number): [number, number, number] {
  const out = run(['-loglevel', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'crop=2:2:in_w/2:in_h/2,scale=1:1,format=rgb24', '-f', 'rawvideo', '-']);
  return [out[0], out[1], out[2]];
}
export const isColor = (p: [number, number, number], want: 'red' | 'blue' | 'green' | 'yellow'): boolean => {
  const [r, g, b] = p; const hi = (v: number) => v > 150; const lo = (v: number) => v < 110;
  return want === 'red' ? hi(r) && lo(g) && lo(b) : want === 'blue' ? hi(b) && lo(r) && lo(g) : want === 'green' ? g > 90 && g > r + 60 && g > b + 60 : hi(r) && hi(g) && lo(b);
};

/** A hash of the audio packets, copied without re-encoding: equal hashes mean the audio stream is bit-for-bit the same. */
export function audioHash(file: string): string {
  return run(['-loglevel', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
}
export function probeJson(file: string): { streams: Array<Record<string, string>>; format: Record<string, string> } {
  return JSON.parse(run(['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,start_time,duration,nb_frames:format=duration', '-of', 'json', file], { binary: ffprobe }).toString());
}
