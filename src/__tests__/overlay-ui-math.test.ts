import { describe, it, expect } from 'vitest';
import { activeOverlayAt, fmtTime, sceneAt, snap, toAnchor, type UiScene } from '@/lib/overlays/ui-math';

const scenes: UiScene[] = [
  { screenId: 10, sceneNumber: 1, startMs: 0, durationMs: 4000, clipUrl: 'a' },
  { screenId: 11, sceneNumber: 2, startMs: 4000, durationMs: 8000, clipUrl: 'b' },
];
describe('composition helpers', () => {
  it('finds the scene at a time, with the end belonging to the last scene', () => {
    expect(sceneAt(scenes, 0)).toMatchObject({ index: 0, offsetMs: 0 });
    expect(sceneAt(scenes, 3999)).toMatchObject({ index: 0, offsetMs: 3999 });
    expect(sceneAt(scenes, 4000)).toMatchObject({ index: 1, offsetMs: 0 });
    expect(sceneAt(scenes, 99999)).toMatchObject({ index: 1, offsetMs: 8000 });
    expect(sceneAt([], 5)).toBeNull();
  });
  it('turns a time on the video into a scene-relative position', () => {
    expect(toAnchor(scenes, 5500)).toEqual({ anchorScreenId: 11, startOffsetMs: 1500 });
    expect(toAnchor(scenes, 11990)).toEqual({ anchorScreenId: 11, startOffsetMs: 7900 });   // never past the end of the scene
  });
  it('shows the highest track that is ready and inside its window, and nothing outside it', () => {
    const o = [
      { id: 1, startMs: 1000, endMs: 3000, sourceStartMs: 0, assetUrl: 'x', status: 'ready', track: 0 },
      { id: 2, startMs: 2000, endMs: 2500, sourceStartMs: 0, assetUrl: 'y', status: 'ready', track: 1 },
      { id: 3, startMs: 5000, endMs: 6000, sourceStartMs: 0, assetUrl: null, status: 'ready', track: 0 },
      { id: 4, startMs: 7000, endMs: 8000, sourceStartMs: 0, assetUrl: 'z', status: 'preparing', track: 0 },
    ];
    expect(activeOverlayAt(o, 500)).toBeNull();
    expect(activeOverlayAt(o, 1500)?.id).toBe(1);
    expect(activeOverlayAt(o, 2200)?.id).toBe(2);
    expect(activeOverlayAt(o, 3000)).toBeNull();      // the Flow footage is back exactly when the overlay ends
    expect(activeOverlayAt(o, 5500)).toBeNull();      // no playable file
    expect(activeOverlayAt(o, 7500)).toBeNull();      // still preparing
  });
  it('formats time and snaps to 100 ms', () => { expect(fmtTime(65_400)).toBe('1:05.4'); expect(snap(1234)).toBe(1200); expect(snap(1251)).toBe(1300); });
});
