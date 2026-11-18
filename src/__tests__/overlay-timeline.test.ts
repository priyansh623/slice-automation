import { describe, it, expect } from 'vitest';
import { buildSceneSpans, checkPlacement, firstFreePlacement, resolveOverlays, snapToFrame, totalDurationMs, type OverlayTiming } from '@/lib/overlays/timeline';

const spans = buildSceneSpans([{ screenId: 10, durationMs: 8000 }, { screenId: 11, durationMs: 6000 }, { screenId: 12, durationMs: 4000 }]);
const ov = (id: number, anchorScreenId: number, startOffsetMs: number, durationMs: number, extra: Partial<OverlayTiming> = {}): OverlayTiming => ({ id, track: 0, anchorScreenId, startOffsetMs, durationMs, sourceStartMs: 0, ...extra });

describe('scene spans', () => {
  it('lay the real Flow durations end to end', () => {
    expect(spans).toEqual([{ screenId: 10, startMs: 0, durationMs: 8000 }, { screenId: 11, startMs: 8000, durationMs: 6000 }, { screenId: 12, startMs: 14000, durationMs: 4000 }]);
    expect(totalDurationMs(spans)).toBe(18000);
  });
  it('follow the order given: reordering the Flow scenes moves an overlay with its anchor scene', () => {
    const o = ov(1, 11, 1000, 2000);
    expect(resolveOverlays(spans, [o]).resolved[0]).toMatchObject({ startMs: 9000, endMs: 11000 });
    const reordered = buildSceneSpans([{ screenId: 11, durationMs: 6000 }, { screenId: 10, durationMs: 8000 }, { screenId: 12, durationMs: 4000 }]);
    expect(resolveOverlays(reordered, [o]).resolved[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
  });
  it('use the actual durations, not the nominal ones: a scene that came out 7.4 s moves everything after it', () => {
    const real = buildSceneSpans([{ screenId: 10, durationMs: 7400 }, { screenId: 11, durationMs: 6000 }]);
    expect(resolveOverlays(real, [ov(1, 11, 0, 1000)]).resolved[0].startMs).toBe(7400);
  });
});

describe('resolving overlays', () => {
  it('lets an overlay run on past its anchor scene into the next ones', () => {
    const r = resolveOverlays(spans, [ov(1, 10, 6000, 5000)]);
    expect(r.problems).toEqual([]);
    expect(r.resolved[0]).toMatchObject({ startMs: 6000, endMs: 11000, shortened: false });   // 2 s in scene 10, 3 s in scene 11
  });
  it('shortens (and says so) an overlay that would run past the end of the video or of its clip', () => {
    expect(resolveOverlays(spans, [ov(1, 12, 3000, 5000)]).resolved[0]).toMatchObject({ endMs: 18000, durationMs: 1000, shortened: true });
    expect(resolveOverlays(spans, [ov(2, 10, 0, 5000, { assetDurationMs: 5000, sourceStartMs: 3000 })]).resolved[0]).toMatchObject({ durationMs: 2000, shortened: true });
  });
  it('reports, and never silently moves or drops: a missing anchor, a start outside its scene, a trim past the clip', () => {
    const r = resolveOverlays(spans, [ov(1, 99, 0, 1000), ov(2, 12, 4000, 1000), ov(3, 10, 0, 1000, { assetDurationMs: 2000, sourceStartMs: 2000 })]);
    expect(r.resolved).toEqual([]);
    expect(r.problems.map((p) => [p.overlayId, p.code])).toEqual([[1, 'anchor_missing'], [2, 'start_outside_scene'], [3, 'trim_beyond_clip']]);
  });
  it('treats overlays that touch end to end as fine and overlays that overlap on one track as a problem', () => {
    expect(resolveOverlays(spans, [ov(1, 10, 0, 2000), ov(2, 10, 2000, 2000)]).problems).toEqual([]);
    const r = resolveOverlays(spans, [ov(1, 10, 0, 3000), ov(2, 10, 2000, 2000)]);
    expect(r.problems).toMatchObject([{ code: 'overlap', overlayId: 2, otherId: 1 }]);
    expect(r.resolved.map((x) => x.id)).toEqual([1]);
  });
  it('allows overlap across tracks, drawn in track order', () => {
    const r = resolveOverlays(spans, [ov(1, 10, 0, 3000, { track: 1 }), ov(2, 10, 1000, 2000, { track: 0 })]);
    expect(r.problems).toEqual([]);
    expect(r.resolved.map((x) => x.id)).toEqual([2, 1]);
  });
  it('overlaps are found across a scene boundary too (anchored in different scenes)', () => {
    expect(resolveOverlays(spans, [ov(1, 10, 6000, 4000), ov(2, 11, 1000, 2000)]).problems).toMatchObject([{ code: 'overlap', overlayId: 2, otherId: 1 }]);
  });
});

describe('placing', () => {
  it('finds the first free stretch, preferring the chosen scene', () => {
    const existing = [ov(1, 10, 0, 3000)];
    expect(firstFreePlacement(spans, existing, 2000, 0, 10)).toEqual({ anchorScreenId: 10, startOffsetMs: 3000 });
    expect(firstFreePlacement(spans, existing, 2000, 0, 11)).toEqual({ anchorScreenId: 11, startOffsetMs: 0 });
  });
  it('returns null when nothing fits', () => {
    expect(firstFreePlacement(buildSceneSpans([{ screenId: 10, durationMs: 2000 }]), [ov(1, 10, 0, 2000)], 1000)).toBeNull();
  });
  it('checkPlacement refuses a clip that overlaps B-roll on another lane, with a plain message', () => {
    const sp = buildSceneSpans([{ screenId: 10, durationMs: 8000 }]);
    const lane0 = ov(1, 10, 0, 3000);
    const cand = { ...ov(2, 10, 2000, 2000), track: 1 };
    expect(checkPlacement(sp, [lane0], cand)).toMatchObject([{ code: 'overlap', overlayId: 2, message: 'It overlaps another B-roll. Trim or move the other one first.' }]);
    expect(checkPlacement(sp, [lane0], { ...cand, startOffsetMs: 3000 })).toEqual([]);
  });
  it('checkPlacement reports a clash for the moved overlay only, and ignores the overlay\'s own old position', () => {
    const others = [ov(1, 10, 0, 3000), ov(2, 11, 0, 1000)];
    expect(checkPlacement(spans, others, ov(3, 10, 1000, 1000))).toMatchObject([{ code: 'overlap', overlayId: 3 }]);
    expect(checkPlacement(spans, others, ov(1, 10, 500, 2000))).toEqual([]);
  });
});

describe('frames', () => {
  it('snaps to the frame grid', () => {
    expect(snapToFrame(1010, 30)).toBeCloseTo(1000, 5);
    expect(snapToFrame(1020, 30)).toBeCloseTo(1033.3333, 3);
  });
});
