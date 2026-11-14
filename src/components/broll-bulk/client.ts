'use client';
/**
 * Browser-side helpers for the bulk upload: reading a video without loading it into memory, and talking to the API.
 * The video itself is only ever opened through an object URL (the browser streams it); frames are small JPEGs.
 */
import { redactForStorage, type Suggestion } from '@/lib/broll-bulk/analysis-schema';
import type { Taxonomy } from '@/lib/broll-bulk/taxonomy';
import type { CompletePayload } from '@/lib/broll-bulk/batch';
import { readSession, type Session } from '@/lib/broll-bulk/session';

export interface VideoInspection { width: number; height: number; durationSeconds: number; thumbnail: string; frames: string[] }

const FRAME_POSITIONS = [0.08, 0.3, 0.55, 0.8];
const MAX_EDGE = 640;

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { video.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { video.removeEventListener('seeked', done); reject(new Error('Timed out reading a frame')); }, 15_000);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

/** Reads size, length and a few evenly spaced frames. Rejects with a readable message if the browser cannot decode the file. */
export async function inspectVideo(file: File): Promise<VideoInspection> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The video took too long to open.')), 20_000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('The browser cannot read this video (it may be corrupt or use an unsupported codec).')); };
      video.src = url;
    });
    const width = video.videoWidth, height = video.videoHeight, duration = video.duration;
    if (!width || !height) throw new Error('The video has no picture.');
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(width * scale)); canvas.height = Math.max(2, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare a frame.');
    const frames: string[] = []; let thumbnail = '';
    const span = Number.isFinite(duration) && duration > 0 ? duration : 0;
    for (const [i, pos] of FRAME_POSITIONS.entries()) {
      if (span > 0) await seek(video, Math.min(span - 0.05, Math.max(0, span * pos)));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.72);
      frames.push(data.slice(data.indexOf(',') + 1));
      if (i === 1) thumbnail = canvas.toDataURL('image/jpeg', 0.6);
      if (span === 0) break;
    }
    return { width, height, durationSeconds: span, thumbnail, frames };
  } finally {
    video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status})`), { status: res.status, code: body.code });
  return body;
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  taxonomy: () => fetch('/api/v1/broll/bulk/taxonomy').then((r) => json<Taxonomy>(r)),
  analyse: (frames: string[], v: { durationSeconds: number; width: number; height: number }) =>
    post('/api/v1/broll/bulk/analyze', { frames, ...v }).then((r) => json<{ suggestion: Suggestion }>(r)).then((b) => b.suggestion),
  duplicates: (items: { sha256: string | null; size: number }[]) =>
    post('/api/v1/broll/bulk/check-duplicates', { items }).then((r) => json<{ results: { matches: { kind: 'library_exact' | 'library_same_size'; clipId: number; title: string }[] }[] }>(r)).then((b) => b.results),
  init: (contentType: string, fileSize: number, fileName: string) =>
    post('/api/v1/broll/upload/init', { contentType, fileSize, fileName }).then((r) => json<{ storagePath: string; uploadUrl: string; headers: Record<string, string> }>(r)),
  complete: (payload: CompletePayload) => post('/api/v1/broll/upload/complete', payload).then((r) => json<{ id: number }>(r)),
  /** Creates a category through the existing authorised endpoint. Only ever called from an explicit approval click. */
  createCategory: (name: string, parentId: number | null) =>
    post('/api/v1/broll/categories', { name, parentId, scope: 'soma' }).then((r) => json<{ id: number; name: string; parentId: number | null; scope: string; brandScope: string | null }>(r)),
};

/** PUTs a file straight to a presigned R2 URL with progress. Resolves when R2 accepted it; rejects on failure, expiry or abort. */
export function putToR2(url: string, headers: Record<string, string>, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 403 ? 'The upload link expired or was refused.' : `Upload failed (${xhr.status}).`)));
    xhr.onerror = () => reject(new Error('The upload was interrupted (network problem).'));
    xhr.onabort = () => reject(new Error('The upload was cancelled.'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

// A small per-browser cache so a refreshed page does not pay for the same video twice. Keyed by the file's SHA-256, kept for
// 24 hours, and stored redacted (see redactForStorage): no text read from the footage and no privacy details are persisted.
const CACHE_PREFIX = 'broll-bulk-analysis:v1:';
const CACHE_TTL_MS = 24 * 3600 * 1000;
export function cachedSuggestion(sha: string): Suggestion | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + sha);
    if (!raw) return null;
    const { at, suggestion } = JSON.parse(raw) as { at: number; suggestion: Suggestion };
    return Date.now() - at < CACHE_TTL_MS ? suggestion : null;
  } catch { return null; }
}
export function cacheSuggestion(sha: string, suggestion: Suggestion): void {
  try { localStorage.setItem(CACHE_PREFIX + sha, JSON.stringify({ at: Date.now(), suggestion: redactForStorage(suggestion) })); } catch { /* storage may be full or blocked */ }
}

// ── Unfinished-batch recovery (see lib/broll-bulk/session.ts for exactly what is and is not kept) ──────────────────────
const SESSION_KEY = 'broll-bulk-session:v1';
/** The saved batch, plus whether there was one that has expired. Never throws (storage can be blocked or corrupt). */
export function loadSession(): { session: Session | null; expired: boolean } {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { session: null, expired: false };
    const session = readSession(JSON.parse(raw));
    if (!session) localStorage.removeItem(SESSION_KEY);
    return { session, expired: !session };
  } catch { return { session: null, expired: false }; }
}
export function saveSession(session: Session): void {
  try {
    if (session.entries.length === 0) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* storage may be full or blocked: recovery is a convenience, never required */ }
}
export function clearSession(): void { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }
