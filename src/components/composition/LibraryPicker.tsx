'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchClips } from '@/lib/broll-search';
import { api, C } from './types';

interface Clip { id: number; title: string; signedUrl: string | null; durationSeconds: number | null; userTags: string | null; subject: string | null; activity: string | null; setting: string | null; brand: string | null; description: string | null; categoryIds: number[]; brands?: { brandName: string | null; role: string }[]; createdAt: number }

/** The existing B-roll library (same endpoint and search as the library page). Choosing a clip adds it, or replaces the selected one. */
export default function LibraryPicker({ title, onPick, onClose }: { title: string; onPick: (clipId: number) => void; onClose: () => void }) {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [q, setQ] = useState('');
  const [cats, setCats] = useState<unknown[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Clip[]>('/api/v1/broll').then((r) => (r.ok ? setClips(r.data as unknown as Clip[]) : setError(r.data.error ?? 'Could not load the library.')));
    api<unknown>('/api/v1/broll/categories').then((r) => { const d = r.data as unknown; const flat = (Array.isArray(d) ? d : (d as { categories?: unknown[] })?.categories ?? []) as Array<{ id: number; children?: unknown[] }>; const out: unknown[] = []; const walk = (n: Array<{ id: number; children?: unknown[] }>) => n.forEach((c) => { out.push(c); if (c.children) walk(c.children as typeof n); }); walk(flat); setCats(out); }).catch(() => undefined);
  }, []);
  const shown = useMemo(() => {
    if (!clips) return [];
    if (!q.trim()) return clips;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return searchClips(q, clips as any, cats as any).hits.map((h) => h.clip as unknown as Clip);
  }, [clips, q, cats]);
  return (
    <div role="dialog" aria-label={title} style={backdrop} onClick={onClose}>
      <div style={sheet} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ font: '700 16px/1.2 Satoshi' }}>{title}</div>
          <button aria-label="Close" onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: C.muted }} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the B-roll library" style={{ width: '100%', height: 36, borderRadius: 9, border: `1px solid ${C.borderStrong}`, padding: '0 12px 0 30px', font: '400 13px/1 Satoshi', boxSizing: 'border-box' }} />
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {!clips && !error && <div style={{ color: C.muted, font: '400 13px/1 Satoshi' }}>Loading…</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10, overflow: 'auto', maxHeight: '55vh' }}>
          {shown.map((c) => (
            <button key={c.id} onClick={() => onPick(c.id)} style={{ textAlign: 'left', border: `1px solid ${C.border}`, borderRadius: 10, background: '#fff', padding: 0, cursor: 'pointer', overflow: 'hidden' }}>
              {c.signedUrl ? <video src={c.signedUrl} muted preload="metadata" style={{ width: '100%', aspectRatio: '9 / 16', objectFit: 'cover', background: '#000', display: 'block' }} /> : <div style={{ aspectRatio: '9 / 16', background: C.soft }} />}
              <div style={{ padding: '6px 8px', font: '500 12px/1.3 Satoshi', color: C.text }}>{c.title}<div style={{ color: C.muted, font: '400 11px/1.3 Satoshi' }}>{c.durationSeconds ? `${c.durationSeconds}s` : ''}</div></div>
            </button>
          ))}
          {clips && shown.length === 0 && <div style={{ color: C.muted, font: '400 13px/1.4 Satoshi' }}>No clips match.</div>}
        </div>
      </div>
    </div>
  );
}
export const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(17,17,19,.45)', display: 'grid', placeItems: 'center', zIndex: 50, padding: 16 };
export const sheet: React.CSSProperties = { width: 'min(760px, 100%)', maxHeight: '85vh', background: '#fff', borderRadius: 14, padding: 20, boxShadow: '0 20px 60px rgba(0,0,0,.25)' };
