/**
 * Makes the Projects-tab thumbnails for projects created before thumbnails existed.
 *
 *   Dry run (the default): reads each project's original image, builds the thumbnail in memory and reports sizes.
 *   Writes nothing anywhere.
 *     npx tsx scripts/backfill-project-thumbnails.ts [--limit <n>]
 *
 *   Real run (only with the explicit flag): stores each missing thumbnail as a NEW object next to the original.
 *     npx tsx scripts/backfill-project-thumbnails.ts --execute [--limit <n>]
 *
 * Safety:
 *   - The original images are only read. They are never overwritten, resized, renamed or deleted, and
 *     video_projects.base_image_path is never changed (Claude and Google Flow keep receiving the originals).
 *   - A thumbnail that already exists is skipped, so re-running is safe and never regenerates anything.
 *   - A failure on one project is reported and does not stop the others; that project simply keeps using its original
 *     in the Projects tab.
 *   - One small object per project (about 10-30 KB). No other storage, database or setting is touched.
 *
 * Run with tsx (not ts-node): it uses the project's '@/' import aliases.
 */
import * as path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { getStorage } from '../src/lib/object-store';
import { db } from '../src/db';
import { videoProjects } from '../src/db/schema.pg';
import { ensureThumbnail, makeThumbnail, thumbnailKeyFor } from '../src/lib/project-thumbnail';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? '', 10) : Infinity;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;

async function main() {
  const storage = getStorage();
  const projects = await db.select({ id: videoProjects.id, path: videoProjects.baseImagePath }).from(videoProjects);
  console.log(`${projects.length} projects. Mode: ${execute ? 'EXECUTE (writes new thumbnail objects)' : 'DRY RUN (writes nothing)'}`);

  let done = 0, existing = 0, failed = 0, origTotal = 0, thumbTotal = 0;
  for (const p of projects) {
    const key = thumbnailKeyFor(p.path);
    if (!key) { console.log(`  #${p.id} skipped: unusual path`); continue; }
    if (await storage.head('uploads', key)) { existing++; continue; }
    if (done >= limit) break;
    try {
      if (execute) {
        const r = await ensureThumbnail(storage, p.path);
        if (r.status === 'created') { done++; origTotal += r.originalBytes; thumbTotal += r.bytes; console.log(`  #${p.id} created ${mb(r.originalBytes)} -> ${kb(r.bytes)}`); }
        else if (r.status === 'exists') existing++;
        else { failed++; console.log(`  #${p.id} FAILED: ${r.reason}`); }
      } else {
        const original = await storage.download('uploads', p.path);
        const thumb = await makeThumbnail(original);
        done++; origTotal += original.length; thumbTotal += thumb.length;
        console.log(`  #${p.id} would create ${mb(original.length)} -> ${kb(thumb.length)}`);
      }
    } catch (err) {
      failed++; console.log(`  #${p.id} FAILED: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  console.log(`\n${execute ? 'Created' : 'Would create'}: ${done}   already had one: ${existing}   failed: ${failed}`);
  if (done > 0) console.log(`Originals read: ${mb(origTotal)}   thumbnails: ${kb(thumbTotal)}   (${(100 - (thumbTotal / origTotal) * 100).toFixed(1)}% smaller)`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
