import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId, serializeSelection } from '@/lib/studio/api';
import { addToSelection, listSelection, removeFromSelection } from '@/lib/studio/selection';

// The project's ONE shared selection across all its approved packs, each image with its original pack.
export const GET = studioRoute<{ id: string }>(async ({ params }) => {
  return NextResponse.json({ selection: await serializeSelection(await listSelection(parseId(params.id))) });
});

// Adds images: { assetIds: [1, 2] }. Each must be in a pack this project approved and not archived.
export const POST = studioRoute<{ id: string }>(async ({ req, params, user }) => {
  const projectId = parseId(params.id);
  const body = await readJson(req);
  const result = await addToSelection(projectId, body.assetIds, user.id);
  return NextResponse.json({ ...result, selection: await serializeSelection(await listSelection(projectId)) });
});

// Removes images: { assetIds: [1] }, or everything when no ids are sent.
export const DELETE = studioRoute<{ id: string }>(async ({ req, params }) => {
  const projectId = parseId(params.id);
  const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
  const removed = await removeFromSelection(projectId, body.assetIds);
  return NextResponse.json({ removed, selection: await serializeSelection(await listSelection(projectId)) });
});
