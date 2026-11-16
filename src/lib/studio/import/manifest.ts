/**
 * The import manifest: the permanent map between a SOURCE IMAGE and the Studio.
 *
 * Two files, on purpose:
 *   manifest.json       (committed)  identity and intent: permanent image ID, source path, checksums, target pack, secondary concepts,
 *                                    review flags and the scene metadata to import. It never contains a description of a person.
 *   import-state.json   (written by an import run, not committed)  what actually happened: database asset ID, R2 keys, thumbnail key
 *                                    and the version history of every image.
 *
 * The permanent ID (IMG-001...) is the image's identity. It does not come from the file name, the folder or the pack, so it survives
 * renames, folder changes and a reorganisation of the packs. A database asset row is one VERSION of that image in one pack.
 */
import * as crypto from 'node:crypto';
import type { ImportedLayer } from '../metadata';
import { mentionsPerson } from './scene-metadata';

export const MANIFEST_VERSION = 1;

export interface ManifestPack { key: string; letter: string; name: string; description: string }
export interface ReviewItem { kind: 'classification_uncertain' | 'setting_discrepancy' | 'filename_mismatch' | 'metadata_draft'; note?: string; alt_pack?: string }
export interface ManifestImage {
  importKey: string;
  source: { folder: string; file: string; relativePath: string };
  sha256: string;
  sha1: string;
  sizeBytes: number;
  width: number;
  height: number;
  format: 'png';
  pack: string;
  secondaryConcepts: string[];
  confidence: 'high' | 'medium' | 'low';
  alternatePack?: string;
  review: ReviewItem[];
  /** The scene metadata to import (fields, composition, operational, technical). Provenance and lineage are added by the importer. */
  imported: ImportedLayer;
}
export interface ImportManifest { manifestVersion: number; sourceDirectory: string; packs: ManifestPack[]; images: ManifestImage[] }

/** One database row (version) of an image, as recorded by a run. */
export interface StateVersion { version: number; assetId: number; packKey: string; packId: number; sha256: string; storageKey: string; thumbKey: string | null; supersedesAssetId: number | null; status: 'active' | 'archived'; registeredAt: number }
export interface ImportState { version: 1; packs: Record<string, { packId: number }>; images: Record<string, { versions: StateVersion[] }>; updatedAt: number }
export const emptyState = (): ImportState => ({ version: 1, packs: {}, images: {}, updatedAt: 0 });

export interface StateStore { load(): ImportState; save(state: ImportState): void }
export class MemoryStateStore implements StateStore {
  constructor(public state: ImportState = emptyState()) {}
  load() { return JSON.parse(JSON.stringify(this.state)) as ImportState; }
  save(s: ImportState) { this.state = JSON.parse(JSON.stringify(s)) as ImportState; }
}

// ── deterministic R2 keys ────────────────────────────────────────────────────

/** A fixed namespace for every Studio import key. Never change it: the keys derive from it. */
export const IMPORT_KEY_NAMESPACE = '6f0a7c53-2b6e-4c1b-9a1e-5d0f3b8e2a41';

/** RFC 4122 version-5 UUID (name-based, SHA-1). */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(ns).update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * The R2 key of one VERSION of an image: it depends on the permanent ID, the version number and the content, never on the file name
 * or the pack. The same inputs always give the same key (so a rerun after a crash finds its own object), and a new version or new
 * content gives a new key (so no object is ever overwritten). It matches the Studio's existing key format.
 */
export const assetKeyFor = (importKey: string, version: number, sha256: string): string => `studio/assets/${uuidV5(`${importKey}|v${version}|${sha256}`, IMPORT_KEY_NAMESPACE)}.png`;

// ── validation ───────────────────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['persona_description', 'persona', 'gender', 'age', 'ethnicity', 'appearance', 'clothing', 'outfit', 'expression', 'scene_description', 'flag_notes']);

/** Structural problems of a manifest (empty = valid), including any trace of a description of a person. */
export function validateManifest(m: ImportManifest): string[] {
  const issues: string[] = [];
  if (m.manifestVersion !== MANIFEST_VERSION) issues.push(`unsupported manifestVersion ${m.manifestVersion}`);
  const packKeys = new Set<string>();
  for (const p of m.packs) {
    if (packKeys.has(p.key)) issues.push(`duplicate pack key ${p.key}`);
    packKeys.add(p.key);
    if (mentionsPerson(p.name) || mentionsPerson(p.description)) issues.push(`pack ${p.key} describes a person`);
  }
  const ids = new Set<string>(); const paths = new Set<string>();
  for (const im of m.images) {
    if (!/^IMG-\d{3,}$/.test(im.importKey)) issues.push(`${im.importKey}: not a permanent image ID`);
    if (ids.has(im.importKey)) issues.push(`duplicate image ID ${im.importKey}`);
    ids.add(im.importKey);
    if (paths.has(im.source.relativePath)) issues.push(`${im.importKey}: source path used twice`);
    paths.add(im.source.relativePath);
    if (!packKeys.has(im.pack)) issues.push(`${im.importKey}: unknown pack ${im.pack}`);
    if (im.alternatePack && !packKeys.has(im.alternatePack)) issues.push(`${im.importKey}: unknown alternate pack ${im.alternatePack}`);
    if (!/^[0-9a-f]{64}$/.test(im.sha256)) issues.push(`${im.importKey}: sha256 is not a hex digest`);
    for (const t of im.secondaryConcepts) if (mentionsPerson(t)) issues.push(`${im.importKey}: secondary concept "${t}" describes a person`);
    const walk = (o: unknown, where: string) => {
      if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${where}[${i}]`));
      else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (FORBIDDEN_KEYS.has(k)) issues.push(`${im.importKey}: forbidden key ${where}.${k}`); walk(v, `${where}.${k}`); }
      else if (typeof o === 'string' && where.startsWith('imported.fields') && mentionsPerson(o)) issues.push(`${im.importKey}: ${where} describes a person: "${o.slice(0, 60)}"`);
    };
    walk(im.imported, 'imported');
  }
  return issues;
}
