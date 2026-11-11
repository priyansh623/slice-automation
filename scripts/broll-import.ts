/**
 * Bulk B-roll import script.
 *
 * Dry-run (default — safe to run any time):
 *   npx ts-node --project tsconfig.json scripts/broll-import.ts
 *
 * Real import (requires explicit flag AND approved dry-run):
 *   npx ts-node --project tsconfig.json scripts/broll-import.ts --import
 *
 * State log: broll-import/imported.json  (clipId → { dbId, storagePath, importedAt })
 * Manifest:  broll-import/manifest.json
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/db';
import { brollClips } from '../src/db/schema.pg';
import { createClient } from '@supabase/supabase-js';

// ── Types ────────────────────────────────────────────────────────────────────

interface ClipEntry {
  clipId: string;
  filename: string;
  title: string;
  tags: string[];
  subject: string;
  activity: string;
  setting: string;
  brand: string;
  description: string;
}

interface ExcludedEntry {
  clipId: string;
  filename: string;
  reason: string;
}

interface Manifest {
  sourceDir: string;
  clips: ClipEntry[];
  excluded: ExcludedEntry[];
}

interface ProbeResult {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  durationSeconds: number;
  rotation: number;
  mimeType: string;
}

interface ImportedRecord {
  dbId: number;
  storagePath: string;
  importedAt: string;
}

interface ImportState {
  [clipId: string]: ImportedRecord;
}

// ── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'broll-import', 'manifest.json');
const STATE_PATH = path.join(PROJECT_ROOT, 'broll-import', 'imported.json');

const FFPROBE_PATH = path.join(
  PROJECT_ROOT,
  'node_modules',
  'ffprobe-static',
  'bin',
  'darwin',
  'arm64',
  'ffprobe',
);

// ── ffprobe ──────────────────────────────────────────────────────────────────

function probeVideo(filePath: string): ProbeResult {
  const result = spawnSync(
    FFPROBE_PATH,
    ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed on ${filePath}: ${result.stderr?.slice(-200)}`);
  }
  const data = JSON.parse(result.stdout);
  const videoStream = (data.streams || []).find((s: { codec_type: string }) => s.codec_type === 'video');
  if (!videoStream) throw new Error(`No video stream found in ${filePath}`);

  const rawW: number = videoStream.width ?? 0;
  const rawH: number = videoStream.height ?? 0;
  const dur: number = parseFloat(data.format?.duration ?? videoStream.duration ?? '0');

  // Rotation — two possible sources:
  // 1. tags.rotate: string, degrees CCW
  // 2. side_data_list[].rotation: number, degrees CW (inverted sign convention)
  let rotation = 0;
  const tagRotate = videoStream.tags?.rotate;
  if (tagRotate !== undefined) {
    rotation = ((parseInt(String(tagRotate), 10) % 360) + 360) % 360;
  } else {
    const sideData: Array<{ rotation?: number }> = videoStream.side_data_list ?? [];
    for (const sd of sideData) {
      if (sd.rotation !== undefined) {
        // CW positive → negate to get CCW, then normalize
        rotation = ((-sd.rotation % 360) + 360) % 360;
        break;
      }
    }
  }

  // Swap dimensions for portrait-encoded videos rotated 90° or 270°
  const swap = rotation === 90 || rotation === 270;
  const displayWidth = swap ? rawH : rawW;
  const displayHeight = swap ? rawW : rawH;

  return {
    width: rawW,
    height: rawH,
    displayWidth,
    displayHeight,
    durationSeconds: Math.round(dur),
    rotation,
    mimeType: 'video/mp4',
  };
}

// ── 9:16 validation ──────────────────────────────────────────────────────────

function is916(w: number, h: number): boolean {
  if (h === 0) return false;
  const ratio = w / h;
  const target = 9 / 16;
  return Math.abs(ratio - target) < 0.03; // ±3% tolerance
}

// ── Load / save state ────────────────────────────────────────────────────────

async function loadState(): Promise<ImportState> {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw) as ImportState;
  } catch {
    return {};
  }
}

async function saveState(state: ImportState): Promise<void> {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── Main ─────────────────────────────────────────────────name──────────────────

async function main() {
  const dryRun = !process.argv.includes('--import');

  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  B-roll Import  —  ${dryRun ? 'DRY RUN (read-only)' : '⚠  REAL IMPORT'}`);
  console.log('══════════════════════════════════════════════════════');
  console.log('');

  // ── Load manifest ──────────────────────────────────────────────────────────
  const manifestRaw = await fs.readFile(MANIFEST_PATH, 'utf8');
  const manifest: Manifest = JSON.parse(manifestRaw);
  const sourceDir = manifest.sourceDir;

  // ── Load state ─────────────────────────────────────────────────────────────
  const state = await loadState();

  // ── Check ffprobe ──────────────────────────────────────────────────────────
  try {
    await fs.access(FFPROBE_PATH);
  } catch {
    console.error(`ERROR: ffprobe not found at ${FFPROBE_PATH}`);
    process.exit(1);
  }

  // ── Check source directory ─────────────────────────────────────────────────
  try {
    await fs.access(sourceDir);
  } catch {
    console.error(`ERROR: sourceDir not found: ${sourceDir}`);
    process.exit(1);
  }

  const dirEntries = await fs.readdir(sourceDir);
  const mp4Files = dirEntries.filter(f => f.endsWith('.mp4'));
  console.log(`Source directory: ${sourceDir}`);
  console.log(`  MP4 files found: ${mp4Files.length}`);
  console.log(`  Manifest clips:  ${manifest.clips.length}  (excluded: ${manifest.excluded.length})`);
  console.log('');

  // ── Probe and validate each clip ───────────────────────────────────────────
  type ClipResult = {
    clip: ClipEntry;
    filePath: string | null;
    fileFound: boolean;
    probe: ProbeResult | null;
    probeError: string | null;
    is916: boolean;
    alreadyImported: boolean;
  };

  const results: ClipResult[] = [];

  for (const clip of manifest.clips) {
    // Match by filename prefix (the UUID suffix in the manifest is from the PDF appendix)
    const prefix = clip.filename.replace('.mp4', '');
    // Try exact match first, then prefix match
    let matched = mp4Files.find(f => f === clip.filename);
    if (!matched) {
      matched = mp4Files.find(f => f.startsWith(prefix.slice(0, 24))); // match on hf_YYYYMMDD_HHMMSS prefix
    }

    const filePath = matched ? path.join(sourceDir, matched) : null;
    const fileFound = filePath !== null;
    const alreadyImported = clip.clipId in state;

    let probe: ProbeResult | null = null;
    let probeError: string | null = null;

    if (fileFound) {
      try {
        probe = probeVideo(filePath!);
      } catch (e) {
        probeError = String(e);
      }
    }

    const aspectOk = probe ? is916(probe.displayWidth, probe.displayHeight) : false;

    results.push({
      clip,
      filePath,
      fileFound,
      probe,
      probeError,
      is916: aspectOk,
      alreadyImported,
    });
  }

  // ── Categorise ─────────────────────────────────────────────────────────────
  const found       = results.filter(r => r.fileFound);
  const notFound    = results.filter(r => !r.fileFound);
  const probeErrors = results.filter(r => r.fileFound && r.probeError);
  const aspect916   = results.filter(r => r.fileFound && !r.probeError && r.is916);
  const aspectBad   = results.filter(r => r.fileFound && !r.probeError && !r.is916);
  const alreadyDone = results.filter(r => r.alreadyImported);
  const eligible    = results.filter(r => r.fileFound && !r.probeError && r.is916 && !r.alreadyImported);

  // ── Print report ────────────────────────────────────────────────────────────
  console.log('── SUMMARY ──────────────────────────────────────────');
  console.log(`  Total manifest entries : ${manifest.clips.length}`);
  console.log(`  Files found            : ${found.length}`);
  console.log(`  Files not found        : ${notFound.length}`);
  console.log(`  Probe errors           : ${probeErrors.length}`);
  console.log(`  Pass 9:16 check        : ${aspect916.length}`);
  console.log(`  Fail 9:16 check        : ${aspectBad.length}`);
  console.log(`  Already imported       : ${alreadyDone.length}`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Eligible to import     : ${eligible.length}`);
  console.log('');

  if (notFound.length > 0) {
    console.log('── NOT FOUND ─────────────────────────────────────────');
    for (const r of notFound) {
      console.log(`  ${r.clip.clipId}  ${r.clip.filename}`);
    }
    console.log('');
  }

  if (aspectBad.length > 0) {
    console.log('── ASPECT RATIO FAILURES ─────────────────────────────');
    for (const r of aspectBad) {
      const p = r.probe!;
      const ratio = (p.displayWidth / p.displayHeight).toFixed(3);
      console.log(`  ${r.clip.clipId}  ${p.displayWidth}×${p.displayHeight} (ratio ${ratio}, rotation ${p.rotation}°)  —  ${r.clip.title}`);
    }
    console.log('');
  }

  if (probeErrors.length > 0) {
    console.log('── PROBE ERRORS ──────────────────────────────────────');
    for (const r of probeErrors) {
      console.log(`  ${r.clip.clipId}  ${r.probeError}`);
    }
    console.log('');
  }

  if (alreadyDone.length > 0) {
    console.log('── ALREADY IMPORTED (skipped) ────────────────────────');
    for (const r of alreadyDone) {
      const rec = state[r.clip.clipId];
      console.log(`  ${r.clip.clipId}  dbId=${rec.dbId}  ${rec.storagePath}`);
    }
    console.log('');
  }

  console.log('── ELIGIBLE CLIPS ────────────────────────────────────');
  for (const r of eligible) {
    const p = r.probe!;
    console.log(`  ${r.clip.clipId}  ${p.displayWidth}×${p.displayHeight}  ${p.durationSeconds}s  "${r.clip.title}"`);
  }
  console.log('');

  console.log('── EXCLUDED (personal data) ──────────────────────────');
  for (const ex of manifest.excluded) {
    console.log(`  ${ex.clipId}  ${ex.filename}`);
    console.log(`    Reason: ${ex.reason}`);
  }
  console.log('');

  if (dryRun) {
    console.log('DRY RUN complete — no files uploaded, no DB rows written.');
    console.log('Re-run with --import to perform the actual import.');
    console.log('');
    return;
  }

  // ══════════════════════════════════════════════════════
  //  REAL IMPORT
  // ══════════════════════════════════════════════════════

  if (eligible.length === 0) {
    console.log('Nothing eligible to import. Done.');
    return;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket      = process.env.SUPABASE_BUCKET_UPLOADS ?? 'uploads';

  if (!supabaseUrl || !serviceKey) {
    console.error('ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
    process.exit(1);
  }

  // userId: the owner of these clips — read from env or fail early
  const importUserId = process.env.BROLL_IMPORT_USER_ID;
  if (!importUserId) {
    console.error('ERROR: BROLL_IMPORT_USER_ID must be set in .env.local (the Supabase user UUID to own these clips)');
    process.exit(1);
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let imported = 0;
  let failed = 0;

  for (const r of eligible) {
    const { clip, filePath, probe } = r;
    console.log(`Importing ${clip.clipId}: ${clip.title}`);

    try {
      const fileBuffer = await fs.readFile(filePath!);
      const fileSize = fileBuffer.length;
      const ext = 'mp4';
      const storageUUID = randomUUID();
      const storagePath = `${importUserId}/broll/${storageUUID}.${ext}`;

      // Upload to Supabase Storage
      const { error: uploadError } = await service.storage
        .from(bucket)
        .upload(storagePath, fileBuffer, {
          contentType: 'video/mp4',
          upsert: false,
        });

      if (uploadError) {
        throw new Error(`Storage upload failed: ${uploadError.message}`);
      }

      // Insert DB record
      const now = Date.now();
      const [row] = await db.insert(brollClips).values({
        userId: importUserId,
        title: clip.title,
        storagePath,
        mimeType: 'video/mp4',
        fileSizeBytes: fileSize,
        durationSeconds: probe!.durationSeconds,
        aiTags: JSON.stringify(clip.tags),
        subject: clip.subject,
        activity: clip.activity,
        setting: clip.setting,
        brand: clip.brand || null,
        description: clip.description,
        processingStatus: 'completed',
        reviewStatus: 'unreviewed',
        createdAt: now,
        updatedAt: now,
      }).returning({ id: brollClips.id });

      // Update state
      state[clip.clipId] = {
        dbId: row.id,
        storagePath,
        importedAt: new Date().toISOString(),
      };
      await saveState(state);

      console.log(`  ✓  dbId=${row.id}  ${storagePath}`);
      imported++;
    } catch (e) {
      console.error(`  ✗  ${clip.clipId} failed: ${e}`);
      failed++;
    }
  }

  console.log('');
  console.log(`══ Import complete: ${imported} succeeded, ${failed} failed ══`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
