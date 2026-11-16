/**
 * What the Repository shows about an imported image: where it came from, whether it needs a human look, brand flags, how the subject
 * is framed (for character replacement) and the file facts. It is built from the imported layer by an allow-list, so nothing else that
 * may ever be stored in that layer reaches the browser. It carries no description of a person: none is ever imported.
 */
import type { ImportedLayer } from './metadata';

export interface ImportInfo {
  importKey: string | null;
  status: string | null;
  version: number | null;
  supersedesAssetId: number | null;
  source: { folder: string | null; file: string | null };
  /** Items a person should look at: an uncertain pack, a setting that differs from the inventory, a filename that does not match. */
  review: Array<{ kind: string; note: string | null; altPack: string | null }>;
  flags: string[];
  brand: { slice: boolean; thirdParty: boolean; notes: string[] };
  /** How the subject is framed. Informational only; never searched, ranked or used to filter. */
  composition: Array<{ label: string; value: string }>;
  technical: Array<{ label: string; value: string }>;
}

const COMPOSITION_LABELS: Record<string, string> = { pose: 'Pose', gaze: 'Gaze', face_visibility: 'Face visibility', subject_position: 'Position in frame', subject_scale: 'Subject scale', hand_interaction: 'Hands' };
const TECH_LABELS: Record<string, string> = { format: 'Format', color_mode: 'Colour mode', width: 'Width', height: 'Height', orientation: 'Orientation', file_size_bytes: 'File size', sha256: 'SHA-256', sha1: 'SHA-1' };
/** Review kinds that mean "look at this image"; the general "draft metadata" note applies to every imported image and is shown once, in the panel. */
export const ATTENTION_KINDS = new Set(['classification_uncertain', 'setting_discrepancy', 'filename_mismatch']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The importer's imported layer is {} for an image that was uploaded by hand: there is then nothing to show (null). */
export function importInfoOf(layer: ImportedLayer | null | undefined): ImportInfo | null {
  if (!layer || Object.keys(layer).length === 0) return null;
  const op = layer.operational ?? {};
  const tech = layer.technical ?? {};
  const technical: ImportInfo['technical'] = [];
  for (const [k, label] of Object.entries(TECH_LABELS)) {
    const v = tech[k];
    if (v === undefined || v === null || v === '') continue;
    technical.push({ label, value: k === 'file_size_bytes' ? `${(Number(v) / 1048576).toFixed(2)} MB` : k === 'sha256' || k === 'sha1' ? `${String(v).slice(0, 12)}…` : String(v) });
  }
  return {
    importKey: str(layer.source?.import_key),
    status: str(layer.status),
    version: typeof layer.version === 'number' ? layer.version : null,
    supersedesAssetId: typeof layer.lineage?.supersedes_asset_id === 'number' ? layer.lineage.supersedes_asset_id : null,
    source: { folder: str(layer.source?.source_folder), file: str(layer.source?.source_file) },
    review: (op.review ?? []).map((r) => ({ kind: r.kind, note: str(r.note), altPack: str(r.alt_pack) })),
    flags: (op.flags ?? []).filter((f) => typeof f === 'string'),
    brand: { slice: !!op.brand?.slice, thirdParty: !!op.brand?.third_party, notes: (op.brand?.notes ?? []).filter((n) => typeof n === 'string') },
    composition: Object.entries(COMPOSITION_LABELS).flatMap(([k, label]) => { const v = str((layer.composition as Record<string, unknown> | undefined)?.[k]); return v ? [{ label, value: v }] : []; }),
    technical,
  };
}

/** True if an imported image has an item a person should look at (not counting the general draft note). */
export const needsReview = (info: ImportInfo | null): boolean => !!info && info.review.some((r) => ATTENTION_KINDS.has(r.kind));
