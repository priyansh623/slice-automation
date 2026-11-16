/** Browser-side helpers for the Scene Pack Repository and the Studio: typed fetches, and the direct-to-R2 upload flow. */

export interface StudioPack {
  id: number; name: string; description: string | null; archivedAt: number | null;
  assetCount: number; analysisPending: number; analysisFailed: number;
}

export type MetaKey = 'environment' | 'activity' | 'objects_props' | 'camera_angle' | 'framing' | 'character_position' | 'lighting' | 'composition' | 'description' | 'tags';
export type Provenance = 'manual' | 'ai' | 'none';

export interface StudioAsset {
  id: number; packId: number; originalFilename: string | null; mime: string; sizeBytes: number; width: number | null; height: number | null;
  analysisStatus: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'; analysisError: string | null;
  archived: boolean; archivedAt: number | null; createdAt: number;
  thumbUrl: string | null; imageUrl: string | null;
  ai: Partial<Record<MetaKey, string | string[] | null>> | null;
  manual: Partial<Record<MetaKey, string | string[] | null>>;
  metadata: Record<string, string | string[] | null>;
  provenance: Record<MetaKey, Provenance>;
  hasManualEdits: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
  });
  const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.code);
  return data as T;
}

/** Runs `worker` over `items` with at most `limit` in flight at once. One failure never stops the others. */
export async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; try { await worker(item); } catch { /* the worker records its own failure */ } }
  }));
}

export interface UploadResult { asset: StudioAsset; created: boolean; duplicate: boolean }

/** init (server picks the key) -> PUT straight to R2 -> complete (server verifies, creates the image, queues analysis). */
export async function uploadImage(packId: number, file: File, ingestGroup: string): Promise<UploadResult> {
  const init = await api<{ storageKey: string; uploadUrl: string; headers: Record<string, string> }>(`/api/v1/studio/packs/${packId}/assets/init`, {
    method: 'POST', body: { contentType: file.type, fileSize: file.size, fileName: file.name },
  });
  let put: Response;
  try {
    put = await fetch(init.uploadUrl, { method: 'PUT', headers: init.headers, body: file });
  } catch {
    throw new Error('The upload to storage was blocked. If this keeps happening, the storage bucket may not allow uploads from this site (CORS).');
  }
  if (!put.ok) throw new Error(`The upload to storage failed (${put.status}).`);
  return api<UploadResult>(`/api/v1/studio/packs/${packId}/assets/complete`, {
    method: 'POST', body: { storageKey: init.storageKey, contentType: file.type, fileSize: file.size, fileName: file.name, ingestGroup },
  });
}

export const newGroupId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `g${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

export const FIELD_LABELS: Record<MetaKey, string> = {
  environment: 'Environment', activity: 'Activity', objects_props: 'Objects and props', camera_angle: 'Camera angle', framing: 'Framing',
  character_position: 'Character position', lighting: 'Lighting', composition: 'Composition', description: 'Description', tags: 'Tags',
};
export const FIELD_ORDER: MetaKey[] = ['description', 'environment', 'activity', 'objects_props', 'camera_angle', 'framing', 'character_position', 'lighting', 'composition', 'tags'];

// ── Studio projects ──────────────────────────────────────────────────────────

export interface StudioRecommendation { packId: number; name: string; description: string | null; packArchived: boolean; score: number; reasons: string[]; moments: string[] }
export interface StudioProject {
  id: number; name: string; script: string; createdBy: string; archived: boolean; createdAt: number; updatedAt: number;
  hasCharacter: boolean; characterUrl: string | null; characterThumbUrl: string | null;
  analysis: { status: 'idle' | 'processing' | 'completed' | 'failed'; error: string | null; at: number | null; current: boolean };
  recommendations: StudioRecommendation[];
  approvedPackCount?: number;
}
export interface ApprovedPack { packId: number; name: string; description: string | null; packArchived: boolean; source: string; approvedAt: number; activeAssetCount: number; newSinceApproval: number; selectedCount: number }

/** Uploads the project's one base character image straight to R2 (init -> PUT -> complete). */
export async function uploadCharacter(projectId: number, file: File): Promise<StudioProject> {
  const init = await api<{ storageKey: string; uploadUrl: string; headers: Record<string, string> }>(`/api/v1/studio/projects/${projectId}/character/init`, {
    method: 'POST', body: { contentType: file.type, fileSize: file.size, fileName: file.name },
  });
  let put: Response;
  try { put = await fetch(init.uploadUrl, { method: 'PUT', headers: init.headers, body: file }); }
  catch { throw new Error('The upload to storage was blocked. If this keeps happening, the storage bucket may not allow uploads from this site (CORS).'); }
  if (!put.ok) throw new Error(`The upload to storage failed (${put.status}).`);
  return (await api<{ project: StudioProject }>(`/api/v1/studio/projects/${projectId}/character/complete`, {
    method: 'POST', body: { storageKey: init.storageKey, contentType: file.type, fileSize: file.size },
  })).project;
}

// ── Selection, batches, outputs ──────────────────────────────────────────────

export interface SelectionRow { assetId: number; packId: number; packName: string; archived: boolean; addedAt: number; image: { id: number; thumbUrl: string | null; imageUrl: string | null; originalFilename: string | null; width: number | null; height: number | null } }
export interface JobOutput { id: number; thumbUrl: string | null; imageUrl: string | null; width: number | null; height: number | null; reviewStatus: 'pending' | 'saved' | 'rejected'; createdAt: number }
export interface JobRow {
  id: number; batchId: number; assetId: number; packId: number; attempt: number; retryOfJobId: number | null;
  status: 'queued' | 'submitting' | 'submit_unknown' | 'processing' | 'succeeded' | 'failed' | 'canceled'; provider: string; isTest: boolean; providerJobId: string | null;
  error: { code: string | null; message: string | null; retryable: boolean | null } | null;
  createdAt: number; startedAt: number | null; finishedAt: number | null;
  source: { thumbUrl: string | null; originalFilename: string | null; archived: boolean };
  outputs: JobOutput[];
}
export interface BatchSummary { total: number; queued: number; submitting: number; submit_unknown: number; processing: number; succeeded: number; failed: number; canceled: number }
export interface BatchListItem { id: number; provider: string; totalJobs: number; createdAt: number; createdBy: string; summary: BatchSummary }
export interface OutputRow {
  id: number; projectId: number; reviewStatus: 'pending' | 'saved' | 'rejected'; reviewedBy: string | null; reviewedAt: number | null; createdAt: number;
  width: number | null; height: number | null; thumbUrl: string | null; imageUrl: string | null;
  /** True when the image came from the test (mock) provider: it is a placeholder, never a real result. */
  isTest: boolean;
  job: { id: number; attempt: number; retryOfJobId: number | null; status: string; providerJobId: string | null; provider: string };
  batch: { id: number; createdAt: number; createdBy: string };
  source: { assetId: number; packId: number; packName: string; originalFilename: string | null; thumbUrl: string | null; archived: boolean };
  character: { thumbUrl: string | null };
}
export const isActiveBatch = (s: BatchSummary): boolean => s.queued + s.submitting + s.submit_unknown + s.processing > 0;

export interface GenerationConfig {
  enabled: boolean; mode: 'disabled' | 'mock' | 'real'; provider: string | null; testMode: boolean; reason: string | null;
  /** True only when a provider is set AND a worker that uses the same provider is running and ready. */
  ready: boolean; code: string | null; message: string | null;
  worker: { status: 'ok' | 'no_worker' | 'provider_mismatch' | 'not_ready'; providers: Array<string | null> } | null;
}
