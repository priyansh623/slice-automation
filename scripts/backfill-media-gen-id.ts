/**
 * Backfills mediaGenerationId for completed generations that are missing it.
 * Usage: USEAPI_TOKEN=xxx npx ts-node --project tsconfig.json scripts/backfill-media-gen-id.ts
 * Or: add USEAPI_TOKEN to .env.local and run without prefix.
 */
import * as path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/db';
import { videoGenerations } from '../src/db/schema.pg';
import { isNull, eq, and } from 'drizzle-orm';

const BASE_URL = 'https://api.useapi.net/v1/google-flow';

async function main() {
  const token = process.env.USEAPI_TOKEN;
  if (!token) throw new Error('USEAPI_TOKEN not set');

  // Find completed generations missing mediaGenerationId
  const rows = await db
    .select({ id: videoGenerations.id, jobId: videoGenerations.jobId })
    .from(videoGenerations)
    .where(and(eq(videoGenerations.status, 'completed'), isNull(videoGenerations.mediaGenerationId)));

  console.log(`Found ${rows.length} completed generation(s) missing mediaGenerationId`);

  for (const row of rows) {
    if (!row.jobId) {
      console.log(`  Gen ${row.id}: no jobId, skipping`);
      continue;
    }
    try {
      const res = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(row.jobId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.log(`  Gen ${row.id}: poll failed ${res.status}`);
        continue;
      }
      const json = await res.json() as Record<string, unknown>;
      type MediaItem = { mediaGenerationId?: string };
      const firstMedia = ((json.media as MediaItem[] | undefined) ?? [])[0];
      const mediaGenerationId = firstMedia?.mediaGenerationId;
      if (!mediaGenerationId) {
        console.log(`  Gen ${row.id}: no mediaGenerationId in response — keys: ${Object.keys(json).join(', ')}`);
        continue;
      }
      await db.update(videoGenerations).set({ mediaGenerationId }).where(eq(videoGenerations.id, row.id));
      console.log(`  Gen ${row.id}: backfilled → ${mediaGenerationId}`);
    } catch (err) {
      console.error(`  Gen ${row.id}: error —`, err);
    }
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
