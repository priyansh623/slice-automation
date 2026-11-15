import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId } from '@/lib/studio/api';
import { prepareCharacterUpload } from '@/lib/studio/character';

// Step 1 of uploading the project's base character image: the server chooses the R2 key and returns a presigned PUT.
export const POST = studioRoute<{ id: string }>(async ({ req, params }) => {
  const body = await readJson(req);
  const upload = await prepareCharacterUpload(parseId(params.id), { contentType: body.contentType, fileSize: body.fileSize, fileName: body.fileName });
  return NextResponse.json(upload, { headers: { 'Cache-Control': 'no-store' } });
});
