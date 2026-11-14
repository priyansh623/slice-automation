import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { brollCategories, brollClipBrands, brollClipCategories, brollClips, storageObjects } from '@/db/schema.pg';
import { createClient } from '@/lib/supabase/server';
import { getStorage } from '@/lib/object-store';
import { registerObjectIfAbsent, registeredRows } from '@/lib/object-store/registry';
import { clipForViewer } from '@/lib/broll-access';
import { BROLL_URL_TTL_S } from '@/lib/broll-signed-url';
import { isOwnBrollKey, verifyStoredObject } from '@/lib/broll-direct-upload';
import { isPortrait916, probeVideo } from '@/lib/broll-probe';
import { buildClassificationNotes, type BrandEntry, type ClipClassification } from '@/lib/broll-classification';
import { planBrandAssociations } from '@/lib/broll-brands';

/**
 * Step 3 of a browser-direct B-roll upload. The browser says "I finished"; the server does not take its word for it:
 * it asks R2 what is really stored, checks the type, size and (best effort) shape of the video, and only then records
 * the file in the registry and creates the B-roll clip. Anything that fails leaves no clip and no registry row.
 * Calling it again for the same upload returns the clip that already exists instead of creating a second one.
 */
interface Body {
  storagePath?: unknown; title?: unknown; userTags?: unknown;
  subject?: unknown; activity?: unknown; setting?: unknown; brand?: unknown; description?: unknown;
  // Optional, used by the bulk upload: existing category ids, brand associations, classification notes and the file's SHA-256.
  categoryIds?: unknown; brands?: unknown; classification?: unknown; sha256?: unknown;
  /** The reviewer explicitly chose to upload a file that matches an existing clip. */
  allowDuplicate?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** The value exactly as given (spaces included), for approved list values such as the stored activity "Payment " (with a trailing space). */
const exact = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const BRAND_ROLES = ['hero', 'incidental', 'client_product', 'unresolved'] as const;

/** Verifying a large file means reading it from R2 once; allow time for the biggest permitted file. */
export const maxDuration = 60;

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

  // Optional bulk fields. Categories are only ever LINKED here, never created: an id that does not exist is refused.
  const categoryIds = Array.isArray(body.categoryIds) ? [...new Set(body.categoryIds)] : [];
  if (categoryIds.length > 10 || categoryIds.some((c) => typeof c !== 'number' || !Number.isInteger(c) || c <= 0)) {
    return NextResponse.json({ error: 'categoryIds must be a short list of category ids.' }, { status: 400 });
  }
  if (categoryIds.length > 0) {
    const found = await db.select({ id: brollCategories.id }).from(brollCategories).where(inArray(brollCategories.id, categoryIds as number[]));
    if (found.length !== categoryIds.length) return NextResponse.json({ error: 'Unknown category. Categories are not created here; create it first and approve it separately.' }, { status: 422 });
  }
  const brandList: { name: string; role: (typeof BRAND_ROLES)[number] }[] = [];
  if (body.brands !== undefined) {
    if (!Array.isArray(body.brands) || body.brands.length > 10) return NextResponse.json({ error: 'brands must be a short list.' }, { status: 400 });
    for (const b of body.brands as { name?: unknown; role?: unknown }[]) {
      const name = str(b?.name);
      const role = (BRAND_ROLES as readonly unknown[]).includes(b?.role) ? (b.role as (typeof BRAND_ROLES)[number]) : null;
      if (!name || name.length > 60 || !role) return NextResponse.json({ error: 'Each brand needs a name (up to 60 characters) and a valid role.' }, { status: 400 });
      brandList.push({ name, role });
    }
  }
  const cls = (body.classification && typeof body.classification === 'object' ? body.classification : null) as { confidence?: unknown; flags?: unknown; review?: unknown } | null;
  const bulkFields = body.categoryIds !== undefined || body.brands !== undefined || body.classification !== undefined;
  const claimedSha = typeof body.sha256 === 'string' && /^[0-9a-f]{64}$/.test(body.sha256) ? body.sha256 : null;
  // The bulk uploader always verifies integrity: the checksum of the selected file is mandatory, whatever the file size.
  if (bulkFields && !claimedSha) return NextResponse.json({ error: 'sha256 (the checksum of the selected file) is required.' }, { status: 400 });

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

  // Integrity: R2's own bytes are streamed through SHA-256 (constant memory, any size up to the 500 MB limit) and must equal the
  // checksum of the file the reviewer selected. Nothing is recorded unless they match. A read that takes too long fails
  // clearly and can simply be retried; it never falls back to skipping the check.
  let verifiedSha: string | null = null;
  if (claimedSha) {
    try {
      const actual = await storage.hashFromR2('uploads', key);
      if (actual.size !== verdict.size) {
        return NextResponse.json({ error: 'The stored file changed while it was being verified. Please upload it again.' }, { status: 409 });
      }
      if (actual.sha256 !== claimedSha) {
        await discardIfUnreferenced(key);
        return NextResponse.json({ error: 'The stored file does not match the file that was selected (checksum differs). Please upload it again.' }, { status: 422 });
      }
      verifiedSha = actual.sha256;
    } catch (err) {
      const timedOut = (err as Error).name === 'HashTimeoutError';
      console.error('[broll/upload/complete] checksum check failed:', timedOut ? 'timed out' : (err as Error).message.slice(0, 120));
      return NextResponse.json(
        { error: timedOut ? 'Verifying the file took too long. Nothing was saved; please try again.' : 'Could not verify the upload. Please try again.', code: timedOut ? 'verification_timeout' : 'verification_failed' },
        { status: timedOut ? 504 : 502 },
      );
    }
  }

