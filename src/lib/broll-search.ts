/**
 * Natural-language search over the shared B-roll library.
 *
 * Pure functions only (no database, no network, no UI), so the same code runs in the browser and in tests and
 * the benchmark. It works on the metadata a clip already has: title, description, activity, subject, setting,
 * brand, tags, brand associations and the categories assigned to it. It never invents attributes.
 *
 * How a query is understood
 *  1. It is split into words; filler words ("person", "someone", "using", "a" …) are dropped.
 *  2. Words that form a known concept ("payment", "shopping", "work" …) are grouped into that concept. Words that
 *     match no concept stay as plain words ("QR", "scanning", "cash", "unboxing", a brand name).
 *  3. Broad query: every word belongs to a known concept. Specific query: at least one word does not.
 *
 * How a clip is matched
 *  - A concept matches DIRECTLY when one of its terms appears in the clip's own text, or the clip is assigned to
 *    one of the concept's categories. It matches RELATEDLY when a concept it is explicitly linked to matches
 *    directly. These links are written down in the lexicon below; nothing is inferred.
 *  - Every concept and every plain word in the query has to match (AND). Plain words match only if the word
 *    (or a listed synonym) is literally in the clip's text.
 *  - Specific queries return direct matches only: they are never broadened, so zero results are possible and
 *    correct. Broad queries return direct matches first, then related matches, which are flagged as related.
 *
 * Filters are not handled here: callers narrow the library first and pass the narrowed list in, so search can
 * only ever rank or drop clips from that list and can never add one back.
 */
import { BROLL_CATEGORY_MAP } from './broll-category-map';

export interface SearchClip {
  id: number;
  title: string;
  description?: string | null;
  subject?: string | null;
  activity?: string | null;
  setting?: string | null;
  brand?: string | null;
  userTags?: string | string[] | null;
  categoryIds?: number[];
  brands?: { brandName: string | null }[];
  createdAt?: number;
}

export interface SearchCategory { id: number; name: string; parentId: number | null }

export type MatchTier = 'direct' | 'related';

export interface SearchHit<T extends SearchClip = SearchClip> {
  clip: T;
  tier: MatchTier;
  score: number;
  /** Human-readable reasons, e.g. 'title: payment', 'category: Rewards cashback', 'related to payment'. */
  why: string[];
}

export interface QueryInterpretation {
  kind: 'empty' | 'broad' | 'specific';
  concepts: string[];
  plainWords: string[];
}

export interface SearchResult<T extends SearchClip = SearchClip> {
  interpretation: QueryInterpretation;
  hits: SearchHit<T>[];
}

// ---------------------------------------------------------------------------------------------------------------
// Text handling

const FILLER = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'with', 'for', 'to', 'and', 'or', 'by', 'from', 'into', 'while', 'who',
  'is', 'are', 'being', 'some', 'my', 'me', 'it', 'its', 'that', 'this', 'up',
  'person', 'people', 'someone', 'somebody', 'anyone', 'using', 'use', 'uses', 'used',
  'video', 'videos', 'clip', 'clips', 'footage', 'shot', 'shots', 'scene', 'scenes', 'broll',
]);

export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length > 5) {
    let s = w.slice(0, -3);
    if (/([^aeiou])\1$/.test(s)) s = s.slice(0, -1);
    return s;
  }
  if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
  if (/(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}

function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w))
    .map(stem);
}

