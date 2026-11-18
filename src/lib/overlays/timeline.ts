/**
 * Overlay timing, as pure functions (no database, no FFmpeg), shared by the API, the compile worker and the Composition page.
 *
 * Overlays are positioned RELATIVE to a Flow scene: (anchor scene, offset into that scene, duration). That is what is stored. The
 * position on the finished video's clock is only worked out when it is needed, from the Flow scenes in their current order and
 * their real durations. An overlay may run on past its anchor scene into the next ones. Overlays never become scenes, and a
 * scene's own length never changes because of them.
 */

export interface SceneSpan { screenId: number; startMs: number; durationMs: number }
export interface SceneClip { screenId: number; durationMs: number }

/** The Flow scenes laid end to end, in the order given (the compile order), each with its start on the video's clock. */
export function buildSceneSpans(clips: readonly SceneClip[]): SceneSpan[] {
  let at = 0;
  return clips.map((c) => { const span = { screenId: c.screenId, startMs: at, durationMs: Math.max(0, Math.round(c.durationMs)) }; at += span.durationMs; return span; });
}
export const totalDurationMs = (spans: readonly SceneSpan[]): number => spans.reduce((t, s) => Math.max(t, s.startMs + s.durationMs), 0);

export interface OverlayTiming {
  id: number;
  track: number;
  anchorScreenId: number;
  startOffsetMs: number;
  durationMs: number;
  sourceStartMs: number;
  /** Length of the stored (normalised) clip, when known: the overlay cannot show more than the clip has. */
  assetDurationMs?: number | null;
}

export type TimelineProblemCode = 'anchor_missing' | 'start_outside_scene' | 'trim_beyond_clip' | 'overlap' | 'beyond_video';
export interface TimelineProblem { code: TimelineProblemCode; overlayId: number; otherId?: number; message: string }

export interface ResolvedOverlay extends OverlayTiming {
  /** On the finished video's clock. */
  startMs: number;
  endMs: number;
  /** True when the overlay was shortened because it would have run past the end of the video or of its clip. */
  shortened: boolean;
}

export const MS_PER_FRAME = (fps: number): number => 1000 / fps;
/** Rounds a time to the nearest frame boundary of a clip at `fps`. */
export const snapToFrame = (ms: number, fps: number): number => Math.round((ms / 1000) * fps) * (1000 / fps);

/**
 * Works out where every overlay sits on the video's clock. Overlays with a problem are left out of `resolved` and reported in
 * `problems`: nothing is silently moved, shortened to nothing or dropped. An overlay is only SHORTENED (and marked so) when it
 * would run past the end of the video or past the end of its own clip.
 */
export function resolveOverlays(spans: readonly SceneSpan[], overlays: readonly OverlayTiming[]): { resolved: ResolvedOverlay[]; problems: TimelineProblem[] } {
  const byScreen = new Map(spans.map((s) => [s.screenId, s]));
  const total = totalDurationMs(spans);
  const problems: TimelineProblem[] = [];
  const resolved: ResolvedOverlay[] = [];
  for (const o of overlays) {
    const span = byScreen.get(o.anchorScreenId);
    if (!span) { problems.push({ code: 'anchor_missing', overlayId: o.id, message: 'Its Flow scene is not in this video any more.' }); continue; }
    if (o.startOffsetMs >= span.durationMs) { problems.push({ code: 'start_outside_scene', overlayId: o.id, message: 'It starts after the end of its Flow scene.' }); continue; }
    const startMs = span.startMs + o.startOffsetMs;
    let durationMs = o.durationMs;
    let shortened = false;
    if (o.assetDurationMs != null) {
      const room = o.assetDurationMs - o.sourceStartMs;
      if (room <= 0) { problems.push({ code: 'trim_beyond_clip', overlayId: o.id, message: 'Its trim starts after the end of the clip.' }); continue; }
      if (durationMs > room) { durationMs = room; shortened = true; }
    }
    if (startMs + durationMs > total) { durationMs = total - startMs; shortened = true; }
    if (durationMs <= 0) { problems.push({ code: 'beyond_video', overlayId: o.id, message: 'It would start after the end of the video.' }); continue; }
    resolved.push({ ...o, durationMs, startMs, endMs: startMs + durationMs, shortened });
  }
  // The same track cannot show two overlays at once. Different tracks may overlap (the higher one draws on top).
  const tracks = new Map<number, ResolvedOverlay[]>();
  for (const r of resolved) tracks.set(r.track, [...(tracks.get(r.track) ?? []), r]);
  const overlapping = new Set<number>();
  for (const list of tracks.values()) {
    list.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]; const cur = list[i];
      if (cur.startMs < prev.endMs) { problems.push({ code: 'overlap', overlayId: cur.id, otherId: prev.id, message: 'It overlaps another overlay on the same track.' }); overlapping.add(cur.id); }
    }
  }
  const ok = resolved.filter((r) => !overlapping.has(r.id)).sort((a, b) => a.track - b.track || a.startMs - b.startMs || a.id - b.id);
  return { resolved: ok, problems };
}

/** The first free stretch on `track` (in the order of the video) long enough for `durationMs`, inside the preferred scene if possible. */
export function firstFreePlacement(spans: readonly SceneSpan[], overlays: readonly OverlayTiming[], durationMs: number, track = 0, preferredScreenId?: number): { anchorScreenId: number; startOffsetMs: number } | null {
  void track; // B-roll on any lane blocks the same time
  const { resolved } = resolveOverlays(spans, overlays);
  const busy = resolved.map((r) => [r.startMs, r.endMs] as const).sort((a, b) => a[0] - b[0]);
  const order = preferredScreenId != null ? [...spans.filter((s) => s.screenId === preferredScreenId), ...spans.filter((s) => s.screenId !== preferredScreenId)] : [...spans];
  const total = totalDurationMs(spans);
  for (const span of order) {
    let at = span.startMs;
    const end = Math.min(span.startMs + span.durationMs, total);
    while (at < end) {
      const clash = busy.find(([s, e]) => at < e && at + durationMs > s);
      if (!clash) return { anchorScreenId: span.screenId, startOffsetMs: at - span.startMs };
      at = clash[1];
    }
  }
  return null;
}

/** Checks one placement against the others on its track, using the scene lengths known right now. Used when a person places or moves an overlay. */
export function checkPlacement(spans: readonly SceneSpan[], others: readonly OverlayTiming[], candidate: OverlayTiming): TimelineProblem[] {
  const rest = others.filter((o) => o.id !== candidate.id);
  const { problems } = resolveOverlays(spans, [...rest, candidate]);
  const out = problems.filter((p) => p.overlayId === candidate.id || p.otherId === candidate.id);
  // B-roll covers the whole frame, so two clips cannot play at once even on different lanes. (Only checked for what a person places or
  // moves: overlays that already overlap across lanes are left as they are until one of them is edited.)
  if (!out.some((p) => p.code === 'overlap')) {
    const me = resolveOverlays(spans, [candidate]).resolved[0];
    if (me) {
      const clash = resolveOverlays(spans, rest.filter((o) => o.track !== candidate.track)).resolved.find((r) => me.startMs < r.endMs && me.endMs > r.startMs);
      if (clash) out.push({ code: 'overlap', overlayId: candidate.id, otherId: clash.id, message: 'It overlaps another B-roll. Trim or move the other one first.' });
    }
  }
  return out;
}
