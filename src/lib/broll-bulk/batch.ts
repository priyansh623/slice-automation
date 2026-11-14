/**
 * Pure state and rules for a bulk B-roll batch: what an item looks like, what a bulk edit may touch, who may be uploaded,
 * how duplicates are marked, the controlled-concurrency runner and the request sent to the server for each approved clip.
 * No DOM, no network: the React component only wires these to the screen, and the tests exercise them directly.
 */
import type { BrandRole, Suggestion } from './analysis-schema';
import { canonicalBrand, canonicalTag, categoryById, matchAllowed, normalizeTag, type Taxonomy } from './taxonomy';
import { hasBlockingIssue, type ValidationIssue } from './rules';

export type AnalysisStatus = 'pending' | 'preparing' | 'analysing' | 'analysed' | 'failed' | 'invalid';
export type UploadStatus = 'none' | 'queued' | 'uploading' | 'verifying' | 'uploaded' | 'failed';

export interface DuplicateInfo {
  kind: 'library_exact' | 'batch_exact' | 'library_same_size';
  clipId?: number;
  title?: string;
  otherItemId?: string;
}

/** The editable copy of the metadata. Only values from the approved lists can end up in it (see the controlled inputs). */
export interface EditableMetadata {
  title: string;
  subject: string;
  categoryId: number | null;
  activity: string | null;
  setting: string | null;
  brands: { name: string; role: BrandRole }[];
  tags: string[];
  description: string;
}

export interface BulkItem {
  id: string;
  fileName: string;
  size: number;
  contentType: string | null;
  thumbnail: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  issues: ValidationIssue[];
  duplicates: DuplicateInfo[];
  analysis: AnalysisStatus;
  analysisError: string | null;
  suggestion: Suggestion | null;
  edit: EditableMetadata | null;
  selected: boolean;
  /** The reviewer opened this clip or changed something about it. */
  reviewed: boolean;
  /** Its analysis and edits were restored from an earlier visit (see session.ts). */
  restored: boolean;
  /** The reviewer's decision to upload this clip. Duplicates start excluded; anything else analysed starts included. */
  included: boolean;
  upload: UploadStatus;
  uploadProgress: number;
  uploadError: string | null;
  /** The server's reason code for a failed upload (for example 'duplicate'), so the page can explain it. */
  uploadErrorCode: string | null;
  /** The reviewer explicitly chose to upload this file although it matches an existing clip. Never set automatically. */
  duplicateOverride: boolean;
  /** Remembered after the file reached R2, so a failed save is retried without uploading the video again. */
  storagePath: string | null;
  clipId: number | null;
}

export function newItem(id: string, file: { name: string; size: number }, contentType: string | null): BulkItem {
  return {
    id, fileName: file.name, size: file.size, contentType, thumbnail: null, durationSeconds: null, width: null, height: null, sha256: null,
    issues: [], duplicates: [], analysis: 'pending', analysisError: null, suggestion: null, edit: null, selected: false, reviewed: false, restored: false, included: false,
    upload: 'none', uploadProgress: 0, uploadError: null, uploadErrorCode: null, duplicateOverride: false, storagePath: null, clipId: null,
  };
}

const titleFromFile = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();

/** The starting point for review: the AI's suggestion, already restricted to approved values. */
export function initialEdit(s: Suggestion, fileName: string): EditableMetadata {
  return {
    title: s.title || titleFromFile(fileName),
    subject: s.subject ?? '',
    categoryId: s.categoryId,
    activity: s.activity,
    setting: s.setting,
    brands: s.brands.map((b) => ({ name: b.name, role: b.role })),
    tags: s.tags.map((t) => t.tag),
    description: s.description,
  };
}

// ── Bulk editing: each operation changes only the field it names ────────────────────────────────────────────

export type BulkOp =
  | { kind: 'category'; categoryId: number | null }
  | { kind: 'activity'; activity: string | null }
  | { kind: 'setting'; setting: string | null }
  | { kind: 'addBrand'; name: string; role: BrandRole }
  | { kind: 'removeBrand'; name: string }
  | { kind: 'addTags'; tags: string[] }
  | { kind: 'removeTags'; tags: string[] };

