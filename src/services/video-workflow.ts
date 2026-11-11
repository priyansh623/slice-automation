import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
// provider.ts uses STORAGE_DIR ?? './storage'; Vercel cwd is read-only so we default to /tmp
process.env.STORAGE_DIR ??= '/tmp';
import { db } from '@/db';
import {
  videoProjects,
  videoScreens,
  screenPromptVersions,
  videoGenerations,
  promptGenerationTasks,
} from '@/db/schema.pg';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import { callClaude, encodeImageFromStorage, loadConversation } from './anthropic';
import { getSkillContent } from '@/lib/ugc-skill';
import { useapiProvider } from '@/providers/useapi/provider';
import type { VideoGenerationProvider } from '@/providers/useapi/interface';
import { RateLimitError } from '@/providers/useapi/errors';
import { createClient as createServiceClient } from '@supabase/supabase-js';

function stripNotesSection(text: string): string {
  // Remove any trailing "**Notes:**", "**Note:**", "Notes:", "Note:" section and everything after it
  return text.replace(/\n+\*{0,2}Notes?\*{0,2}:[\s\S]*/i, '').trimEnd();
}

async function downloadImageToTmp(storagePath: string, bucket: string): Promise<string> {
  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error || !data) throw new Error(`Failed to download image ${storagePath}: ${error?.message}`);
  const buffer = Buffer.from(await data.arrayBuffer());
  const tmpPath = path.join('/tmp', `${crypto.randomBytes(8).toString('hex')}-${path.basename(storagePath)}`);
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

const DEFAULT_MODEL = () => process.env.VIDEO_DEFAULT_MODEL ?? 'omni-flash';
const DEFAULT_DURATION = () => parseInt(process.env.VIDEO_DEFAULT_DURATION ?? '8', 10);
const UPLOADS_BUCKET = () => process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';

// ── Creative Brief ────────────────────────────────────────────────────────────

export interface CreativeBrief {
  voiceIdentity?: string;
  characterAppearance?: string;
  performanceStyle?: string;
  emotionalDirection?: string;
  gestureIntensity?: 'low' | 'medium' | 'high';
  camera?: string;
  setting?: string;
}

export function parseBrief(creativeBriefJson: string | null | undefined): CreativeBrief {
  if (!creativeBriefJson) return {};
  try {
    return JSON.parse(creativeBriefJson) as CreativeBrief;
  } catch {
    return {};
  }
}

function detectFeedbackScope(feedback: string): 'project' | 'scene' {
  const projectIndicators =
    /across all scenes|throughout|in every scene|all scenes|his voice throughout|her voice throughout|the whole project|project.wide|consistently|every scene/i;
  return projectIndicators.test(feedback) ? 'project' : 'scene';
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  issues: string[];
  warnings: string[];
}

