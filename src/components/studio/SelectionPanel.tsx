'use client';

import type { GenerationConfig, SelectionRow } from '@/lib/studio/client';

interface Props {
  selection: SelectionRow[];
  busy: boolean;
  hasCharacter: boolean;
  /** Whether generation is on, and whether it is the test provider. Unknown (null) until it has loaded. */
  generation?: GenerationConfig | null;
  onRemove: (assetIds: number[]) => void;
  onClear: () => void;
  onGenerate: () => void;
}

/** The one shared selection across all approved packs, reviewed before it is submitted as a batch. */
export default function SelectionPanel({ selection, busy, hasCharacter, generation, onRemove, onClear, onGenerate }: Props) {
  const archived = selection.filter((s) => s.archived);
  const usable = selection.length - archived.length;
  const byPack = new Map<string, SelectionRow[]>();
  for (const s of selection) byPack.set(s.packName, [...(byPack.get(s.packName) ?? []), s]);

  return (
    <div style={{ border: '1px solid #ECECE8', borderRadius: 12, background: '#fff', padding: '16px 18px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ font: '700 15px/1.3 Satoshi' }}>5. Your selection ({selection.length})</div>
          <div style={{ font: '400 12px/1.5 Satoshi', color: '#75757C' }}>One selection across all approved packs. Tick images in the pack grids above to add them here.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {selection.length > 0 && <button className="btn btn-secondary" disabled={busy} onClick={onClear} style={{ height: 34 }}>Clear selection</button>}
          <button className="btn btn-primary" disabled={busy || usable === 0 || archived.length > 0 || !hasCharacter || generation?.enabled === false} onClick={onGenerate} style={{ height: 34 }} title={generation?.enabled === false ? 'Image generation is not switched on' : !hasCharacter ? 'Upload the character image first' : archived.length > 0 ? 'Remove the archived images first' : ''}>
            {busy ? 'Submitting…' : `Generate ${usable} image${usable === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
      {generation?.enabled === false && <div role="alert" style={{ font: '400 12px/1.5 Satoshi', color: '#92400E', marginTop: 8 }}>{generation.reason ?? 'Image generation is not switched on yet.'}</div>}
      {generation?.enabled && generation.testMode && <div role="status" style={{ font: '500 12px/1.5 Satoshi', color: '#6D28D9', marginTop: 8 }}>Test mode: generated images are placeholders, not real results. No provider is being used.</div>}
      {!hasCharacter && selection.length > 0 && <div role="status" style={{ font: '400 12px Satoshi', color: '#92400E', marginTop: 8 }}>Upload the base character image (step 1) before generating.</div>}
      {archived.length > 0 && <div role="alert" style={{ font: '400 12px/1.5 Satoshi', color: '#92400E', marginTop: 8 }}>{archived.length} selected image{archived.length === 1 ? ' is' : 's are'} archived and cannot be generated. Remove {archived.length === 1 ? 'it' : 'them'} to continue.</div>}
      {selection.length === 0 && <div style={{ font: '400 13px Satoshi', color: '#75757C', marginTop: 10 }}>Nothing selected yet.</div>}
      {[...byPack.entries()].map(([pack, rows]) => (
        <div key={pack} style={{ marginTop: 12 }}>
          <div style={{ font: '600 12px Satoshi', color: '#5E5E65', marginBottom: 6 }}>{pack} ({rows.length})</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {rows.map((s) => (
              <div key={s.assetId} style={{ position: 'relative', width: 84, opacity: s.archived ? 0.6 : 1 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {s.image.thumbUrl ? <img src={s.image.thumbUrl} alt="" style={{ width: 84, height: 63, objectFit: 'cover', borderRadius: 8, display: 'block', background: '#F4F4F0' }} /> : <div style={{ width: 84, height: 63, borderRadius: 8, background: '#F4F4F0' }} />}
                {s.archived && <span style={{ position: 'absolute', left: 3, top: 3, background: '#374151', color: '#fff', borderRadius: 4, padding: '0 5px', font: '600 9px/1.6 Satoshi' }}>Archived</span>}
                <button aria-label={`Remove image ${s.assetId} from the selection`} onClick={() => onRemove([s.assetId])} disabled={busy} style={{ position: 'absolute', right: 3, top: 3, width: 18, height: 18, borderRadius: 9, border: 'none', background: 'rgba(17,17,19,.75)', color: '#fff', cursor: 'pointer', lineHeight: '16px', fontSize: 12 }}>×</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
