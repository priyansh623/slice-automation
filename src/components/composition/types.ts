import type { UiScene } from '@/lib/overlays/ui-math';

export interface CompScene extends UiScene { dialogue: string; generationId: number | null; lengthKnown: boolean; approved: boolean }
export interface CompOverlay {
  id: number; kind: 'generic' | 'character'; track: number; anchorScreenId: number; anchorSceneNumber: number | null;
  startOffsetMs: number; durationMs: number; sourceStartMs: number; status: 'preparing' | 'ready' | 'failed'; errorMessage: string | null;
  placementSource: 'auto' | 'manual';
  startMs: number | null; endMs: number | null; needsAttention: boolean; attentionReason: string | null;
  assetUrl: string | null; assetDurationMs: number | null; title: string; brollClipId: number | null; characterItemId: number | null;
  problems: Array<{ code: string; message: string }>;
}
export interface CompItem {
  id: number; studioAssetId: number; intendedAction: string; imageStatus: 'pending' | 'generating' | 'ready' | 'approved' | 'rejected' | 'failed'; imageError: string | null; imageUrl: string | null;
  fullImageUrl: string | null; imageWidth: number | null; imageHeight: number | null; imageJobStatus: string | null; imageJobCreatedAt: number | null; imageNote: string | null;
  motionPrompt: string | null; promptEdited: boolean;
  clipStatus: 'not_started' | 'queued' | 'submitting' | 'submit_unknown' | 'processing' | 'ready' | 'failed'; clipErrorCode: string | null; clipErrorMessage: string | null; clipRetryable: boolean | null;
  clipProvider: string | null; clipEndpoint: string | null; clipDurationMs: number | null; clipWidth: number | null; clipHeight: number | null; clipUrl: string | null;
}
export interface FillResult { created: number; moved: number; unplaced: number; sceneMissing: number; waiting: number }
export interface Composition {
  enabled: true; project: { id: number; name: string | null }; scenes: CompScene[]; totalMs: number; limit: number;
  overlays: CompOverlay[]; items: CompItem[]; imageGeneration: { ready: boolean; provider: string | null; message: string | null };
  videoGeneration: { ready: boolean; provider: string | null; message: string | null };
}

export const C = { primary: '#6C47FF', border: '#ECECE8', borderStrong: '#E4E4E0', text: '#111113', muted: '#75757C', soft: '#F6F6F3', danger: '#C0392B', ok: '#1F7A4D', warn: '#9A6B00', generic: '#3B82F6', character: '#C2410C' } as const;

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T & { error?: string; code?: string } }> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return { ok: res.ok, status: res.status, data };
}
export const post = (url: string, body?: unknown) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
export const patch = (url: string, body: unknown) => api(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