/** Applies one bulk operation to the selected items that have an editable copy. Everything else is returned untouched. */
export function applyBulkEdit(items: BulkItem[], ids: ReadonlySet<string>, op: BulkOp, taxonomy: Taxonomy): BulkItem[] {
  return items.map((it) => {
    if (!ids.has(it.id) || !it.edit) return it;
    const e = it.edit;
    switch (op.kind) {
      case 'category': return { ...it, edit: { ...e, categoryId: op.categoryId === null ? null : categoryById(taxonomy, op.categoryId)?.id ?? e.categoryId } };
      case 'activity': return { ...it, edit: { ...e, activity: op.activity === null ? null : matchAllowed(op.activity, taxonomy.activities) ?? e.activity } };
      case 'setting': return { ...it, edit: { ...e, setting: op.setting === null ? null : matchAllowed(op.setting, taxonomy.settings) ?? e.setting } };
      case 'addBrand': {
        const name = canonicalBrand(op.name, taxonomy.brands) ?? op.name.trim();
        const k = name.toLowerCase();
        if (!name || e.brands.some((b) => b.name.toLowerCase() === k)) return it;
        return { ...it, edit: { ...e, brands: [...e.brands, { name, role: op.role }] } };
      }
      case 'removeBrand': return { ...it, edit: { ...e, brands: e.brands.filter((b) => b.name.toLowerCase() !== op.name.toLowerCase()) } };
      case 'addTags': {
        const add = op.tags.map((t) => canonicalTag(t, taxonomy.tags.map((x) => x.tag))?.tag).filter((t): t is string => !!t);
        return { ...it, edit: { ...e, tags: [...e.tags, ...add.filter((t) => !e.tags.includes(t))] } };
      }
      case 'removeTags': {
        const drop = new Set(op.tags.map((t) => normalizeTag(t)).filter((t): t is string => !!t));
        return { ...it, edit: { ...e, tags: e.tags.filter((t) => !drop.has(t)) } };
      }
    }
  });
}

// ── Duplicates ──────────────────────────────────────────────────────────────────────────────────────────

/** Marks files in the same batch that have identical content (SHA-256). The first one stays clean; later copies are flagged. */
export function markBatchDuplicates(items: BulkItem[]): BulkItem[] {
  const first = new Map<string, string>();
  return items.map((it) => {
    const rest = it.duplicates.filter((d) => d.kind !== 'batch_exact');
    if (!it.sha256) return { ...it, duplicates: rest };
    const owner = first.get(it.sha256);
    if (owner === undefined) { first.set(it.sha256, it.id); return { ...it, duplicates: rest }; }
    return { ...it, duplicates: [...rest, { kind: 'batch_exact', otherItemId: owner }] };
  });
}

export const hasExactDuplicate = (it: BulkItem): boolean => it.duplicates.some((d) => d.kind === 'library_exact' || d.kind === 'batch_exact');

// ── Readiness ───────────────────────────────────────────────────────────────────────────────────────────

/** Why an item cannot be in the upload batch yet (empty = it can). */
export function blockers(it: BulkItem): string[] {
  const out: string[] = [];
  if (hasBlockingIssue(it.issues)) out.push(...it.issues.filter((i) => i.severity === 'error').map((i) => i.message));
  if (it.analysis === 'failed') out.push('Analysis failed. Retry it, or remove the video.');
  else if (it.analysis !== 'analysed' && !hasBlockingIssue(it.issues)) out.push('Not analysed yet.');
  if (it.edit) {
    if (!it.edit.title.trim()) out.push('A clip name is required.');
    if (it.edit.tags.length === 0) out.push('At least one tag is required.');
  }
  return out;
}

export const isUploadable = (it: BulkItem): boolean => it.included && blockers(it).length === 0 && it.upload !== 'uploaded';

export interface BatchSummary {
  total: number; analysed: number; analysing: number; failedAnalysis: number; invalid: number;
  selectedForUpload: number; uncategorised: number; withPrivacyWarnings: number; duplicates: number;
  uploaded: number; uploadFailed: number; uploadingNow: number;
  analysisDone: boolean;
}

export function summarise(items: BulkItem[]): BatchSummary {
  const s: BatchSummary = { total: items.length, analysed: 0, analysing: 0, failedAnalysis: 0, invalid: 0, selectedForUpload: 0, uncategorised: 0, withPrivacyWarnings: 0, duplicates: 0, uploaded: 0, uploadFailed: 0, uploadingNow: 0, analysisDone: false };
  for (const it of items) {
    if (it.analysis === 'analysed') s.analysed++;
    else if (it.analysis === 'analysing' || it.analysis === 'preparing' || it.analysis === 'pending') s.analysing++;
    else if (it.analysis === 'failed') s.failedAnalysis++;
    else if (it.analysis === 'invalid') s.invalid++;
    if (it.upload === 'uploaded') s.uploaded++;
    if (it.upload === 'failed') s.uploadFailed++;
    if (it.upload === 'uploading' || it.upload === 'verifying') s.uploadingNow++;
    if (hasExactDuplicate(it)) s.duplicates++;
    if (it.suggestion && it.suggestion.privacy.length > 0) s.withPrivacyWarnings++;
    if (isUploadable(it)) { s.selectedForUpload++; if (it.edit && it.edit.categoryId === null) s.uncategorised++; }
  }
  s.analysisDone = items.length > 0 && s.analysing === 0;
  return s;
}

// ── Controlled concurrency ──────────────────────────────────────────────────────────────────────────────

/** Runs the tasks with at most `limit` at a time. A failing task never stops the others; every outcome is returned in order. */
export async function runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await tasks[i]() }; } catch (reason) { results[i] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}

// ── The request for one approved clip ───────────────────────────────────────────────────────────────────

