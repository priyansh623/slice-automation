/**
 * Recovering an unfinished bulk batch after a refresh or a return visit, without any server-side storage.
 *
 * What is remembered (in the browser only, for 24 hours): per video, its SHA-256, the reviewer's editable metadata, the
 * (redacted) AI suggestion, whether it was reviewed or included, and, once it exists, the clip it became. What is NEVER
 * remembered: the video files, the sampled frames, thumbnails, text read from the footage, privacy details, or any approval.
 *
 * Coming back is deliberately a re-selection: the browser cannot keep the files, so the user picks the same videos again and
 * each one is matched by its SHA-256. A match restores the work; nothing is uploaded and no record is created by recovery,
 * and a restored batch is never "approved": the upload still needs its own explicit approval.
 */
import { redactForStorage, sanitiseAnalysis, type Suggestion } from './analysis-schema';
import type { BulkItem, EditableMetadata } from './batch';
import { canonicalBrand, categoryById, matchAllowed, normalizeTag, type Taxonomy } from './taxonomy';

export const SESSION_VERSION = 1;
export const SESSION_TTL_MS = 24 * 3600 * 1000;

export type EntryStage = 'analysed' | 'reviewed' | 'uploaded' | 'upload_incomplete';

export interface SessionEntry {
  sha256: string;
  fileName: string;
  size: number;
  stage: EntryStage;
  suggestion: Suggestion;
  edit: EditableMetadata;
  included: boolean;
  duplicateOverride: boolean;
  /** The file reached storage but the clip was never saved: the next approved upload only repeats the save. */
  storagePath: string | null;
  clipId: number | null;
  savedAt: number;
}
export interface Session { version: number; savedAt: number; entries: SessionEntry[] }

/** The snapshot to keep. Only analysed items with a known checksum can be matched again, so only they are kept. */
export function snapshotItems(items: BulkItem[], now = Date.now()): Session {
  const entries: SessionEntry[] = [];
  for (const it of items) {
    if (!it.sha256 || it.analysis !== 'analysed' || !it.suggestion || !it.edit) continue;
    const stage: EntryStage = it.upload === 'uploaded' ? 'uploaded' : it.storagePath ? 'upload_incomplete' : it.reviewed ? 'reviewed' : 'analysed';
    entries.push({
      sha256: it.sha256, fileName: it.fileName, size: it.size, stage,
      suggestion: redactForStorage(it.suggestion), edit: it.edit, included: it.included, duplicateOverride: it.duplicateOverride,
      storagePath: it.upload === 'uploaded' ? null : it.storagePath, clipId: it.clipId, savedAt: now,
    });
  }
  return { version: SESSION_VERSION, savedAt: now, entries };
}

/** Drops anything of another version, anything expired, and anything malformed. Never throws. */
export function readSession(raw: unknown, now = Date.now()): Session | null {
  const s = raw as Partial<Session> | null;
  if (!s || typeof s !== 'object' || s.version !== SESSION_VERSION || !Array.isArray(s.entries)) return null;
  const entries = s.entries.filter((e): e is SessionEntry =>
    !!e && typeof e === 'object' && typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256) && typeof e.savedAt === 'number'
    && now - e.savedAt < SESSION_TTL_MS && !!e.edit && !!e.suggestion && ['analysed', 'reviewed', 'uploaded', 'upload_incomplete'].includes(e.stage));
  return entries.length ? { version: SESSION_VERSION, savedAt: typeof s.savedAt === 'number' ? s.savedAt : now, entries } : null;
}

/** True when there is still something worth coming back for (anything not yet uploaded). */
export const hasUnfinishedWork = (s: Session | null): boolean => !!s && s.entries.some((e) => e.stage !== 'uploaded');

export const findEntry = (s: Session | null, sha256: string | null): SessionEntry | null => (s && sha256 ? s.entries.find((e) => e.sha256 === sha256) ?? null : null);

/** Saved entries whose file has not been selected again. */
export function missingEntries(s: Session | null, items: BulkItem[]): SessionEntry[] {
  if (!s) return [];
  const have = new Set(items.map((i) => i.sha256).filter((x): x is string => !!x));
  return s.entries.filter((e) => !have.has(e.sha256));
}

