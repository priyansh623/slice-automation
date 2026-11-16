import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId, serializeAssets } from '@/lib/studio/api';
import { editMetadata, StudioError } from '@/lib/studio/repository';
import { parseManualPatch } from '@/lib/studio/metadata';

// Saves a person's edit: { fields: { environment: "...", lighting: null }, revert: ["tags"] }. A value sets the field, null
// clears it on purpose, revert gives it back to the AI value. Only the manual part changes; re-analysis never undoes it.
export const PUT = studioRoute<{ id: string }>(async ({ req, params, user }) => {
  const parsed = parseManualPatch(await readJson(req));
  if (!parsed.ok) throw new StudioError(parsed.error, 400, 'invalid_metadata');
  const [asset] = await serializeAssets([await editMetadata(parseId(params.id), parsed.patch, user.id)], { full: true });
  return NextResponse.json({ asset });
});
