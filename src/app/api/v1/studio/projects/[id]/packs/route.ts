import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId } from '@/lib/studio/api';
import { approvePacks, listProjectPacks } from '@/lib/studio/approvals';
import { StudioError } from '@/lib/studio/repository';

// The packs this project has approved, with how many images each holds and how many are selected.
export const GET = studioRoute<{ id: string }>(async ({ params }) => {
  return NextResponse.json({ packs: await listProjectPacks(parseId(params.id)) });
});

// Approves one or more packs: { packIds: [1, 2] }. Any pack can be approved, recommended or not.
export const POST = studioRoute<{ id: string }>(async ({ req, params, user }) => {
  const body = await readJson(req);
  const ids = Array.isArray(body.packIds) ? body.packIds : [];
  if (!ids.every((v) => typeof v === 'number' && Number.isInteger(v) && v > 0)) throw new StudioError('packIds must be a list of pack ids.', 400, 'invalid_ids');
  const projectId = parseId(params.id);
  const result = await approvePacks(projectId, ids as number[], user.id);
  return NextResponse.json({ ...result, packs: await listProjectPacks(projectId) });
});
