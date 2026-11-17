'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Replace, Trash2 } from 'lucide-react';
import { fmtTime } from '@/lib/overlays/ui-math';
import { C, type CompItem, type CompOverlay, type CompScene } from './types';

interface Props {
  overlay: CompOverlay | null; scenes: CompScene[]; item: CompItem | null;
  onChange: (id: number, patch: Record<string, number>) => Promise<string | null>;
  onRemove: (id: number) => void; onReplace: (id: number) => void; onRetry: (id: number) => void;
}

const statusText: Record<string, string> = { preparing: 'Preparing the silent copy…', ready: 'Ready', failed: 'Failed' };

export default function Details({ overlay, scenes, item, onChange, onRemove, onReplace, onRetry }: Props) {
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setErr(null), [overlay?.id]);
  if (!overlay) return <div style={card}><div style={{ font: '400 13px/1.5 Satoshi', color: C.muted }}>Select a B-roll block on the timeline to see and change its details.</div></div>;

  const commit = async (field: 'startOffsetMs' | 'durationMs' | 'sourceStartMs', seconds: string) => {
    const n = Math.round(parseFloat(seconds) * 1000);
    if (!Number.isFinite(n)) return;
    setErr(await onChange(overlay.id, { [field]: n }));
  };
  const sourceLine = overlay.kind === 'generic' ? `Library clip · ${overlay.title}` : `Character B-roll${item?.clipEndpoint ? ` · ${item.clipEndpoint}` : ''}`;
  const maxTrim = overlay.assetDurationMs != null ? Math.max(0, (overlay.assetDurationMs - 500) / 1000) : undefined;

  return (
    <div style={card} data-testid="overlay-details">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ font: '700 14px/1.3 Satoshi' }}>{overlay.kind === 'character' ? 'Character B-roll' : 'Library B-roll'}</div>
        <span style={{ ...pill, background: overlay.status === 'ready' ? '#E7F5EE' : overlay.status === 'failed' ? '#FDECEA' : '#FFF4D6', color: overlay.status === 'ready' ? C.ok : overlay.status === 'failed' ? C.danger : C.warn }}>{statusText[overlay.status]}</span>
      </div>
      <div style={{ font: '400 12px/1.4 Satoshi', color: C.muted, marginTop: 4 }}>{sourceLine}</div>
      <div style={{ font: '500 11px/1.4 Satoshi', color: overlay.placementSource === 'auto' ? C.muted : C.primary, marginTop: 4 }} data-testid="placement-source">{overlay.placementSource === 'auto' ? 'Placed automatically. Change it and it becomes yours.' : 'Placed or edited by you. It is never moved automatically.'}</div>

      {overlay.needsAttention && (
        <div role="alert" style={{ display: 'flex', gap: 8, marginTop: 10, padding: '8px 10px', borderRadius: 8, background: '#FDECEA', color: C.danger, font: '400 12px/1.4 Satoshi' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{overlay.attentionReason}</span>
        </div>
      )}
      {overlay.problems.filter((p) => p.code !== 'anchor_missing').map((p) => <div key={p.code} style={{ marginTop: 8, font: '400 12px/1.4 Satoshi', color: C.danger }}>{p.message}</div>)}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        <label style={field}>Flow scene
          <select value={overlay.anchorScreenId} onChange={async (e) => setErr(await onChange(overlay.id, { anchorScreenId: Number(e.target.value), startOffsetMs: 0 }))} style={input}>
            {scenes.map((s) => <option key={s.screenId} value={s.screenId}>Scene {s.sceneNumber}</option>)}
          </select>
        </label>
        <label style={field}>Starts in the scene at (s)
          <input key={`s${overlay.id}-${overlay.startOffsetMs}`} type="number" step="0.1" min="0" defaultValue={(overlay.startOffsetMs / 1000).toFixed(1)} onBlur={(e) => commit('startOffsetMs', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} style={input} />
        </label>
        <label style={field}>Duration (s)
          <input key={`d${overlay.id}-${overlay.durationMs}`} type="number" step="0.1" min="0.5" defaultValue={(overlay.durationMs / 1000).toFixed(1)} onBlur={(e) => commit('durationMs', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} style={input} />
        </label>
        <label style={field}>Trim in (s)
          <input key={`t${overlay.id}-${overlay.sourceStartMs}`} type="number" step="0.1" min="0" max={maxTrim} defaultValue={(overlay.sourceStartMs / 1000).toFixed(1)} onBlur={(e) => commit('sourceStartMs', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} style={input} />
        </label>
      </div>
      {err && <div role="alert" style={{ marginTop: 8, font: '400 12px/1.4 Satoshi', color: C.danger }}>{err}</div>}

      <div style={{ font: '400 12px/1.5 Satoshi', color: C.muted, marginTop: 10 }}>
        {overlay.startMs != null ? <>On the video: {fmtTime(overlay.startMs)} to {fmtTime(overlay.endMs ?? overlay.startMs)}. </> : null}
        Silent: the Flow narration keeps playing underneath.
      </div>
      {overlay.status === 'failed' && overlay.errorMessage && <div style={{ marginTop: 8, font: '400 12px/1.4 Satoshi', color: C.danger }}>{overlay.errorMessage}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        {overlay.kind === 'generic' && <button style={ghost} onClick={() => onReplace(overlay.id)}><Replace size={13} /> Replace clip</button>}
        {overlay.kind === 'generic' && overlay.status === 'failed' && <button style={ghost} onClick={() => onRetry(overlay.id)}><RefreshCw size={13} /> Retry</button>}
        <button style={{ ...ghost, color: C.danger }} onClick={() => onRemove(overlay.id)}><Trash2 size={13} /> Remove</button>
      </div>
    </div>
  );
}
const card: React.CSSProperties = { border: `1px solid ${C.border}`, borderRadius: 12, background: '#fff', padding: 16 };
const pill: React.CSSProperties = { height: 22, padding: '0 9px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', font: '500 11px/1 Satoshi' };
const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, font: '500 11px/1.2 Satoshi', color: C.muted };
const input: React.CSSProperties = { height: 32, borderRadius: 8, border: `1px solid ${C.borderStrong}`, padding: '0 8px', font: '400 13px/1 Satoshi', background: '#fff', color: C.text };
const ghost: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 8, background: '#fff', border: `1px solid ${C.borderStrong}`, font: '500 12px/1 Satoshi', cursor: 'pointer', color: C.text };
