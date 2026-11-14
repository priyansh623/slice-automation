import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips, storageObjects } from '@/db/schema.pg';
import { requireUser } from '@/lib/api-auth';

/**
 * Looks for clips already in the library that match files in a batch. Read-only.
 *  - library_exact: an uploaded B-roll object with the same SHA-256 in the storage registry.
 *  - library_same_size: a clip with exactly the same byte size whose checksum was never recorded (older uploads), so the
 *    match is a warning, not proof.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;

  let body: { items?: { sha256?: unknown; size?: unknown }[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0 || items.length > 200) return NextResponse.json({ error: 'Send between 1 and 200 items.' }, { status: 400 });
  const clean = items.map((i) => ({
    sha256: typeof i.sha256 === 'string' && /^[0-9a-f]{64}$/.test(i.sha256) ? i.sha256 : null,
    size: typeof i.size === 'number' && Number.isInteger(i.size) && i.size > 0 ? i.size : null,
  }));

  const shas = [...new Set(clean.map((c) => c.sha256).filter((s): s is string => !!s))];
  const sizes = [...new Set(clean.map((c) => c.size).filter((s): s is number => !!s))];

  const exactRows = shas.length
    ? await db.select({ sha256: storageObjects.sha256, clipId: brollClips.id, title: brollClips.title })
        .from(storageObjects).innerJoin(brollClips, eq(brollClips.storagePath, storageObjects.key))
        .where(and(eq(storageObjects.bucket, 'uploads'), inArray(storageObjects.sha256, shas)))
    : [];
  const sizeRows = sizes.length
    ? await db.select({ size: brollClips.fileSizeBytes, clipId: brollClips.id, title: brollClips.title, shaKnown: storageObjects.sha256 })
        .from(brollClips).leftJoin(storageObjects, and(eq(storageObjects.key, brollClips.storagePath), eq(storageObjects.bucket, 'uploads')))
        .where(inArray(brollClips.fileSizeBytes, sizes))
    : [];

  const results = clean.map((c) => {
    const matches: { kind: 'library_exact' | 'library_same_size'; clipId: number; title: string }[] = [];
    if (c.sha256) for (const r of exactRows) if (r.sha256 === c.sha256) matches.push({ kind: 'library_exact', clipId: r.clipId, title: r.title });
    if (c.size && matches.length === 0) for (const r of sizeRows) if (r.size === c.size && !r.shaKnown) matches.push({ kind: 'library_same_size', clipId: r.clipId, title: r.title });
    return { matches };
  });
  return NextResponse.json({ results }, { headers: { 'Cache-Control': 'no-store' } });
}
