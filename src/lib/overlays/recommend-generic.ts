/**
 * Generic B-roll suggestions from the script, with no AI service and no new data: each Flow scene's dialogue is matched, word by word,
 * against the metadata the library already holds for every clip (tags, subjects, activity, category, title, summary). The result only
 * ORDERS and EXPLAINS clips ("matches: coffee, phone"); it never selects anything.
 */
import { and, asc, eq, gt, notInArray } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips, videoScreens } from '@/db/schema.pg';

const STOP = new Set(('a an and are as at be been but by can did do does for from had has have he her his how i if in into is it its just me my no not of on or our she so than that the their them then there these they this to too up us was we were what when where which who will with you your am im ive dont cant very really also about over after before again all any more most some such only own same each both few other out off than').split(' '));
/** Light stemming so "tapping" matches "tap" and "cards" matches "card". */
export const stem = (w: string): string => w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? '' : m));
export const tokens = (text: string | null | undefined): string[] => [...new Set((text ?? '').toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !STOP.has(w)).map(stem) ?? [])];

export interface LibraryClip { id: number; title: string; aiTags: string | null; aiSubjects: string | null; aiSummary: string | null; aiSceneType: string | null; userTags: string | null; category: string | null; subject: string | null; activity: string | null; reviewStatus: string }
export interface SceneText { screenId: number; sceneNumber: number; dialogue: string }
export interface GenericSuggestion { clipId: number; score: number; matches: string[] }

const list = (json: string | null): string => { try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v.join(' ') : ''; } catch { return ''; } };

/** For each scene, up to `perScene` clips that share words with its dialogue, best first. A clip with no matching word is never suggested. */
export function recommendGeneric(scenes: readonly SceneText[], clips: readonly LibraryClip[], perScene = 6): Record<number, GenericSuggestion[]> {
  const fields = clips.filter((c) => c.reviewStatus !== 'archived' && c.reviewStatus !== 'rejected').map((c) => ({
    id: c.id,
    strong: new Set(tokens([list(c.aiTags), list(c.userTags), list(c.aiSubjects), c.subject, c.activity, c.category, c.aiSceneType].join(' '))),
    medium: new Set(tokens(c.title)), weak: new Set(tokens(c.aiSummary)),
  }));
  const out: Record<number, GenericSuggestion[]> = {};
  for (const s of scenes) {
    const words = tokens(s.dialogue);
    const scored: GenericSuggestion[] = [];
    for (const f of fields) {
      let score = 0; const matches: string[] = [];
      for (const w of words) {
        const pts = f.strong.has(w) ? 3 : f.medium.has(w) ? 2 : f.weak.has(w) ? 1 : 0;
        if (pts) { score += pts; matches.push(w); }
      }
      if (score > 0) scored.push({ clipId: f.id, score, matches });
    }
    out[s.screenId] = scored.sort((a, b) => b.score - a.score || a.clipId - b.clipId).slice(0, perScene);
  }
  return out;
}

export async function genericSuggestionsForProject(projectId: number) {
  const rows = await db.select({ id: videoScreens.id, n: videoScreens.screenNumber, d: videoScreens.dialogue }).from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, projectId), gt(videoScreens.screenNumber, 0))).orderBy(asc(videoScreens.position));
  const clips = await db.select().from(brollClips).where(notInArray(brollClips.reviewStatus, ['archived', 'rejected']));
  return recommendGeneric(rows.map((r) => ({ screenId: r.id, sceneNumber: r.n, dialogue: r.d })), clips);
}
