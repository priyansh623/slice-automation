/**
 * Image metadata with provenance. Three layers are stored apart, and the value a field has is decided PER FIELD, here and in SQL
 * (studio_effective, migration 0027), by one rule:
 *
 *   manual has the key            -> the manual value wins (a null means "cleared on purpose": the field shows as empty and does NOT
 *                                    fall back to imported or AI)
 *   else imported has a value     -> the imported value (a null or missing imported value means "none supplied")
 *   else                          -> the AI value
 *
 * Re-analysis only replaces `ai`; a person's edit only writes `manual`; an import only replaces `imported`. So none of them can
 * overwrite another. Metadata is used for search and recommendations, never to hide an image.
 */

export const METADATA_TEXT_FIELDS = [
  'environment', 'activity', 'objects_props', 'camera_angle', 'framing', 'character_position', 'lighting', 'composition', 'description',
] as const;
export const METADATA_FIELDS = [...METADATA_TEXT_FIELDS, 'tags'] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];
export type MetadataTextField = (typeof METADATA_TEXT_FIELDS)[number];

export const MAX_TEXT_CHARS = 1000;
export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_TAGS = 30;
export const MAX_TAG_CHARS = 40;

export type FieldValue = string | string[] | null;
export type MetadataRecord = Partial<Record<MetadataField, FieldValue>>;
export type Provenance = 'manual' | 'imported' | 'ai' | 'none';

/**
 * What an import stores. Only `fields` (the scene metadata) takes part in the effective value. The rest is provenance and
 * composition detail for people to read; none of it is searched, ranked or used to filter. No description of the person
 * (gender, age, appearance, clothing) is ever stored here.
 */
export interface ImportedLayer {
  fields?: MetadataRecord;
  /** How the person is framed, for character replacement. Never a filter. */
  composition?: Partial<Record<'pose' | 'gaze' | 'face_visibility' | 'subject_position' | 'subject_scale' | 'hand_interaction', string>>;
  operational?: { flags?: string[]; review?: Array<{ kind: string; note?: string; alt_pack?: string }>; brand?: { slice?: boolean; third_party?: boolean; notes?: string[] }; near_duplicates?: string[] };
  technical?: Record<string, string | number | boolean | null>;
  source?: { import_key?: string; source_folder?: string; source_file?: string; manifest_version?: number; imported_at?: number };
  status?: string;
  version?: number;
  lineage?: { version: number; supersedes_asset_id?: number | null };
  [k: string]: unknown;
}

export interface EffectiveMetadata {
  values: { [K in MetadataTextField]: string | null } & { tags: string[] };
  /** Where each field's value comes from. 'none' = no value at all. */
  provenance: Record<MetadataField, Provenance>;
  /** True when a person has edited at least one field. */
  hasManualEdits: boolean;
}

const isField = (k: string): k is MetadataField => (METADATA_FIELDS as readonly string[]).includes(k);
const maxFor = (f: MetadataTextField) => (f === 'description' ? MAX_DESCRIPTION_CHARS : MAX_TEXT_CHARS);

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const t = cleanText(item, MAX_TAG_CHARS)?.toLowerCase();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Keeps only the known fields of what the model returned, trimmed and bounded. Anything else is dropped. */
export function sanitiseAiMetadata(raw: unknown): MetadataRecord {
  const out: MetadataRecord = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const f of METADATA_TEXT_FIELDS) {
    const t = cleanText(r[f], maxFor(f));
    if (t) out[f] = t;
  }
  const tags = cleanTags(r.tags);
  if (tags.length > 0) out.tags = tags;
  return out;
}

export interface ManualPatch {
  /** Field to new value. A string/array sets it; null clears it on purpose (the AI value is then ignored). */
  set: MetadataRecord;
  /** Fields to give back to the AI value (removes the manual override). */
  revert: MetadataField[];
}

export type PatchResult = { ok: true; patch: ManualPatch } | { ok: false; error: string };

/** Validates an edit request: { fields: {...}, revert: [...] }. Unknown fields are rejected, not ignored. */
export function parseManualPatch(body: unknown): PatchResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Send the fields to change.' };
  const b = body as { fields?: unknown; revert?: unknown };
  const set: MetadataRecord = {};
  const revert: MetadataField[] = [];
  if (b.fields !== undefined) {
    if (!b.fields || typeof b.fields !== 'object' || Array.isArray(b.fields)) return { ok: false, error: 'fields must be an object.' };
    for (const [k, v] of Object.entries(b.fields as Record<string, unknown>)) {
      if (!isField(k)) return { ok: false, error: `Unknown metadata field: ${k}` };
      if (k === 'tags') {
        if (v === null) set.tags = null;
        else if (Array.isArray(v)) set.tags = cleanTags(v);
        else return { ok: false, error: 'tags must be a list of words.' };
      } else if (v === null) {
        set[k] = null;
      } else if (typeof v === 'string') {
        // An empty string is a deliberate clear, the same as null.
        set[k] = cleanText(v, maxFor(k)) ?? null;
      } else {
        return { ok: false, error: `${k} must be text.` };
      }
    }
  }
  if (b.revert !== undefined) {
    if (!Array.isArray(b.revert)) return { ok: false, error: 'revert must be a list of field names.' };
    for (const k of b.revert) {
      if (typeof k !== 'string' || !isField(k)) return { ok: false, error: `Unknown metadata field: ${String(k)}` };
      revert.push(k);
    }
  }
  if (Object.keys(set).length === 0 && revert.length === 0) return { ok: false, error: 'Nothing to change.' };
  const clash = revert.find((f) => f in set);
  if (clash) return { ok: false, error: `${clash} cannot be both edited and reverted.` };
  return { ok: true, patch: { set, revert } };
}

/** Applies an edit to the stored `manual` object. Returns a new object; the input is not changed. */
export function applyManualPatch(manual: MetadataRecord | null | undefined, patch: ManualPatch): MetadataRecord {
  const next: MetadataRecord = { ...(manual ?? {}) };
  for (const [k, v] of Object.entries(patch.set)) next[k as MetadataField] = v as FieldValue;
  for (const f of patch.revert) delete next[f];
  return next;
}

/** The value each field has, and where it came from. */
export function effectiveMetadata(ai: MetadataRecord | null | undefined, manual: MetadataRecord | null | undefined, imported?: ImportedLayer | null): EffectiveMetadata {
  const a = ai ?? {};
  const m = manual ?? {};
  const i: MetadataRecord = imported?.fields ?? {};
  const values = { tags: [] as string[] } as EffectiveMetadata['values'];
  const provenance = {} as Record<MetadataField, Provenance>;
  for (const f of METADATA_FIELDS) {
    const hasManual = Object.prototype.hasOwnProperty.call(m, f);
    const impVal = i[f];
    const hasImported = !hasManual && impVal !== undefined && impVal !== null && !(Array.isArray(impVal) ? impVal.length === 0 : impVal === '');
    const raw: FieldValue | undefined = hasManual ? m[f] : hasImported ? impVal : a[f];
    if (f === 'tags') {
      values.tags = Array.isArray(raw) ? raw : [];
    } else {
      values[f] = typeof raw === 'string' && raw ? raw : null;
    }
    const has = f === 'tags' ? values.tags.length > 0 : values[f] !== null;
    provenance[f] = hasManual ? 'manual' : has ? (hasImported ? 'imported' : 'ai') : 'none';
  }
  return { values, provenance, hasManualEdits: Object.keys(m).length > 0 };
}
