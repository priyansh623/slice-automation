/**
 * Smoke test for the AI analysis behind the bulk B-roll upload. Read-only: it reads the approved taxonomy from the
 * database, samples 4 frames from each video you name, asks the model, and prints the validated suggestion. It uploads
 * nothing and writes nothing (no clips, categories or storage objects).
 *
 *   npx tsx scripts/broll-bulk-analyze.ts <video.mp4> [more videos...]
 *
 * Needs ANTHROPIC_API_KEY (and optionally BROLL_ANALYSIS_MODEL) in .env.local, plus the usual database settings.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) { console.error('Usage: npx tsx scripts/broll-bulk-analyze.ts <video.mp4> [more...]'); process.exit(2); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set in .env.local. Nothing was done.'); process.exit(2); }
  const { db } = await import('../src/db');
  const { loadTaxonomy } = await import('../src/lib/broll-bulk/taxonomy-server');
  const { analyseFrames, ANALYSIS_MODEL } = await import('../src/lib/broll-bulk/analyzer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpeg = require('ffmpeg-static') as string; const ffprobe = (require('ffprobe-static') as { path: string }).path; // eslint-disable-line @typescript-eslint/no-require-imports

  const taxonomy = await loadTaxonomy(db);
  console.log(`model ${ANALYSIS_MODEL()} | taxonomy: ${taxonomy.categories.length} categories, ${taxonomy.activities.length} activities, ${taxonomy.settings.length} settings, ${taxonomy.brands.length} brands, ${taxonomy.tags.length} tags`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-frames-'));
  for (const file of files) {
    const dur = Number(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString().trim()) || 5;
    const frames = [0.08, 0.3, 0.55, 0.8].map((pos, i) => {
      const out = path.join(tmp, `f${i}.jpg`);
      spawnSync(ffmpeg, ['-y', '-v', 'error', '-ss', String(dur * pos), '-i', file, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-q:v', '4', out]);
      return fs.readFileSync(out).toString('base64');
    });
    const s = await analyseFrames({ frames, durationSeconds: dur, width: null, height: null }, taxonomy);
    const cat = s.categoryId ? taxonomy.categories.find((c) => c.id === s.categoryId)?.path : 'NEEDS REVIEW';
    console.log(`\n== ${path.basename(file)}\n  title:    ${s.title}\n  category: ${cat} [${s.categoryConfidence}]${s.proposedCategory ? `\n  proposal: "${s.proposedCategory.name}" (${s.proposedCategory.reason})` : ''}\n  activity: ${s.activity} | setting: ${s.setting}\n  brands:   ${s.brands.map((b) => `${b.name} (${b.role}${b.existing ? ', existing' : ', new'})`).join(', ') || '-'}\n  tags:     ${s.tags.map((t) => t.tag + (t.known ? '' : '*')).join(', ')}\n  privacy:  ${s.privacy.map((p) => `${p.type} [${p.severity}]`).join(', ') || '-'}\n  text:     ${s.visibleText.join(' | ') || '-'}\n  unresolved: ${s.unresolved.join(', ') || '-'} | confidence ${s.confidence}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
main().catch((e) => { console.error('Failed:', (e as Error).message); process.exit(1); });
