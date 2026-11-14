import Anthropic from '@anthropic-ai/sdk';
import { sanitiseAnalysis, type Suggestion } from './analysis-schema';
import type { Taxonomy } from './taxonomy';

/**
 * Looks at a few sampled frames of ONE video and proposes metadata, using the Anthropic API the application already uses
 * (ANTHROPIC_API_KEY). The model only ever returns a tool call with a fixed JSON shape; sanitiseAnalysis then checks every
 * value against the approved taxonomy. This module cannot write to the database: it is given a Taxonomy and returns data.
 *
 * The file name is deliberately never sent: the analysis has to come from what is visible in the frames.
 */
export const ANALYSIS_MODEL = () => process.env.BROLL_ANALYSIS_MODEL || 'claude-sonnet-5-5';
export const MAX_FRAMES = 6;
export const MAX_FRAME_BYTES = 700_000;
const TOOL = 'record_clip_metadata';

export interface AnalysisInput { frames: string[]; durationSeconds: number | null; width: number | null; height: number | null }
export interface MessagesClient { messages: { create(args: Anthropic.MessageCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number }): Promise<Anthropic.Message> } }

/**
 * The analyse route may run for at most 60 s (maxDuration). One attempt may take 25 s and one retry is allowed, so even a stalled
 * provider fails with an error the page can retry, instead of the platform cutting the function off.
 */
export const ATTEMPT_TIMEOUT_MS = 25_000;
export const MAX_RETRIES = 1;

let shared: Anthropic | null = null;
const defaultClient = (): MessagesClient => (shared ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short clip name starting with an -ing verb, e.g. "Holding a coffee cup at a cafe table". Factual, no brand claims you cannot see.' },
    subject: { type: ['string', 'null'], description: 'One short phrase for the main subject, or null.' },
    summary: { type: 'string', description: 'One or two sentences: what happens, based only on the frames.' },
    description: { type: 'string', description: 'A short factual description (one sentence) usable for search.' },
    subjects: { type: 'array', items: { type: 'string' }, description: 'Main people or things shown (no identification of individuals).' },
    objects: { type: 'array', items: { type: 'string' } },
    descriptors: { type: 'array', items: { type: 'string' }, description: 'Visual descriptors such as lighting, camera movement, time of day.' },
    visible_text: { type: 'array', items: { type: 'string' }, description: 'Text you can actually read in the frames, copied exactly. Empty if none.' },
    category_id: { type: ['integer', 'null'], description: 'The id of the best EXISTING category from the list, or null if none fits.' },
    category_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    category_reason: { type: 'string', description: 'Why this category: name the main subject and what is happening, and why it beats the closest alternative.' },
    proposed_category: {
      type: ['object', 'null'],
      description: 'ONLY when category_id is null: a suggestion for a new category. It is a proposal for a human to approve; it is never created automatically.',
      properties: { name: { type: 'string' }, parent_id: { type: ['integer', 'null'] }, reason: { type: 'string', description: 'Why no existing category is sufficient.' } },
      required: ['name', 'reason'],
    },
    activity: { type: ['string', 'null'], description: 'EXACTLY one of the approved activities, or null.' },
    setting: { type: ['string', 'null'], description: 'EXACTLY one of the approved settings, or null.' },
    brands: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, role: { type: 'string', enum: ['hero', 'incidental', 'unresolved'] }, evidence: { type: 'string', description: 'What in the frames shows this brand.' } },
        required: ['name', 'role', 'evidence'],
      },
      description: 'Only brands you can actually see (logo, packaging, readable text). hero = the main subject; incidental = in the background.',
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'Lower-case tags. Prefer tags from the approved vocabulary.' },
    privacy: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['face', 'name', 'phone', 'email', 'travel_document', 'payment_details', 'financial_info', 'receipt', 'address', 'other_pii'] },
          detail: { type: 'string', description: 'Say what is visible and WHY it has this severity (for example whether a face is identifiable). Describe sensitive information, never copy it: no names, numbers or addresses.' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Follow the severity rules in the instructions.' },
        },
        required: ['type', 'detail', 'severity'],
      },
      description: 'Anything personal or sensitive that is visible: identifiable faces, names or name tags, phone numbers, emails, boarding passes or travel documents, card or payment details, credit scores or financial information, receipts with personal data.',
    },
    unresolved: { type: 'array', items: { type: 'string' }, description: 'Names of fields you could not determine confidently.' },
    overall_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['title', 'summary', 'description', 'category_id', 'category_confidence', 'activity', 'setting', 'brands', 'tags', 'privacy', 'visible_text', 'unresolved', 'overall_confidence'],
} as const;

