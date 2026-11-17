'use client';

import { useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { C } from '@/components/composition/types';
import { primaryBtn } from '@/components/studio/ui/ds';
import type { Scene } from './useBrollSelection';

/** The script, scene by scene, on the left. Click a scene to see what fits it; the badge counts what is already chosen for it. */
export function ScriptRail({ scenes, counts, focus, onFocus }: { scenes: Scene[]; counts: Record<number, number>; focus: number | null; onFocus: (id: number | null) => void }) {
  return (
    <aside style={{ width: 300, flexShrink: 0, borderRight: '1px solid #ECECE8', background: '#fff', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '16px 18px 8px', font: '700 15px/1.3 Satoshi' }}>Script</div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {scenes.map((s) => (
          <div key={s.screenId} role="button" tabIndex={0} aria-pressed={focus === s.screenId} onClick={() => onFocus(focus === s.screenId ? null : s.screenId)} onKeyDown={(e) => { if (e.key === 'Enter') onFocus(focus === s.screenId ? null : s.screenId); }}
            style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', background: focus === s.screenId ? '#EFEBFF' : 'transparent', font: '400 14px/1.5 Satoshi', color: '#111113' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}><b style={{ font: '700 11px/1 Satoshi', color: '#6C47FF', textTransform: 'uppercase', letterSpacing: '.05em' }}>Scene {s.sceneNumber}</b>{counts[s.screenId] ? <span style={{ height: 18, padding: '0 7px', borderRadius: 999, background: '#6C47FF', color: '#fff', font: '600 10px/18px Satoshi' }}>{counts[s.screenId]} chosen</span> : null}</div>
            {s.dialogue}
          </div>
        ))}
        {focus !== null && <button onClick={() => onFocus(null)} style={{ alignSelf: 'flex-start', border: 'none', background: 'none', color: '#75757C', font: '500 12px/1 Satoshi', cursor: 'pointer', padding: '4px 12px' }}>Show everything</button>}
      </div>
    </aside>
  );
}

/** Which scene(s) does this go in? Opens when something is ticked. `suggested` scenes are only a hint; nothing is chosen for you. */
export function ScenePicker({ title, subtitle, thumb, scenes, initial, suggested, withAction, initialAction, onSave, onClose }: {
  title: string; subtitle?: string; thumb: { kind: 'video' | 'image'; url: string | null }; scenes: Scene[]; initial: number[]; suggested: number[];
  withAction: boolean; initialAction: string; onSave: (screenIds: number[], action: string) => void; onClose: () => void;
}) {
  const [chosen, setChosen] = useState<number[]>(initial); const [action, setAction] = useState(initialAction);
  const toggle = (id: number) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <div role="dialog" aria-label={title} onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(17,17,19,.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 100%)', maxHeight: '86vh', overflow: 'auto', background: '#fff', borderRadius: 16, padding: 20, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', gap: 14 }}>
          <div style={{ width: 84, aspectRatio: '9/16', borderRadius: 10, background: '#111113', overflow: 'hidden', flexShrink: 0 }}>
            {thumb.url && (thumb.kind === 'video' ? <video src={thumb.url} muted autoPlay loop playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <img src={thumb.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'start', gap: 8 }}><div style={{ flex: 1, font: '700 16px/1.3 Satoshi' }}>{title}</div><button aria-label="Close" onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={18} /></button></div>
            {subtitle && <div style={{ font: '400 12px/1.4 Satoshi', color: C.muted, marginTop: 2 }}>{subtitle}</div>}
            <div style={{ font: '600 13px/1.3 Satoshi', margin: '12px 0 8px' }}>Which scene is this for?</div>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          {scenes.map((s) => {
            const on = chosen.includes(s.screenId);
            return (
              <button key={s.screenId} onClick={() => toggle(s.screenId)} aria-pressed={on} style={{ display: 'flex', gap: 10, alignItems: 'start', textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: on ? '2px solid #6C47FF' : '1px solid #E4E4E0', background: on ? '#F5F3FF' : '#fff', cursor: 'pointer' }}>
                <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 1, background: on ? '#6C47FF' : '#fff', border: `1.5px solid ${on ? '#6C47FF' : '#C4C4C9'}`, color: '#fff', display: 'grid', placeItems: 'center' }}>{on && <Check size={13} />}</span>
                <span style={{ flex: 1, font: '400 13px/1.45 Satoshi', color: '#111113' }}><b style={{ font: '700 12px/1 Satoshi' }}>Scene {s.sceneNumber}</b>{suggested.includes(s.screenId) && <span style={{ marginLeft: 8, color: '#6C47FF', font: '600 11px/1 Satoshi' }}><Sparkles size={11} style={{ verticalAlign: -1 }} /> fits this scene</span>}<br />{s.dialogue}</span>
              </button>
            );
          })}
        </div>
        {withAction && (
          <label style={{ display: 'block', margin: '14px 0 0', font: '600 12px/1.3 Satoshi' }}>What should the character do? <span style={{ color: C.muted, font: '400 12px/1 Satoshi' }}>(optional, used to write the motion prompt)</span>
            <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="For example: taps her card at the cafe counter" style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, height: 38, borderRadius: 8, border: '1px solid #E4E4E0', padding: '0 12px', font: '400 13px/1 Satoshi' }} />
          </label>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => { onSave(chosen, action); onClose(); }} style={primaryBtn}>{chosen.length === 0 ? (initial.length ? 'Remove' : 'Done') : `Use in ${chosen.length} scene${chosen.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>
  );
}

export interface TrayItem { key: string; url: string | null; kind: 'video' | 'image'; sceneNumber: number | string; onRemove: () => void }
/** The bottom bar of the selection views: what is chosen so far (thumbnail, scene, remove), Clear, and the main button. */
export function Tray({ items, onClear, onDone, doneLabel, saving }: { items: TrayItem[]; onClear: () => void; onDone: () => void; doneLabel: string; saving: boolean }) {
  return (
    <div style={{ flexShrink: 0, background: '#fff', borderTop: '1px solid #ECECE8', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 8, overflowX: 'auto', alignItems: 'center', minHeight: 64 }}>
        {items.length === 0 && <span style={{ font: '400 13px/1.5 Satoshi', color: '#A3A3A9' }}>Tap anything to choose it, then pick the scene it is for.</span>}
        {items.map((it) => (
          <div key={it.key} title={`Scene ${it.sceneNumber}`} style={{ position: 'relative', width: 36, height: 64, borderRadius: 6, background: '#E4E4E0', overflow: 'hidden', flexShrink: 0 }}>
            {it.url && (it.kind === 'video' ? <video src={it.url} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <img src={it.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />)}
            <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.6)', color: '#fff', font: '600 9px/12px Satoshi', textAlign: 'center' }}>S{it.sceneNumber}</span>
            <button aria-label="Remove" onClick={it.onRemove} style={{ position: 'absolute', top: 2, right: 2, width: 16, height: 16, border: 'none', borderRadius: 8, background: 'rgba(0,0,0,.55)', color: '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0 }}><X size={10} /></button>
          </div>
        ))}
      </div>
      <button onClick={onClear} disabled={items.length === 0} style={{ height: 38, padding: '0 14px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer', opacity: items.length ? 1 : 0.5 }}>Clear</button>
      <button onClick={onDone} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>{doneLabel}</button>
    </div>
  );
}