export function validatePrompt(
  promptText: string,
  dialogue: string,
  durationSeconds?: number | null,
  brief?: CreativeBrief | null,
): ValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  const normalizedDialogue = dialogue.trim().replace(/['"''""]/g, '').toLowerCase();
  const normalizedPrompt = promptText.toLowerCase().replace(/['"''""]/g, '');
  if (normalizedDialogue.length > 10) {
    const snippet = normalizedDialogue.substring(0, 30);
    if (!normalizedPrompt.includes(snippet)) {
      issues.push('Scene dialogue does not appear verbatim in the Dialogue section.');
    }
  }

  if (durationSeconds) {
    const wordCount = dialogue.trim().split(/\s+/).filter(Boolean).length;
    const DURATION_RANGES: Record<number, [number, number]> = {
      4: [10, 15],
      6: [18, 24],
      8: [28, 36],
      10: [38, 50],
    };
    const range = DURATION_RANGES[durationSeconds];
    if (range) {
      const [low, high] = range;
      if (wordCount < low * 0.6 || wordCount > high * 1.5) {
        warnings.push(
          `Dialogue has ${wordCount} word${wordCount !== 1 ? 's' : ''} but a ${durationSeconds}s scene typically fits ${low}-${high} words.`,
        );
      }
    }
  }

  const choreographyMatches = promptText.match(/on the word|as (she|he|they) says|when (she|he|they) says|at the word/gi);
  if ((choreographyMatches?.length ?? 0) > 2) {
    warnings.push('Expression section contains detailed word-by-word choreography. Consider simplifying.');
  }

  const contradictionPairs: [RegExp, RegExp][] = [
    [/whisper|whispered|intimate/i, /projecting|loud(ly)?|shout/i],
    [/close.up|tight.shot|close.crop/i, /wide.shot|full.body|wide.frame/i],
  ];
  for (const [a, b] of contradictionPairs) {
    if (a.test(promptText) && b.test(promptText)) {
      warnings.push('Prompt may contain contradictory directions.');
      break;
    }
  }

  if (brief?.voiceIdentity && !promptText.toLowerCase().includes('audio')) {
    warnings.push('Prompt appears to be missing an Audio section.');
  }

  return { issues, warnings };
}

// ── Script Analysis ──────────────────────────────────────────────────────────

const ANALYSIS_SYSTEM_PROMPT = `You break UGC ad scripts into individual scenes for video production.

Rules:
- Split at natural spoken units: complete thoughts, sentence ends, natural pauses
- Never split mid-phrase or mid-sentence
- Copy dialogue verbatim from the script — no paraphrasing
- Account for all dialogue in the script

Duration assignment — use word count as the primary signal:
- Available durations: 4, 6, 8, 10 seconds (all supported by omni-flash)
- Word-count guide: 10-15 words → 4s; 18-24 words → 6s; 28-36 words → 8s; 38-50 words → 10s
- For Hinglish or bilingual scripts, add 10-15% to the estimate
- Always allow for a natural lead-in and trailing silence
- When a line fits two possible durations, choose the longer one — rushed delivery hurts performance
- Add extra time for: rhetorical questions, dramatic pauses, product reveals, emotional beats

For each scene, also include a one-sentence durationNote explaining why you chose that duration (e.g. word count, language mix, emotional beat).

Typo detection:
- Scan the script for likely spelling mistakes, OCR errors, or unusual words that appear unintentional
- Include them in the JSON output as possibleTypos
- Only flag words that are clearly wrong or suspicious — do not flag proper nouns, brand names, or intentional slang

Respond with valid JSON only, no other text:
{"screens": [{"screenNumber": 1, "dialogue": "...", "durationSeconds": 6, "durationNote": "19 words at comfortable pace"}, ...], "possibleTypos": [{"original": "mo3ney", "suggestion": "money", "context": "keep mo3ney rolling"}]}`;

export interface TypoCandidate {
  original: string;
  suggestion: string;
  context: string;
}

export async function analyzeScript(videoProjectId: number): Promise<{
  screens: Array<{ screenNumber: number; dialogue: string; durationSeconds: number; durationNote?: string }>;
  possibleTypos: TypoCandidate[];
}> {
  const rows = await db
    .select()
    .from(videoProjects)
    .where(eq(videoProjects.id, videoProjectId))
    .limit(1);
  const project = rows[0];
  if (!project) throw new Error(`Video project ${videoProjectId} not found`);

  const userMessage = `Script:\n${project.approvedScript ?? project.originalScript}`;
  const response = await callClaude(videoProjectId, userMessage, ANALYSIS_SYSTEM_PROMPT, {
    fresh: true,
    model: 'claude-sonnet-5-5',
    thinking: false,
  });

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON for script breakdown');

  const parsed = JSON.parse(jsonMatch[0]) as {
    screens: Array<{ screenNumber: number; dialogue: string; durationSeconds: number; durationNote?: string }>;
    possibleTypos?: TypoCandidate[];
  };

  return {
    screens: parsed.screens,
    possibleTypos: parsed.possibleTypos ?? [],
  };
}

// ── Creative Brief Extraction ─────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are extracting the established creative direction for a UGC video project.
You will be given the full calibration history for Scene 1 — the conversation of feedback and revisions — followed by the final approved prompt.
Your job is to synthesize what was calibrated and locked in during that process.

Return ONLY valid JSON with these fields (use null for any field you cannot determine):
{
  "voiceIdentity": "voice texture, pace, tone, and any specific accent or register established",
  "characterAppearance": "character description locked from the reference image and any approved adjustments",
  "performanceStyle": "overall performance energy, delivery approach, and any specific calibration outcomes",
  "emotionalDirection": "specific emotional expressions, facial expressions, moods, or feeling-based directions the creator locked in (e.g. 'confident but warm', 'dry humour delivery', 'genuine excitement not performed excitement', 'soft and relatable not high energy')",
  "gestureIntensity": "low" or "medium" or "high",
  "camera": "framing or shot style confirmed in the approved prompt",
  "setting": "any setting details confirmed",
  "calibrationNotes": "brief summary of what changed between drafts and what was explicitly locked in or ruled out"
}`;

export async function extractAndStoreCreativeBrief(
  videoProjectId: number,
  approvedPromptText: string,
  screen1Id?: number,
): Promise<CreativeBrief> {
  const rows = await db
    .select()
    .from(videoProjects)
    .where(eq(videoProjects.id, videoProjectId))
    .limit(1);
  const project = rows[0];
  if (!project) throw new Error(`Project ${videoProjectId} not found`);

  const existingBrief = parseBrief(project.creativeBrief);

  let calibrationContext = '';
  if (screen1Id) {
    const history = await loadConversation(videoProjectId, screen1Id);
    if (history.length > 0) {
      const turns = history
        .map((m) => {
          const role = m.role === 'user' ? 'Creator feedback' : 'Claude revision';
          const text = Array.isArray(m.content)
            ? m.content.filter((b) => (b as { type: string }).type === 'text').map((b) => (b as { type: string; text: string }).text).join('\n')
            : typeof m.content === 'string' ? m.content : '';
          return `${role}:\n${text}`;
        })
        .join('\n\n---\n\n');
      calibrationContext = `Screen 1 calibration history:\n\n${turns}\n\n---\n\n`;
    }
  }

  const rawResponse = await callClaude(
    videoProjectId,
    `${calibrationContext}Final approved Screen 1 prompt:\n\n${approvedPromptText}`,
    EXTRACTION_SYSTEM_PROMPT,
    { fresh: true },
  );

  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('extractAndStoreCreativeBrief: Claude did not return valid JSON');
    return existingBrief;
  }

  let extracted: Partial<CreativeBrief & { calibrationNotes?: string }> = {};
  try {
    extracted = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn('extractAndStoreCreativeBrief: JSON parse failed');
    return existingBrief;
  }

  const mergedBrief: CreativeBrief = {
    voiceIdentity: (extracted.voiceIdentity as string | undefined) ?? undefined,
    characterAppearance: (extracted.characterAppearance as string | undefined) ?? undefined,
    performanceStyle: (extracted.performanceStyle as string | undefined) ?? undefined,
    emotionalDirection: (extracted.emotionalDirection as string | undefined) ?? undefined,
    gestureIntensity: (extracted.gestureIntensity as CreativeBrief['gestureIntensity']) ?? undefined,
    camera: (extracted.camera as string | undefined) ?? undefined,
    setting: (extracted.setting as string | undefined) ?? undefined,
  };

  await db
    .update(videoProjects)
    .set({ creativeBrief: JSON.stringify(mergedBrief), updatedAt: Date.now() })
    .where(eq(videoProjects.id, videoProjectId));

  return mergedBrief;
}

// ── Creative Direction Helpers ────────────────────────────────────────────────

const SELF_CONTAINED_PROMPT_INSTRUCTION =
  `\n\nCRITICAL — Google Flow receives each scene as an isolated API call with zero memory of previous requests. Every scene 2+ prompt MUST be fully self-contained:\n` +
  `- Character section: write the complete character description from the established creative direction above. NEVER write "Same character." — Google Flow does not know what that refers to.\n` +
  `- Audio section: write the full voice description, accent, tone and delivery style every time. NEVER write "Same voice" or reference Scene 1 — it will be ignored.\n` +
  `The reference image (sent as referenceImage_1 in R2V mode) handles visual appearance. Your prompt must carry everything else explicitly.`;

function buildCreativeDirectionBlock(brief: CreativeBrief, screen1PromptText: string | null, creatorDescription?: string | null): string {
  const parts: string[] = [];
  if (brief.voiceIdentity) parts.push(`Voice: ${brief.voiceIdentity}`);
  if (brief.performanceStyle) parts.push(`Performance: ${brief.performanceStyle}`);
  if (brief.emotionalDirection) parts.push(`Emotional direction: ${brief.emotionalDirection}`);
  if (creatorDescription) parts.push(`Creator's character notes: ${creatorDescription}`);
  if (brief.gestureIntensity) parts.push(`Gesture intensity: ${brief.gestureIntensity}`);
  if (brief.camera) parts.push(`Camera/framing: ${brief.camera}`);
  if (brief.characterAppearance) parts.push(`Character: ${brief.characterAppearance}`);

  let block = '';
  if (parts.length > 0) {
    block += `\n\nEstablished creative direction (from Screen 1 approval — apply to all scenes):\n${parts.join('\n')}`;
  }
  if (screen1PromptText) {
    block += `\n\nApproved Screen 1 prompt (reference for tone, format and voice):\n${screen1PromptText}`;
  }
  return block;
}

async function gatherProjectScopeFeedback(videoProjectId: number): Promise<string | null> {
  const screens = await db
    .select({ id: videoScreens.id })
    .from(videoScreens)
    .where(eq(videoScreens.videoProjectId, videoProjectId));
  if (screens.length === 0) return null;

  const screenIds = screens.map((s) => s.id);
  const pvRows = await db
    .select({ nlFeedback: screenPromptVersions.nlFeedback })
    .from(screenPromptVersions)
    .where(
      and(
        inArray(screenPromptVersions.videoScreenId, screenIds),
        eq(screenPromptVersions.feedbackScope, 'project'),
      ),
    )
    .orderBy(desc(screenPromptVersions.createdAt))
    .limit(1);

  return pvRows[0]?.nlFeedback ?? null;
}

async function getScreen1ApprovedPromptInfo(videoProjectId: number): Promise<{ promptText: string; versionId: number } | null> {
  const allScreens = await db
    .select()
    .from(videoScreens)
    .where(eq(videoScreens.videoProjectId, videoProjectId));
  const screen1 = allScreens.find((s) => s.screenNumber === 1);
  if (!screen1?.approvedGenerationId) return null;

  const genRows = await db
    .select()
    .from(videoGenerations)
    .where(eq(videoGenerations.id, screen1.approvedGenerationId))
    .limit(1);
  const approvedGen = genRows[0];
  if (!approvedGen) return null;

  const pvRows = await db
    .select()
    .from(screenPromptVersions)
    .where(eq(screenPromptVersions.id, approvedGen.promptVersionId))
    .limit(1);
  const promptVersion = pvRows[0];
  if (!promptVersion) return null;
  return { promptText: promptVersion.promptText, versionId: promptVersion.id };
}

// ── Prompt Generation ────────────────────────────────────────────────────────

export async function generateScreen1Prompt(
  videoProjectId: number,
  videoScreenId: number,
  nlFeedback?: string,
  reviewingGenerationId?: number,
): Promise<{ promptText: string; version: number; validation: ValidationResult; feedbackScope?: string }> {
  const [screenRows, projectRows] = await Promise.all([
    db.select().from(videoScreens).where(eq(videoScreens.id, videoScreenId)).limit(1),
    db.select().from(videoProjects).where(eq(videoProjects.id, videoProjectId)).limit(1),
  ]);
  const screen = screenRows[0];
  const project = projectRows[0];
  if (!screen) throw new Error(`Screen ${videoScreenId} not found`);
  if (!project) throw new Error(`Video project ${videoProjectId} not found`);

  const skillContent = getSkillContent(project.skillVersion);
  const brief = parseBrief(project.creativeBrief);
  const image = await encodeImageFromStorage(project.baseImagePath, UPLOADS_BUCKET());

  let userMessage: string;
  let feedbackScope: string | undefined;

  if (nlFeedback) {
    feedbackScope = detectFeedbackScope(nlFeedback);

    const allVersions = await db
      .select()
      .from(screenPromptVersions)
      .where(eq(screenPromptVersions.videoScreenId, videoScreenId));
    const latestVersion = allVersions.sort((a, b) => b.version - a.version)[0];

    const scene1Brief = parseBrief(project.creativeBrief);
    const scene1CreativeNotes: string[] = [];
    if (project.creatorDescription) scene1CreativeNotes.push(`Creator's character notes: ${project.creatorDescription}`);
    if (scene1Brief.emotionalDirection) scene1CreativeNotes.push(`Emotional direction: ${scene1Brief.emotionalDirection}`);
    if (scene1Brief.performanceStyle) scene1CreativeNotes.push(`Performance: ${scene1Brief.performanceStyle}`);
    if (scene1Brief.voiceIdentity) scene1CreativeNotes.push(`Voice: ${scene1Brief.voiceIdentity}`);
    const scene1CreativeBlock = scene1CreativeNotes.length > 0
      ? `\n\nCreative direction to maintain:\n${scene1CreativeNotes.join('\n')}`
      : '';

    userMessage =
      `Revise the Scene 1 prompt based on this feedback: ${nlFeedback}\n\n` +
      `Return only the formatted scene prompt. Do not add a Notes section or any commentary after the prompt.` +
      scene1CreativeBlock +
      `\n\nFull script:\n${project.approvedScript ?? project.originalScript}\n\n` +
      `Scene 1 dialogue: "${screen.dialogue}"` +
      (screen.durationSeconds ? `\nTarget duration: ${screen.durationSeconds} seconds` : '') +
      (latestVersion ? `\n\nCurrent prompt:\n${latestVersion.promptText}` : '');

    if (reviewingGenerationId) {
      await db
        .update(videoGenerations)
        .set({ creatorFeedback: nlFeedback, updatedAt: Date.now() })
        .where(eq(videoGenerations.id, reviewingGenerationId));
    }
  } else {
    const characterPart = project.creatorDescription
      ? `This is my character and ${project.creatorDescription}`
      : `This is my character — see the reference image for their appearance.`;

    const DEFAULT_SCENE1_HOOK = `Scene 1 needs to be punchier with better emotions to address the hook. The character needs to keep the audience engaged and interested with the hook.`;
    const hookText = project.scene1HookSnapshot ?? DEFAULT_SCENE1_HOOK;

    userMessage =
      `${characterPart}\n` +
      `Use the skill to write out the prompt for Google Flow.\n` +
      `Return only the formatted scene prompt. Preserve the original dialogue exactly. Do not add a Notes section or any commentary after the prompt.\n\n` +
      `Full script:\n${project.approvedScript ?? project.originalScript}\n\n` +
      `Script for Scene 1: "${screen.dialogue}"` +
      (screen.durationSeconds ? `\nTarget duration: ${screen.durationSeconds} seconds` : '') +
      `\n\n${hookText}`;
  }

  const promptText = stripNotesSection(await callClaude(videoProjectId, userMessage, skillContent, { videoScreenId, image }));
  const version = await insertPromptVersion(videoScreenId, promptText, 'claude', nlFeedback, feedbackScope);
  const validation = validatePrompt(promptText, screen.dialogue, screen.durationSeconds, brief);

  return { promptText, version, validation, feedbackScope };
}

export async function generateInitialScreenPrompt(
  videoProjectId: number,
  videoScreenId: number,
): Promise<{ promptText: string; version: number; validation: ValidationResult }> {
  const [screenRows, projectRows] = await Promise.all([
    db.select().from(videoScreens).where(eq(videoScreens.id, videoScreenId)).limit(1),
    db.select().from(videoProjects).where(eq(videoProjects.id, videoProjectId)).limit(1),
  ]);
  const screen = screenRows[0];
  const project = projectRows[0];
  if (!screen) throw new Error(`Screen ${videoScreenId} not found`);
  if (!project) throw new Error(`Video project ${videoProjectId} not found`);

  const skillContent = getSkillContent(project.skillVersion);
  const brief = parseBrief(project.creativeBrief);
  const image = await encodeImageFromStorage(project.baseImagePath, UPLOADS_BUCKET());
  const screen1Info = await getScreen1ApprovedPromptInfo(videoProjectId);
  const creativeDirectionBlock = buildCreativeDirectionBlock(brief, screen1Info?.promptText ?? null, project.creatorDescription);
  const projectFeedback = await gatherProjectScopeFeedback(videoProjectId);

  const userMessage =
    `Here is the original video script and the reference image of the creator.` +
    `\nUsing the UGC skill, generate the Google Flow video prompt for Scene ${screen.screenNumber} only.` +
    `\nReturn only the formatted scene prompt. Do not include scene breakdown, analysis, or content for other scenes. Do not add a Notes section or any commentary after the prompt.` +
    `\nPreserve the original dialogue exactly.` +
    creativeDirectionBlock +
    (screen.screenNumber > 1 ? SELF_CONTAINED_PROMPT_INSTRUCTION : '') +
    (projectFeedback ? `\n\nProject-wide creator feedback (apply to all scenes): ${projectFeedback}` : '') +
    `\n\nFull script:\n${project.approvedScript ?? project.originalScript}` +
    `\n\nScene ${screen.screenNumber} dialogue: "${screen.dialogue}"` +
    (screen.durationSeconds ? `\nTarget duration: ${screen.durationSeconds} seconds` : '');

  const promptText = stripNotesSection(await callClaude(videoProjectId, userMessage, skillContent, { videoScreenId, image }));
  const version = await insertPromptVersion(
    videoScreenId, promptText, 'claude', undefined, undefined,
    screen1Info?.versionId ?? null,
    project.creativeBrief ?? null,
  );
  const validation = validatePrompt(promptText, screen.dialogue, screen.durationSeconds, brief);

  return { promptText, version, validation };
}

export async function generateRemainingPrompts(
  videoProjectId: number,
): Promise<Array<{ videoScreenId: number; promptText: string; version: number }>> {
  const allScreens = await db
    .select()
    .from(videoScreens)
    .where(eq(videoScreens.videoProjectId, videoProjectId));
  const screens = allScreens.filter((s) => s.screenNumber > 1).sort((a, b) => a.position - b.position);

  const projectRows = await db.select().from(videoProjects).where(eq(videoProjects.id, videoProjectId)).limit(1);
  const project = projectRows[0];
  if (!project) throw new Error(`Video project ${videoProjectId} not found`);

  const skillContent = getSkillContent(project.skillVersion);
  const brief = parseBrief(project.creativeBrief);
  const image = await encodeImageFromStorage(project.baseImagePath, UPLOADS_BUCKET());
  const screen1Info = await getScreen1ApprovedPromptInfo(videoProjectId);
  const creativeDirectionBlock = buildCreativeDirectionBlock(brief, screen1Info?.promptText ?? null, project.creatorDescription);
  const projectFeedback = await gatherProjectScopeFeedback(videoProjectId);

  const results: Array<{ videoScreenId: number; promptText: string; version: number }> = [];

  for (const screen of screens) {
    const userMessage =
      `Here is the original video script and the reference image of the creator.` +
      `\nUsing the UGC skill, generate the Google Flow video prompt for Scene ${screen.screenNumber} only.` +
      `\nPreserve the original dialogue exactly.` +
      creativeDirectionBlock +
      SELF_CONTAINED_PROMPT_INSTRUCTION +
      (projectFeedback ? `\n\nProject-wide creator feedback (apply to all scenes): ${projectFeedback}` : '') +
      `\n\nFull script:\n${project.approvedScript ?? project.originalScript}` +
      `\n\nScene ${screen.screenNumber} dialogue: "${screen.dialogue}"` +
      (screen.durationSeconds ? `\nTarget duration: ${screen.durationSeconds} seconds` : '');

    const promptText = stripNotesSection(await callClaude(videoProjectId, userMessage, skillContent, {
      videoScreenId: screen.id,
      image,
    }));
    const version = await insertPromptVersion(
      screen.id, promptText, 'claude', undefined, undefined,
      screen1Info?.versionId ?? null,
      project.creativeBrief ?? null,
    );
    results.push({ videoScreenId: screen.id, promptText, version });
  }

  return results;
}

export async function revisePrompt(
  videoProjectId: number,
  videoScreenId: number,
  nlFeedback: string,
  reviewingGenerationId?: number,
): Promise<{ promptText: string; version: number; validation: ValidationResult; feedbackScope: string }> {
  const [screenRows, projectRows] = await Promise.all([
    db.select().from(videoScreens).where(eq(videoScreens.id, videoScreenId)).limit(1),
    db.select().from(videoProjects).where(eq(videoProjects.id, videoProjectId)).limit(1),
  ]);
  const screen = screenRows[0];
  const project = projectRows[0];
  if (!screen) throw new Error(`Screen ${videoScreenId} not found`);
  if (!project) throw new Error(`Video project ${videoProjectId} not found`);

  const skillContent = getSkillContent(project.skillVersion);
  const brief = parseBrief(project.creativeBrief);
  const feedbackScope = detectFeedbackScope(nlFeedback);
  const image = await encodeImageFromStorage(project.baseImagePath, UPLOADS_BUCKET());

  const allVersions = await db
    .select()
    .from(screenPromptVersions)
    .where(eq(screenPromptVersions.videoScreenId, videoScreenId));
  const latestVersion = allVersions.sort((a, b) => b.version - a.version)[0];

  const screen1Info = screen.screenNumber > 1 ? await getScreen1ApprovedPromptInfo(videoProjectId) : null;
  const creativeDirectionBlock = screen.screenNumber > 1
    ? buildCreativeDirectionBlock(brief, screen1Info?.promptText ?? null, project.creatorDescription)
    : '';

  const projectFeedback = feedbackScope === 'scene'
    ? await gatherProjectScopeFeedback(videoProjectId)
    : null;

  const userMessage =
    `Revise the Scene ${screen.screenNumber} prompt based on this feedback: ${nlFeedback}\n\n` +
    `Return only the formatted scene prompt. Do not add a Notes section or any commentary after the prompt.\n\n` +
    `Full script:\n${project.approvedScript ?? project.originalScript}\n\n` +
    `Scene ${screen.screenNumber} dialogue: "${screen.dialogue}"` +
    (screen.durationSeconds ? `\nTarget duration: ${screen.durationSeconds} seconds` : '') +
    creativeDirectionBlock +
    (screen.screenNumber > 1 ? SELF_CONTAINED_PROMPT_INSTRUCTION : '') +
    (projectFeedback ? `\n\nProject-wide creator feedback (apply to all scenes): ${projectFeedback}` : '') +
    (latestVersion ? `\n\nCurrent prompt:\n${latestVersion.promptText}` : '');

  if (reviewingGenerationId) {
    await db
      .update(videoGenerations)
      .set({ creatorFeedback: nlFeedback, updatedAt: Date.now() })
      .where(eq(videoGenerations.id, reviewingGenerationId));
  }

  const promptText = stripNotesSection(await callClaude(videoProjectId, userMessage, skillContent, { videoScreenId, image }));
  const version = await insertPromptVersion(
    videoScreenId, promptText, 'claude', nlFeedback, feedbackScope,
    screen1Info?.versionId ?? null,
    screen.screenNumber > 1 ? project.creativeBrief ?? null : null,
  );
  const validation = validatePrompt(promptText, screen.dialogue, screen.durationSeconds, brief);

  return { promptText, version, validation, feedbackScope };
}

// ── Async Prompt Generation Task Queueing ─────────────────────────────────────

export async function enqueueScreen1ApprovalTasks(
  videoProjectId: number,
  screen1Id: number,
): Promise<{ tasksQueued: number }> {
  const now = Date.now();

  await db.insert(promptGenerationTasks).values({
    videoProjectId,
    videoScreenId: screen1Id,
    taskType: 'extract_brief',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  const allScreens = await db
    .select()
    .from(videoScreens)
    .where(eq(videoScreens.videoProjectId, videoProjectId));
  const remainingScreens = allScreens
    .filter((s) => s.screenNumber > 1)
    .sort((a, b) => a.position - b.position);

  for (const screen of remainingScreens) {
    await db.insert(promptGenerationTasks).values({
      videoProjectId,
      videoScreenId: screen.id,
      taskType: 'generate_prompt',
      status: 'pending',
      createdAt: now + 1,
      updatedAt: now + 1,
    });
  }

  return { tasksQueued: 1 + remainingScreens.length };
}

// ── Queued Generation Submission ──────────────────────────────────────────────

export async function submitQueuedGeneration(
  generationId: number,
  provider: VideoGenerationProvider = useapiProvider,
): Promise<void> {
  const genRows = await db
    .select()
    .from(videoGenerations)
    .where(eq(videoGenerations.id, generationId))
    .limit(1);
  const gen = genRows[0];
  if (!gen || gen.status !== 'queued') return;

  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(eq(videoScreens.id, gen.videoScreenId))
    .limit(1);
  const screen = screenRows[0];

  const [projectRows, pvRows] = await Promise.all([
    screen ? db.select().from(videoProjects).where(eq(videoProjects.id, screen.videoProjectId)).limit(1) : Promise.resolve([]),
    db.select().from(screenPromptVersions).where(eq(screenPromptVersions.id, gen.promptVersionId)).limit(1),
  ]);
  const project = (projectRows as typeof projectRows)[0];
  const promptVersion = pvRows[0];

  if (!screen || !project || !promptVersion) {
    await db
      .update(videoGenerations)
      .set({ status: 'failed', errorMessage: 'Missing related records', updatedAt: Date.now() })
      .where(eq(videoGenerations.id, generationId));
    return;
  }

  const duration = gen.durationSeconds ?? screen.durationSeconds ?? DEFAULT_DURATION();
  const now = Date.now();

  await db
    .update(videoGenerations)
    .set({ status: 'processing', updatedAt: now })
    .where(eq(videoGenerations.id, generationId));

  try {
    let referenceImageMediaId = project.baseImageMediaId;
    if (!referenceImageMediaId) {
      if (process.env.MOCK_USEAPI === 'true') {
        referenceImageMediaId = 'mock-media-id';
      } else {
        const tmpPath = await downloadImageToTmp(project.baseImagePath, UPLOADS_BUCKET());
        try {
          const uploaded = await provider.uploadReferenceImage({
            imagePath: tmpPath,
            contentType: guessContentType(project.baseImagePath),
            email: process.env.GOOGLE_FLOW_EMAIL!,
          });
          referenceImageMediaId = uploaded.mediaGenerationId ?? null;
        } finally {
          fs.unlink(tmpPath, () => {});
        }
        if (referenceImageMediaId) {
          await db
            .update(videoProjects)
            .set({ baseImageMediaId: referenceImageMediaId, updatedAt: now })
            .where(eq(videoProjects.id, project.id));
        }
      }
    }

    if (process.env.MOCK_USEAPI === 'true') {
      await db
        .update(videoGenerations)
        .set({ jobId: `mock-job-${now}`, status: 'completed', updatedAt: now })
        .where(eq(videoGenerations.id, generationId));
      return;
    }

    const result = await provider.submitGeneration({
      prompt: promptVersion.promptText,
      model: DEFAULT_MODEL(),
      referenceImageMediaId: referenceImageMediaId!,
      duration,
      aspectRatio: 'portrait',
      correlationId: `screen-${gen.videoScreenId}-v${gen.promptVersionId}-q`,
    });

    if (result.videoUrl) {
      const downloaded = await provider.downloadVideo({
        jobId: result.jobId,
        signedUrl: result.videoUrl,
        outputMediaGenerationId: result.mediaGenerationId ?? null,
        jobCompletedAt: now,
      });
      let storagePath: string;
      try {
        storagePath = await uploadVideoToStorage(downloaded.tempPath, gen.videoScreenId, generationId);
      } catch (uploadErr: unknown) {
        fs.unlink(downloaded.tempPath, () => {});
        throw uploadErr;
      }
      await db
        .update(videoGenerations)
        .set({ jobId: result.jobId, status: 'completed', videoStoragePath: storagePath, mediaGenerationId: result.mediaGenerationId ?? null, updatedAt: now })
        .where(eq(videoGenerations.id, generationId));
    } else {
      await db
        .update(videoGenerations)
        .set({ jobId: result.jobId, status: 'pending', updatedAt: now })
        .where(eq(videoGenerations.id, generationId));
    }
  } catch (err: unknown) {
    if (err instanceof RateLimitError) {
      // All accounts busy — reset to queued so the worker retries on the next tick
      await db
        .update(videoGenerations)
        .set({ status: 'queued', updatedAt: Date.now() })
        .where(eq(videoGenerations.id, generationId));
      console.log(`[workflow] Gen ${generationId} rate-limited, reset to queued (retry next tick)`);
      return;
    }
    await db
      .update(videoGenerations)
      .set({ status: 'failed', errorMessage: (err instanceof Error ? err.message : String(err)), updatedAt: Date.now() })
      .where(eq(videoGenerations.id, generationId));
    throw err;
  }
}

// ── Generate All Scenes ───────────────────────────────────────────────────────

export async function enqueueAllSceneGenerations(
  videoProjectId: number,
): Promise<{ enqueued: number; skipped: number; generationIds: number[] }> {
  const allScreens = await db
    .select()
    .from(videoScreens)
    .where(eq(videoScreens.videoProjectId, videoProjectId));
  const screens = allScreens
    .filter((s) => !s.approvedGenerationId)
    .sort((a, b) => a.position - b.position);

  const now = Date.now();
  const generationIds: number[] = [];
  let skipped = 0;

  for (const screen of screens) {
    const allGens = await db
      .select()
      .from(videoGenerations)
      .where(eq(videoGenerations.videoScreenId, screen.id));
    const existingActive = allGens.find((g) => ['queued', 'pending', 'processing'].includes(g.status));
    if (existingActive) { skipped++; continue; }

    const allVersions = await db
      .select()
      .from(screenPromptVersions)
      .where(eq(screenPromptVersions.videoScreenId, screen.id));
    const latestPrompt = allVersions.sort((a, b) => b.version - a.version)[0];
    if (!latestPrompt) { skipped++; continue; }

    const inserted = await db
      .insert(videoGenerations)
      .values({
        videoScreenId: screen.id,
        promptVersionId: latestPrompt.id,
        jobId: null,
        status: 'queued',
        videoStoragePath: null,
        durationSeconds: screen.durationSeconds ?? DEFAULT_DURATION(),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: videoGenerations.id });
    generationIds.push(inserted[0].id);
  }

  return { enqueued: generationIds.length, skipped, generationIds };
}

// ── Manual Prompt Edit ───────────────────────────────────────────────────────

export async function saveManualPromptEdit(
  videoScreenId: number,
  promptText: string,
): Promise<{ version: number; validation: ValidationResult }> {
  const screenRows = await db
    .select()
    .from(videoScreens)
    .where(eq(videoScreens.id, videoScreenId))
    .limit(1);
  const screen = screenRows[0];

  const projectRows = screen
    ? await db.select().from(videoProjects).where(eq(videoProjects.id, screen.videoProjectId)).limit(1)
    : [];
  const project = projectRows[0];
  const brief = parseBrief(project?.creativeBrief);

  const screenNumber = screen?.screenNumber ?? 0;
  const screen1Info = screenNumber > 1 && screen && project
    ? await getScreen1ApprovedPromptInfo(screen.videoProjectId)
    : null;
  const version = await insertPromptVersion(
    videoScreenId, promptText, 'manual', undefined, undefined,
    screen1Info?.versionId ?? null,
    screenNumber > 1 && project ? project.creativeBrief ?? null : null,
  );
  const validation = validatePrompt(promptText, screen?.dialogue ?? '', screen?.durationSeconds, brief);
  return { version, validation };
}

// ── Video Generation ─────────────────────────────────────────────────────────

export async function submitVideoGeneration(
  videoProjectId: number,
  videoScreenId: number,
  promptVersionId: number,
  durationOverride?: number,
  provider: VideoGenerationProvider = useapiProvider,
): Promise<{ generationId: number }> {
  const [projectRows, pvRows, screenRows] = await Promise.all([
    db.select().from(videoProjects).where(eq(videoProjects.id, videoProjectId)).limit(1),
    db.select().from(screenPromptVersions).where(eq(screenPromptVersions.id, promptVersionId)).limit(1),
    db.select().from(videoScreens).where(eq(videoScreens.id, videoScreenId)).limit(1),
  ]);
  const project = projectRows[0];
  const promptVersion = pvRows[0];
  const screen = screenRows[0];
  if (!project) throw new Error(`Video project ${videoProjectId} not found`);
  if (!promptVersion) throw new Error(`Prompt version ${promptVersionId} not found`);

  const duration = durationOverride ?? screen?.durationSeconds ?? DEFAULT_DURATION();

  let referenceImageMediaId = project.baseImageMediaId;
  if (!referenceImageMediaId) {
    if (process.env.MOCK_USEAPI === 'true') {
      referenceImageMediaId = 'mock-media-id';
    } else {
      const tmpPath = await downloadImageToTmp(project.baseImagePath, UPLOADS_BUCKET());
      try {
        const uploaded = await provider.uploadReferenceImage({
          imagePath: tmpPath,
          contentType: guessContentType(project.baseImagePath),
          email: process.env.GOOGLE_FLOW_EMAIL!,
        });
        referenceImageMediaId = uploaded.mediaGenerationId ?? null;
      } finally {
        fs.unlink(tmpPath, () => {});
      }
      if (referenceImageMediaId) {
        await db
          .update(videoProjects)
          .set({ baseImageMediaId: referenceImageMediaId, updatedAt: Date.now() })
          .where(eq(videoProjects.id, videoProjectId));
      }
    }
  }

  const now = Date.now();

  if (process.env.MOCK_USEAPI === 'true') {
    const inserted = await db
      .insert(videoGenerations)
      .values({
        videoScreenId,
        promptVersionId,
        jobId: `mock-job-${now}`,
        status: 'completed',
        videoStoragePath: null,
        durationSeconds: duration,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: videoGenerations.id });
    return { generationId: inserted[0].id };
  }

  const result = await provider.submitGeneration({
    prompt: promptVersion.promptText,
    model: DEFAULT_MODEL(),
    referenceImageMediaId,
    duration,
    aspectRatio: 'portrait',
    correlationId: `screen-${videoScreenId}-v${promptVersionId}`,
  });

  if (result.videoUrl) {
    const downloaded = await provider.downloadVideo({
      jobId: result.jobId,
      signedUrl: result.videoUrl,
      outputMediaGenerationId: result.mediaGenerationId ?? null,
      jobCompletedAt: now,
    });
    // Insert the row first so we have the real generation ID for the storage path.
    // Also saves mediaGenerationId here — previously this was omitted, causing
    // compilation to fail with "clip is missing its media ID".
    const inserted = await db
      .insert(videoGenerations)
      .values({
        videoScreenId,
        promptVersionId,
        jobId: result.jobId ?? null,
        status: 'processing',
        videoStoragePath: null,
        mediaGenerationId: result.mediaGenerationId ?? null,
        durationSeconds: duration,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: videoGenerations.id });
    const generationId = inserted[0].id;
    let storagePath: string;
    try {
      storagePath = await uploadVideoToStorage(downloaded.tempPath, videoScreenId, generationId);
    } catch (uploadErr: unknown) {
      fs.unlink(downloaded.tempPath, () => {});
      await db
        .update(videoGenerations)
        .set({ status: 'failed', errorMessage: (uploadErr instanceof Error ? uploadErr.message : String(uploadErr)), updatedAt: Date.now() })
        .where(eq(videoGenerations.id, generationId));
      throw uploadErr;
    }
    await db
      .update(videoGenerations)
      .set({ status: 'completed', videoStoragePath: storagePath, updatedAt: Date.now() })
      .where(eq(videoGenerations.id, generationId));
    return { generationId };
  }

  const inserted = await db
    .insert(videoGenerations)
    .values({
      videoScreenId,
      promptVersionId,
      jobId: result.jobId ?? null,
      status: 'pending',
      videoStoragePath: null,
      durationSeconds: duration,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: videoGenerations.id });

  return { generationId: inserted[0].id };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function insertPromptVersion(
  videoScreenId: number,
  promptText: string,
  source: 'claude' | 'manual',
  nlFeedback: string | undefined,
  feedbackScope: string | undefined,
  screen1PromptVersionId?: number | null,
  creativeBriefSnapshot?: string | null,
): Promise<number> {
  const rows = await db
    .select({ maxVersion: max(screenPromptVersions.version) })
    .from(screenPromptVersions)
    .where(eq(screenPromptVersions.videoScreenId, videoScreenId));

  const nextVersion = (rows[0]?.maxVersion ?? 0) + 1;

  await db.insert(screenPromptVersions).values({
    videoScreenId,
    version: nextVersion,
    promptText,
    source,
    nlFeedback: nlFeedback ?? null,
    feedbackScope: feedbackScope ?? null,
    screen1PromptVersionId: screen1PromptVersionId ?? null,
    creativeBriefSnapshot: creativeBriefSnapshot ?? null,
    createdAt: Date.now(),
  });

  return nextVersion;
}

async function uploadVideoToStorage(localPath: string, videoScreenId: number, generationId: number): Promise<string> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const fs = await import('node:fs/promises');
  const fileBuffer = await fs.readFile(localPath);
  const storagePath = `screen-${videoScreenId}/${Date.now()}-gen-${generationId}.mp4`;
  const bucket = process.env.SUPABASE_BUCKET_VIDEOS ?? 'videos';
  const { error } = await supabase.storage.from(bucket).upload(storagePath, fileBuffer, {
    contentType: 'video/mp4',
    upsert: false,
  });
  if (error) throw new Error(`Failed to upload video to Supabase Storage: ${error.message}`);
  // Clean up temp file (non-fatal if it fails)
  fs.unlink(localPath).catch(() => {});
  return storagePath;
}

function guessContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  return map[ext ?? ''] ?? 'image/jpeg';
}
