/**
 * Uploads the validated "Ready" B-roll batch (CSV converted to JSON) to R2 and creates the clip records.
 *
 *   dry run (default):  npx tsx scripts/broll-batch-import.ts <batch.json> <source dir> <state.json>
 *   real import:        npx tsx scripts/broll-batch-import.ts <batch.json> <source dir> <state.json> --import
 *
 * For every clip: the file must exist and match its recorded SHA-256, be 9:16, and every category id must already exist
 * (categories are never created). The file is written to R2 only (Supabase fallback is switched off for this process, so
 * nothing can land in Supabase), read back and checksum-compared, and only then is the clip row, its category links and its
 * brand associations inserted in one transaction. Resumable: a clip that is already imported is skipped.
 * Metadata follows the existing import: broll-classification/v1 notes, review_status unreviewed, no clearance decisions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
process.env.STORAGE_FAILOVER = 'off'; // an R2 failure must fail the clip, never write to Supabase

import { inArray, like, and } from 'drizzle-orm';
import { db } from '../src/db';
import { brollCategories, brollClipBrands, brollClipCategories, brollClips } from '../src/db/schema.pg';
import { getStorage } from '../src/lib/object-store';
import { buildClassificationNotes, type BrandEntry, type ClipClassification } from '../src/lib/broll-classification';
import { planBrandAssociations } from '../src/lib/broll-brands';
import { isPortrait916, probeVideo } from '../src/lib/broll-probe';

type Row = Record<string, string>;
const [batchPath, sourceDir, statePath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const EXECUTE = process.argv.includes('--import');
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const nz = (s: string | undefined): string | null => (s && s.trim() ? s : null); // keeps the exact text, trailing spaces included

function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = []; let depth = 0; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++; if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && sep.test(s.slice(i)) && s.slice(i).match(sep)!.index === 0) { const m = s.slice(i).match(sep)!; out.push(cur); cur = ''; i += m[0].length - 1; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function classificationOf(r: Row): { c: ClipClassification; categoryIds: number[] } {
  const brands: BrandEntry[] = []; let clientProduct: ClipClassification['clientProduct'];
  for (const part of splitTop(r['Brand associations'] ?? '', /^\s\|\s/)) {
    const m = part.match(/^(hero|incidental|client_product|unresolved):\s*(.+)$/);
    if (!m) throw new Error(`${r.Ref}: cannot read brand association "${part}"`);
    const [, role, text] = m;
    if (role === 'client_product') clientProduct = { what: text.replace(/\s*\(no brand name\)\s*$/, ''), brandConfirmed: false };
    else brands.push({ name: text, role: role as BrandEntry['role'], clearance: 'unresolved' });
  }
  const review = [r.Notes, r['Clearance note']].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
  const c: ClipClassification = {
    clipId: r.Ref, confidence: r.Confidence, categories: [], removeTags: [], addTags: [], clientProduct, brands,
    flags: splitTop(r.Flags ?? '', /^,/), review,
  };
  return { c, categoryIds: (r['Category IDs'] ?? '').split(';').map((x) => Number(x.trim())).filter(Boolean) };
}

async function main() {
  const rows: Row[] = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
  const state: Record<string, { dbId: number; storagePath: string; sha256: string }> = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  const userId = process.env.BROLL_IMPORT_USER_ID;
  if (!userId) throw new Error('BROLL_IMPORT_USER_ID is not set');
  console.log(EXECUTE ? 'REAL IMPORT' : 'DRY RUN (nothing is written)', `| ${rows.length} rows in the batch`);

  // 1. Whole-batch checks, before anything is written.
  const plan: { r: Row; file: string; buf?: Buffer; categoryIds: number[]; problems: string[]; probe?: ReturnType<typeof probeVideo> }[] = [];
  const allIds = [...new Set(rows.flatMap((r) => classificationOf(r).categoryIds))];
  const found = await db.select({ id: brollCategories.id }).from(brollCategories).where(inArray(brollCategories.id, allIds));
  const missingCats = allIds.filter((id) => !found.some((f) => f.id === id));
  if (missingCats.length) throw new Error(`categories not found (never created here): ${missingCats.join(', ')}`);
  for (const r of rows) {
    const problems: string[] = [];
    const file = path.join(sourceDir, r['Upload file']);
    let buf: Buffer | undefined;
    if (r['Upload status'] !== 'Ready') problems.push(`status is ${r['Upload status']}`);
    if (!fs.existsSync(file)) problems.push('file not found');
    else {
      buf = fs.readFileSync(file);
      if (sha256(buf) !== r['SHA256 (full)']) problems.push('SHA-256 differs from the manifest');
    }
    const { categoryIds } = classificationOf(r);
    if (categoryIds.length === 0) problems.push('no category ids');
    const probe = buf ? probeVideo(file) : undefined;
    if (probe && (!probe.dims || !isPortrait916(probe.dims))) problems.push(`not 9:16 (${probe.dims ? `${probe.dims.width}x${probe.dims.height}` : 'unreadable'})`);
    plan.push({ r, file, buf, categoryIds, problems, probe });
  }
  const blocked = plan.filter((p) => p.problems.length);
  for (const b of blocked) console.log(`BLOCKED ${b.r.Ref} ${b.r['Clip name']}: ${b.problems.join('; ')}`);
  const ready = plan.filter((p) => !p.problems.length);
  console.log(`checked: ${ready.length} ready, ${blocked.length} blocked`);

  // 2. Per clip: skip if already imported, else upload, verify, insert.
  const storage = getStorage();
  let done = 0, skipped = 0, failed = 0, bytes = 0;
  for (const p of ready) {
    const { r, buf } = p; const ref = r.Ref;
    const existing = state[ref] ?? (await db.select({ id: brollClips.id }).from(brollClips).where(and(like(brollClips.notes, `%"clipId":"${ref}"%`), like(brollClips.notes, `%${r['Upload file']}%`))).limit(1).then((x) => x[0] && { dbId: x[0].id, storagePath: '', sha256: '' }));
    if (existing) { console.log(`skip     ${ref} (already imported as clip ${existing.dbId})`); skipped++; continue; }
    const { c } = classificationOf(r);
    const notes = buildClassificationNotes(c, r['Upload file']);
    const plannedBrands = planBrandAssociations(notes).associations;
    if (!EXECUTE) { console.log(`would    ${ref} ${String(buf!.length).padStart(8)} B  cats [${p.categoryIds}]  brands ${plannedBrands.length}  dur ${p.probe!.durationSeconds}s  "${r['Clip name']}"`); continue; }

    const storagePath = `${userId}/broll/${crypto.randomUUID()}.mp4`;
    try {
      const put = await storage.put('uploads', storagePath, buf!, { contentType: 'video/mp4', preferProvider: 'r2' });
      if (put.provider !== 'r2') throw new Error(`stored in ${put.provider}, not R2`);
      const head = await storage.headR2('uploads', storagePath);
      if (!head || head.size !== buf!.length) throw new Error(`R2 reports ${head?.size} B, expected ${buf!.length}`);
      const back = await storage.download('uploads', storagePath);
      if (sha256(back) !== r['SHA256 (full)']) throw new Error('read-back SHA-256 differs from the source');
      const now = Date.now();
      const id = await db.transaction(async (tx) => {
        const [row] = await tx.insert(brollClips).values({
          userId, title: r['Clip name'], storagePath, mimeType: 'video/mp4', fileSizeBytes: buf!.length,
          durationSeconds: p.probe!.durationSeconds, userTags: JSON.stringify(r.Tags.split(',').map((t) => t.trim()).filter(Boolean)),
          subject: nz(r.Subject), activity: nz(r.Activity), setting: nz(r.Setting), brand: nz(r.Brand), description: nz(r.Description),
          notes, processingStatus: 'completed', reviewStatus: 'unreviewed', createdAt: now, updatedAt: now,
        }).returning({ id: brollClips.id });
        await tx.insert(brollClipCategories).values(p.categoryIds.map((categoryId) => ({ clipId: row.id, categoryId, createdAt: now })));
        if (plannedBrands.length) await tx.insert(brollClipBrands).values(plannedBrands.map((a) => ({ clipId: row.id, brandName: a.brandName, role: a.role, note: a.note, createdAt: now, updatedAt: now })));
        return row.id;
      });
      state[ref] = { dbId: id, storagePath, sha256: r['SHA256 (full)'] };
      fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
      console.log(`imported ${ref} -> clip ${id}  ${buf!.length} B  ${storagePath}`);
      done++; bytes += buf!.length;
    } catch (e) {
      console.log(`FAILED   ${ref} ${r['Clip name']}: ${(e as Error).message.slice(0, 200)}  (object key if written: ${storagePath})`);
      failed++;
    }
  }
  console.log(`\nsummary: ${EXECUTE ? `imported ${done}` : `would import ${ready.length - skipped}`}, skipped ${skipped}, failed ${failed}, blocked ${blocked.length}${EXECUTE ? `, ${bytes} bytes` : ''}`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error('Aborted:', e.message); process.exit(1); });
