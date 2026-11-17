/**
 * Which library clips and categories a script points to, using only the library's own search (its concept lexicon, tags and categories). No AI,
 * no new data. Each concept the search understands in a scene's text is searched on its own; clips that match more concepts rank higher.
 * It only orders and explains; it never selects anything.
 */
import { interpretQuery, searchClips, type SearchCategory, type SearchClip } from './broll-search';

export interface SceneText { screenId: number; dialogue: string }
export interface Recommended<T extends SearchClip> { clip: T; scenes: number[]; why: string[] }

export function recommendClips<T extends SearchClip>(scenes: readonly SceneText[], clips: readonly T[], categories: readonly SearchCategory[], limit = 12): Recommended<T>[] {
  const score = new Map<number, { clip: T; n: number; scenes: Set<number>; why: Set<string> }>();
  for (const s of scenes) {
    for (const concept of interpretQuery(s.dialogue).concepts) {
      for (const h of searchClips(concept, [...clips], [...categories]).hits.filter((x) => x.tier === 'direct').slice(0, 8)) {
        const e = score.get(h.clip.id) ?? { clip: h.clip, n: 0, scenes: new Set<number>(), why: new Set<string>() };
        e.n += h.score; e.scenes.add(s.screenId); e.why.add(concept); score.set(h.clip.id, e);
      }
    }
  }
  return [...score.values()].sort((a, b) => b.n - a.n || a.clip.id - b.clip.id).slice(0, limit).map((e) => ({ clip: e.clip, scenes: [...e.scenes], why: [...e.why] }));
}
