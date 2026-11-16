/**
 * Builds scripts/studio-import/manifest.json from the source inventory CSV, the approved allocation and the image files.
 * Read-only on the source: it never modifies, moves or copies a file. Run it again only if the inventory or allocation changes.
 *
 *   npx tsx scripts/studio-import/build-manifest.ts --source "/Users/priyansh/Downloads/Scene Packs " \
 *     --inventory /Users/priyansh/Downloads/scene_pack_image_inventory.csv [--out scripts/studio-import/manifest.json]
 *
 * It refuses to build if any file is missing, any SHA-1 differs from the inventory, or an allocation is missing.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { ALLOCATION, PACKS } from './allocation';
import { MANIFEST_VERSION, validateManifest, type ImportManifest, type ManifestImage, type ReviewItem } from '../../src/lib/studio/import/manifest';
import { projectRow, type InventoryRow, type ProjectionAudit } from '../../src/lib/studio/import/scene-metadata';

export function parseCsv(text: string): InventoryRow[] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const source = arg('source'); const inv = arg('inventory'); const out = arg('out') ?? path.join(__dirname, 'manifest.json');
  if (!source || !inv) throw new Error('Usage: build-manifest.ts --source <folder> --inventory <csv> [--out <file>]');
  if (!fs.existsSync(source)) throw new Error(`Source folder not found: ${source}`);
  if (!fs.existsSync(inv)) throw new Error(`Inventory not found: ${inv}`);
  const rows = parseCsv(fs.readFileSync(inv, 'utf8'));
  const letterToKey = new Map(PACKS.map((p) => [p.letter, p.key]));
  const idOf = new Map<string, string>(); // "<folder>/<file>" -> IMG-nnn, in inventory order
  rows.forEach((r, i) => idOf.set(`${r.pack_id}/${r.file_name}`, `IMG-${String(i + 1).padStart(3, '0')}`));

  const images: ManifestImage[] = []; const audits: Array<{ id: string; audit: ProjectionAudit }> = [];
  for (const r of rows) {
    const id = idOf.get(`${r.pack_id}/${r.file_name}`)!;
    const alloc = ALLOCATION[`${r.pack_id}/${r.file_name}`];
    if (!alloc) throw new Error(`No allocation for ${r.pack_id}/${r.file_name}`);
    const abs = path.join(source, r.pack_id, r.file_name);
    if (!fs.existsSync(abs)) throw new Error(`Missing file ${abs}`);
    const bytes = fs.readFileSync(abs);
    const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
    if (sha1 !== r.sha1) throw new Error(`${id}: SHA-1 differs from the inventory`);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const meta = await sharp(bytes).metadata();
    if (meta.format !== 'png' || meta.width !== Number(r.width) || meta.height !== Number(r.height)) throw new Error(`${id}: format or dimensions differ from the inventory`);
    const { imported, audit } = projectRow(r, { nameOf: (f) => idOf.get(`${r.pack_id}/${f}`) });
    if (alloc.fields) { if (alloc.fields.environment) imported.fields!.environment = alloc.fields.environment; if (alloc.fields.description) imported.fields!.description = alloc.fields.description; }
    imported.technical = { format: 'PNG', color_mode: r.color_mode, has_alpha_channel: r.has_alpha_channel === 'yes', width: meta.width!, height: meta.height!, aspect_ratio: Number(r.aspect_ratio), orientation: r.orientation, file_size_bytes: bytes.length, sha1, sha256, texture_score: Number(r.texture_score) };
    const review: ReviewItem[] = [{ kind: 'metadata_draft', note: 'The inventory marks all of its metadata as a draft that needs a human check.' }];
    if (alloc.confidence !== 'high') review.push({ kind: 'classification_uncertain', note: alloc.note?.startsWith('Setting discrepancy') ? 'The pack is a judgement call; the setting note below explains why.' : alloc.note, alt_pack: alloc.alt ? letterToKey.get(alloc.alt) : undefined });
    if (alloc.note?.startsWith('Setting discrepancy')) review.push({ kind: 'setting_discrepancy', note: alloc.note });
    if (imported.operational?.flags?.includes('FILENAME_MISMATCH')) review.push({ kind: 'filename_mismatch', note: alloc.note });
    imported.operational = { ...imported.operational, review };
    images.push({
      importKey: id, source: { folder: r.pack_id, file: r.file_name, relativePath: `${r.pack_id}/${r.file_name}` }, sha256, sha1, sizeBytes: bytes.length, width: meta.width!, height: meta.height!, format: 'png',
      pack: letterToKey.get(alloc.pack)!, secondaryConcepts: alloc.secondary, confidence: alloc.confidence, alternatePack: alloc.alt ? letterToKey.get(alloc.alt) : undefined, review, imported,
    });
    audits.push({ id, audit });
  }
  const manifest: ImportManifest = { manifestVersion: MANIFEST_VERSION, sourceDirectory: path.basename(source), packs: PACKS.map(({ key, letter, name, description }) => ({ key, letter, name, description })), images };
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`The manifest is not valid:\n${problems.join('\n')}`);
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  const sum = (f: (a: ProjectionAudit) => number) => audits.reduce((n, a) => n + f(a.audit), 0);
  console.log(`Wrote ${out}: ${images.length} images, ${manifest.packs.length} packs.`);
  console.log(`Dropped as person-related (not imported): ${sum((a) => a.droppedProps.length)} props, ${sum((a) => a.droppedTags.length)} tags, ${sum((a) => a.droppedText.length)} text fields, ${sum((a) => a.droppedFlags.length)} flags.`);
  const byReason = new Map<string, Set<string>>();
  for (const { audit } of audits) for (const d of [...audit.droppedProps, ...audit.droppedTags]) { if (!byReason.has(d.reason)) byReason.set(d.reason, new Set()); byReason.get(d.reason)!.add(d.term); }
  for (const [reason, terms] of byReason) console.log(`  ${reason}: ${[...terms].sort().join(' | ')}`);
}

if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
