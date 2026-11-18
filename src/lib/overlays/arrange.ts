/**
 * The initial arrangement of B-roll on the timeline, as a pure function (no database, no FFmpeg).
 *
 * B-roll is attached to a Flow scene, which is the script segment it was chosen for. That is the ONLY timing information that exists, so
 * the arrangement never invents more than a sensible default INSIDE that scene. B-roll covers the whole frame, so no two clips (of any kind,
 * on any lane) play at the same time:
 *   - the clips attached to a scene are laid one after another and spread evenly through it (equal gaps before, between and after them,
 *     so a lone clip is centred), snapped to 0.1 s;
 *   - when they do not fit at full length they are SHORTENED to share the scene (each keeps the beginning of its clip, never less than
 *     MIN_SHARE_MS; short clips keep their length and the rest is shared out). A person then trims each to the part they want;
 *   - what still does not fit is reported as unplaced and left where it is. It is never re-attached to another scene.
 * Clips a person has positioned ('manual') are never moved or resized: they are fixed obstacles the automatic ones route around.
 */
import { resolveOverlays, totalDurationMs, type OverlayTiming, type SceneSpan } from './timeline';

export const ARRANGE_SNAP_MS = 100;
/** The shortest an automatic clip is made when several share one scene. */
export const MIN_SHARE_MS = 1000;
const snapDown = (ms: number): number => Math.floor(ms / ARRANGE_SNAP_MS) * ARRANGE_SNAP_MS;

export interface ArrangeInput extends OverlayTiming { placementSource: 'auto' | 'manual' }
export interface ArrangeResult {
  /** New offsets (relative to each overlay's own anchor scene), and new lengths when it was shortened, for the automatic overlays that need to change. */
  moves: Array<{ id: number; startOffsetMs: number; durationMs?: number }>;
  /** Automatic overlays that could not be placed inside their own scene and were left alone. */
  unplaced: number[];
}

/** Shares `room` between clips: short ones keep their length, the rest split what is left equally (snapped down). */
function shareOut(natural: number[], room: number): number[] {
  const out = natural.map(() => 0); const open = natural.map((_, i) => i);
  let left = room;
  while (open.length) {
    const each = snapDown(left / open.length);
    const small = open.filter((i) => natural[i] <= each);
    if (!small.length) { for (const i of open) out[i] = each; break; }
    for (const i of small) { out[i] = natural[i]; left -= natural[i]; }
    for (const i of small) open.splice(open.indexOf(i), 1);
  }
  return out;
}

export function arrangeAuto(spans: readonly SceneSpan[], overlays: readonly ArrangeInput[]): ArrangeResult {
  const total = totalDurationMs(spans);
  // Obstacles: what people placed, on any lane, on the finished video's clock.
  const busy: Array<[number, number]> = [];
  const users = overlays.filter((o) => o.placementSource === 'manual');
  for (const r of resolveOverlays(spans, users).resolved) busy.push([r.startMs, r.endMs]);

  const moves: ArrangeResult['moves'] = []; const unplaced: number[] = [];
  const autos = overlays.filter((o) => o.placementSource === 'auto');
  for (const span of spans) {
    const items = autos.filter((o) => o.anchorScreenId === span.screenId).sort((a, b) => a.track - b.track || a.id - b.id);
    if (!items.length) continue;
    const natural = items.map((o) => Math.max(0, Math.min(o.durationMs, o.assetDurationMs != null ? o.assetDurationMs - o.sourceStartMs : o.durationMs)));
    const end = Math.min(span.startMs + span.durationMs, total);
    const taken = busy.reduce((t, [a, b]) => t + Math.max(0, Math.min(b, end) - Math.max(a, span.startMs)), 0);
    const room = Math.max(0, end - span.startMs - taken);
    const sum = natural.reduce((t, d) => t + d, 0);
    const fits = sum <= room;
    let dur = natural;
    let keep = items.map(() => true);
    if (!fits) {
      // Never below MIN_SHARE_MS each: if even that does not fit, the later clips are left unplaced.
      const maxCount = Math.max(0, Math.floor(room / Math.min(MIN_SHARE_MS, ...natural.filter((d) => d > 0), MIN_SHARE_MS)));
      keep = items.map((_, i) => i < maxCount && natural[i] > 0);
      const kept = items.map((_, i) => i).filter((i) => keep[i]);
      const shared = shareOut(kept.map((i) => natural[i]), room);
      dur = natural.map(() => 0); kept.forEach((i, k) => { dur[i] = Math.max(Math.min(natural[i], MIN_SHARE_MS), shared[k]); });
    }
    const placed = keep.filter(Boolean).length;
    const sumKept = dur.reduce((t, d) => t + d, 0);
    const gap = fits ? Math.max(0, (room - sumKept) / (placed + 1)) : 0;
    let cursor = fits ? gap : 0;
    items.forEach((o, i) => {
      const d = dur[i];
      if (!keep[i] || d <= 0) { unplaced.push(o.id); return; }
      let start = span.startMs + snapDown(cursor);
      // route around anything already there (people's clips, and automatic ones placed just before)
      for (let guard = 0; guard < 50; guard++) {
        const hit = busy.find(([a, b]) => start < b && start + d > a);
        if (!hit) break;
        start = hit[1];
      }
      const offset = start - span.startMs;
      if (offset >= span.durationMs || start >= total || start + d > end) { unplaced.push(o.id); return; }
      busy.push([start, start + d]);
      const shorter = d < o.durationMs;
      if (offset !== o.startOffsetMs || shorter) moves.push({ id: o.id, startOffsetMs: offset, ...(shorter ? { durationMs: d } : {}) });
      cursor = offset + d + gap;
    });
  }
  return { moves, unplaced };
}
