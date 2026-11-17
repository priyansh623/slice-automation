/** Small pure helpers for the Composition page (time <-> scene position). No React, no network. */
export interface UiScene { screenId: number; sceneNumber: number; startMs: number; durationMs: number; clipUrl: string | null }
export interface UiOverlayTime { id: number; startMs: number | null; endMs: number | null; sourceStartMs: number; assetUrl: string | null; status: string; track: number }

export const SNAP_MS = 100;
export const snap = (ms: number): number => Math.round(ms / SNAP_MS) * SNAP_MS;

export function fmtTime(ms: number): string {
  const s = Math.max(0, ms) / 1000; const m = Math.floor(s / 60); const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

/** The scene playing at `ms` on the whole video's clock (the last scene at the very end). */
export function sceneAt<T extends { startMs: number; durationMs: number }>(scenes: readonly T[], ms: number): { index: number; scene: T; offsetMs: number } | null {
  if (scenes.length === 0) return null;
  for (let i = 0; i < scenes.length; i++) if (ms < scenes[i].startMs + scenes[i].durationMs) return { index: i, scene: scenes[i], offsetMs: Math.max(0, ms - scenes[i].startMs) };
  const last = scenes[scenes.length - 1];
  return { index: scenes.length - 1, scene: last, offsetMs: last.durationMs };
}

/** The overlay that is on screen at `ms` (the highest track wins), if it can be shown. */
export function activeOverlayAt<T extends UiOverlayTime>(overlays: readonly T[], ms: number): T | null {
  const live = overlays.filter((o) => o.status === 'ready' && o.assetUrl && o.startMs != null && o.endMs != null && ms >= o.startMs && ms < o.endMs);
  return live.sort((a, b) => b.track - a.track)[0] ?? null;
}

/** A position on the whole video's clock, expressed the way overlays are stored: relative to a Flow scene. */
export function toAnchor(scenes: readonly UiScene[], globalMs: number): { anchorScreenId: number; startOffsetMs: number } | null {
  const at = sceneAt(scenes, Math.max(0, globalMs));
  if (!at) return null;
  return { anchorScreenId: at.scene.screenId, startOffsetMs: Math.min(at.offsetMs, Math.max(0, at.scene.durationMs - SNAP_MS)) };
}
