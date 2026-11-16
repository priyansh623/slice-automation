import { NextRequest, NextResponse } from 'next/server';
import { requireUser, type AuthUser } from '@/lib/api-auth';
import { StudioError, type AssetView } from './repository';
import { signKeys } from './image-store';
import { effectiveMetadata } from './metadata';
import { importInfoOf } from './import-info';
import { characterThumbKey } from './keys';
import { isTestProvider } from './mock-provider';

/**
 * Every Character B-roll Studio route goes through this: a signed-in user is required, and that is the whole rule. There is
 * no ownership, role or admin check: the Studio is a shared workspace, so any authenticated user can manage any pack,
 * image or project. Unauthenticated requests get 401 and never reach the handler.
 */
export function studioRoute<P extends Record<string, string> = Record<string, never>>(
  handler: (ctx: { req: NextRequest; user: AuthUser; params: P }) => Promise<NextResponse>,
) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<NextResponse> => {
    const auth = await requireUser();
    if (auth instanceof NextResponse) return auth;
    try {
      return await handler({ req, user: auth.user, params: await ctx.params });
    } catch (err) {
      if (err instanceof StudioError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
      console.error('[studio] unexpected error:', err instanceof Error ? err.message : err);
      return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
    }
  };
}

export function parseId(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new StudioError('Invalid id.', 400, 'invalid_id');
  return n;
}

/**
 * A page-size query parameter: absent means "use the default", anything else must be a whole number of at least 1 (the library
 * then caps it). "abc", "0", "-3" and "1.5" are refused with a clear error instead of silently becoming something else.
 */
export function parseLimit(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new StudioError('limit must be a whole number of at least 1.', 400, 'invalid_limit');
  return Number(raw);
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    throw new StudioError('Invalid JSON body.', 400, 'invalid_json');
  }
}

/**
 * The shape every image has in API responses: the record, both kinds of metadata, the effective value with its source, and signed
 * URLs. A list only signs each image's small thumbnail (a grid of 200 cards is 200 URLs, not 400, and no original is fetched);
 * the full-size original is signed only for a single image (`full`), which is what the detail view asks for.
 */
export async function serializeAssets(views: AssetView[], opts: { full?: boolean } = {}) {
  const urls = await signKeys(views.flatMap((v) => (opts.full ? [v.asset.thumbKey ?? v.asset.storageKey, v.asset.storageKey] : [v.asset.thumbKey ?? v.asset.storageKey])));
  return views.map((v) => ({
    id: v.asset.id,
    packId: v.asset.packId,
    originalFilename: v.asset.originalFilename,
    mime: v.asset.mime,
    sizeBytes: v.asset.sizeBytes,
    width: v.asset.width,
    height: v.asset.height,
    sha256: v.asset.sha256,
    analysisStatus: v.asset.analysisStatus,
    analysisError: v.asset.analysisError,
    archived: v.asset.archivedAt !== null,
    archivedAt: v.asset.archivedAt,
    createdAt: v.asset.createdAt,
    thumbUrl: urls.get(v.asset.thumbKey ?? v.asset.storageKey) ?? null,
    imageUrl: opts.full ? (urls.get(v.asset.storageKey) ?? null) : null,
    ai: v.ai,
    manual: v.manual,
    aiAnalyzedAt: v.aiAnalyzedAt,
    metadata: v.metadata.values,
    provenance: v.metadata.provenance,
    hasManualEdits: v.metadata.hasManualEdits,
    importKey: v.asset.importKey,
    importInfo: importInfoOf(v.imported),
  }));
}

/** The selection as the API returns it: each image with the pack it came from (kept from selection time) and archived state. */
export async function serializeSelection(items: import('./selection').SelectionItem[]) {
  const views = await serializeAssets(items.map((i) => ({ asset: i.asset, ai: null, manual: {}, imported: {}, metadata: effectiveMetadata(null, null), aiAnalyzedAt: null })));
  return items.map((i, n) => ({ assetId: i.assetId, packId: i.packId, packName: i.packName, addedAt: i.addedAt, archived: i.archived, image: { id: views[n].id, importKey: views[n].importKey ?? null, thumbUrl: views[n].thumbUrl, imageUrl: views[n].imageUrl, originalFilename: views[n].originalFilename, width: views[n].width, height: views[n].height } }));
}

