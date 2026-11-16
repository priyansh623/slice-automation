/**
 * Script analysis and Scene Pack recommendation. The model reads the whole script and a compact profile of every active pack
 * and says which packs are likely to hold useful images, and why. Recommendations only ORDER and EXPLAIN packs: a project can
 * approve any pack, recommended or not, and approval (not a score) is what makes a pack's images visible.
 *
 * Pack profiles are built from the images' effective metadata (manual over imported over AI), by counting, with no model call.
 * They describe SCENES only. Anything that names or describes a person is dropped from a profile, and no composition detail (pose,
 * gaze, position of a person in the frame) and no attribute of the project's character reference ever reaches the prompt.
 */
import Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssetMetadata, studioAssets, studioPacks, studioProjects } from '@/db/schema.pg';
import { aiConfigured, getStudioClient, type StudioMessagesClient } from './ai-client';
import { studioAnalysisModel } from './analysis-schema';
import { effectiveMetadata, type ImportedLayer, type MetadataRecord } from './metadata';
import { classifyProp, classifyTag, mentionsIndexedPerson, mentionsPerson, stripPersonWords } from './import/scene-metadata';
import { getProject } from './projects';
import { StudioError } from './repository';

export interface PackProfile {
  environments: string[]; activities: string[]; objects: string[]; tags: string[]; imageCount: number; analysedCount: number;
  /** The scene concepts that tell this pack apart from the others (tags ranked by how few packs share them). */
  concepts?: string[];
  /** How many images carry a brand (Slice card or app screen, third-party). Informational: branding alone is never a reason to recommend. */
  brand?: { slice: number; thirdParty: number };
}
export interface Recommendation { packId: number; score: number; reasons: string[]; moments: string[]; /** The specific scene concepts of the pack that make it relevant. */ scenes?: string[] }

export const MAX_RECOMMENDATIONS = 12;
/** A recommendation below this score is treated as "not really relevant" and is not shown. */
export const MIN_SCORE = 0.3;
export const RECOMMEND_TIMEOUT_MS = 40_000;
/** A project whose analysis has been "processing" longer than this is treated as abandoned. */
export const ANALYSIS_STALE_MS = 90_000;
const TOP = 12;
/** Most objects, tags and concepts kept per pack. Most of a pack's terms occur once, so a small cap cuts arbitrary ones (alphabetically); the cap only guards against a very large pack. */
const PROFILE_CAP = 80;

function top(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
}

interface RawProfile { profile: PackProfile; tags: Map<string, number> }

/** Counts the effective values of a pack's active images. Deterministic. Values that name or describe a person are left out. */
async function computeRawProfile(packId: number): Promise<RawProfile> {
  const rows = await db
    .select({ ai: studioAssetMetadata.ai, manual: studioAssetMetadata.manual, imported: studioAssetMetadata.imported, status: studioAssets.analysisStatus })
    .from(studioAssets).leftJoin(studioAssetMetadata, eq(studioAssetMetadata.assetId, studioAssets.id))
    .where(and(eq(studioAssets.packId, packId), isNull(studioAssets.archivedAt)));
  const env = new Map<string, number>(); const act = new Map<string, number>(); const obj = new Map<string, number>(); const tag = new Map<string, number>();
  let analysed = 0; let slice = 0; let thirdParty = 0;
  const bump = (m: Map<string, number>, v: string | null, scene: (t: string) => boolean = (t) => !mentionsPerson(t) && !mentionsIndexedPerson(t)) => { const k = v?.toLowerCase().trim(); if (k && scene(k)) m.set(k, (m.get(k) ?? 0) + 1); };
  // Objects and tags must be scene content: a person, clothing, a personal accessory or a facial expression never becomes a signal.
  const sceneProp = (t: string) => classifyProp(t).class === 'scene' && !mentionsIndexedPerson(t);
  const sceneTag = (t: string) => classifyTag(t).class === 'scene' && !mentionsIndexedPerson(t);
  for (const r of rows) {
    const imported = (r.imported as ImportedLayer | null) ?? {};
    const e = effectiveMetadata(r.ai as MetadataRecord | null, r.manual as MetadataRecord | null, imported);
    if (e.values.environment || e.values.description || e.values.tags.length) analysed++;
    bump(env, e.values.environment); bump(act, e.values.activity);
    for (const o of (e.values.objects_props ?? '').split(',')) bump(obj, o, sceneProp);
    for (const t of e.values.tags) bump(tag, t, sceneTag);
    if (imported.operational?.brand?.slice) slice++;
    if (imported.operational?.brand?.third_party) thirdParty++;
  }
  const profile: PackProfile = { environments: top(env, TOP), activities: top(act, TOP), objects: top(obj, PROFILE_CAP), tags: top(tag, PROFILE_CAP), imageCount: rows.length, analysedCount: analysed };
  if (slice || thirdParty) profile.brand = { slice, thirdParty };
  return { profile, tags: tag };
}

