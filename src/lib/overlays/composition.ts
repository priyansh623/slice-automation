/** Everything the Composition page needs in one read: the Flow scenes with playable clips, the overlays with playable (silent) clips, and the Character B-roll items. */
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { brollClips, videoGenerations, videoProjects, videoScreens } from '@/db/schema.pg';
import { getStorage } from '@/lib/object-store';
import { generationReadiness } from '@/lib/studio/readiness';
import { listItems } from './character';
import { videoGenerationReadiness } from './readiness';
import { listOverlays, overlayLimit } from './service';

const URL_TTL_S = 3600;

export async function loadComposition(projectId: number) {
  const [project] = await db.select({ id: videoProjects.id, name: videoProjects.name }).from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  const screens = await db.select().from(videoScreens).where(and(eq(videoScreens.videoProjectId, projectId), gt(videoScreens.screenNumber, 0))).orderBy(asc(videoScreens.position));
  const screenIds = screens.map((s) => s.id);
  const gens = screenIds.length ? await db.select().from(videoGenerations).where(inArray(videoGenerations.videoScreenId, screenIds)).orderBy(desc(videoGenerations.id)) : [];
  const chosen = new Map<number, (typeof gens)[number]>();
  for (const s of screens) {
    const pick = (s.approvedGenerationId ? gens.find((g) => g.id === s.approvedGenerationId) : undefined) ?? gens.find((g) => g.videoScreenId === s.id && g.status === 'completed' && g.videoStoragePath);
    if (pick) chosen.set(s.id, pick);
  }
  const { overlays, scenes: spans, totalMs, limit } = await listOverlays(projectId);
  const clipIds = overlays.map((o) => o.brollClipId).filter((v): v is number => v != null);
  const titles = clipIds.length ? await db.select({ id: brollClips.id, title: brollClips.title }).from(brollClips).where(inArray(brollClips.id, clipIds)) : [];
  const titleOf = new Map(titles.map((t) => [t.id, t.title]));

  const storage = getStorage();
  const keys = [...[...chosen.values()].map((g) => g.videoStoragePath), ...overlays.map((o) => o.assetStoragePath)].filter((k): k is string => !!k);
  const signed = keys.length ? await storage.signedReadUrls('videos', keys, URL_TTL_S).catch(() => new Map<string, string>()) : new Map<string, string>();
  const spanById = new Map(spans.map((s) => [s.screenId, s]));
  const sceneRows = screens.map((s) => {
    const g = chosen.get(s.id); const span = spanById.get(s.id);
    return { screenId: s.id, sceneNumber: s.screenNumber, dialogue: s.dialogue, generationId: g?.id ?? null, clipUrl: g?.videoStoragePath ? signed.get(g.videoStoragePath) ?? null : null, startMs: span?.startMs ?? 0, durationMs: span?.durationMs ?? 0, lengthKnown: span?.lengthKnown ?? false, approved: !!s.approvedGenerationId };
  });
  const readiness = await generationReadiness().catch(() => null);
  return {
    enabled: true as const,
    project, scenes: sceneRows, totalMs, limit: limit ?? overlayLimit(),
    overlays: overlays.map((o) => ({ ...o, title: o.kind === 'generic' ? titleOf.get(o.brollClipId ?? -1) ?? 'Library clip' : 'Character B-roll', assetUrl: o.assetStoragePath ? signed.get(o.assetStoragePath) ?? null : null })),
    items: await listItems(projectId),
    videoGeneration: await videoGenerationReadiness().catch(() => ({ ready: false, provider: null, message: 'Video generation status is unavailable.' })),
    imageGeneration: readiness ? { ready: readiness.ready, provider: readiness.config.provider ?? null, message: readiness.message } : { ready: false, provider: null, message: 'Image generation status is unavailable.' },
  };
}
