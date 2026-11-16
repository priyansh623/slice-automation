/**
 * Script analysis and Scene Pack recommendation. The model reads the whole script and a compact profile of every active pack
 * and says which packs are likely to hold useful images, and why. Recommendations only ORDER and EXPLAIN packs: a project can
 * approve any pack, recommended or not, and approval (not a score) is what makes a pack's images visible.
 *
 * Pack profiles are built from the images' effective metadata (manual over AI), by counting, with no model call.
 */
import Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssetMetadata, studioAssets, studioPacks, studioProjects } from '@/db/schema.pg';
import { aiConfigured, getStudioClient, type StudioMessagesClient } from './ai-client';
import { studioAnalysisModel } from './analysis-schema';
import { effectiveMetadata, type MetadataRecord } from './metadata';
import { getProject } from './projects';
import { StudioError } from './repository';

export interface PackProfile { environments: string[]; activities: string[]; objects: string[]; tags: string[]; imageCount: number; analysedCount: number }
export interface Recommendation { packId: number; score: number; reasons: string[]; moments: string[] }

export const MAX_RECOMMENDATIONS = 12;
export const RECOMMEND_TIMEOUT_MS = 40_000;
/** A project whose analysis has been "processing" longer than this is treated as abandoned. */
export const ANALYSIS_STALE_MS = 90_000;
const TOP = 12;

function top(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
}

/** Counts the effective values of a pack's active images. Deterministic. */
export async function computePackProfile(packId: number): Promise<PackProfile> {
  const rows = await db
    .select({ ai: studioAssetMetadata.ai, manual: studioAssetMetadata.manual, status: studioAssets.analysisStatus })
    .from(studioAssets).leftJoin(studioAssetMetadata, eq(studioAssetMetadata.assetId, studioAssets.id))
    .where(and(eq(studioAssets.packId, packId), isNull(studioAssets.archivedAt)));
  const env = new Map<string, number>(); const act = new Map<string, number>(); const obj = new Map<string, number>(); const tag = new Map<string, number>();
  let analysed = 0;
  const bump = (m: Map<string, number>, v: string | null) => { const k = v?.toLowerCase().trim(); if (k) m.set(k, (m.get(k) ?? 0) + 1); };
  for (const r of rows) {
    const e = effectiveMetadata(r.ai as MetadataRecord | null, r.manual as MetadataRecord | null);
    if (e.values.environment || e.values.description || e.values.tags.length) analysed++;
    bump(env, e.values.environment); bump(act, e.values.activity);
    for (const o of (e.values.objects_props ?? '').split(',')) bump(obj, o);
    for (const t of e.values.tags) bump(tag, t);
  }
  return { environments: top(env, TOP), activities: top(act, TOP), objects: top(obj, TOP), tags: top(tag, 30), imageCount: rows.length, analysedCount: analysed };
}

/** Rebuilds the stored profile of every active pack that is out of date (new, changed or newly analysed images). */
export async function refreshStaleProfiles(): Promise<number> {
  const stale = await db.select({ id: studioPacks.id }).from(studioPacks).where(and(isNull(studioPacks.archivedAt), sql`(${studioPacks.profileStale} or ${studioPacks.profile} is null)`));
  for (const p of stale) {
    const profile = await computePackProfile(p.id);
    await db.update(studioPacks).set({ profile, profileStale: false }).where(eq(studioPacks.id, p.id));
  }
  return stale.length;
}

const TOOL = 'recommend_scene_packs';
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    recommendations: {
      type: 'array',
      description: `The most useful Scene Packs for this script, best first (at most ${MAX_RECOMMENDATIONS}). Leave out packs that are not useful.`,
      items: {
        type: 'object',
        properties: {
          pack_id: { type: 'integer', description: 'The id of a pack from the list.' },
          score: { type: 'number', description: 'How useful the pack is for this script, from 0 to 1.' },
          reasons: { type: 'array', items: { type: 'string' }, description: '1 to 3 short reasons, tied to what the pack holds and what the script needs.' },
          moments: { type: 'array', items: { type: 'string' }, description: 'The moments or lines in the script this pack could illustrate (short quotes or paraphrases).' },
        },
        required: ['pack_id', 'score', 'reasons', 'moments'],
        additionalProperties: false,
      },
    },
  },
  required: ['recommendations'],
  additionalProperties: false,
} as const;

const SYSTEM = [
  'You help plan the visuals for a short video. You are given the complete script and a list of Scene Packs (named collections of reference images).',
  'Find the visual moments in the script (places, activities, objects, situations) and recommend the packs most likely to hold images for them.',
  'Judge only from the pack names, descriptions and the environments, activities, objects and tags listed for each pack.',
  'Never consider or mention anyone\'s gender, age, ethnicity or appearance. Recommendations only order and explain packs; they do not hide anything.',
  'Always answer by calling the recommend_scene_packs tool. Use only pack ids from the list.',
].join('\n');

export interface PackForPrompt { id: number; name: string; description: string | null; profile: PackProfile | null }

