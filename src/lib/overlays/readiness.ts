/** Can a Character B-roll VIDEO be made right now? The video loop runs inside the worker, which reports its provider with its Studio status. */
import { gt } from 'drizzle-orm';
import { db } from '@/db';
import { studioWorkerStatus } from '@/db/schema.pg';
import { WORKER_STALE_MS } from '@/lib/studio/worker-status';

export interface VideoReadiness { ready: boolean; provider: string | null; message: string | null }

export async function videoGenerationReadiness(now = Date.now()): Promise<VideoReadiness> {
  const rows = await db.select().from(studioWorkerStatus).where(gt(studioWorkerStatus.lastSeenAt, now - WORKER_STALE_MS));
  if (rows.length === 0) return { ready: false, provider: null, message: 'No worker is running, so a video requested now would not be processed.' };
  const providers = rows.map((r) => (r.details as { clipProvider?: string | null } | null)?.clipProvider ?? null).filter((p): p is string => !!p);
  if (providers.length === 0) return { ready: false, provider: null, message: 'The worker has no video provider configured (HF_CREDENTIALS is missing on the worker), so nothing can be submitted. Nothing was charged.' };
  return { ready: true, provider: providers[0], message: null };
}
