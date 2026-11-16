import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId } from '@/lib/studio/api';
import { prepareUpload } from '@/lib/studio/ingest';

// Step 1 of adding an image: the server chooses the R2 key and returns a short-lived presigned PUT. Nothing is recorded yet.
export const POST = studioRoute<{ id: string }>(async ({ req, params, user }) => {
  const body = await readJson(req);
  const upload = await prepareUpload(parseId(params.id), { contentType: body.contentType, fileSize: body.fileSize, fileName: body.fileName }, user.id);
  return NextResponse.json(upload, { headers: { 'Cache-Control': 'no-store' } });
});
