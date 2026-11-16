'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, FIELD_LABELS, FIELD_ORDER, type MetaKey, type StudioAsset } from '@/lib/studio/client';
import ImportPanel from './ImportPanel';

interface Props {
  asset: StudioAsset;
  onChange: (asset: StudioAsset) => void;
  onClose: () => void;
  /** The Studio shows the same panel read-only. */
  readOnly?: boolean;
}

const asText = (v: string | string[] | null | undefined): string => (Array.isArray(v) ? v.join(', ') : (v ?? ''));
const chip = (p: string) => (p === 'manual' ? { t: 'Edited by you', bg: '#FEF3C7', fg: '#92400E' } : p === 'imported' ? { t: 'Imported', bg: '#DBEAFE', fg: '#1D4ED8' } : p === 'ai' ? { t: 'AI', bg: '#EDE9FE', fg: '#6D28D9' } : { t: 'Empty', bg: '#F3F4F6', fg: '#6B7280' });

/** The image, its analysis state, and every metadata field with where its value came from. Edits are saved as manual values. */
export default function AssetDetail({ asset, onChange, onClose, readOnly }: Props) {
  const initial = useMemo(() => Object.fromEntries(FIELD_ORDER.map((k) => [k, asText(asset.metadata[k])])) as Record<MetaKey, string>, [asset]);
  const [draft, setDraft] = useState<Record<MetaKey, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setDraft(initial); setError(''); }, [initial, asset.id]);
  // Lists only carry thumbnails; the full-size original is loaded here, for the one image that is open.
  const [fullUrl, setFullUrl] = useState<string | null>(asset.imageUrl);
  useEffect(() => {
    setFullUrl(asset.imageUrl);
    if (asset.imageUrl) return;
    let cancelled = false;
    api<{ asset: StudioAsset }>(`/api/v1/studio/assets/${asset.id}`).then((r) => { if (!cancelled) setFullUrl(r.asset.imageUrl); }).catch(() => {});
    return () => { cancelled = true; };
  }, [asset.id, asset.imageUrl]);

  const changed = FIELD_ORDER.filter((k) => draft[k] !== initial[k]);

  async function run(fn: () => Promise<{ asset: StudioAsset }>) {
    setBusy(true); setError('');
    try { onChange((await fn()).asset); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const save = () => run(() => api(`/api/v1/studio/assets/${asset.id}/metadata`, {
    method: 'PUT',
    body: { fields: Object.fromEntries(changed.map((k) => [k, k === 'tags' ? draft[k].split(',').map((t) => t.trim()).filter(Boolean) : (draft[k].trim() || null)])) },
  }));
  const revert = (k: MetaKey) => run(() => api(`/api/v1/studio/assets/${asset.id}/metadata`, { method: 'PUT', body: { revert: [k] } }));
  const reanalyse = () => run(() => api(`/api/v1/studio/assets/${asset.id}/reanalyze`, { method: 'POST' }));
  const archive = (archived: boolean) => run(() => api(`/api/v1/studio/assets/${asset.id}/archive`, { method: 'POST', body: { archived } }));

  const statusText = { pending: 'Waiting for analysis', processing: 'Analysing…', completed: 'Analysed', failed: 'Analysis failed', skipped: 'Not analysed' }[asset.analysisStatus];

  return (
    <div style={{ width: 380, flexShrink: 0, borderLeft: '1px solid #ECECE8', background: '#fff', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px 8px' }}>
        <div style={{ font: '700 15px/1.3 Satoshi', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.originalFilename ?? `Image ${asset.id}`}</div>
        <button onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'none', fontSize: 20, cursor: 'pointer', color: '#75757C' }}>×</button>
      </div>
      <div style={{ padding: '0 16px' }}>
        {fullUrl ?? asset.thumbUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={(fullUrl ?? asset.thumbUrl)!} alt="" style={{ width: '100%', borderRadius: 10, display: 'block', background: '#F4F4F0' }} />
          : <div style={{ height: 160, background: '#F4F4F0', borderRadius: 10 }} />}
        <div style={{ font: '400 12px/1.5 Satoshi', color: '#75757C', marginTop: 6 }}>
          {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}{(asset.sizeBytes / 1048576).toFixed(2)} MB · {asset.mime.replace('image/', '').toUpperCase()}. The original is stored unchanged.
        </div>

        <div style={{ margin: '12px 0', padding: '9px 11px', border: '1px solid #ECECE8', borderRadius: 10, background: '#FAFAF8' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ font: '600 13px Satoshi', color: asset.analysisStatus === 'failed' ? '#B91C1C' : '#111113' }}>{statusText}</span>
            {!readOnly && !asset.archived && <button onClick={reanalyse} disabled={busy || asset.analysisStatus === 'processing'} className="btn btn-secondary" style={{ height: 28, padding: '0 10px', fontSize: 12 }}>{asset.analysisStatus === 'failed' ? 'Retry analysis' : 'Re-analyse'}</button>}
          </div>
          {asset.analysisError && <div role="alert" style={{ font: '400 12px/1.4 Satoshi', color: '#B91C1C', marginTop: 4 }}>{asset.analysisError}</div>}
          <div style={{ font: '400 11px/1.4 Satoshi', color: '#75757C', marginTop: 4 }}>Re-analysis replaces the AI values only. Imported values and anything you edited are kept.</div>
        </div>
        <ImportPanel asset={asset} />

        {FIELD_ORDER.map((k) => {
          const c = chip(asset.provenance[k]);
          const multiline = k === 'description';
          const common = { value: draft[k], disabled: readOnly || busy, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [k]: e.target.value })), 'aria-label': FIELD_LABELS[k], style: { width: '100%', boxSizing: 'border-box' as const, border: '1px solid #E4E4E0', borderRadius: 8, padding: '7px 9px', font: '400 13px/1.4 Satoshi', background: readOnly ? '#FAFAF8' : '#fff' } };
          return (
            <div key={k} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <label style={{ font: '600 12px Satoshi' }}>{FIELD_LABELS[k]}</label>
                <span style={{ padding: '0 6px', borderRadius: 999, background: c.bg, color: c.fg, font: '500 10px/1.6 Satoshi' }}>{c.t}</span>
                {!readOnly && asset.provenance[k] === 'manual' && <button onClick={() => revert(k)} disabled={busy} style={{ border: 'none', background: 'none', color: '#6C47FF', font: '500 11px Satoshi', cursor: 'pointer' }}>{asset.importInfo ? 'Use imported or AI value' : 'Use AI value'}</button>}
              </div>
              {multiline ? <textarea rows={3} {...common} /> : <input type="text" {...common} />}
              {k === 'tags' && <div style={{ font: '400 11px Satoshi', color: '#75757C', marginTop: 2 }}>Separate tags with commas.</div>}
            </div>
          );
        })}

        {error && <div role="alert" style={{ font: '400 12px/1.4 Satoshi', color: '#B91C1C', marginBottom: 8 }}>{error}</div>}
        {!readOnly && (
          <div style={{ display: 'flex', gap: 8, padding: '4px 0 16px', position: 'sticky', bottom: 0, background: '#fff' }}>
            <button className="btn btn-primary" onClick={save} disabled={busy || changed.length === 0} style={{ height: 34 }}>{busy ? 'Saving…' : changed.length ? `Save ${changed.length} change${changed.length > 1 ? 's' : ''}` : 'Saved'}</button>
            {asset.archived
              ? <button className="btn btn-secondary" onClick={() => archive(false)} disabled={busy} style={{ height: 34 }}>Restore image</button>
              : <button className="btn btn-secondary" onClick={() => { if (window.confirm('Archive this image? It leaves active use but nothing is deleted, and past generations keep it.')) void archive(true); }} disabled={busy} style={{ height: 34 }}>Archive image</button>}
          </div>
        )}
      </div>
    </div>
  );
}
