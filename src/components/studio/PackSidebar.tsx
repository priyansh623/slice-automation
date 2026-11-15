'use client';

import { useState } from 'react';
import type { StudioPack } from '@/lib/studio/client';

interface Props {
  packs: StudioPack[];
  selectedId: number | null;
  showArchived: boolean;
  onShowArchived: (v: boolean) => void;
  onSelect: (id: number) => void;
  onCreate: (name: string) => Promise<void>;
}

export default function PackSidebar({ packs, selectedId, showArchived, onShowArchived, onSelect, onCreate }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try { await onCreate(name.trim()); setName(''); setAdding(false); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div style={{ width: 270, flexShrink: 0, borderRight: '1px solid #ECECE8', display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div style={{ padding: '18px 16px 10px' }}>
        <div style={{ font: '700 18px/1.2 Satoshi', marginBottom: 12 }}>Scene Packs</div>
        {adding ? (
          <div>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Pack name" aria-label="Pack name"
              onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setAdding(false); }}
              style={{ width: '100%', boxSizing: 'border-box', height: 36, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 10px', font: '400 13px Satoshi' }}
            />
            {error && <div role="alert" style={{ font: '400 12px/1.4 Satoshi', color: '#B91C1C', marginTop: 6 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={() => void create()} disabled={busy || !name.trim()} className="btn btn-primary" style={{ height: 32 }}>{busy ? 'Creating…' : 'Create'}</button>
              <button onClick={() => { setAdding(false); setError(''); }} className="btn btn-secondary" style={{ height: 32 }}>Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} style={{ width: '100%', height: 36, border: '1px dashed #6C47FF', borderRadius: 8, background: '#F5F3FF', color: '#6C47FF', font: '600 13px Satoshi', cursor: 'pointer' }}>+ New pack</button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {packs.length === 0 && <div style={{ padding: '16px', font: '400 13px/1.5 Satoshi', color: '#75757C' }}>No Scene Packs yet. Create one to start adding images.</div>}
        {packs.map((p) => {
          const active = p.id === selectedId;
          return (
            <button key={p.id} onClick={() => onSelect(p.id)} aria-current={active} style={{
              width: '100%', textAlign: 'left', padding: '11px 16px', border: 'none', borderBottom: '1px solid #F4F4F0', cursor: 'pointer',
              background: active ? '#F5F3FF' : 'transparent', display: 'block',
            }}>
              <div style={{ font: `${active ? 700 : 600} 14px/1.3 Satoshi`, color: '#111113', opacity: p.archivedAt ? 0.55 : 1 }}>{p.name}{p.archivedAt ? ' (archived)' : ''}</div>
              <div style={{ font: '400 12px/1.4 Satoshi', color: '#75757C', marginTop: 2 }}>
                {p.assetCount} image{p.assetCount === 1 ? '' : 's'}
                {p.analysisPending > 0 && <span style={{ color: '#6D28D9' }}> · {p.analysisPending} analysing</span>}
                {p.analysisFailed > 0 && <span style={{ color: '#B91C1C' }}> · {p.analysisFailed} failed</span>}
              </div>
            </button>
          );
        })}
      </div>

      <label style={{ padding: '10px 16px', borderTop: '1px solid #ECECE8', font: '400 12px Satoshi', color: '#5E5E65', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={showArchived} onChange={(e) => onShowArchived(e.target.checked)} /> Show archived packs
      </label>
    </div>
  );
}