function parseTags(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lexicon: concepts and their written-down relationships

interface ConceptDef {
  /**
   * Head words: a query word in this list means the concept (broad). They also match clip text.
   * Query "payment" means the payment concept.
   */
  terms: string[];
  /**
   * Narrower words that count as this concept when they appear in a clip's text, but do not make a query about
   * the concept. Query "snack" is NOT the food concept: it is a plain word that must appear in the clip, so it
   * is not widened to every food clip.
   */
  members?: string[];
  /** Category slugs (see BROLL_CATEGORY_MAP) whose clips are direct matches whatever their text says. */
  categories?: string[];
  /** Concepts whose direct matches are related matches here, with a strength (2 close, 1 loose). */
  related?: Record<string, 1 | 2>;
  /** Category slugs whose clips are related matches. */
  relatedCategories?: Record<string, 1 | 2>;
}

const LEXICON: Record<string, ConceptDef> = {
  payment: {
    terms: ['payment', 'pay', 'paid', 'tap to pay', 'contactless'],
    categories: ['mobile-payment', 'card-tap', 'checkout-payment'],
    related: { rewards: 2, banking: 2, card: 1 },
  },
  rewards: {
    terms: ['reward', 'cashback'],
    members: ['redemption', 'redeem', 'points'],
    categories: ['rewards-cashback'],
    relatedCategories: { 'mobile-payment': 1, 'card-tap': 1, 'checkout-payment': 1 },
  },
  banking: {
    terms: ['bank', 'banking'],
    members: ['transaction', 'balance'],
    categories: ['banking-app'],
    relatedCategories: { 'mobile-payment': 2, 'card-tap': 1, 'checkout-payment': 1 },
  },
  card: {
    terms: ['card'],
    members: ['debit card', 'credit card'],
    categories: ['cards', 'card-reveal', 'card-lifestyle', 'card-benefits', 'card-tap'],
    relatedCategories: { 'mobile-payment': 1, 'checkout-payment': 1 },
  },
  shopping: {
    terms: ['shopping', 'shop', 'retail', 'buy', 'purchase'],
    members: ['store', 'mall', 'boutique'],
    categories: ['shopping-retail', 'in-store-browsing', 'product-display', 'bags-after-purchase'],
    related: { payment: 2 },
    relatedCategories: { 'quick-commerce': 1, 'checkout-payment': 2 },
  },
  groceries: {
    terms: ['grocery'],
    members: ['supermarket', 'minimart', 'produce', 'aisle'],
    categories: ['groceries', 'supermarket-aisles', 'fresh-produce', 'groceries-checkout'],
    relatedCategories: { 'quick-commerce': 1 },
  },
  food: {
    terms: ['food', 'meal', 'eat', 'dining'],
    members: ['snack', 'noodle', 'momo', 'pizza', 'popcorn', 'chip', 'rice', 'restaurant', 'takeaway', 'street food'],
    categories: ['food-beverage', 'cafe-coffee', 'restaurant-dining', 'street-food', 'food-at-home'],
    related: { groceries: 1 },
  },
  drink: {
    terms: ['drink', 'beverage'],
    members: ['coffee', 'tea', 'chai', 'cola', 'juice', 'latte', 'kulhad', 'cup', 'mug'],
    categories: ['cafe-coffee'],
    related: { food: 1 },
  },
  coffee: {
    terms: ['coffee'],
    members: ['latte', 'espresso', 'cappuccino'],
    related: { cafe: 1 },
  },
  tea: {
    terms: ['tea', 'chai'],
    members: ['kulhad'],
  },
  cafe: {
    terms: ['cafe', 'coffee shop'],
    categories: ['cafe-coffee'],
    related: { coffee: 2 },
  },
  cooking: {
    terms: ['cook', 'recipe'],
    members: ['kitchen', 'mix', 'bake'],
    categories: ['cooking-at-home'],
  },
  delivery: {
    terms: ['delivery', 'deliver'],
    members: ['parcel', 'package', 'courier', 'shipment', 'quick commerce'],
    categories: ['delivery-logistics', 'package-delivery', 'last-mile', 'courier', 'quick-commerce'],
  },
  travel: {
    terms: ['travel', 'trip', 'journey', 'commute'],
    members: ['flight', 'plane', 'airport', 'train', 'transit', 'cab', 'taxi', 'rickshaw', 'hotel', 'road trip'],
    categories: ['travel-transport', 'airport', 'train-transit', 'road-trip', 'cab-ride-hailing'],
  },
  cab: {
    terms: ['cab', 'taxi', 'rickshaw', 'ride hailing'],
    categories: ['cab-ride-hailing'],
  },
  entertainment: {
    terms: ['entertainment', 'fun'],
    members: ['movie', 'cinema', 'film', 'go kart'],
    categories: ['entertainment'],
  },
  gaming: {
    terms: ['gaming', 'game', 'video game'],
    members: ['controller', 'ps5', 'playstation', 'console'],
  },
  relax: {
    terms: ['relax', 'relaxation', 'chill'],
    members: ['recliner', 'feet up', 'cozy'],
    categories: ['relaxation'],
  },
  social: {
    terms: ['social', 'outing', 'hangout', 'hang out'],
    members: ['friend'],
    categories: ['social-outings'],
  },
  phone: {
    terms: ['phone', 'smartphone', 'mobile'],
    relatedCategories: { 'app-walkthrough': 2, 'banking-app': 1, 'dashboard': 1, 'notification': 1, 'digital-products-ui': 1 },
  },
  app: {
    terms: ['app', 'application'],
    members: ['screen', 'interface'],
    categories: ['digital-products-ui', 'app-walkthrough', 'dashboard', 'notification'],
  },
  money: {
    terms: ['money', 'finance', 'financial'],
    categories: ['payments-finance', 'mobile-payment', 'card-tap', 'banking-app', 'rewards-cashback'],
  },
  work: {
    terms: ['work', 'workplace', 'office'],
    members: ['desk', 'colleague', 'meeting', 'job'],
    categories: ['work-education', 'office-workspace', 'collaboration'],
    related: { study: 1 },
  },
  study: {
    terms: ['study', 'learning', 'education'],
    members: ['school', 'student', 'class'],
    categories: ['study-learning'],
    related: { work: 1 },
  },
  fitness: {
    terms: ['fitness', 'gym', 'workout', 'exercise'],
    members: ['yoga', 'run', 'wellness'],
    categories: ['health-fitness', 'gym-workout', 'outdoor-activity', 'wellness'],
  },
};

/** Grounded one-word synonyms for plain (non-concept) words. Each entry lists true alternatives, not neighbours. */
const WORD_SYNONYMS: Record<string, string[]> = {
  television: ['tv'],
  tv: ['television'],
  sofa: ['couch'],
  couch: ['sofa'],
  auto: ['rickshaw'],
  airplane: ['plane'],
  flight: ['plane'],
  movie: ['cinema'],
  film: ['cinema'],
  // keys are stemmed forms: 'clothes' -> clothe, 'clothing' -> cloth
  clothe: ['clothing'],
  cloth: ['clothes'],
};

interface CompiledConcept {
  id: string;
  /** Head terms only: the words that turn a query into this concept. */
  headPhrases: string[][];
  /** Head terms and members: everything that counts as this concept in a clip's text. */
  phrases: string[][];
  categoryIds: Set<number>;
  related: Map<string, number>;
  relatedCategoryIds: Map<number, number>;
}

function categoryIdsFor(slugs: string[] = []): number[] {
  return slugs.map((s) => BROLL_CATEGORY_MAP[s]?.id).filter((id): id is number => typeof id === 'number');
}

const COMPILED: Map<string, CompiledConcept> = new Map(
  Object.entries(LEXICON).map(([id, def]) => [id, {
    id,
    headPhrases: def.terms.map((t) => tokenize(t)),
    phrases: [...def.terms, ...(def.members ?? [])].map((t) => tokenize(t)),
    categoryIds: new Set(categoryIdsFor(def.categories)),
    related: new Map(Object.entries(def.related ?? {})),
    relatedCategoryIds: new Map(Object.entries(def.relatedCategories ?? {}).flatMap(([slug, s]) => categoryIdsFor([slug]).map((cid) => [cid, s] as [number, number]))),
  }]),
);

// Longest phrases first, so "road trip" is read as one concept term before "trip".
const PHRASE_INDEX: { tokens: string[]; concept: string }[] = [...COMPILED.values()]
  .flatMap((c) => c.headPhrases.map((tokens) => ({ tokens, concept: c.id })))
  .sort((a, b) => b.tokens.length - a.tokens.length);

// ---------------------------------------------------------------------------------------------------------------
// Query understanding

/**
 * A query word can belong to several concepts (e.g. "coffee" is both the narrow concept "coffee" and part of
 * "drink"). The narrowest concept that fully covers the query words wins, so a query for "coffee" means coffee,
 * not every drink.
 */
function parseQuery(query: string): { concepts: string[]; plainWords: string[] } {
  const words = queryWords(query);
  const concepts: string[] = [];
  const plain: string[] = [];
  let i = 0;
  while (i < words.length) {
    const candidates = PHRASE_INDEX.filter((p) => p.tokens.length > 0 && p.tokens.every((t, k) => words[i + k] === t));
    if (candidates.length === 0) { plain.push(words[i]); i += 1; continue; }
    const longest = Math.max(...candidates.map((c) => c.tokens.length));
    const atLongest = candidates.filter((c) => c.tokens.length === longest).map((c) => c.concept);
    // Prefer the concept with the fewest terms: the narrower meaning.
    atLongest.sort((a, b) => COMPILED.get(a)!.headPhrases.length - COMPILED.get(b)!.headPhrases.length);
    const chosen = atLongest[0];
    if (!concepts.includes(chosen)) concepts.push(chosen);
    i += longest;
  }
  return { concepts, plainWords: plain };
}

export function interpretQuery(query: string): QueryInterpretation {
  const { concepts, plainWords } = parseQuery(query);
  if (concepts.length === 0 && plainWords.length === 0) return { kind: 'empty', concepts, plainWords };
  return { kind: plainWords.length === 0 ? 'broad' : 'specific', concepts, plainWords };
}

// ---------------------------------------------------------------------------------------------------------------
// Clip index

const FIELD_WEIGHT = { title: 5, activity: 4, tag: 4, brand: 3, subject: 3, setting: 3, description: 3, category: 2 } as const;
type Field = keyof typeof FIELD_WEIGHT;

interface IndexedClip {
  fields: { field: Field; label: string; tokens: string[] }[];
  categoryIds: Set<number>;
}

function indexClip(clip: SearchClip, categoryById: Map<number, SearchCategory>): IndexedClip {
  const fields: IndexedClip['fields'] = [];
  const add = (field: Field, label: string, text: string | null | undefined) => {
    const tokens = tokenize(text);
    if (tokens.length) fields.push({ field, label, tokens });
  };
  add('title', 'title', clip.title);
  add('activity', 'activity', clip.activity);
  add('subject', 'subject', clip.subject);
  add('setting', 'setting', clip.setting);
  add('description', 'description', clip.description);
  add('brand', 'brand', clip.brand);
  for (const b of clip.brands ?? []) add('brand', 'brand', b.brandName);
  for (const t of parseTags(clip.userTags)) add('tag', 'tag', t);
  // Only the categories the clip is assigned to count as its own text. A parent's name is not: being in
  // "Rewards cashback" does not make a clip a "Payments & Finance" clip by name.
  for (const id of clip.categoryIds ?? []) {
    const cat = categoryById.get(id);
    if (cat) add('category', 'category', cat.name);
  }
  return { fields, categoryIds: new Set(clip.categoryIds ?? []) };
}

function containsPhrase(tokens: string[], phrase: string[]): boolean {
  if (phrase.length === 0) return false;
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    if (phrase.every((p, k) => tokens[i + k] === p)) return true;
  }
  return false;
}