  // Registry first (insert-only: an existing row is never changed), so the clip never points at a file readers cannot find.
  try {
    await registerObjectIfAbsent({ bucket: 'uploads', key, provider: 'r2', sizeBytes: verdict.size, contentType: verdict.contentType, sha256: verifiedSha, verifiedAt: Date.now() });
  } catch (err) {
    console.error('[broll/upload/complete] registry write failed:', (err as Error).message);
    return NextResponse.json({ error: 'Could not record the upload. Please try again.' }, { status: 500 });
  }

  // Classification notes in the same format as every other clip (broll-classification/v1), only when the bulk fields are sent.
  let notes: string | null = null;
  let plannedBrands: ReturnType<typeof planBrandAssociations>['associations'] = [];
  if (cls || brandList.length > 0) {
    const entries: BrandEntry[] = brandList.filter((b) => b.role !== 'client_product').map((b) => ({ name: b.name, role: b.role as BrandEntry['role'], clearance: 'unresolved' }));
    const client = brandList.find((b) => b.role === 'client_product');
    const classification: ClipClassification = {
      clipId: key.split('/').pop()!.replace(/\.[^.]+$/, ''),
      confidence: typeof cls?.confidence === 'string' ? cls.confidence.slice(0, 20) : 'Manual decision',
      categories: [], removeTags: [], addTags: [],
      clientProduct: client ? { what: client.name, brandConfirmed: false } : undefined,
      brands: entries,
      flags: Array.isArray(cls?.flags) ? (cls!.flags as unknown[]).filter((f): f is string => typeof f === 'string').map((f) => f.slice(0, 60)).slice(0, 12) : [],
      review: typeof cls?.review === 'string' ? cls.review.slice(0, 600) : '',
    };
    notes = buildClassificationNotes(classification, key.split('/').pop()!);
    plannedBrands = planBrandAssociations(notes).associations;
  }

  const now = Date.now();
  // One completion at a time per file: a second, simultaneous request waits here and then finds the clip the first created.
  const clip: { row?: typeof brollClips.$inferSelect; created: boolean; duplicate?: { id: number; title: string } } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [again] = await tx.select().from(brollClips).where(and(eq(brollClips.storagePath, key))).limit(1);
    if (again) return { row: again, created: false };
    // An exact duplicate (same SHA-256) of a different existing clip is refused unless the reviewer chose "upload anyway".
    // The lock makes two identical files completing at the same moment see each other.
    if (verifiedSha && body.allowDuplicate !== true) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sha:${verifiedSha}`}))`);
      const [dup] = await tx.select({ id: brollClips.id, title: brollClips.title }).from(brollClips)
        .innerJoin(storageObjects, and(eq(storageObjects.key, brollClips.storagePath), eq(storageObjects.bucket, 'uploads')))
        .where(and(eq(storageObjects.sha256, verifiedSha), ne(brollClips.storagePath, key))).limit(1);
      if (dup) return { created: false, duplicate: dup };
    }
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
      // In the bulk flow these come from the approved lists, so they are saved exactly; the one-video form keeps its trimming.
      activity: bulkFields ? exact(body.activity) : str(body.activity),
      setting: bulkFields ? exact(body.setting) : str(body.setting),
      brand: str(body.brand),
      description: str(body.description),
      notes,
      processingStatus: 'completed',
      reviewStatus: 'unreviewed',
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (categoryIds.length > 0) {
      await tx.insert(brollClipCategories).values((categoryIds as number[]).map((categoryId) => ({ clipId: inserted.id, categoryId, createdAt: now }))).onConflictDoNothing();
    }
    if (plannedBrands.length > 0) {
      await tx.insert(brollClipBrands).values(plannedBrands.map((a) => ({ clipId: inserted.id, brandName: a.brandName, role: a.role, note: a.note, createdAt: now, updatedAt: now })));
    }
    return { row: inserted, created: true };
  });
  if (clip.duplicate) {
    // Our own brand-new object and registry row (created moments ago under a key nothing else uses) are removed again.
    await discardOwnUpload(key);
    return NextResponse.json({ error: `This file is identical to the existing clip “${clip.duplicate.title}”.`, code: 'duplicate', clipId: clip.duplicate.id, title: clip.duplicate.title }, { status: 409 });
  }
  return respondWithClip(clip.row!, clip.created ? 201 : 200);
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

/**
 * Removes an upload this request itself just created: its registry row and its R2 object, but only when no clip refers to the
 * key. Used when a verified file turns out to be an exact duplicate of an existing clip.
 */
async function discardOwnUpload(key: string): Promise<void> {
  try {
    if (await findClip(key)) return;
    await db.delete(storageObjects).where(and(eq(storageObjects.bucket, 'uploads'), eq(storageObjects.key, key), eq(storageObjects.provider, 'r2')));
    await getStorage().deleteFromR2('uploads', key);
  } catch (err) {
    console.warn('[broll/upload/complete] could not remove a duplicate upload:', (err as Error).message.slice(0, 120));
  }
}
