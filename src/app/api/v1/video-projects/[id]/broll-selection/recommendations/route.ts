import { NextRequest, NextResponse } from 'next/server';
import { inArray } from 'drizzle-orm';
import { db } from '@/db';
import { studioPacks, videoProjects } from '@/db/schema.pg';
import { eq } from 'drizzle-orm';
import { ensureStudioProject } from '@/lib/overlays/character';
import { overlayErrorResponse, overlayGuard } from '@/lib/overlays/route-helpers';
import { analyseProjectScript, type Recommendation } from '@/lib/studio/recommend';
import { updateProject } from '@/lib/studio/projects';
import { StudioError } from '@/lib/studio/repository';

export const maxDuration = 60;

// Scene Pack recommendations for this project's script, from the EXISTING Studio recommender (one model call, only when asked; the stored
// result is returned while the script is unchanged). Recommendations never select anything and never start a job.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const g = await overlayGuard(params);
  if (g instanceof NextResponse) return g;
  try {
    const [p] = await db.select({ approved: videoProjects.approvedScript, original: videoProjects.originalScript }).from(videoProjects).where(eq(videoProjects.id, g.projectId)).limit(1);
    const studioId = await ensureStudioProject(g.projectId, g.user.id);
    await updateProject(studioId, { script: (p?.approved ?? p?.original ?? '').slice(0, 50_000) });
    const project = await analyseProjectScript(studioId);
    const recs = ((project.recommendations ?? []) as Recommendation[]);
    const packs = recs.length ? await db.select({ id: studioPacks.id, name: studioPacks.name }).from(studioPacks).where(inArray(studioPacks.id, recs.map((r) => r.packId))) : [];
    const name = new Map(packs.map((x) => [x.id, x.name]));
    return NextResponse.json({ recommendations: recs.map((r) => ({ ...r, name: name.get(r.packId) ?? `Pack ${r.packId}` })) });
  } catch (err) {
    if (err instanceof StudioError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    return overlayErrorResponse(err);
  }
}
