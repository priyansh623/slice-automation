import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId, serializeOutputs } from '@/lib/studio/api';
import { reviewOutput } from '@/lib/studio/outputs';

// Saves ({ status: "saved" }), rejects ({ status: "rejected" }) or resets ({ status: "pending" }) an output. Nothing is deleted.
export const POST = studioRoute<{ id: string }>(async ({ req, params, user }) => {
  const body = await readJson(req);
  const view = await reviewOutput(parseId(params.id), body.status, user.id);
  return NextResponse.json({ output: (await serializeOutputs([view], { full: true }))[0] });
});