export interface CompletePayload {
  storagePath: string;
  title: string;
  userTags: string[];
  subject: string | null;
  activity: string | null;
  setting: string | null;
  brand: string | null;
  description: string | null;
  categoryIds: number[];
  brands: { name: string; role: BrandRole }[];
  classification: { confidence: string; flags: string[]; review: string };
  sha256: string | null;
  /** Only true when the reviewer chose "Upload anyway" for a file that matches an existing clip. */
  allowDuplicate?: true;
}

/** Everything the server needs to verify and record one clip. Category ids and brands are the reviewer's final choices. */
export function buildCompletePayload(it: BulkItem, storagePath: string): CompletePayload {
  const e = it.edit!;
  const s = it.suggestion;
  const hero = e.brands.find((b) => b.role === 'hero');
  const flags: string[] = [];
  if (e.brands.length) flags.push('brand');
  if (s && (s.hasVisibleText || s.visibleText.length)) flags.push('text');
  for (const p of s?.privacy ?? []) { const f = p.type === 'face' ? 'person (face visible)' : `privacy: ${p.type.replace(/_/g, ' ')}`; if (!flags.includes(f)) flags.push(f); }
  return {
    storagePath,
    title: e.title.trim(),
    userTags: e.tags,
    subject: e.subject.trim() || null,
    activity: e.activity,
    setting: e.setting,
    brand: hero?.name ?? null,
    description: e.description.trim() || null,
    categoryIds: e.categoryId === null ? [] : [e.categoryId],
    brands: e.brands,
    classification: {
      confidence: s ? s.confidence : 'low',
      flags,
      review: `AI-assisted bulk upload: suggested from sampled frames and approved by a reviewer.${s && s.privacy.length ? ` Privacy flags raised: ${s.privacy.map((p) => p.type.replace(/_/g, ' ')).join(', ')}.` : ''}`,
    },
    sha256: it.sha256,
    ...(it.duplicateOverride ? { allowDuplicate: true as const } : {}),
  };
}

// ── Category proposals ──────────────────────────────────────────────────────────────────────────────────

export interface ProposalGroup { key: string; name: string; parentId: number | null; reasons: string[]; itemIds: string[] }

/**
 * Groups the AI's "no existing category fits" proposals so the reviewer decides once per new category. Only clips that
 * still have no category count. A proposal is only a proposal: nothing here (or in the analysis) creates a category.
 */
export function groupProposals(items: BulkItem[]): ProposalGroup[] {
  const groups = new Map<string, ProposalGroup>();
  for (const it of items) {
    const p = it.suggestion?.proposedCategory;
    if (!p || !it.edit || it.edit.categoryId !== null || it.analysis !== 'analysed') continue;
    const key = `${p.name.trim().toLowerCase()}|${p.parentId ?? ''}`;
    const g = groups.get(key) ?? { key, name: p.name.trim(), parentId: p.parentId, reasons: [], itemIds: [] };
    if (p.reason && !g.reasons.includes(p.reason)) g.reasons.push(p.reason);
    g.itemIds.push(it.id);
    groups.set(key, g);
  }
  return [...groups.values()];
}

// ── Uploading one approved clip (resumable) ─────────────────────────────────────────────────────────────

export interface UploadDeps {
  init(contentType: string, size: number, name: string): Promise<{ storagePath: string; uploadUrl: string; headers: Record<string, string> }>;
  put(url: string, headers: Record<string, string>, onProgress: (fraction: number) => void): Promise<void>;
  complete(payload: CompletePayload): Promise<{ id: number }>;
}

/**
 * One clip's upload, written so it can be repeated safely:
 *  - If the file already reached storage (storagePath is known) only the verify-and-save step runs again, so a successful
 *    upload is never repeated. The server returns the existing clip for a repeated save, so no duplicate record appears.
 *  - If the server says it cannot find the file (409) or the file failed its checksum (422), the next try uploads again.
 * Returns the changes to apply to the item. It never throws.
 */
export async function uploadApproved(it: BulkItem, contentType: string, name: string, deps: UploadDeps, onUpdate: (p: Partial<BulkItem>) => void): Promise<Partial<BulkItem>> {
  let path = it.storagePath;
  try {
    if (!path) {
      onUpdate({ upload: 'uploading', uploadProgress: 0, uploadError: null });
      const init = await deps.init(contentType, it.size, name);
      await deps.put(init.uploadUrl, init.headers, (f) => onUpdate({ uploadProgress: f }));
      path = init.storagePath;
      onUpdate({ storagePath: path, uploadProgress: 1 });
    }
    onUpdate({ upload: 'verifying', uploadError: null, uploadErrorCode: null });
    const clip = await deps.complete(buildCompletePayload(it, path));
    return { upload: 'uploaded', clipId: clip.id, uploadError: null, uploadErrorCode: null, storagePath: path };
  } catch (e) {
    const { status, code } = e as { status?: number; code?: string };
    // A refused duplicate was removed by the server, so a later "upload anyway" uploads it again, like 409 and 422.
    return { upload: 'failed', uploadError: (e as Error).message, uploadErrorCode: code ?? null, storagePath: status === 409 || status === 422 ? null : path };
  }
}
