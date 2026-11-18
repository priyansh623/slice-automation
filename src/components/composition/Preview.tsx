'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { activeOverlayAt, sceneAt } from '@/lib/overlays/ui-math';
import type { CompOverlay, CompScene } from './types';

export interface PreviewHandle { seek: (ms: number) => void; toggle: () => void; restart: () => void }
interface Props { scenes: CompScene[]; overlays: CompOverlay[]; totalMs: number; onTime: (ms: number) => void; time: number; onPlaying?: (playing: boolean) => void }

/**
 * The Flow sequence with the B-roll over it. The Flow clip is the master: its own video and sound keep playing underneath, and the
 * overlay is a separate muted layer that appears for its window and goes away again, so the Flow footage is never paused or replaced.
 * This is a preview in the browser (one clip after another, the next one starts when the previous ends); the compiled file is the
 * authority on exact timing.
 */
const Preview = forwardRef<PreviewHandle, Props>(function Preview({ scenes, overlays, totalMs, onTime, time, onPlaying }, ref) {
  const baseRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const pendingSeek = useRef<number | null>(null);
  const indexRef = useRef(0); indexRef.current = index;
  const scene = scenes[index];
  const active = activeOverlayAt(overlays.map((o) => ({ ...o, startMs: o.startMs, endMs: o.endMs })), time);

  const goTo = useCallback((ms: number) => {
    const at = sceneAt(scenes, ms);
    if (!at) return;
    if (at.index !== indexRef.current) { pendingSeek.current = at.offsetMs / 1000; setIndex(at.index); }
    else if (baseRef.current) baseRef.current.currentTime = at.offsetMs / 1000;
    onTime(ms);
  }, [scenes, onTime]);
  useEffect(() => { onPlaying?.(playing); }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new scene's clip loaded: apply a pending seek, then keep playing if we were playing.
  const onLoaded = () => {
    const v = baseRef.current; if (!v) return;
    if (pendingSeek.current != null) { v.currentTime = pendingSeek.current; pendingSeek.current = null; }
    if (playing) void v.play().catch(() => setPlaying(false));
  };
  const onEnded = () => {
    if (indexRef.current < scenes.length - 1) { pendingSeek.current = 0; setIndex(indexRef.current + 1); }
    else { setPlaying(false); onTime(totalMs); }
  };

  // The clock: the Flow video's own position, so nothing can drift away from the narration.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = baseRef.current; const s = scenes[indexRef.current];
      if (v && s && !v.seeking) onTime(s.startMs + v.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    if (playing) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, scenes, onTime]);

  // The overlay layer: follows the clock, never leads it. Always muted.
  useEffect(() => {
    const o = overlayRef.current; if (!o) return;
    o.muted = true;
    if (!active) { o.pause(); return; }
    const want = (active.sourceStartMs + (time - (active.startMs ?? 0))) / 1000;
    if (o.getAttribute('data-src') !== active.assetUrl) { o.setAttribute('data-src', active.assetUrl ?? ''); o.src = active.assetUrl ?? ''; o.currentTime = Math.max(0, want); }
    else if (Math.abs(o.currentTime - want) > 0.3) o.currentTime = Math.max(0, want);
    if (playing) void o.play().catch(() => undefined); else o.pause();
  }, [active?.id, active?.assetUrl, time, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const v = baseRef.current; if (!v) return; if (playing) void v.play().catch(() => setPlaying(false)); else v.pause(); }, [playing]);

  const toggle = () => { if (!scene?.clipUrl) return; if (!playing && time >= totalMs - 50) goTo(0); setPlaying((p) => !p); };
  useImperativeHandle(ref, () => ({ seek: goTo, toggle, restart: () => { setPlaying(false); goTo(0); } }));

  return (
    <div style={{ position: 'relative', height: '100%', maxWidth: '100%', aspectRatio: '9 / 16', background: '#000', borderRadius: 16, overflow: 'hidden', boxShadow: '0 8px 30px rgba(17,17,19,.12)' }}>
        {scene?.clipUrl
          ? <video ref={baseRef} key={scene.screenId} src={scene.clipUrl} playsInline preload="auto" onLoadedMetadata={onLoaded} onEnded={onEnded} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          : <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#bbb', font: '400 13px/1.4 Satoshi', padding: 16, textAlign: 'center' }}>{scenes.length === 0 ? 'No Flow scenes yet.' : `Scene ${scene?.sceneNumber ?? ''} has no finished clip to preview.`}</div>}
        <video ref={overlayRef} muted playsInline preload="auto" data-testid="overlay-layer" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: active ? 'block' : 'none', pointerEvents: 'none' }} />
      </div>
  );
});
export default Preview;
