import { NextResponse } from 'next/server';
import { studioRoute, parseId } from '@/lib/studio/api';
import { listProjectPacks, revokePack } from '@/lib/studio/approvals';

// Removes a pack's approval. Refused (409) while any of its images is still selected; history is never touched.
export const DELETE = studioRoute<{ id: string; packId: string }>(async ({ params }) => {
  const projectId = parseId(params.id);
  await revokePack(projectId, parseId(params.packId));
  return NextResponse.json({ packs: await listProjectPacks(projectId) });
});
