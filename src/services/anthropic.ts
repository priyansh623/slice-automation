import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { createClient } from '@supabase/supabase-js';
import { db } from '@/db';
import { claudeConversations } from '@/db/schema.pg';
import { and, eq, isNull } from 'drizzle-orm';

const MODEL = () => process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const SUPPORTED_IMAGE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

type SupportedMimeType = (typeof SUPPORTED_IMAGE_TYPES)[keyof typeof SUPPORTED_IMAGE_TYPES];

export interface EncodedImage {
  base64: string;
  mimeType: SupportedMimeType;
}

// Module-level image cache for the worker process (runs as a persistent Render process, not
// Vercel serverless — instances are not shared and won't survive a restart, but within a single
// worker process this avoids re-downloading the same base image for every single-screen call).
const IMAGE_CACHE_MAX = 100;
const _imageCache = new Map<string, EncodedImage>();

/**
 * Downloads a file from Supabase Storage and encodes it as base64 for Claude.
 * storagePath: the path stored in the DB, e.g. "uploads/my-image.jpg"
 * bucket: the Supabase Storage bucket name
 */
export async function encodeImageFromStorage(storagePath: string, bucket: string): Promise<EncodedImage> {
  const cacheKey = `${bucket}:${storagePath}`;
  const cached = _imageCache.get(cacheKey);
  if (cached) return cached;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error || !data) {
    throw new Error(`Failed to download ${storagePath} from bucket ${bucket}: ${error?.message}`);
  }

  const ext = storagePath.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = SUPPORTED_IMAGE_TYPES[ext as keyof typeof SUPPORTED_IMAGE_TYPES] ?? 'image/jpeg';
  const arrayBuffer = await data.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const result: EncodedImage = { base64, mimeType };
  if (_imageCache.size >= IMAGE_CACHE_MAX) {
    // Evict oldest entry (Map preserves insertion order, so the first key is oldest).
    const firstKey = _imageCache.keys().next().value;
    if (firstKey !== undefined) _imageCache.delete(firstKey);
  }
  _imageCache.set(cacheKey, result);
  return result;
}

export async function loadConversation(
  videoProjectId: number,
  videoScreenId?: number,
): Promise<MessageParam[]> {
  let rows;
  if (videoScreenId) {
    rows = await db
      .select()
      .from(claudeConversations)
      .where(eq(claudeConversations.videoScreenId, videoScreenId))
      .limit(1);
  } else {
    rows = await db
      .select()
      .from(claudeConversations)
      .where(
        and(
          eq(claudeConversations.videoProjectId, videoProjectId),
          isNull(claudeConversations.videoScreenId),
        ),
      )
      .limit(1);
  }
  const row = rows[0];
  if (!row) return [];
  try {
    return JSON.parse(row.messagesJson) as MessageParam[];
  } catch {
    return [];
  }
}

export async function saveConversation(
  videoProjectId: number,
  messages: MessageParam[],
  videoScreenId?: number,
): Promise<void> {
  const now = Date.now();
  let existing;
  if (videoScreenId) {
    const rows = await db
      .select()
      .from(claudeConversations)
      .where(eq(claudeConversations.videoScreenId, videoScreenId))
      .limit(1);
    existing = rows[0];
  } else {
    const rows = await db
      .select()
      .from(claudeConversations)
      .where(
        and(
          eq(claudeConversations.videoProjectId, videoProjectId),
          isNull(claudeConversations.videoScreenId),
        ),
      )
      .limit(1);
    existing = rows[0];
  }

  const json = JSON.stringify(messages);
  if (existing) {
    await db
      .update(claudeConversations)
      .set({ messagesJson: json, updatedAt: now })
      .where(eq(claudeConversations.id, existing.id));
  } else {
    await db
      .insert(claudeConversations)
      .values({ videoProjectId, videoScreenId: videoScreenId ?? null, messagesJson: json, updatedAt: now });
  }
}

export interface CallClaudeOptions {
  videoScreenId?: number;
  fresh?: boolean;
  image?: EncodedImage;
}

export async function callClaude(
  videoProjectId: number,
  userMessage: string,
  systemPrompt?: string,
  options?: CallClaudeOptions,
): Promise<string> {
  const { videoScreenId, fresh = false, image } = options ?? {};

  const history = fresh ? [] : await loadConversation(videoProjectId, videoScreenId);

  const userContent: MessageParam['content'] = image
    ? [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mimeType, data: image.base64 },
        },
        { type: 'text' as const, text: userMessage },
      ]
    : userMessage;

  const messages: MessageParam[] = [
    ...history,
    { role: 'user', content: userContent },
  ];

  const response = await getClient().messages.create({
    model: MODEL(),
    max_tokens: 8192,
    system: systemPrompt,
    messages,
  });

  const assistantText = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  if (!fresh) {
    const updated: MessageParam[] = [
      ...messages,
      { role: 'assistant', content: response.content },
    ];
    await saveConversation(videoProjectId, updated, videoScreenId);
  }

  return assistantText;
}
