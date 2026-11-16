import { NextResponse } from 'next/server';
import { studioRoute, readJson, parseId } from '@/lib/studio/api';
import { analyseProjectScript } from '@/lib/studio/recommend';
import { serializeProject } from '@/lib/studio/project-api';

/** One attempt may take 40 s; the platform allows 60. */
export const maxDuration = 60;

// Analyses the whole script and recommends Scene Packs, with reasons. Returns the stored result if the script has not changed
// (send { force: true } to analyse again). Recommendations never limit what can be approved.
export const POST = studioRoute<{ id: string }>(async ({ req, params }) => {
  const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
  const project = await analyseProjectScript(parseId(params.id), { force: body.force === true });
  return NextResponse.json({ project: await serializeProject(project, { full: true }) });
});
