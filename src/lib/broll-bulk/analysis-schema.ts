/**
 * The shape of an AI suggestion and the code that turns the model's raw output into a safe one. The model is only ever
 * a source of PROPOSALS: every value is checked against the approved taxonomy here, and anything that does not match is
 * dropped and listed as unresolved so the reviewer decides. Nothing in this file touches the database.
 */
import { canonicalBrand, canonicalTag, categoryById, matchAllowed, type Taxonomy } from './taxonomy';

export type Confidence = 'high' | 'medium' | 'low';
export type BrandRole = 'hero' | 'incidental' | 'unresolved';
export const PRIVACY_TYPES = ['face', 'name', 'phone', 'email', 'travel_document', 'payment_details', 'financial_info', 'receipt', 'address', 'other_pii'] as const;
export type PrivacyType = (typeof PRIVACY_TYPES)[number];
export interface PrivacyFlag { type: PrivacyType; detail: string; severity: 'low' | 'medium' | 'high' }
export interface BrandSuggestion { name: string; role: BrandRole; /** true when it is a brand already in the library */ existing: boolean; evidence: string }
export interface CategoryProposal { name: string; parentId: number | null; reason: string }

export interface Suggestion {
  title: string;
  subject: string | null;
  summary: string;
  description: string;
  subjects: string[];
  objects: string[];
  descriptors: string[];
  visibleText: string[];
  /** whether the model read any text in the frames (kept when the text itself is not stored) */
  hasVisibleText: boolean;
  categoryId: number | null;
  categoryConfidence: Confidence;
  categoryReason: string;
  /** true when no existing category was chosen: the clip needs a human decision */
  needsCategoryReview: boolean;
  proposedCategory: CategoryProposal | null;
  activity: string | null;
  setting: string | null;
  brands: BrandSuggestion[];
  tags: { tag: string; known: boolean }[];
  privacy: PrivacyFlag[];
  confidence: Confidence;
  /** fields the model could not settle, plus values it gave that are not in the approved lists */
  unresolved: string[];
  /** what the model said for activity/setting when that value is not an approved one (shown, never saved) */
  rejectedValues: { activity?: string; setting?: string };
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const strList = (v: unknown, max: number, items: number): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => str(x, max)).filter(Boolean))].slice(0, items) : [];
const confidence = (v: unknown): Confidence => (v === 'high' || v === 'medium' || v === 'low' ? v : 'low');

/** Facts in text the model read from the frames that look like personal data, found by pattern rather than by the model. */
export function detectPiiInText(texts: string[]): PrivacyFlag[] {
  const out: PrivacyFlag[] = [];
  const joined = texts.join(' \n ');
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(joined)) out.push({ type: 'email', detail: 'An email address is visible in the text.', severity: 'high' });
  const card = /\b(?:\d{4}[ -]){3}\d{3,4}\b|\b\d{13,19}\b/.test(joined);
  if (card) out.push({ type: 'payment_details', detail: 'A long digit sequence that could be a card number is visible.', severity: 'high' });
  if (!card && (/(?:\+\d{1,3}[\s-]?)?\b\d{5}[\s-]?\d{5}\b/.test(joined) || /\b\d{3}[\s-]\d{3}[\s-]\d{4}\b/.test(joined))) {
    out.push({ type: 'phone', detail: 'A phone number may be visible in the text.', severity: 'medium' });
  }
  return out;
}

/**
 * The lowest severity a kind of information may be given. These are sensitive whatever the context, so a model that rates them
 * lower is corrected upwards (never downwards). Faces have no floor: whether a face is identifiable needs judgement.
 */
export const SEVERITY_FLOOR: Partial<Record<PrivacyType, 'medium' | 'high'>> = {
  financial_info: 'high', payment_details: 'high', travel_document: 'high',
  name: 'medium', phone: 'medium', email: 'medium', address: 'medium', receipt: 'medium',
};
const RANK = { low: 0, medium: 1, high: 2 } as const;
const raiseToFloor = (type: PrivacyType, severity: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' => {
  const floor = SEVERITY_FLOOR[type];
  return floor && RANK[severity] < RANK[floor] ? floor : severity;
};

