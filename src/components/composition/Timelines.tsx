'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { fmtTime, snap, toAnchor } from '@/lib/overlays/ui-math';
import { C, type CompOverlay, type CompScene } from './types';

interface Props {
  scenes: CompScene[]; overlays: CompOverlay[]; totalMs: number; time: number; selectedId: number | null;
  onSeek: (ms: number) => void; onSelect: (id: number | null) => void;
  onMove: (id: number, to: { anchorScreenId: number; startOffsetMs: number }) => void;
  onResize: (id: number, durationMs: number) => void;
}
const MIN_MS = 500;

/** The primary Flow timeline (read-only, in compile order, widths proportional to length) and the one B-roll track below it. */
export default function Timelines({ scenes, overlays, totalMs, time, selectedId, onSeek, onSelect, onMove, onResize }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: number; mode: 'move' | 'resize'; startX: number; dx: number } | null>(null);
  const total = Math.max(1, totalMs);
  const pct = (ms: number) => `${(ms / total) * 100}%`;
  const msPerPx = () => { const w = trackRef.current?.getBoundingClientRect().width ?? 1; return total / Math.max(1, w); };

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
    const r = trackRef.current?.getBoundingClientRect(); if (!r) return;
    onSeek(Math.max(0, Math.min(total, ((e.clientX - r.left) / r.width) * total)));
  };

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: '#fff', padding: '12px 14px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 10, alignItems: 'center' }}>
        <div style={label}>Script</div>
        <div style={{ position: 'relative', height: 40, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }} data-testid="script-track" aria-label="Script by scene">
          {scenes.map((s) => (
            <div key={s.screenId} title={s.dialogue} style={{ position: 'absolute', left: pct(s.startMs), width: pct(s.durationMs), top: 0, bottom: 0, boxSizing: 'border-box', borderRight: `1px solid ${C.border}`, padding: '4px 6px', overflow: 'hidden', font: '400 10px/1.3 Satoshi', color: C.muted }}>{s.dialogue}</div>
          ))}
        </div>
        <div style={label}>Flow scenes</div>
        <div ref={trackRef} onClick={seekFromClick} style={{ position: 'relative', height: 46, background: C.soft, borderRadius: 8, cursor: 'pointer', overflow: 'hidden' }} data-testid="flow-track">
          {scenes.map((s, i) => (
            <div key={s.screenId} title={s.dialogue} style={{ position: 'absolute', left: pct(s.startMs), width: pct(s.durationMs), top: 0, bottom: 0, boxSizing: 'border-box', borderRight: i < scenes.length - 1 ? '2px solid #fff' : 'none', background: s.clipUrl ? '#E9E5FB' : '#EFEFEC', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 8px', overflow: 'hidden' }}>
              <span style={{ font: '700 12px/1.2 Satoshi', color: C.text, whiteSpace: 'nowrap' }}>Scene {s.sceneNumber}</span>
              <span style={{ font: '400 11px/1.2 Satoshi', color: C.muted, whiteSpace: 'nowrap' }}>{(s.durationMs / 1000).toFixed(1)}s{s.lengthKnown ? '' : ' (est.)'}</span>
            </div>
          ))}
          <div style={{ position: 'absolute', left: pct(Math.min(time, total)), top: 0, bottom: 0, width: 2, background: C.primary, pointerEvents: 'none' }} />
        </div>

        <div style={label}>B-roll</div>
        <div onClick={seekFromClick} style={{ position: 'relative', height: 46, background: C.soft, borderRadius: 8, cursor: 'pointer', overflow: 'hidden' }} data-testid="overlay-track">
          {overlays.length === 0 && <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', font: '400 12px/1 Satoshi', color: C.muted }}>No B-roll yet. Add some from the buttons above.</span>}
          {overlays.map((o) => {
            const colour = o.kind === 'character' ? C.character : C.generic;
            const live = drag?.id === o.id;
            const startMs = o.startMs ?? 0;
            const left = live && drag!.mode === 'move' ? startMs + drag!.dx * msPerPx() : startMs;
            const width = live && drag!.mode === 'resize' ? Math.max(MIN_MS, o.durationMs + drag!.dx * msPerPx()) : o.durationMs;
            const sel = selectedId === o.id;
            return (
              <div key={o.id} data-testid={`overlay-block-${o.id}`} onPointerDown={(e) => begin(e, o, 'move')} onPointerMove={moveTo} onPointerUp={() => end(o)} onClick={(e) => e.stopPropagation()}
                title={o.needsAttention ? o.attentionReason ?? '' : o.title}
                style={{ position: 'absolute', top: 5, bottom: 5, left: pct(Math.max(0, left)), width: pct(width), minWidth: 8, background: o.needsAttention ? '#FDECEA' : colour, color: o.needsAttention ? C.danger : '#fff', border: sel ? `2px solid ${C.text}` : o.needsAttention ? `1px dashed ${C.danger}` : 'none', borderRadius: 6, cursor: 'grab', touchAction: 'none', display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px', overflow: 'hidden', boxSizing: 'border-box', opacity: o.status === 'ready' || o.needsAttention ? 1 : 0.65 }}>
                {o.needsAttention ? <AlertTriangle size={12} /> : o.status === 'preparing' ? <Loader2 size={12} className="spin" /> : null}
                <span aria-label={o.placementSource === 'auto' ? 'Placed automatically' : 'Placed by you'} title={o.placementSource === 'auto' ? 'Placed automatically' : 'Placed or edited by you'} style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: o.placementSource === 'auto' ? 'rgba(255,255,255,.55)' : '#fff', border: o.placementSource === 'auto' ? '1px dashed #fff' : 'none' }} />
                <span style={{ font: '500 11px/1 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.title}</span>
                {o.startMs != null && <div onPointerDown={(e) => begin(e, o, 'resize')} aria-label="Change duration" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', background: 'rgba(0,0,0,.25)' }} />}
              </div>
            );
          })}
          <div style={{ position: 'absolute', left: pct(Math.min(time, total)), top: 0, bottom: 0, width: 2, background: C.primary, pointerEvents: 'none' }} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, marginLeft: 102, font: '400 11px/1 Satoshi', color: C.muted }}><span>0:00.0</span><span>{fmtTime(total)}</span></div>
      <div style={{ marginTop: 6, marginLeft: 102, font: '400 11px/1.4 Satoshi', color: C.muted }}>Dashed dot: placed automatically from the scene it was chosen for. Solid dot: placed or edited by you (never moved automatically).</div>
      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
const label: React.CSSProperties = { font: '500 12px/1.2 Satoshi', color: '#75757C' };
