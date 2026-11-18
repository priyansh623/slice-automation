import { describe, it, expect } from 'vitest';
import { makeUrlStabiliser } from '@/lib/overlays/ui-math';

describe('a file keeps the same link across refreshes', () => {
  it('reuses the first link for the same file, so the video is not downloaded again after an edit', () => {
    const stable = makeUrlStabiliser(1000, () => 0);
    expect(stable('scene:1:10', 'https://x/a?sig=1')).toBe('https://x/a?sig=1');
    expect(stable('scene:1:10', 'https://x/a?sig=2')).toBe('https://x/a?sig=1');
    expect(stable('scene:1:10', 'https://x/a?sig=3')).toBe('https://x/a?sig=1');
  });
  it('a different file (another generation) gets its own link', () => {
    const stable = makeUrlStabiliser(1000, () => 0);
    stable('scene:1:10', 'https://x/a?sig=1');
    expect(stable('scene:1:11', 'https://x/b?sig=1')).toBe('https://x/b?sig=1');
  });
  it('takes a fresh link before the old one expires, and passes null through', () => {
    let t = 0; const stable = makeUrlStabiliser(1000, () => t);
    stable('o:1:p', 'https://x/a?sig=1');
    t = 999; expect(stable('o:1:p', 'https://x/a?sig=2')).toBe('https://x/a?sig=1');
    t = 1000; expect(stable('o:1:p', 'https://x/a?sig=2')).toBe('https://x/a?sig=2');
    expect(stable('o:2:p', null)).toBeNull();
  });
});