export function sanitiseAnalysis(raw: unknown, taxonomy: Taxonomy): Suggestion {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const unresolved: string[] = [];
  const rejectedValues: Suggestion['rejectedValues'] = {};

  // Category: only an existing id counts. A name match to an existing category also resolves (never a new one).
  let categoryId: number | null = categoryById(taxonomy, r.category_id)?.id ?? null;
  let categoryConfidence = confidence(r.category_confidence);
  let categoryReason = str(r.category_reason, 300);
  let proposedCategory: CategoryProposal | null = null;
  if (categoryId === null) {
    const p = (r.proposed_category && typeof r.proposed_category === 'object' ? r.proposed_category : null) as Record<string, unknown> | null;
    const name = p ? str(p.name, 60) : '';
    if (name.length >= 2) {
      const sameName = taxonomy.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (sameName) { categoryId = sameName.id; categoryConfidence = 'low'; }
      else {
        const parent = categoryById(taxonomy, p!.parent_id);
        proposedCategory = { name, parentId: parent ? parent.id : null, reason: str(p!.reason, 400) || 'No existing category fits this footage.' };
      }
    }
  }
  const needsCategoryReview = categoryId === null;
  if (needsCategoryReview) { unresolved.push('category'); categoryConfidence = 'low'; if (!categoryReason) categoryReason = 'No existing category fits with enough confidence.'; }

  const activity = matchAllowed(r.activity, taxonomy.activities);
  if (typeof r.activity === 'string' && r.activity.trim() && activity === null) { rejectedValues.activity = str(r.activity, 80); unresolved.push('activity'); }
  else if (activity === null) unresolved.push('activity');
  const setting = matchAllowed(r.setting, taxonomy.settings);
  if (typeof r.setting === 'string' && r.setting.trim() && setting === null) { rejectedValues.setting = str(r.setting, 80); unresolved.push('setting'); }
  else if (setting === null) unresolved.push('setting');

  const brands: BrandSuggestion[] = [];
  const seenBrand = new Set<string>();
  for (const b of Array.isArray(r.brands) ? r.brands : []) {
    const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    const given = str(o.name, 60);
    if (!given) continue;
    const existingName = canonicalBrand(given, taxonomy.brands);
    const name = existingName ?? given;
    const k = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!k || seenBrand.has(k)) continue;
    seenBrand.add(k);
    brands.push({ name, role: o.role === 'hero' || o.role === 'incidental' ? o.role : 'unresolved', existing: existingName !== null, evidence: str(o.evidence, 160) });
    if (brands.length >= 6) break;
  }

  const tags: Suggestion['tags'] = [];
  const vocab = taxonomy.tags.map((t) => t.tag);
  for (const t of Array.isArray(r.tags) ? r.tags : []) {
    const c = canonicalTag(t, vocab);
    if (c && !tags.some((x) => x.tag === c.tag)) tags.push(c);
    if (tags.length >= 12) break;
  }

  const visibleText = strList(r.visible_text, 120, 12);
  const privacy: PrivacyFlag[] = [];
  for (const p of Array.isArray(r.privacy) ? r.privacy : []) {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const type = (PRIVACY_TYPES as readonly string[]).includes(String(o.type)) ? (o.type as PrivacyType) : 'other_pii';
    const given = o.severity === 'low' || o.severity === 'high' || o.severity === 'medium' ? o.severity : 'medium';
    privacy.push({ type, detail: str(o.detail, 300) || 'Possible personal information.', severity: raiseToFloor(type, given) });
    if (privacy.length >= 10) break;
  }
  for (const f of detectPiiInText(visibleText)) if (!privacy.some((p) => p.type === f.type)) privacy.push(f);

  // The model names fields as they appear in its tool schema; the page uses its own names.
  const FIELD_ALIASES: Record<string, string> = { category_id: 'category', proposed_category: 'category', brand: 'brands', visible_text: 'visible text' };
  for (const raw of strList(r.unresolved, 40, 12)) { const f = FIELD_ALIASES[raw] ?? raw; if (!unresolved.includes(f)) unresolved.push(f); }

  return {
    title: str(r.title, 120),
    subject: str(r.subject, 160) || null,
    summary: str(r.summary, 400),
    description: str(r.description, 400),
    subjects: strList(r.subjects, 60, 8),
    objects: strList(r.objects, 60, 12),
    descriptors: strList(r.descriptors, 40, 12),
    visibleText, hasVisibleText: visibleText.length > 0,
    categoryId, categoryConfidence, categoryReason, needsCategoryReview, proposedCategory,
    activity, setting, brands, tags, privacy,
    confidence: confidence(r.overall_confidence),
    unresolved, rejectedValues,
  };
}

/**
 * What may be kept in the browser between visits. Everything the model read OUT of the footage (text on screen, names of
 * things and people, privacy details, the evidence behind a brand) is dropped: those are the places personal information can
 * appear, and nothing needs them again. What stays is exactly what a reviewer would save to the library anyway (name,
 * description, category, activity, setting, brands, tags) plus the privacy warning types and severities, so warnings still show.
 */
export function redactForStorage(s: Suggestion): Suggestion {
  return {
    ...s,
    summary: '', subjects: [], objects: [], descriptors: [], visibleText: [],
    hasVisibleText: s.hasVisibleText || s.visibleText.length > 0,
    brands: s.brands.map((b) => ({ ...b, evidence: '' })),
    privacy: s.privacy.map((p) => ({ ...p, detail: 'Details are not kept after the page is closed. Run the analysis again to see them.' })),
  };
}
