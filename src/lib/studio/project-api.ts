import { inArray } from 'drizzle-orm';
import { db } from '@/db';
import { studioPacks } from '@/db/schema.pg';
import { characterThumbKey } from './keys';
import { signKeys } from './image-store';
import { recommendationsAreCurrent, type ProjectRow } from './projects';
import type { Recommendation } from './recommend';

/** A project as the API returns it: signed character URLs and the recommendations with their pack names. */
export async function serializeProject(p: ProjectRow) {
  const thumb = p.characterKey ? characterThumbKey(p.characterKey) : null;
  const urls = await signKeys([p.characterKey, thumb].filter((k): k is string => !!k));
  const recs = (p.recommendations as Recommendation[] | null) ?? [];
  const packs = recs.length ? await db.select({ id: studioPacks.id, name: studioPacks.name, description: studioPacks.description, archivedAt: studioPacks.archivedAt }).from(studioPacks).where(inArray(studioPacks.id, recs.map((r) => r.packId))) : [];
  const byId = new Map(packs.map((x) => [x.id, x]));
  return {
    id: p.id, name: p.name, script: p.script, createdBy: p.createdBy, archived: p.archivedAt !== null, createdAt: p.createdAt, updatedAt: p.updatedAt,
    characterUrl: p.characterKey ? (urls.get(p.characterKey) ?? null) : null,
    characterThumbUrl: p.characterKey ? (urls.get(thumb ?? '') ?? urls.get(p.characterKey) ?? null) : null,
    hasCharacter: p.characterKey !== null,
    analysis: { status: p.analysisStatus, error: p.analysisError, at: p.analysisAt, current: recommendationsAreCurrent(p) },
    recommendations: recs.map((r) => ({ ...r, name: byId.get(r.packId)?.name ?? `Pack ${r.packId}`, description: byId.get(r.packId)?.description ?? null, packArchived: byId.get(r.packId)?.archivedAt != null })),
  };
}
