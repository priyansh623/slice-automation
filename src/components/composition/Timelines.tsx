'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Clapperboard, Film, Loader2, Plus, Repeat2, RotateCcw, Trash2, UserRound } from 'lucide-react';
import { snap, toAnchor } from '@/lib/overlays/ui-math';
import { C, type CompOverlay, type CompScene } from './types';

interface Props {
  scenes: CompScene[]; overlays: CompOverlay[]; totalMs: number; time: number; selectedId: number | null; atLimit: boolean;
  onSeek: (ms: number) => void; onSelect: (id: number | null) => void;
  onMove: (id: number, to: { anchorScreenId: number; startOffsetMs: number }) => void;
  onResize: (id: number, durationMs: number) => void;
  onReplace: (id: number) => void; onRemove: (id: number) => void; onScene: (id: number, screenId: number) => void; onRetry: (id: number) => void;
  onAddGeneric: () => void;
}
const MIN_MS = 500;
const LABEL_W = 176;
const PX_PER_SEC_MIN = 30;
const ORANGE = '#C2410C';

const clock = (ms: number) => { const s = Math.max(0, ms) / 1000; return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const tickLabel = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

/**
 * The timeline: a ruler with the red playhead, a header per scene (dashed dividers run through every lane), then the lanes Generic B-roll,
 * Character B-roll and Flow scenes. The Flow lane shows frames of each scene. Click a B-roll clip to get its small toolbar (Replace, Remove,
 * Scene); drag it to move it, drag its right edge to change its length.
 */
export default function Timelines({ scenes, overlays, totalMs, time, selectedId, atLimit, onSeek, onSelect, onMove, onResize, onReplace, onRemove, onScene, onRetry, onAddGeneric }: Props) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: number; mode: 'move' | 'resize'; startX: number; dx: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const total = Math.max(1, totalMs);
  const pct = (ms: number) => `${(ms / total) * 100}%`;
  const msPerPx = () => { const w = innerRef.current?.getBoundingClientRect().width ?? 1; return total / Math.max(1, w); };
  const selected = overlays.find((o) => o.id === selectedId) ?? null;
  const step = total <= 40_000 ? 4000 : total <= 120_000 ? 10_000 : 30_000;
  const ticks: number[] = []; for (let t = 0; t <= total; t += step) ticks.push(t);

  // Where the selected clip is on screen, so its toolbar can float just above it.
  useLayoutEffect(() => {
    const measure = () => setRect(selectedId == null ? null : (document.querySelector(`[data-testid="overlay-block-${selectedId}"]`) as HTMLElement | null)?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener('resize', measure); document.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); document.removeEventListener('scroll', measure, true); };
  }, [selectedId, overlays, scenes, totalMs, drag === null]);
  useEffect(() => { setMenu(false); }, [selectedId]);
  // Delete removes the selected clip (never while typing in a field).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!selectedId || (t && /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onRemove(selectedId); }
      if (e.key === 'Escape') onSelect(null);
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [selectedId, onRemove, onSelect]);

  const begin = (e: React.PointerEvent, o: CompOverlay, mode: 'move' | 'resize') => {
    e.stopPropagation(); e.preventDefault(); onSelect(o.id);
    if (o.startMs == null) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: o.id, mode, startX: e.clientX, dx: 0 });
  };
  const moveTo = (e: React.PointerEvent) => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.startX }); };
  const end = (o: CompOverlay) => {
    if (!drag || drag.id !== o.id) return;
    const deltaMs = drag.dx * msPerPx(); const d = drag; setDrag(null);
    if (Math.abs(d.dx) < 3 || o.startMs == null) return;
    if (d.mode === 'move') { const target = toAnchor(scenes, snap(o.startMs + deltaMs)); if (target) onMove(o.id, target); }
    else onResize(o.id, Math.max(MIN_MS, snap(o.durationMs + deltaMs)));
  };
  const seekFromClick = (e: React.MouseEvent) => {
    const r = innerRef.current?.getBoundingClientRect(); if (!r) return;
    onSeek(Math.max(0, Math.min(total, ((e.clientX - r.left) / r.width) * total)));
  };

  const block = (o: CompOverlay) => {
    const colour = o.kind === 'character' ? ORANGE : C.generic;
    const live = drag?.id === o.id; const startMs = o.startMs ?? 0;
    const left = live && drag!.mode === 'move' ? startMs + drag!.dx * msPerPx() : startMs;
    const width = live && drag!.mode === 'resize' ? Math.max(MIN_MS, o.durationMs + drag!.dx * msPerPx()) : o.durationMs;
    const sel = selectedId === o.id;
    return (
      <div key={o.id} data-testid={`overlay-block-${o.id}`} onPointerDown={(e) => begin(e, o, 'move')} onPointerMove={moveTo} onPointerUp={() => end(o)} onClick={(e) => e.stopPropagation()}
        title={o.needsAttention ? o.attentionReason ?? '' : o.title}
        style={{ position: 'absolute', top: 8, bottom: 8, left: pct(Math.max(0, left)), width: pct(width), minWidth: 10, background: o.needsAttention ? '#FDECEA' : colour, color: o.needsAttention ? C.danger : '#fff', outline: sel ? `2px solid ${C.text}` : 'none', outlineOffset: 1, border: o.needsAttention ? `1px dashed ${C.danger}` : 'none', borderRadius: 10, cursor: 'grab', touchAction: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', overflow: 'hidden', boxSizing: 'border-box', opacity: o.status === 'ready' || o.needsAttention ? 1 : 0.65 }}>
        {o.needsAttention ? <AlertTriangle size={13} /> : o.status === 'preparing' ? <Loader2 size={13} className="spin" /> : null}
        <span aria-label={o.placementSource === 'auto' ? 'Placed automatically' : 'Placed by you'} title={o.placementSource === 'auto' ? 'Placed automatically' : 'Placed or edited by you'} style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: o.placementSource === 'auto' ? 'rgba(255,255,255,.55)' : '#fff', border: o.placementSource === 'auto' ? '1px dashed #fff' : 'none' }} />
        <span style={{ font: '600 12px/1 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.title}</span>
        {o.startMs != null && <div onPointerDown={(e) => begin(e, o, 'resize')} aria-label="Change duration" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 9, cursor: 'ew-resize', background: 'rgba(0,0,0,.25)' }} />}
      </div>
    );
  };

  const lane = (key: string, label: string, icon: React.ReactNode, height: number, content: React.ReactNode, extra?: React.ReactNode) => (
    <div key={key} style={{ display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`, borderTop: `1px solid ${C.border}` }}>
      <div style={{ position: 'sticky', left: 0, zIndex: 3, background: '#fff', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height, font: '500 13px/1.25 Satoshi', color: C.text, borderRight: `1px solid ${C.border}` }}>{icon}<span style={{ flex: 1 }}>{label}</span>{extra}</div>
      <div style={{ position: 'relative', height }}>{content}</div>
    </div>
  );

  return (
    <div style={{ background: '#fff', borderRadius: 16, border: `1px solid ${C.border}`, overflowX: 'auto', overflowY: 'hidden' }} data-testid="timeline">
      <div style={{ minWidth: LABEL_W + (total / 1000) * PX_PER_SEC_MIN }}>
        {/* ruler + scene headers */}
        <div style={{ display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr` }}>
          <div style={{ position: 'sticky', left: 0, zIndex: 3, background: '#fff', borderRight: `1px solid ${C.border}` }} />
          <div style={{ position: 'relative' }}>
            <div onClick={seekFromClick} style={{ position: 'relative', height: 30, cursor: 'pointer' }} data-testid="ruler">
              {ticks.map((t) => <span key={t} style={{ position: 'absolute', left: pct(t), top: 0, bottom: 0, borderLeft: `1px solid ${C.border}`, paddingLeft: 6, font: '500 12px/30px Satoshi', color: C.muted }}>{tickLabel(t)}</span>)}
              <span style={{ position: 'absolute', left: pct(Math.min(time, total)), top: 0, bottom: 0, width: 2, background: '#E11D2E', pointerEvents: 'none' }} />
            </div>
            <div onClick={seekFromClick} style={{ position: 'relative', height: 28, cursor: 'pointer' }}>
              {scenes.map((s) => <span key={s.screenId} style={{ position: 'absolute', left: pct(s.startMs), paddingLeft: 6, font: '600 13px/28px Satoshi', color: C.primary, whiteSpace: 'nowrap' }}>Scene {s.sceneNumber}</span>)}
              <span style={{ position: 'absolute', left: pct(Math.min(time, total)), top: 0, bottom: 0, width: 2, background: '#E11D2E', pointerEvents: 'none' }} />
            </div>
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          {/* lanes (click empty space to seek; the lanes share one clock) */}
          <div ref={innerRef} style={{ position: 'absolute', left: LABEL_W, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
            {scenes.map((s, i) => i > 0 && <span key={s.screenId} style={{ position: 'absolute', left: pct(s.startMs), top: 0, bottom: 0, borderLeft: '1px dashed #D9D6E4' }} />)}
            <span data-testid="playhead" style={{ position: 'absolute', left: pct(Math.min(time, total)), top: 0, bottom: 0, width: 2, background: '#E11D2E', zIndex: 4 }} />
          </div>
          {lane('generic', 'Generic B-roll', <Film size={16} />, 64,
            <div onClick={(e) => { onSelect(null); seekFromClick(e); }} style={{ position: 'absolute', inset: 0, cursor: 'pointer' }} data-testid="generic-lane">{overlays.filter((o) => o.kind === 'generic').map(block)}</div>,
            <button aria-label="Add a library clip" title={atLimit ? 'The B-roll limit is reached' : 'Add a library clip'} disabled={atLimit} onClick={onAddGeneric} style={{ width: 24, height: 24, borderRadius: 7, border: `1px solid ${C.borderStrong}`, background: '#fff', display: 'grid', placeItems: 'center', cursor: atLimit ? 'not-allowed' : 'pointer', opacity: atLimit ? 0.4 : 1 }}><Plus size={14} /></button>)}
          {lane('character', 'Character B-roll', <UserRound size={16} color={ORANGE} />, 64,
            <div onClick={(e) => { onSelect(null); seekFromClick(e); }} style={{ position: 'absolute', inset: 0, cursor: 'pointer' }} data-testid="character-lane">{overlays.filter((o) => o.kind === 'character').map(block)}</div>)}
          {lane('flow', 'Flow scenes', <Clapperboard size={16} />, 92,
            <div onClick={seekFromClick} style={{ position: 'absolute', inset: 0, cursor: 'pointer' }} data-testid="flow-track">
              {scenes.map((s) => {
                const n = Math.max(2, Math.min(6, Math.round(s.durationMs / 1500)));
                return (
                  <div key={s.screenId} title={s.dialogue} style={{ position: 'absolute', left: pct(s.startMs), width: pct(s.durationMs), top: 8, bottom: 8, boxSizing: 'border-box', padding: '0 1px', pointerEvents: 'none' }}>
                    <div style={{ position: 'relative', height: '100%', borderRadius: 10, overflow: 'hidden', background: s.clipUrl ? '#1B1B22' : '#EFEFEC', display: 'flex', border: `2px solid ${s.approved ? '#C9C2EA' : '#E4E4E0'}`, boxSizing: 'border-box' }}>
                      {s.clipUrl && Array.from({ length: n }).map((_, i) => <video key={i} src={`${s.clipUrl}#t=${(((i + 0.5) / n) * (s.durationMs / 1000)).toFixed(1)}`} muted playsInline preload="metadata" style={{ flex: 1, minWidth: 0, height: '100%', objectFit: 'cover', display: 'block' }} />)}
                      <span style={{ position: 'absolute', left: 8, top: 8, padding: '3px 8px', borderRadius: 7, background: 'rgba(17,17,19,.72)', color: '#fff', font: '600 12px/1 Satoshi' }}>Scene {s.sceneNumber} · {Math.round(s.durationMs / 1000)}s{s.lengthKnown ? '' : ' (est.)'}</span>
                    </div>
                  </div>
                );
              })}
            </div>)}
        </div>
      </div>

      {/* the small toolbar of the selected clip: Replace, Remove, Scene */}
      {selected && rect && !drag && (
        <div role="toolbar" aria-label="Selected B-roll" onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', zIndex: 40, left: rect.left + rect.width / 2, top: Math.max(8, rect.top - 46), transform: 'translateX(-50%)', display: 'flex', gap: 2, padding: 4, borderRadius: 12, background: '#111113', color: '#fff', boxShadow: '0 6px 20px rgba(0,0,0,.28)' }}>
          {selected.status === 'failed' && selected.kind === 'generic' && <TB label="Retry" onClick={() => onRetry(selected.id)} icon={<RotateCcw size={14} />} />}
          {selected.kind === 'generic' && <TB label="Replace" onClick={() => onReplace(selected.id)} icon={<Repeat2 size={14} />} />}
          <TB label="Remove" onClick={() => onRemove(selected.id)} icon={<Trash2 size={14} />} />
          <div style={{ position: 'relative' }}>
            <TB label="Scene" onClick={() => setMenu((m) => !m)} icon={<Clapperboard size={14} />} trailing={<ChevronDown size={12} />} active={menu} />
            {menu && (
              <div role="menu" aria-label="Move to a scene" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 150, maxHeight: 240, overflow: 'auto', background: '#fff', color: C.text, borderRadius: 10, border: `1px solid ${C.border}`, boxShadow: '0 10px 30px rgba(0,0,0,.18)', padding: 4 }}>
                {scenes.map((s) => (
                  <button key={s.screenId} role="menuitem" onClick={() => { setMenu(false); if (s.screenId !== selected.anchorScreenId) onScene(selected.id, s.screenId); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderRadius: 7, background: s.screenId === selected.anchorScreenId ? '#F5F3FF' : 'transparent', font: '500 13px/1 Satoshi', cursor: 'pointer', color: C.text }}>Scene {s.sceneNumber}{s.screenId === selected.anchorScreenId && <span style={{ marginLeft: 'auto', color: C.primary, font: '600 11px/1 Satoshi' }}>here</span>}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function TB({ label, icon, onClick, trailing, active }: { label: string; icon: React.ReactNode; onClick: () => void; trailing?: React.ReactNode; active?: boolean }) {
  return <button onClick={onClick} aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px', borderRadius: 8, border: 'none', background: active ? 'rgba(255,255,255,.16)' : 'transparent', color: '#fff', font: '600 12px/1 Satoshi', cursor: 'pointer', whiteSpace: 'nowrap' }}>{icon}{label}{trailing}</button>;
}

export { clock };
