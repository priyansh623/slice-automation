/**
 * Joins already-stored clips with FFmpeg. Used when a compilation includes clips that the useapi.net concatenate
 * endpoint cannot take (older generations without a mediaGenerationId). It works from the clips' stored MP4 files, so
 * it spends no useapi.net credits and never regenerates or changes a clip.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFfmpegFilterComplex } from './ffmpeg-utils';

export interface FfmpegClip {
  /** Storage path of the clip's MP4 in the 'videos' bucket. */
  storagePath: string;
}

export interface FfmpegCompileDeps {
  download: (storagePath: string) => Promise<Buffer>;
  /** Defaults to the real FFmpeg runner; tests replace it. */
  run?: (inputPaths: string[], outputPath: string, crf: number) => void;
}

export async function compileWithFfmpeg(clips: FfmpegClip[], crf: number, deps: FfmpegCompileDeps): Promise<Buffer> {
  const run = deps.run ?? runFfmpegFilterComplex;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-compile-'));
  try {
    const inputs: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      let bytes: Buffer;
      try {
        bytes = await deps.download(clips[i].storagePath);
      } catch (err) {
        throw new Error(`Could not read the stored video for clip ${i + 1}: ${(err as Error).message}`);
      }
      const file = path.join(dir, `clip-${i}.mp4`);
      await fs.writeFile(file, bytes);
      inputs.push(file);
    }
    const output = path.join(dir, 'compiled.mp4');
    run(inputs, output, crf);
    const result = await fs.readFile(output);
    if (result.length === 0) throw new Error('FFmpeg produced an empty file');
    return result;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
