import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId } from '@/lib/studio/api';
import { getPack, listPacks, updatePack } from '@/lib/studio/repository';

export const GET = studioRoute<{ id: string }>(async ({ params }) => {
  const id = parseId(params.id);
  await getPack(id);
  const summary = (await listPacks({ includeArchived: true })).find((p) => p.id === id);
  return NextResponse.json({ pack: summary });
});

export const PUT = studioRoute<{ id: string }>(async ({ req, params }) => {
  const body = await readJson(req);
  const pack = await updatePack(parseId(params.id), { name: body.name, description: body.description });
  return NextResponse.json({ pack });
});