interface Match { score: number; why: string }

/** Best direct match of a concept against the clip's own text or assigned categories. */
function directConcept(concept: CompiledConcept, ix: IndexedClip): Match | null {
  let best: Match | null = null;
  for (const f of ix.fields) {
    for (const phrase of concept.phrases) {
      if (containsPhrase(f.tokens, phrase)) {
        const score = FIELD_WEIGHT[f.field];
        if (!best || score > best.score) best = { score, why: `${f.label}: ${phrase.join(' ')}` };
      }
    }
  }
  for (const id of concept.categoryIds) {
    if (ix.categoryIds.has(id) && (!best || best.score < FIELD_WEIGHT.category)) best = { score: FIELD_WEIGHT.category, why: `category: ${concept.id}` };
  }
  return best;
}

/** 0 = no relation, otherwise the strength (1 loose, 2 close) of the best written-down relation. */
function relatedConcept(concept: CompiledConcept, ix: IndexedClip): { strength: number; why: string } | null {
  let best: { strength: number; why: string } | null = null;
  for (const [otherId, strength] of concept.related) {
    const other = COMPILED.get(otherId);
    if (other && directConcept(other, ix) && (!best || strength > best.strength)) best = { strength, why: `related to ${concept.id} through ${otherId}` };
  }
  for (const [catId, strength] of concept.relatedCategoryIds) {
    if (ix.categoryIds.has(catId) && (!best || strength > best.strength)) best = { strength, why: `related to ${concept.id} through its category` };
  }
  return best;
}

