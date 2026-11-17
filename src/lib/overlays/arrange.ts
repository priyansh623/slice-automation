/**
 * The initial arrangement of B-roll on the timeline, as a pure function (no database, no FFmpeg).
 *
 * B-roll is attached to a Flow scene, which is the script segment it was chosen for. That is the ONLY timing information that exists, so
 * the arrangement never invents more than a sensible default INSIDE that scene: the clips attached to a scene are spread evenly through it
 * (equal gaps before, between and after them, so a lone clip is centred), snapped to 0.1 s. A clip that is longer than its scene (or a
 * scene with more B-roll than it can hold) starts at the beginning and runs on into the following scene, and never overlaps another clip
 * on the same track. Clips a person has positioned ('manual') are never moved: they are fixed obstacles the automatic ones route around.
 *
 * A clip that cannot be placed without leaving its own scene is NOT re-attached to another scene (that would silently attach it to
 * different words): it is reported as unplaced and left where it is, for a person to decide.
 */
import { resolveOverlays, totalDurationMs, type OverlayTiming, type SceneSpan } from './timeline';

export const ARRANGE_SNAP_MS = 100;
const snapDown = (ms: number): number => Math.floor(ms / ARRANGE_SNAP_MS) * ARRANGE_SNAP_MS;

export interface ArrangeInput extends OverlayTiming { placementSource: 'auto' | 'manual' }
export interface ArrangeResult {
  /** New offsets (relative to each overlay's own anchor scene) for the automatic overlays that need to move. */
  moves: Array<{ id: number; startOffsetMs: number }>;
  /** Automatic overlays that could not be placed inside their own scene and were left alone. */
  unplaced: number[];
}

export function arrangeAuto(spans: readonly SceneSpan[], overlays: readonly ArrangeInput[]): ArrangeResult {
  const total = totalDurationMs(spans);
  const byScreen = new Map(spans.map((s) => [s.screenId, s]));
  // Obstacles: what people placed, per track, on the finished video's clock.
  const busy = new Map<number, Array<[number, number]>>();
  const addBusy = (track: number, a: number, b: number) => busy.set(track, [...(busy.get(track) ?? []), [a, b]]);
  const users = overlays.filter((o) => o.placementSource === 'manual');
  for (const r of resolveOverlays(spans, users).resolved) addBusy(r.track, r.startMs, r.endMs);

  const moves: ArrangeResult['moves'] = []; const unplaced: number[] = [];
  const autos = overlays.filter((o) => o.placementSource === 'auto');
  for (const span of spans) {
    const inScene = autos.filter((o) => o.anchorScreenId === span.screenId);
    for (const track of [...new Set(inScene.map((o) => o.track))].sort((a, b) => a - b)) {
      const items = inScene.filter((o) => o.track === track).sort((a, b) => a.id - b.id);
      const dur = items.map((o) => Math.max(0, Math.min(o.durationMs, o.assetDurationMs != null ? o.assetDurationMs - o.sourceStartMs : o.durationMs)));
      const sum = dur.reduce((t, d) => t + d, 0);
      const fits = sum <= span.durationMs;
      const gap = fits ? (span.durationMs - sum) / (items.length + 1) : 0;
      let cursor = fits ? gap : 0;
      items.forEach((o, i) => {
        let start = span.startMs + snapDown(cursor);
        const d = dur[i];
        // route around anything already on this track (people's clips, and automatic ones placed just before)
        for (let guard = 0; guard < 50; guard++) {
          const hit = (busy.get(track) ?? []).find(([a, b]) => start < b && start + d > a);
          if (!hit) break;
          start = hit[1];
        }
        const offset = start - span.startMs;
        if (d <= 0 || offset >= span.durationMs || start >= total) { unplaced.push(o.id); cursor += d + gap; return; }
        addBusy(track, start, start + d);
        if (offset !== o.startOffsetMs) moves.push({ id: o.id, startOffsetMs: offset });
        cursor = (start - span.startMs) + d + gap;
      });
    }
  }
  // Anchors that are not in the sequence at all are not this function's business (they are flagged elsewhere).
  void byScreen;
  return { moves, unplaced };
}
