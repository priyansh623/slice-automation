import * as fs from 'node:fs/promises';
import { getStorage } from './index';

/**
 * Stores a generated clip that the video provider returned (already downloaded to a temp file) and returns its key.
 * One implementation for the worker and for the Generate Video request path; the key format is unchanged.
 */
export async function storeGeneratedVideo(localPath: string, videoScreenId: number, generationId: number): Promise<string> {
  const fileBuffer = await fs.readFile(localPath);
  const key = `screen-${videoScreenId}/${Date.now()}-gen-${generationId}.mp4`;
  await getStorage().put('videos', key, fileBuffer, { contentType: 'video/mp4' });
  // Clean up the temp file (non-fatal if it fails)
  fs.unlink(localPath).catch(() => {});
  return key;
}