/** A job as the API returns it, with its image and its outputs (signed URLs). */
export async function serializeJobs(views: import('./batches').JobView[]) {
  // Thumbnails only: this list is refreshed every few seconds while jobs run, so it never signs a full-size image.
  const keys = views.flatMap((v) => [v.asset.thumbKey ?? v.asset.storageKey, ...v.outputs.map((o) => o.thumbKey ?? o.storageKey)]);
  const urls = await signKeys(keys);
  return views.map((v) => ({
    id: v.job.id, batchId: v.job.batchId, assetId: v.job.assetId, packId: v.job.packId, attempt: v.job.attempt, retryOfJobId: v.job.retryOfJobId,
    status: v.job.status, provider: v.job.provider, isTest: isTestProvider(v.job.provider), providerJobId: v.job.providerJobId,
    error: v.job.status === 'failed' || v.job.status === 'submit_unknown' ? { code: v.job.errorCode, message: v.job.errorMessage, retryable: v.job.errorRetryable } : null,
    createdAt: v.job.createdAt, startedAt: v.job.startedAt, finishedAt: v.job.finishedAt,
    source: { thumbUrl: urls.get(v.asset.thumbKey ?? v.asset.storageKey) ?? null, originalFilename: v.asset.originalFilename, importKey: v.asset.importKey ?? null, archived: v.asset.archivedAt !== null },
    outputs: v.outputs.map((o) => ({ id: o.id, thumbUrl: urls.get(o.thumbKey ?? o.storageKey) ?? null, imageUrl: null, width: o.width, height: o.height, reviewStatus: o.reviewStatus, createdAt: o.createdAt })),
  }));
}

/** An output with everything linked to it, and signed URLs for the image, its thumbnail, the source image and the character. */
export async function serializeOutputs(views: import('./outputs').OutputView[], opts: { full?: boolean } = {}) {
  // Thumbnails for the list (the character's small copy, not the original); the full-size image only for a single output (`full`).
  const keys = views.flatMap((v) => [v.output.thumbKey ?? v.output.storageKey, ...(opts.full ? [v.output.storageKey] : []), v.asset.thumbKey ?? v.asset.storageKey, characterThumbKey(v.batch.characterKey) ?? '']);
  const urls = await signKeys(keys);
  return views.map((v) => ({
    id: v.output.id, projectId: v.output.projectId, reviewStatus: v.output.reviewStatus, reviewedBy: v.output.reviewedBy, reviewedAt: v.output.reviewedAt, createdAt: v.output.createdAt,
    width: v.output.width, height: v.output.height, sizeBytes: v.output.sizeBytes, isTest: isTestProvider(v.job.provider),
    thumbUrl: urls.get(v.output.thumbKey ?? v.output.storageKey) ?? null, imageUrl: opts.full ? (urls.get(v.output.storageKey) ?? null) : null,
    job: { id: v.job.id, attempt: v.job.attempt, retryOfJobId: v.job.retryOfJobId, status: v.job.status, providerJobId: v.job.providerJobId, provider: v.job.provider },
    batch: { id: v.batch.id, createdAt: v.batch.createdAt, createdBy: v.batch.createdBy },
    source: { assetId: v.asset.id, packId: v.asset.packId, packName: v.packName, originalFilename: v.asset.originalFilename, importKey: v.asset.importKey ?? null, thumbUrl: urls.get(v.asset.thumbKey ?? v.asset.storageKey) ?? null, archived: v.asset.archivedAt !== null },
    character: { thumbUrl: urls.get(characterThumbKey(v.batch.characterKey) ?? '') ?? null },
  }));
}
