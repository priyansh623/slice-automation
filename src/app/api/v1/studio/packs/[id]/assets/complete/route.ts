import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId, serializeAssets } from '@/lib/studio/api';
import { completeUpload } from '@/lib/studio/ingest';
import { getAssetView } from '@/lib/studio/repository';

/** Verifying an upload reads it from R2 once; allow time for the largest permitted image. */
export const maxDuration = 60;

// Step 3 of adding an image: the browser says it finished; the server checks what R2 really holds, then creates the image
// (analysis is queued for the worker). Repeating it for the same upload returns the same image.
export const POST = studioRoute<{ id: string }>(async ({ req, params, user }) => {
  const body = await readJson(req);
  const result = await completeUpload({
    packId: parseId(params.id), storageKey: body.storageKey, contentType: body.contentType, fileSize: body.fileSize, fileName: body.fileName, ingestGroup: body.ingestGroup,
  }, user.id);
  const [asset] = await serializeAssets([await getAssetView(result.asset.id)], { full: true });
  return NextResponse.json({ asset, created: result.created, duplicate: result.duplicate }, { status: result.created ? 201 : 200 });
});
