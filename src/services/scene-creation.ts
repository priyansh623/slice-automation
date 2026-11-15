/**
 * Second step of adding a scene: write its prompt, and record how it went (see "Scene creation records" in
 * scene-management.ts). Used by "Add scene" and by Retry on a failed or interrupted scene.
 *
 * The prompt is written exactly as for any other scene (the same functions the "Write prompt" button uses): from the
 * scene's dialogue, the full script, the reference image and, after Scene 1, the creative direction.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { videoScreens } from '@/db/schema.pg';
import { markCreation } from '@/services/scene-management';
import { generateInitialScreenPrompt, generateScreen1Prompt } from '@/services/video-workflow';

export type CreationOutcome =
  | { ok: true; promptText: string; version: number; validation: { issues: string[]; warnings: string[] } }
  | { ok: false; error: string };

export async function writeScenePrompt(projectId: number, screenId: number, eventId: number): Promise<CreationOutcome> {
  try {
    const screen = (await db.select().from(videoScreens).where(eq(videoScreens.id, screenId)).limit(1))[0];
    if (!screen) throw new Error(`Screen ${screenId} not found`);
    const prompt = screen.screenNumber === 1
      ? await generateScreen1Prompt(projectId, screenId)
      : await generateInitialScreenPrompt(projectId, screenId);
    await markCreation(eventId, 'done').catch((err) => console.error(`[scenes] could not mark scene ${screenId} done:`, err));
    return { ok: true, promptText: prompt.promptText, version: prompt.version, validation: prompt.validation };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scenes] prompt for scene ${screenId} (project ${projectId}) failed:`, message);
    await markCreation(eventId, 'failed', 'The prompt could not be written.').catch((e) => console.error(`[scenes] could not mark scene ${screenId} failed:`, e));
    return { ok: false, error: 'The prompt could not be written.' };
  }
}