function directWord(word: string, ix: IndexedClip): Match | null {
  const alternatives = [word, ...(WORD_SYNONYMS[word] ?? [])].map((w) => stem(w));
  let best: Match | null = null;
  for (const f of ix.fields) {
    if (alternatives.some((a) => f.tokens.includes(a))) {
      const score = FIELD_WEIGHT[f.field];
      if (!best || score > best.score) best = { score, why: `${f.label}: ${word}` };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Search

export function searchClips<T extends SearchClip>(query: string, clips: T[], categories: SearchCategory[]): SearchResult<T> {
  const interpretation = interpretQuery(query);
  if (interpretation.kind === 'empty') {
    return { interpretation, hits: clips.map((clip) => ({ clip, tier: 'direct' as const, score: 0, why: [] })) };
  }

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const concepts = interpretation.concepts.map((id) => COMPILED.get(id)!);
  const allowRelated = interpretation.kind === 'broad';
  const hits: SearchHit<T>[] = [];

  for (const clip of clips) {
    const ix = indexClip(clip, categoryById);
    let score = 0;
    let relatedStrength = Infinity;
    let direct = true;
    let ok = true;
    const why: string[] = [];

    for (const concept of concepts) {
      const m = directConcept(concept, ix);
      if (m) { score += m.score; why.push(m.why); continue; }
      direct = false;
      const r = allowRelated ? relatedConcept(concept, ix) : null;
      if (!r) { ok = false; break; }
      relatedStrength = Math.min(relatedStrength, r.strength);
      why.push(r.why);
    }
    if (!ok) continue;
    for (const word of interpretation.plainWords) {
      const m = directWord(word, ix);
      if (!m) { ok = false; break; }
      score += m.score;
      why.push(m.why);
    }
    if (!ok) continue;

    hits.push({ clip, tier: direct ? 'direct' : 'related', score: direct ? score : relatedStrength, why });
  }

  hits.sort((a, b) =>
    (a.tier === b.tier ? 0 : a.tier === 'direct' ? -1 : 1)
    || b.score - a.score
    || (b.clip.createdAt ?? 0) - (a.clip.createdAt ?? 0)
    || a.clip.id - b.clip.id);

  return { interpretation, hits };
}
