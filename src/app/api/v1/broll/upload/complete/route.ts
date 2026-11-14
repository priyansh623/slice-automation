import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { getStorage } from '@/lib/object-store';
import { registerObjectIfAbsent, registeredRows } from '@/lib/object-store/registry';
import { clipForViewer } from '@/lib/broll-access';
import { BROLL_URL_TTL_S } from '@/lib/broll-signed-url';
import { isOwnBrollKey, verifyStoredObject } from '@/lib/broll-direct-upload';
import { isPortrait916, probeVideo } from '@/lib/broll-probe';

/**
 * Step 3 of a browser-direct B-roll upload. The browser says "I finished"; the server does not take its word for it:
 * it asks R2 what is really stored, checks the type, size and (best effort) shape of the video, and only then records
 * the file in the registry and creates the B-roll clip. Anything that fails leaves no clip and no registry row.
 * Calling it again for the same upload returns the clip that already exists instead of creating a second one.
 */
interface Body {
  storagePath?: unknown; title?: unknown; userTags?: unknown;
  subject?: unknown; activity?: unknown; setting?: unknown; brand?: unknown; description?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const title = str(body.title);
  if (!title) return NextResponse.json({ error: 'title and storagePath are required' }, { status: 400 });
  if (typeof body.storagePath !== 'string') return NextResponse.json({ error: 'title and storagePath are required' }, { status: 400 });
  // Only a key this flow could have issued to this very user: not another user's folder, not an arbitrary path.
  if (!isOwnBrollKey(user.id, body.storagePath)) return NextResponse.json({ error: 'Invalid storagePath' }, { status: 403 });
  const key = body.storagePath;
  const tags = Array.isArray(body.userTags) ? body.userTags.filter((t): t is string => typeof t === 'string') : null;

  // A repeat of a completed upload returns the existing clip.
  const existing = await findClip(key);
  if (existing) return respondWithClip(existing, 200);

  const storage = getStorage();
  let head: { size: number; contentType: string | null } | null;
  try {
    head = await storage.headR2('uploads', key);
  } catch (err) {
    console.error('[broll/upload/complete] could not check R2:', (err as Error).message);
    return NextResponse.json({ error: 'Could not verify the upload. Please try again.' }, { status: 502 });
  }
  const verdict = verifyStoredObject(key, head);
  if (!verdict.ok) {
    if (verdict.discard) await discardIfUnreferenced(key);
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  // Look at the real video (reads only what ffprobe needs, over a short-lived read URL).
  let signedUrl: string | null = null;
  try { signedUrl = await storage.signedReadUrl('uploads', key, BROLL_URL_TTL_S); } catch { signedUrl = null; }
  let durationSeconds: number | null = null;
  if (signedUrl) {
    const probe = probeVideo(signedUrl);
    durationSeconds = probe.durationSeconds;
    if (probe.dims && !isPortrait916(probe.dims)) {
      await discardIfUnreferenced(key);
      return NextResponse.json({ error: `Video must be 9:16 aspect ratio. Detected ${probe.dims.width}×${probe.dims.height}.` }, { status: 422 });
    }
  }

  // Registry first (insert-only: an existing row is never changed), so the clip never points at a file readers cannot find.
  try {
    await registerObjectIfAbsent({ bucket: 'uploads', key, provider: 'r2', sizeBytes: verdict.size, contentType: verdict.contentType, verifiedAt: Date.now() });
  } catch (err) {
    console.error('[broll/upload/complete] registry write failed:', (err as Error).message);
    return NextResponse.json({ error: 'Could not record the upload. Please try again.' }, { status: 500 });
  }

  const now = Date.now();
  // One completion at a time per file: a second, simultaneous request waits here and then finds the clip the first created.
  const clip = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [again] = await tx.select().from(brollClips).where(and(eq(brollClips.storagePath, key))).limit(1);
    if (again) return { row: again, created: false };
    const [inserted] = await tx.insert(brollClips).values({
      userId: user.id,
      title,
      storagePath: key,
      signedUrl,
      signedUrlExpiresAt: signedUrl ? now + BROLL_URL_TTL_S * 1000 : null,
      mimeType: verdict.contentType,
      fileSizeBytes: verdict.size,
      durationSeconds,
      userTags: tags ? JSON.stringify(tags) : null,
      subject: str(body.subject),
      activity: str(body.activity),
      setting: str(body.setting),
      brand: str(body.brand),
      description: str(body.description),
      processingStatus: 'completed',
      reviewStatus: 'unreviewed',
      createdAt: now,
      updatedAt: now,
    }).returning();
    return { row: inserted, created: true };
  });
  return respondWithClip(clip.row, clip.created ? 201 : 200);
}

async function findClip(key: string) {
  const [row] = await db.select().from(brollClips).where(eq(brollClips.storagePath, key)).limit(1);
  return row ?? null;
}

function respondWithClip(row: typeof brollClips.$inferSelect, status: number): NextResponse {
  return NextResponse.json(clipForViewer(row, { categoryCount: 0, brands: [], signedUrl: row.signedUrl }), { status });
}

/**
 * Removes a rejected upload from R2, but only when nothing refers to it: no clip and no registry row. Objects that are
 * registered (for example the migrated files) or used by a clip are never touched. Failure to remove is not an error.
 */
async function discardIfUnreferenced(key: string): Promise<void> {
  try {
    if (await findClip(key)) return;
    if ((await registeredRows('uploads', [key])).has(key)) return;
    await getStorage().deleteFromR2('uploads', key);
  } catch (err) {
    console.warn('[broll/upload/complete] could not remove a rejected upload:', (err as Error).message.slice(0, 120));
  }
}