export interface SessionSummary { total: number; analysed: number; reviewed: number; uploaded: number; incomplete: number }
export function summariseSession(s: Session | null): SessionSummary {
  const out: SessionSummary = { total: 0, analysed: 0, reviewed: 0, uploaded: 0, incomplete: 0 };
  for (const e of s?.entries ?? []) {
    out.total++;
    if (e.stage === 'analysed') out.analysed++;
    else if (e.stage === 'reviewed') out.reviewed++;
    else if (e.stage === 'uploaded') out.uploaded++;
    else out.incomplete++;
  }
  return out;
}

/** The saved edit, re-checked against today's taxonomy: a value that no longer exists is cleared, never trusted. */
export function revalidateEdit(edit: EditableMetadata, taxonomy: Taxonomy): EditableMetadata {
  return {
    title: typeof edit.title === 'string' ? edit.title : '',
    subject: typeof edit.subject === 'string' ? edit.subject : '',
    categoryId: categoryById(taxonomy, edit.categoryId)?.id ?? null,
    activity: matchAllowed(edit.activity, taxonomy.activities),
    setting: matchAllowed(edit.setting, taxonomy.settings),
    brands: (Array.isArray(edit.brands) ? edit.brands : []).filter((b) => b && typeof b.name === 'string' && b.name.trim()).map((b) => ({ name: canonicalBrand(b.name, taxonomy.brands) ?? b.name, role: b.role === 'hero' || b.role === 'incidental' ? b.role : 'unresolved' })),
    tags: (Array.isArray(edit.tags) ? edit.tags : []).map((t) => normalizeTag(t)).filter((t): t is string => !!t),
    description: typeof edit.description === 'string' ? edit.description : '',
  };
}

/**
 * Restores a saved entry onto a freshly selected item. It restores the work and nothing else: the item is not uploaded, not
 * approved, and not selected for bulk editing. An already-uploaded entry is shown as uploaded and left out of the batch, so
 * the same video cannot be uploaded twice by accident.
 */
export function applyEntry(item: BulkItem, entry: SessionEntry, taxonomy: Taxonomy): BulkItem {
  const suggestion = redactForStorage(sanitiseAnalysis({
    title: entry.suggestion.title, subject: entry.suggestion.subject, summary: '', description: entry.suggestion.description,
    category_id: entry.suggestion.categoryId, category_confidence: entry.suggestion.categoryConfidence, category_reason: entry.suggestion.categoryReason,
    proposed_category: entry.suggestion.proposedCategory ? { name: entry.suggestion.proposedCategory.name, parent_id: entry.suggestion.proposedCategory.parentId, reason: entry.suggestion.proposedCategory.reason } : null,
    activity: entry.suggestion.activity, setting: entry.suggestion.setting, brands: entry.suggestion.brands, tags: entry.suggestion.tags.map((t) => t.tag),
    privacy: entry.suggestion.privacy, unresolved: entry.suggestion.unresolved, overall_confidence: entry.suggestion.confidence,
  }, taxonomy));
  suggestion.hasVisibleText = entry.suggestion.hasVisibleText;
  const base: BulkItem = {
    ...item, analysis: 'analysed', analysisError: null, suggestion, edit: revalidateEdit(entry.edit, taxonomy),
    included: entry.included, duplicateOverride: entry.duplicateOverride, reviewed: entry.stage !== 'analysed', restored: true, selected: false,
  };
  if (entry.stage === 'uploaded') return { ...base, upload: 'uploaded', clipId: entry.clipId, included: false, duplicateOverride: false, storagePath: null };
  return { ...base, upload: 'none', uploadProgress: 0, uploadError: null, uploadErrorCode: null, storagePath: entry.storagePath, clipId: null };
}

/**
 * The session to save: everything in the current batch, plus saved work for files that have not been selected again yet
 * (so reselecting files one at a time never loses the rest). Saved entries keep their original age and still expire after 24 h.
 */
export function mergeForSave(current: Session, previous: Session | null, now = Date.now()): Session {
  const have = new Set(current.entries.map((e) => e.sha256));
  const kept = (previous?.entries ?? []).filter((e) => !have.has(e.sha256) && now - e.savedAt < SESSION_TTL_MS);
  return { version: SESSION_VERSION, savedAt: now, entries: [...current.entries, ...kept] };
}
