import { describe, it, expect } from 'vitest';
import { arrangeAuto, type ArrangeInput } from '@/lib/overlays/arrange';
import { buildSceneSpans } from '@/lib/overlays/timeline';

const spans = buildSceneSpans([{ screenId: 1, durationMs: 8000 }, { screenId: 2, durationMs: 8000 }, { screenId: 3, durationMs: 6000 }]);   // 0-8, 8-16, 16-22
const o = (id: number, anchor: number, dur: number, over: Partial<ArrangeInput> = {}): ArrangeInput => ({ id, track: 0, anchorScreenId: anchor, startOffsetMs: 0, durationMs: dur, sourceStartMs: 0, assetDurationMs: dur, placementSource: 'auto', ...over });
const offsetOf = (r: ReturnType<typeof arrangeAuto>, id: number) => r.moves.find((m) => m.id === id)?.startOffsetMs;

describe('automatic placement from the script segments', () => {
  it('centres a lone clip inside its own scene (the only timing that exists is "this scene")', () => {
    const r = arrangeAuto(spans, [o(1, 2, 4000)]);
    expect(offsetOf(r, 1)).toBe(2000);            // scene 2 is 8 s: (8 - 4) / 2
    expect(r.unplaced).toEqual([]);
  });
  it('spreads several clips of one scene evenly, never overlapping', () => {
    const r = arrangeAuto(spans, [o(1, 1, 2000), o(2, 1, 2000)]);
    expect(offsetOf(r, 1)).toBe(1300);            // gaps of (8000 - 4000) / 3, snapped to 0.1 s
    expect(offsetOf(r, 2)).toBe(4600);
  });
  it('a clip longer than its scene starts at the scene start and runs on; the next scene\'s clip on the same track waits for it', () => {
    const r = arrangeAuto(spans, [o(1, 1, 12000), o(2, 2, 2000)]);
    expect(offsetOf(r, 1)).toBeUndefined();       // already at 0 (no move needed)
    expect(offsetOf(r, 2)).toBe(4000);            // its centred spot (11 s) is under the first clip, which ends at 12 s (4 s into scene 2)
  });
  it('different tracks are independent (a character clip and a library clip may share a moment)', () => {
    const r = arrangeAuto(spans, [o(1, 2, 4000, { track: 1 }), o(2, 2, 4000, { track: 0 })]);
    expect(offsetOf(r, 1)).toBe(2000); expect(offsetOf(r, 2)).toBe(2000);
  });
  it('never moves a clip a person placed, and routes automatic clips around it', () => {
    const r = arrangeAuto(spans, [o(1, 2, 3000, { placementSource: 'manual', startOffsetMs: 2500 }), o(2, 2, 3000)]);
    expect(r.moves.find((m) => m.id === 1)).toBeUndefined();
    // the ideal centred spot (2.5-5.5 s) is taken by the person's clip (2.5-5.5 s): the automatic clip goes after it
    expect(offsetOf(r, 2)).toBe(5500);
  });
  it('does not re-attach a clip to another scene when its own scene has no room: it is reported, not moved', () => {
    const r = arrangeAuto(spans, [o(1, 3, 6000, { placementSource: 'manual', startOffsetMs: 0 }), o(2, 3, 2000)]);
    expect(r.unplaced).toEqual([2]);
    expect(r.moves).toEqual([]);
  });
  it('is stable: arranging an arranged timeline moves nothing', () => {
    const first = arrangeAuto(spans, [o(1, 1, 2000), o(2, 2, 3000), o(3, 2, 2000, { track: 1 })]);
    const placed = [o(1, 1, 2000), o(2, 2, 3000), o(3, 2, 2000, { track: 1 })].map((x) => ({ ...x, startOffsetMs: first.moves.find((m) => m.id === x.id)?.startOffsetMs ?? x.startOffsetMs }));
    expect(arrangeAuto(spans, placed).moves).toEqual([]);
  });
  it('uses real scene lengths: the same clip lands differently when the generated scene is shorter', () => {
    const real = buildSceneSpans([{ screenId: 1, durationMs: 8000 }, { screenId: 2, durationMs: 5000 }, { screenId: 3, durationMs: 6000 }]);
    expect(offsetOf(arrangeAuto(real, [o(1, 2, 3000)]), 1)).toBe(1000);
  });
});
