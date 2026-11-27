import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { studioAssets, videoScreens } from '@/db/schema.pg';
import { signKeys } from '@/lib/studio/image-store';
import { getSelection, saveSelection } from '@/lib/overlays/selection';
import { overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';

// The B-roll a person picked for this project (IDs only) and the Flow scenes it can be attached to. Reading this never selects, creates or generates anything.
// A read that has not answered in a minute will not answer: fail (the page offers Retry) instead of hanging to the platform's 300 s limit.
export const maxDuration = 60;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  const scenes = (await db.select({ id: videoScreens.id, n: videoScreens.screenNumber, d: videoScreens.dialogue }).from(videoScreens)
    .where(and(eq(videoScreens.videoProjectId, g.projectId), gt(videoScreens.screenNumber, 0))).orderBy(asc(videoScreens.position)))
    .map((s) => ({ screenId: s.id, sceneNumber: s.n, dialogue: s.d }));
  const selection = await getSelection(g.projectId);
  // Small pictures of the chosen Scene Pack images (signed links), so the screens can show what was chosen.
  const assetIds = [...new Set(selection.character.map((c) => c.assetId))];
  const rows = assetIds.length ? await db.select({ id: studioAssets.id, thumbKey: studioAssets.thumbKey, storageKey: studioAssets.storageKey }).from(studioAssets).where(inArray(studioAssets.id, assetIds)) : [];
  const signed = await signKeys(rows.map((r) => r.thumbKey ?? r.storageKey));
  const previews = { assets: Object.fromEntries(rows.map((r) => [r.id, signed.get(r.thumbKey ?? r.storageKey) ?? null])) as Record<number, string | null> };
  return NextResponse.json({ enabled: true, selection, scenes, previews });
}

// Replaces the selection. Creates no overlays and starts no jobs.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
  const generic: Array<{ clipId: number; screenId: number }> = []; const character: Array<{ assetId: number; screenId: number; action?: string }> = [];
  for (const e of Array.isArray(body.generic) ? body.generic : []) { const clipId = int(e?.clipId), screenId = int(e?.screenId); if (clipId === null || screenId === null) return NextResponse.json({ error: 'Each generic pick needs clipId and screenId.' }, { status: 400 }); generic.push({ clipId, screenId }); }
  for (const e of Array.isArray(body.character) ? body.character : []) { const assetId = int(e?.assetId), screenId = int(e?.screenId); if (assetId === null || screenId === null) return NextResponse.json({ error: 'Each character pick needs assetId and screenId.' }, { status: 400 }); character.push({ assetId, screenId, action: typeof e.action === 'string' ? e.action : '' }); }
  try { return NextResponse.json({ selection: await saveSelection(g.projectId, { generic, character }) }); }
  catch (err) { return overlayErrorResponse(err); }
}
