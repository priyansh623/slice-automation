'use client';

import type { StudioAsset } from '@/lib/studio/client';

const STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  pending: { label: 'Waiting for analysis', bg: '#EDE9FE', fg: '#6D28D9' },
  processing: { label: 'Analysing…', bg: '#EDE9FE', fg: '#6D28D9' },
  completed: { label: 'Analysed', bg: '#DCFCE7', fg: '#16A34A' },
  failed: { label: 'Analysis failed', bg: '#FEE2E2', fg: '#B91C1C' },
  skipped: { label: 'Not analysed', bg: '#F3F4F6', fg: '#6B7280' },
};

interface Props {
  assets: StudioAsset[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Optional per-card extras (the Studio adds selection checkboxes here). */
  renderExtra?: (asset: StudioAsset) => React.ReactNode;
}

/** Every image of a pack as a thumbnail card with its analysis state. Nothing is hidden by what an image looks like. */
export default function AssetGrid({ assets, selectedId, onSelect, renderExtra }: Props) {
  if (assets.length === 0) return <div style={{ padding: '40px 0', textAlign: 'center', font: '400 14px/1.5 Satoshi', color: '#75757C' }}>No images to show.</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 12 }}>
      {assets.map((a) => {
        const st = STATUS[a.analysisStatus] ?? STATUS.skipped;
        const active = a.id === selectedId;
        return (
          <div key={a.id} style={{ position: 'relative', border: `2px solid ${active ? '#6C47FF' : '#ECECE8'}`, borderRadius: 12, overflow: 'hidden', background: '#fff', opacity: a.archived ? 0.55 : 1 }}>
            <button onClick={() => onSelect(a.id)} aria-label={`Open ${a.originalFilename ?? `image ${a.id}`}`} style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: '#F4F4F0', cursor: 'pointer', aspectRatio: '4 / 3' }}>
              {a.thumbUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={a.thumbUrl} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                : <span style={{ font: '400 12px Satoshi', color: '#9A9AA0' }}>No preview</span>}
            </button>
            <div style={{ padding: '7px 9px 9px' }}>
              <div style={{ font: '500 12px/1.3 Satoshi', color: '#111113', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.metadata.environment ? String(a.metadata.environment) : (a.originalFilename ?? `Image ${a.id}`)}</div>
              <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
                <span style={{ padding: '1px 7px', borderRadius: 999, background: st.bg, color: st.fg, font: '500 10px/1.5 Satoshi' }}>{st.label}</span>
                {a.hasManualEdits && <span style={{ padding: '1px 7px', borderRadius: 999, background: '#FEF3C7', color: '#92400E', font: '500 10px/1.5 Satoshi' }}>Edited</span>}
                {a.archived && <span style={{ padding: '1px 7px', borderRadius: 999, background: '#F3F4F6', color: '#6B7280', font: '500 10px/1.5 Satoshi' }}>Archived</span>}
              </div>
              {renderExtra?.(a)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
