import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId } from '@/lib/studio/api';
import { completeCharacterUpload } from '@/lib/studio/character';
import { serializeProject } from '@/lib/studio/project-api';

export const maxDuration = 60;

// Step 3: verifies what R2 holds, then makes this image the project's character (the previous one stays in R2 untouched).
export const POST = studioRoute<{ id: string }>(async ({ req, params }) => {
  const body = await readJson(req);
  const project = await completeCharacterUpload(parseId(params.id), { storageKey: body.storageKey, contentType: body.contentType, fileSize: body.fileSize });
  return NextResponse.json({ project: await serializeProject(project, { full: true }) });
});
