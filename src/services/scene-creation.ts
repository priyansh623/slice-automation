/**
 * Second step of adding a scene: write its prompt, and record how it went (see "Scene creation records" in
 * scene-management.ts). Used by "Add scene" and by Retry on a failed or interrupted scene.
 */
import { markCreation, type SceneBrief } from '@/services/scene-management';
import { generateManualScenePrompt } from '@/services/video-workflow';

export type CreationOutcome =
  | { ok: true; promptText: string; version: number; validation: { issues: string[]; warnings: string[] } }
  | { ok: false; error: string };

export async function writeScenePrompt(projectId: number, screenId: number, eventId: number, brief: SceneBrief): Promise<CreationOutcome> {
  try {
    const prompt = await generateManualScenePrompt(projectId, screenId, brief);
    await markCreation(eventId, 'done').catch((err) => console.error(`[scenes] could not mark scene ${screenId} done:`, err));
    return { ok: true, ...prompt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scenes] prompt for scene ${screenId} (project ${projectId}) failed:`, message);
    await markCreation(eventId, 'failed', 'The prompt could not be written.').catch((e) => console.error(`[scenes] could not mark scene ${screenId} failed:`, e));
    return { ok: false, error: 'The prompt could not be written.' };
  }
}