export function buildSystemPrompt(t: Taxonomy): string {
  const cats = t.categories.map((c) => `${c.id}: ${c.path}`).join('\n');
  const lines = (xs: string[]) => xs.map((x) => `- ${JSON.stringify(x)}`).join('\n');
  return [
    'You label short B-roll videos for a marketing team. You are shown a few frames sampled from one video, in time order.',
    '',
    'Rules:',
    '- Describe ONLY what is visible in the frames. Never guess from context you cannot see. Never invent brands, activities, settings, text or details.',
    '- If you are not confident about something, return null (or an empty list) and add the field name to "unresolved".',
    '- category_id MUST be one of the ids below. If none fits, return null and fill proposed_category with a name, an optional parent_id from the list, and why no existing category is enough. Never invent an id.',
    '- activity and setting MUST be copied exactly from the approved lists below, or null.',
    '- Only list a brand when its logo, packaging or text is actually readable. Prefer the exact spelling from the known brands list when it is the same brand.',
    '- Prefer tags from the approved vocabulary; add a new tag only when nothing there fits.',
    '- Always answer by calling the record_clip_metadata tool.',
    '',
    'CHOOSING A CATEGORY:',
    '- Decide by the MAIN SUBJECT and what is actually happening, never by a word that merely appears in a category name or a tag. Read every category together with its parent: the parent says what subject area it covers, and a child only applies inside that area.',
    '- A category about a specific kind of object (for example payment cards) applies only when that object is the subject of the footage. Packaging, boxes, parcels, bags and carried purchases are not payment cards or banking items.',
    '- Unboxing, shopping, carrying purchases and after-purchase footage belongs with the shopping and purchase categories when one fits. Financial, card and banking categories are for footage where a payment card, a payment, or a banking or finance app is the subject.',
    '- Compare the closest two or three categories, choose the one that describes the main subject best, and say why in category_reason. A broad parent category that is merely related to the subject, without describing what the footage is about, is NOT a fit. If no existing category fits, return category_id null and propose a category separately in proposed_category. Do not choose a loosely related category to avoid proposing one, and never invent an id.',
    '',
    'PRIVACY:',
    '- Keep three things apart: (1) a person is visible; (2) a person is identifiable; (3) sensitive personal information is legible. Report each that applies; do not identify anyone.',
    '- Severity for a person (type "face"): high when an identifiable face is the main subject or appears together with other personal information or a sensitive context (a child, ID, documents); medium when a face is clearly identifiable (large in the frame, sharp, facing or in clear profile, or on screen for a sustained time) even if it is not the subject; low only when people are distant, small, blurred, turned away or partly hidden so they could not be recognised. A person merely in the background is not high by default.',
    '- Severity for information: high for financial information (credit scores, balances, payment history, card numbers, bank details) and for travel or identity documents with legible details (boarding passes, passports, ID cards, licences). Medium or high for legible names or name tags, phone numbers, email addresses and addresses: medium when partly legible or incidental, high when clearly legible and tied to a person.',
    '- Do not report privacy concerns for ordinary signage, shop fronts, product packaging or brand text that identifies no individual.',
    '- In each privacy item, "detail" must say what is visible and why it has that severity, in words, without repeating any personal data.',
    '',
    'EXISTING CATEGORIES (id: path):',
    cats || '(none)',
    '',
    'APPROVED ACTIVITIES:',
    lines(t.activities) || '(none)',
    '',
    'APPROVED SETTINGS:',
    lines(t.settings) || '(none)',
    '',
    'KNOWN BRANDS:',
    t.brands.join(', ') || '(none)',
    '',
    'APPROVED TAG VOCABULARY (most used first):',
    t.tags.slice(0, 200).map((x) => x.tag).join(', ') || '(none)',
  ].join('\n');
}

export async function analyseFrames(
  input: AnalysisInput,
  taxonomy: Taxonomy,
  deps: { client?: MessagesClient; model?: string; timeoutMs?: number; maxRetries?: number } = {},
): Promise<Suggestion> {
  if (input.frames.length === 0) throw new Error('No frames to analyse');
  const content: Anthropic.ContentBlockParam[] = [];
  input.frames.forEach((data, i) => {
    content.push({ type: 'text', text: `Frame ${i + 1} of ${input.frames.length}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  });
  content.push({ type: 'text', text: `Video: ${input.durationSeconds ? `${Math.round(input.durationSeconds)} s, ` : ''}${input.width && input.height ? `${input.width}x${input.height}` : 'portrait'}. Record the metadata.` });

  const res = await (deps.client ?? defaultClient()).messages.create({
    model: deps.model ?? ANALYSIS_MODEL(),
    max_tokens: 1800,
    system: buildSystemPrompt(taxonomy),
    tools: [{ name: TOOL, description: 'Record the metadata for this video.', input_schema: TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema }],
    // 'auto', not a forced tool: claude-sonnet-5-5 (found by the real-API smoke test) rejects tool_choice of type 'tool'/'any'.
    // The prompt requires the tool call; an answer without it is reported as a retryable failure below.
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
  }, { timeout: deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS, maxRetries: deps.maxRetries ?? MAX_RETRIES });
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL);
  if (!call) throw new Error('The model did not return structured metadata');
  return sanitiseAnalysis(call.input, taxonomy);
}
