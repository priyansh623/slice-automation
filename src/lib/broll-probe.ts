import { spawnSync } from 'node:child_process';

interface FfprobeStream {
  width?: number; height?: number;
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}

/**
 * Best-effort look at a video with ffprobe: display size (rotation applied, so iPhone portrait clips count as portrait)
 * and duration in whole seconds. `input` is a file path or an https URL (ffprobe then reads only what it needs).
 * Anything that cannot be read gives null, so a probe problem never blocks an upload by itself.
 */
export function probeVideo(input: string, timeoutMs = 30_000): { dims: { width: number; height: number } | null; durationSeconds: number | null } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('ffprobe-static') as string | { path: string };
    const ffprobePath = typeof mod === 'string' ? mod : mod.path;
    if (!ffprobePath) return { dims: null, durationSeconds: null };
    const r = spawnSync(ffprobePath, ['-v', 'quiet', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', input], { stdio: 'pipe', timeout: timeoutMs });
    if (r.status !== 0) return { dims: null, durationSeconds: null };
    const json = JSON.parse(r.stdout?.toString().trim() || '{}') as { streams?: FfprobeStream[]; format?: { duration?: string } };
    const stream = json.streams?.[0];
    const d = parseFloat(json.format?.duration ?? '');
    const durationSeconds = Number.isFinite(d) && d > 0 ? Math.round(d) : null;
    if (!stream || !stream.width || !stream.height || stream.width <= 0 || stream.height <= 0) return { dims: null, durationSeconds };
    let { width, height } = stream;
    let rotation = stream.tags?.rotate ? parseInt(stream.tags.rotate, 10) : 0;
    const dm = stream.side_data_list?.find((sd) => sd.side_data_type === 'Display Matrix');
    if (dm?.rotation !== undefined) rotation = dm.rotation;
    rotation = ((rotation % 360) + 360) % 360;
    if (rotation === 90 || rotation === 270) [width, height] = [height, width];
    return { dims: { width, height }, durationSeconds };
  } catch {
    return { dims: null, durationSeconds: null };
  }
}

/** True when the video is portrait 9:16 within the same tolerance the server-side upload uses. */
export const isPortrait916 = (dims: { width: number; height: number }): boolean => Math.abs(dims.width / dims.height - 9 / 16) <= 0.05;
