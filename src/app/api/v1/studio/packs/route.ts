import { NextResponse } from 'next/server';
import { studioRoute, readJson } from '@/lib/studio/api';
import { createPack, listPacks } from '@/lib/studio/repository';

// Every pack with its image count and analysis progress. ?includeArchived=1 also lists archived packs.
export const GET = studioRoute(async ({ req }) => {
  const packs = await listPacks({ includeArchived: req.nextUrl.searchParams.get('includeArchived') === '1' });
  return NextResponse.json({ packs });
});

export const POST = studioRoute(async ({ req, user }) => {
  const body = await readJson(req);
  const pack = await createPack({ name: body.name, description: body.description }, user.id);
  return NextResponse.json({ pack }, { status: 201 });
});
