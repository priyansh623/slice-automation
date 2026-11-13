import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';
import { eq, and, lt, isNull } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { getStorage } from '@/lib/object-store';

const BROLL_TASK_LEASE_MS = 10 * 60 * 1000;

interface BrollAIMetadata {
  tags: string[];
  mood: string;
  sceneType: string;
  subjects: string[];
  summary: string;
}

const BROLL_ANALYSIS_SYSTEM = `You are a video metadata expert. Analyze B-roll clips and return structured metadata as valid JSON.`;

const BROLL_ANALYSIS_PROMPT = (title: string, hasThumbnail: boolean) => `Analyze this B-roll video clip.
Title: "${title}"
${hasThumbnail ? 'A thumbnail frame from the video is attached.' : 'No thumbnail available — infer from the title only.'}

Return ONLY a valid JSON object with these fields:
{
  "tags": ["array of 5-10 descriptive scene keywords"],
  "mood": "one word: energetic | calm | professional | playful | serious | warm | neutral",
  "sceneType": "one word: indoor | outdoor | product | nature | urban | abstract | person | lifestyle",
  "subjects": ["array of 2-5 main subjects visible"],
  "summary": "1-2 sentence description of what the clip shows"
}`;

async function fetchThumbnailBase64(signedUrl: string): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const res = await fetch(signedUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const buf = await res.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    return { base64, mediaType: contentType };
  } catch {
    return null;
  }
}

async function analyzeClip(clip: { title: string; thumbnailSignedUrl: string | null }): Promise<BrollAIMetadata> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const hasThumbnail = !!clip.thumbnailSignedUrl;
  const userContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];

  if (hasThumbnail && clip.thumbnailSignedUrl) {
    const img = await fetchThumbnailBase64(clip.thumbnailSignedUrl);
    if (img) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: img.base64 },
      });
    }
  }

  userContent.push({ type: 'text', text: BROLL_ANALYSIS_PROMPT(clip.title, hasThumbnail) });

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
    max_tokens: 512,
    system: BROLL_ANALYSIS_SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude response');

  const parsed = JSON.parse(jsonMatch[0]) as Partial<BrollAIMetadata>;
  return {
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    mood: typeof parsed.mood === 'string' ? parsed.mood : 'neutral',
    sceneType: typeof parsed.sceneType === 'string' ? parsed.sceneType : 'indoor',
    subjects: Array.isArray(parsed.subjects) ? parsed.subjects : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}

async function refreshThumbnailSignedUrl(storagePath: string): Promise<string | null> {
  if (!storagePath) return null;
  try {
    return await getStorage().signedReadUrl('uploads', storagePath, 3600);
  } catch {
    return null;
  }
}

export async function processPendingBrollClips(): Promise<void> {
  const now = Date.now();
  const staleThreshold = now - BROLL_TASK_LEASE_MS;

  // Recover stale claimed clips
  await db
    .update(brollClips)
    .set({ processingStatus: 'pending', claimedAt: null, updatedAt: now })
    .where(
      and(
        eq(brollClips.processingStatus, 'processing'),
        lt(brollClips.claimedAt, staleThreshold),
      ),
    );

  // Claim one pending clip
  const [pending] = await db
    .select()
    .from(brollClips)
    .where(eq(brollClips.processingStatus, 'pending'))
    .limit(1);

  if (!pending) return;

  await db
    .update(brollClips)
    .set({ processingStatus: 'processing', claimedAt: now, updatedAt: now })
    .where(eq(brollClips.id, pending.id));

  try {
    // Refresh thumbnail signed URL if we have a thumbnail
    let thumbnailUrl = pending.thumbnailSignedUrl;
    if (pending.thumbnailStoragePath && (!thumbnailUrl || (pending.thumbnailSignedUrlExpiresAt ?? 0) < now + 60_000)) {
      thumbnailUrl = await refreshThumbnailSignedUrl(pending.thumbnailStoragePath);
    }

    const metadata = await analyzeClip({ title: pending.title, thumbnailSignedUrl: thumbnailUrl ?? null });

    await db
      .update(brollClips)
      .set({
        processingStatus: 'completed',
        claimedAt: null,
        aiTags: JSON.stringify(metadata.tags),
        aiMood: metadata.mood,
        aiSceneType: metadata.sceneType,
        aiSubjects: JSON.stringify(metadata.subjects),
        aiSummary: metadata.summary,
        updatedAt: Date.now(),
      })
      .where(eq(brollClips.id, pending.id));

    console.log(`[broll] Processed clip ${pending.id}: ${pending.title}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[broll] Failed to process clip ${pending.id}:`, msg);
    await db
      .update(brollClips)
      .set({ processingStatus: 'failed', processingError: msg, claimedAt: null, updatedAt: Date.now() })
      .where(eq(brollClips.id, pending.id));
  }
}