export async function computePackProfile(packId: number): Promise<PackProfile> {
  const { profile, tags } = await computeRawProfile(packId);
  profile.concepts = top(tags, PROFILE_CAP);
  return profile;
}

/** Tags ranked by how few OTHER packs share them (a concept only this pack has is the one that tells the packs apart), then by frequency. */
function rankConcepts(tags: Map<string, number>, docFreq: Map<string, number>, nPacks: number, n: number): string[] {
  const score = (t: string, c: number) => c * Math.log(1 + nPacks / (docFreq.get(t) ?? 1));
  return [...tags.entries()].sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]) || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
}

/**
 * Rebuilds the stored profile of every active pack when any of them is out of date. All packs are rebuilt together because the
 * "distinctive concepts" of one pack depend on what the others contain.
 */
export async function refreshStaleProfiles(): Promise<number> {
  const stale = await db.select({ id: studioPacks.id }).from(studioPacks).where(and(isNull(studioPacks.archivedAt), sql`(${studioPacks.profileStale} or ${studioPacks.profile} is null)`));
  if (stale.length === 0) return 0;
  const active = await db.select({ id: studioPacks.id }).from(studioPacks).where(isNull(studioPacks.archivedAt));
  const raws = new Map<number, RawProfile>();
  for (const p of active) raws.set(p.id, await computeRawProfile(p.id));
  const docFreq = new Map<string, number>();
  for (const { tags } of raws.values()) for (const t of tags.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  for (const [id, { profile, tags }] of raws) {
    profile.concepts = rankConcepts(tags, docFreq, raws.size, PROFILE_CAP);
    await db.update(studioPacks).set({ profile, profileStale: false }).where(eq(studioPacks.id, id));
  }
  return stale.length;
}

const TOOL = 'recommend_scene_packs';
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    recommendations: {
      type: 'array',
      description: `The Scene Packs that contain a scene which helps show this script, best first (at most ${MAX_RECOMMENDATIONS}). An empty list is correct when no pack helps.`,
      items: {
        type: 'object',
        properties: {
          pack_id: { type: 'integer', description: 'The id of a pack from the list.' },
          score: { type: 'number', description: 'How useful the pack is for this script, from 0 to 1.' },
          reasons: { type: 'array', items: { type: 'string' }, description: '1 to 3 short reasons: which scene in the pack helps, and which part of the script it supports.' },
          moments: { type: 'array', items: { type: 'string' }, description: 'The moments or lines in the script this pack could illustrate (short quotes or paraphrases).' },
          scenes: { type: 'array', items: { type: 'string' }, description: 'The specific scene concepts of this pack (taken from its environments, activities, objects or concepts) that make it relevant.' },
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
  'You help plan the visuals for a short video. You are given the complete script and a list of Scene Packs (named collections of reference scenes).',
  'Find the visual moments in the script (places, activities, objects, situations) and recommend a pack ONLY when it contains a meaningful scene that helps show one of those moments.',
  'Do not force recommendations: if no pack holds a scene that helps, return an empty list. A weak or generic match is not a reason to recommend a pack.',
  'Judge only from the pack names, descriptions and the environments, activities, objects and concepts listed for each pack.',
  'For each recommended pack say which specific scene concepts make it relevant, and which part of the script they support.',
  'A brand (a card, an app screen, a logo) is never a reason by itself. Mention a branded scene only when the script is about that brand\'s own product and needs that kind of scene.',
  'Never consider or mention anyone\'s gender, age, ethnicity, clothing or appearance. Recommendations only order and explain packs; they do not hide anything.',
  'Always answer by calling the recommend_scene_packs tool. Use only pack ids from the list.',
].join('\n');

export interface PackForPrompt { id: number; name: string; description: string | null; profile: PackProfile | null }

export function buildRecommendationPrompt(script: string, packs: PackForPrompt[]): string {
  const list = packs.map((p) => {
    const pr = p.profile;
    return [
      `Pack ${p.id}: ${stripPersonWords(p.name)}`,
      stripPersonWords(p.description ?? '') ? `  About: ${stripPersonWords(p.description ?? '')}` : null,
      pr && pr.imageCount > 0 ? `  Images: ${pr.imageCount}` : '  Images: none analysed yet',
      pr?.environments.length ? `  Environments: ${pr.environments.join('; ')}` : null,
      pr?.activities.length ? `  Activities: ${pr.activities.join('; ')}` : null,
      pr?.objects.length ? `  Objects: ${pr.objects.join('; ')}` : null,
      pr?.concepts?.length ? `  Scene concepts: ${pr.concepts.slice(0, PROFILE_CAP).join(', ')}` : pr?.tags.length ? `  Tags: ${pr.tags.slice(0, 20).join(', ')}` : null,
      pr?.brand?.slice ? `  Brand note: ${pr.brand.slice} of ${pr.imageCount} images show a Slice card or app screen. Relevant only to scripts about that offer; not a reason by itself.` : null,
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
    const rec: Recommendation = { packId: id, score: Math.round(score * 100) / 100, reasons: list(r.reasons, 3, 300), moments: list(r.moments, 5, 200) };
    const scenes = list((it as { scenes?: unknown }).scenes, 6, 80);
    if (scenes.length) rec.scenes = scenes;
    out.push(rec);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_RECOMMENDATIONS);
}

const BRAND_WORDS = /\b(slice|super slicer|brand(ed|ing)?|logo|card|app|ui|screen|credit|upi)\b/gi;
const words = (t: string): string[] => t.toLowerCase().match(/[a-z]{4,}/g) ?? [];
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');

/** True if the explanation has nothing but branding in it ("shows a Slice card"): branding alone is not relevance. */
export function isBrandOnly(texts: string[]): boolean {
  const rest = texts.join(' ').replace(BRAND_WORDS, ' ');
  return words(rest).length < 2;
}

/**
 * Keeps a recommendation only if it is relevant, explained and grounded in the pack: a score of at least MIN_SCORE, at least one
 * reason, not only a brand, and an explanation that mentions something the pack really holds (its name, description, environments,
 * activities, objects or concepts). Scenes the model names that the pack does not hold are removed. Returns [] when nothing
 * qualifies: a recommendation is never forced.
 */
export function groundRecommendations(recs: Recommendation[], packs: PackForPrompt[]): Recommendation[] {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const out: Recommendation[] = [];
  for (const r of recs) {
    const p = byId.get(r.packId);
    if (!p || r.score < MIN_SCORE || r.reasons.length === 0) continue;
    const vocabTexts = [p.name, p.description ?? '', ...(p.profile?.environments ?? []), ...(p.profile?.activities ?? []), ...(p.profile?.objects ?? []), ...(p.profile?.concepts ?? []), ...(p.profile?.tags ?? [])];
    const vocab = new Set(vocabTexts.flatMap(words).map(stem));
    const held = (t: string) => words(t).map(stem).some((w) => vocab.has(w));
    const scenes = (r.scenes ?? []).filter(held);
    if (isBrandOnly([...r.reasons, ...scenes])) continue;
    if (!held([...r.reasons, ...scenes].join(' '))) continue;
    out.push({ ...r, scenes: scenes.length ? scenes : undefined });
  }
  return out;
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
  return groundRecommendations(sanitiseRecommendations(call.input, new Set(packs.map((p) => p.id))), packs);
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
