import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { ANALYSIS_SYSTEM_PROMPT, ANALYSIS_TOOL, ANALYSIS_TOOL_SCHEMA, studioAnalysisModel } from './analysis-schema';
import { sanitiseAiMetadata, type MetadataRecord } from './metadata';
import { STUDIO_MAX_PIXELS } from './keys';

/**
 * Looks at ONE image and returns metadata for it, using the Anthropic API the application already uses (ANTHROPIC_API_KEY).
 * It cannot write to the database or to storage: it is given bytes and returns data. The original is never modified; the
 * model is shown a downscaled JPEG copy made in memory.
 */
export const ANALYSIS_LONG_EDGE = 1568;
/**
 * Images with more pixels than this are not decoded (protects the 512 MiB worker). It is the same limit uploads are held to, so an
 * image the Studio accepted can always be analysed, and one it did not accept (older or imported) fails cleanly instead of using
 * gigabytes of memory.
 */
export const ANALYSIS_MAX_PIXELS = STUDIO_MAX_PIXELS;
const MAX_COPY_BYTES = 4_000_000;
export const ATTEMPT_TIMEOUT_MS = 45_000;
export const MAX_RETRIES = 1;

export interface MessagesClient { messages: { create(args: Anthropic.MessageCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number }): Promise<Anthropic.Message> } }

let shared: Anthropic | null = null;
const defaultClient = (): MessagesClient => (shared ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

/**
 * Called once by the worker process before any Studio image work: no decoded-image cache and one libvips thread, so the memory
 * used for an image is released as soon as it is done and a decode never holds several cores' worth of buffers at once.
 */
export function configureSharpForWorker(): void {
  sharp.cache(false);
  sharp.concurrency(1);
}

export const analysisConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY);

/** A JPEG copy of the image for the model: rotated upright, no larger than 1568 px on its long edge, small enough to send. */
export async function prepareForAnalysis(original: Buffer): Promise<{ base64: string; mediaType: 'image/jpeg' }> {
  for (const quality of [82, 70, 55]) {
    const copy = await sharp(original, { failOn: 'none', limitInputPixels: ANALYSIS_MAX_PIXELS, sequentialRead: true })
      .rotate()
      .resize({ width: ANALYSIS_LONG_EDGE, height: ANALYSIS_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // a PNG with transparency becomes a plain JPEG
      .jpeg({ quality })
      .toBuffer();
    if (copy.length <= MAX_COPY_BYTES) return { base64: copy.toString('base64'), mediaType: 'image/jpeg' };
  }
  throw new Error('The image could not be reduced to a size the model accepts');
}

export async function analyseImage(
  copy: { base64: string; mediaType: 'image/jpeg' },
  deps: { client?: MessagesClient; model?: string; timeoutMs?: number; maxRetries?: number } = {},
): Promise<{ metadata: MetadataRecord; model: string }> {
  const model = deps.model ?? studioAnalysisModel();
  const res = await (deps.client ?? defaultClient()).messages.create({
    model,
    max_tokens: 1500,
    system: ANALYSIS_SYSTEM_PROMPT,
    tools: [{ name: ANALYSIS_TOOL, description: 'Record the metadata for this image.', input_schema: ANALYSIS_TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema }],
    // 'auto', not a forced tool: claude-sonnet-5-5 rejects tool_choice of type 'tool'/'any' (see src/lib/broll-bulk/analyzer.ts).
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: copy.mediaType, data: copy.base64 } },
      { type: 'text', text: 'Record the metadata for this image.' },
    ] }],
  }, { timeout: deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS, maxRetries: deps.maxRetries ?? MAX_RETRIES });
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === ANALYSIS_TOOL);
  if (!call) throw new Error('The model did not return structured metadata');
  const metadata = sanitiseAiMetadata(call.input);
  if (Object.keys(metadata).length === 0) throw new Error('The model returned no usable metadata');
  return { metadata, model };
}