export function buildRecommendationPrompt(script: string, packs: PackForPrompt[]): string {
  const list = packs.map((p) => {
    const pr = p.profile;
    return [
      `Pack ${p.id}: ${p.name}`,
      p.description ? `  About: ${p.description}` : null,
      pr && pr.imageCount > 0 ? `  Images: ${pr.imageCount}` : '  Images: none analysed yet',
      pr?.environments.length ? `  Environments: ${pr.environments.join('; ')}` : null,
      pr?.activities.length ? `  Activities: ${pr.activities.join('; ')}` : null,
      pr?.objects.length ? `  Objects: ${pr.objects.join('; ')}` : null,
      pr?.tags.length ? `  Tags: ${pr.tags.slice(0, 20).join(', ')}` : null,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return `SCRIPT:\n${script.trim()}\n\nSCENE PACKS:\n${list}\n\nRecommend the packs for this script.`;
}

/** Keeps only real pack ids, bounded scores and short text, best first, without repeats. */
export function sanitiseRecommendations(raw: unknown, validIds: Set<number>): Recommendation[] {
  const items = (raw as { recommendations?: unknown })?.recommendations;
  if (!Array.isArray(items)) return [];
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const list = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.map((x) => text(x, max)).filter(Boolean).slice(0, n) : []);
  const seen = new Set<number>();
  const out: Recommendation[] = [];
  for (const it of items) {
    const r = it as { pack_id?: unknown; score?: unknown; reasons?: unknown; moments?: unknown };
    const id = typeof r.pack_id === 'number' ? r.pack_id : NaN;
    if (!validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const score = typeof r.score === 'number' && Number.isFinite(r.score) ? Math.min(Math.max(r.score, 0), 1) : 0;
    out.push({ packId: id, score: Math.round(score * 100) / 100, reasons: list(r.reasons, 3, 300), moments: list(r.moments, 5, 200) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_RECOMMENDATIONS);
}

export async function recommendPacks(script: string, packs: PackForPrompt[], deps: { client?: StudioMessagesClient; model?: string } = {}): Promise<Recommendation[]> {
  if (packs.length === 0) return [];
  const res = await (deps.client ?? getStudioClient()).messages.create({
    model: deps.model ?? studioAnalysisModel(),
    max_tokens: 3000,
    system: SYSTEM,
    tools: [{ name: TOOL, description: 'Record the recommended Scene Packs.', input_schema: TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema }],
    tool_choice: { type: 'auto' }, // a forced tool choice is rejected by claude-sonnet-5-5 (see src/lib/broll-bulk/analyzer.ts)
    messages: [{ role: 'user', content: buildRecommendationPrompt(script, packs) }],
  }, { timeout: RECOMMEND_TIMEOUT_MS, maxRetries: 1 });
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL);
  if (!call) throw new Error('The model did not return recommendations');
  return sanitiseRecommendations(call.input, new Set(packs.map((p) => p.id)));
}

/**
 * Analyses the project's script and stores the recommendations with the hash of the script they were made for. State is kept
 * on the project (idle | processing | completed | failed) so a timeout or error is visible and retryable. Re-running for the
 * same script returns the stored result unless `force` is set.
 */
export async function analyseProjectScript(projectId: number, opts: { force?: boolean; client?: StudioMessagesClient; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const project = await getProject(projectId);
  if (!project.script.trim()) throw new StudioError('Enter the script first.', 400, 'script_required');
  if (!opts.client && !aiConfigured()) throw new StudioError('Script analysis is not configured (ANTHROPIC_API_KEY is missing).', 503, 'ai_not_configured');
  if (!opts.force && project.analysisStatus === 'completed' && project.recommendationsScriptHash === project.scriptHash && project.recommendations) return project;
  const scriptHash = project.scriptHash;
  // Claim the run in ONE statement: of two simultaneous requests exactly one matches (the other sees "processing" and is refused),
  // so a double click or two tabs cannot start two model calls for the same script.
  const claimed = await db.update(studioProjects).set({ analysisStatus: 'processing', analysisError: null, analysisAt: now, updatedAt: now })
    .where(and(eq(studioProjects.id, projectId), or(isNull(studioProjects.analysisStatus), ne(studioProjects.analysisStatus, 'processing'), isNull(studioProjects.analysisAt), lt(studioProjects.analysisAt, now - ANALYSIS_STALE_MS))))
    .returning({ id: studioProjects.id });
  if (claimed.length === 0) throw new StudioError('The script is already being analysed. Wait a moment.', 409, 'in_progress');
  try {
    await refreshStaleProfiles();
    const packs = await db.select().from(studioPacks).where(isNull(studioPacks.archivedAt)).orderBy(asc(studioPacks.id));
    const recs = await recommendPacks(project.script, packs.map((p) => ({ id: p.id, name: p.name, description: p.description, profile: p.profile as PackProfile | null })), { client: opts.client });
    const [row] = await db.update(studioProjects)
      .set({ analysisStatus: 'completed', analysisError: null, analysisAt: Date.now(), recommendations: recs, recommendationsScriptHash: scriptHash, updatedAt: Date.now() })
      .where(eq(studioProjects.id, projectId)).returning();
    return row;
  } catch (err) {
    const e = err as { name?: string; status?: number };
    console.error('[studio/recommend] failed:', e.name ?? 'Error', e.status ?? '');
    await db.update(studioProjects).set({ analysisStatus: 'failed', analysisError: 'The script could not be analysed. Try again.', analysisAt: Date.now(), updatedAt: Date.now() }).where(eq(studioProjects.id, projectId));
    throw new StudioError('The script could not be analysed. Your script is saved; try again.', 502, 'analysis_failed');
  }
}
