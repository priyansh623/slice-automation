'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import AssetGrid from './AssetGrid';
import AssetDetail from './AssetDetail';
import SelectionPanel from './SelectionPanel';
import ResultsPanel from './ResultsPanel';
import { api, uploadCharacter, type ApprovedPack, type GenerationConfig, type SelectionRow, type StudioAsset, type StudioPack, type StudioProject } from '@/lib/studio/client';

const box: React.CSSProperties = { border: '1px solid #ECECE8', borderRadius: 12, background: '#fff', padding: '16px 18px', marginBottom: 16 };
const h: React.CSSProperties = { font: '700 15px/1.3 Satoshi', marginBottom: 4 };
const sub: React.CSSProperties = { font: '400 12px/1.5 Satoshi', color: '#75757C', marginBottom: 10 };

/** One Studio project: character image, script, recommended packs, approved packs and their images. */
export default function ProjectView({ projectId }: { projectId: number }) {
  const [project, setProject] = useState<StudioProject | null>(null);
  const [generation, setGeneration] = useState<GenerationConfig | null>(null);
  useEffect(() => { api<{ generation: GenerationConfig }>('/api/v1/studio/config').then((r) => setGeneration(r.generation)).catch(() => {}); }, []);
  const [script, setScript] = useState('');
  const [savedScript, setSavedScript] = useState('');
  const [name, setName] = useState('');
  const [packs, setPacks] = useState<ApprovedPack[]>([]);
  const [allPacks, setAllPacks] = useState<StudioPack[]>([]);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [openPack, setOpenPack] = useState<number | null>(null);
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<SelectionRow[]>([]);
  const [resultsKey, setResultsKey] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  const reloadProject = useCallback(async () => {
    const r = await api<{ project: StudioProject }>(`/api/v1/studio/projects/${projectId}`);
    setProject(r.project); setName(r.project.name);
    return r.project;
  }, [projectId]);
  const reloadPacks = useCallback(async () => { setPacks((await api<{ packs: ApprovedPack[] }>(`/api/v1/studio/projects/${projectId}/packs`)).packs); }, [projectId]);
  const reloadSelection = useCallback(async () => { setSelection((await api<{ selection: SelectionRow[] }>(`/api/v1/studio/projects/${projectId}/selection`)).selection); }, [projectId]);

  useEffect(() => {
    void (async () => {
      try {
        const p = await reloadProject(); setScript(p.script); setSavedScript(p.script);
        await reloadPacks();
        await reloadSelection();
        setAllPacks((await api<{ packs: StudioPack[] }>('/api/v1/studio/packs')).packs);
      } catch (e) { setError((e as Error).message); }
    })();
  }, [reloadProject, reloadPacks, reloadSelection]);
  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(t); }, [search]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  // Images of the pack being browsed: every non-archived image, a page at a time.
  const loadAssets = useCallback(async (after?: number) => {
    if (!openPack) return;
    const p = new URLSearchParams({ limit: '60' });
    if (after) p.set('after', String(after));
    if (debounced) p.set('q', debounced);
    const r = await api<{ assets: StudioAsset[]; nextCursor: number | null; totalActive: number }>(`/api/v1/studio/projects/${projectId}/packs/${openPack}/assets?${p}`);
    setAssets((cur) => (after ? [...cur, ...r.assets] : r.assets)); setCursor(r.nextCursor); setTotal(r.totalActive);
  }, [openPack, debounced, projectId]);
  useEffect(() => { setAssets([]); setSelectedAsset(null); void loadAssets().catch((e) => setError((e as Error).message)); }, [loadAssets]);

  if (!project) return <div style={{ padding: 40, font: '400 14px Satoshi', color: '#75757C' }}>{error || 'Loading…'}</div>;

  const approvedIds = new Set(packs.map((p) => p.packId));
  const scriptChanged = script !== savedScript;
  const notApproved = allPacks.filter((p) => !approvedIds.has(p.id));
  const recs = project.recommendations;
  const selected = assets.find((a) => a.id === selectedAsset) ?? null;

  const selectedIds = new Set(selection.map((x) => x.assetId));
  const toggle = (a: StudioAsset) => run('select', async () => {
    if (selectedIds.has(a.id)) await api(`/api/v1/studio/projects/${projectId}/selection`, { method: 'DELETE', body: { assetIds: [a.id] } });
    else await api(`/api/v1/studio/projects/${projectId}/selection`, { method: 'POST', body: { assetIds: [a.id] } });
    await reloadSelection(); await reloadPacks();
  });
  const selectAllShown = () => run('select', async () => {
    const ids = assets.filter((a) => !selectedIds.has(a.id)).map((a) => a.id);
    if (ids.length) await api(`/api/v1/studio/projects/${projectId}/selection`, { method: 'POST', body: { assetIds: ids } });
    await reloadSelection(); await reloadPacks();
  });
  const removeFromSelection = (ids?: number[]) => run('select', async () => {
    await api(`/api/v1/studio/projects/${projectId}/selection`, { method: 'DELETE', body: ids ? { assetIds: ids } : {} });
    await reloadSelection(); await reloadPacks();
  });
  const generate = () => run('generate', async () => {
    await api(`/api/v1/studio/projects/${projectId}/batches`, { method: 'POST', body: {} });
    setResultsKey((k) => k + 1);
  });

  const approve = (ids: number[]) => run('approve', async () => {
    const r = await api<{ packs: ApprovedPack[] }>(`/api/v1/studio/projects/${projectId}/packs`, { method: 'POST', body: { packIds: ids } });
    setPacks(r.packs); setPick(new Set());
    if (!openPack && r.packs[0]) setOpenPack(r.packs[0].packId);
  });

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '22px 28px' }}>
        <a href="/studio" style={{ font: '500 12px Satoshi', color: '#75757C', textDecoration: 'none' }}>← All projects</a>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 16px' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name !== project.name) void run('rename', async () => { const r = await api<{ project: StudioProject }>(`/api/v1/studio/projects/${projectId}`, { method: 'PUT', body: { name } }); setProject(r.project); }); }} aria-label="Project name" style={{ font: '700 22px Satoshi', border: '1px solid transparent', borderRadius: 8, padding: '2px 6px', minWidth: 280 }} />
        </div>
        {error && <div role="alert" style={{ marginBottom: 12, padding: '9px 12px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, font: '400 13px/1.4 Satoshi', color: '#991B1B', display: 'flex', justifyContent: 'space-between' }}><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit' }}>×</button></div>}

        {/* 1. Character */}
        <div style={box}>
          <div style={h}>1. Base character image</div>
          <div style={sub}>One image of your character. The original is stored unchanged in R2.</div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <div style={{ width: 90, height: 120, borderRadius: 10, background: '#F4F4F0', overflow: 'hidden', flexShrink: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {project.characterThumbUrl && <img src={project.characterThumbUrl} alt="Character" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </div>
            <div>
              <button className="btn btn-secondary" disabled={!!busy} onClick={() => file.current?.click()}>{busy === 'character' ? 'Uploading…' : project.hasCharacter ? 'Change character image' : 'Upload character image'}</button>
              <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run('character', async () => setProject(await uploadCharacter(projectId, f))); }} />
            </div>
          </div>
        </div>

        {/* 2. Script */}
        <div style={box}>
          <div style={h}>2. Script</div>
          <div style={sub}>Paste the complete video script.</div>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={8} aria-label="Script" style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #E4E4E0', borderRadius: 8, padding: '10px 12px', font: '400 13px/1.6 Satoshi', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={!!busy || !scriptChanged} onClick={() => run('script', async () => { const r = await api<{ project: StudioProject }>(`/api/v1/studio/projects/${projectId}`, { method: 'PUT', body: { script } }); setProject(r.project); setSavedScript(r.project.script); })}>{busy === 'script' ? 'Saving…' : scriptChanged ? 'Save script' : 'Saved'}</button>
            <button className="btn btn-secondary" disabled={!!busy || scriptChanged || !script.trim()} title={scriptChanged ? 'Save the script first' : ''} onClick={() => run('analyse', async () => { const r = await api<{ project: StudioProject }>(`/api/v1/studio/projects/${projectId}/analyze`, { method: 'POST', body: { force: project.analysis.status === 'failed' || (recs.length > 0 && !project.analysis.current) } }); setProject(r.project); })}>{busy === 'analyse' ? 'Analysing script…' : recs.length ? 'Analyse again' : 'Analyse script and recommend packs'}</button>
            {project.analysis.status === 'failed' && <span role="alert" style={{ font: '400 12px Satoshi', color: '#B91C1C' }}>{project.analysis.error}</span>}
          </div>
        </div>

        {/* 3. Recommendations and approvals */}
        <div style={box}>
          <div style={h}>3. Scene Packs</div>
          <div style={sub}>Approve the packs you want to use. Once a pack is approved, every image in it is available. Recommendations only suggest where to look; you can approve any pack.</div>
          {recs.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ font: '600 13px Satoshi', marginBottom: 6 }}>Recommended for this script{!project.analysis.current && <span style={{ color: '#92400E', fontWeight: 500 }}> (the script changed since: analyse again to refresh)</span>}</div>
              {recs.map((r) => (
                <div key={r.packId} style={{ display: 'flex', gap: 12, padding: '10px 0', borderTop: '1px solid #F4F4F0', alignItems: 'flex-start' }}>
                  <input type="checkbox" aria-label={`Select ${r.name}`} disabled={approvedIds.has(r.packId) || r.packArchived} checked={approvedIds.has(r.packId) || pick.has(r.packId)} onChange={(e) => setPick((s) => { const n = new Set(s); if (e.target.checked) n.add(r.packId); else n.delete(r.packId); return n; })} style={{ marginTop: 3 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ font: '600 14px Satoshi' }}>{r.name} <span style={{ font: '500 11px Satoshi', color: '#6D28D9', background: '#EDE9FE', borderRadius: 999, padding: '1px 8px' }}>{Math.round(r.score * 100)}% match</span>{approvedIds.has(r.packId) && <span style={{ font: '500 11px Satoshi', color: '#16A34A', marginLeft: 6 }}>Approved</span>}</div>
                    {r.reasons.map((x, i) => <div key={i} style={{ font: '400 12px/1.5 Satoshi', color: '#3F3F46' }}>{x}</div>)}
                    {r.moments.length > 0 && <div style={{ font: '400 12px/1.5 Satoshi', color: '#75757C' }}>Script moments: {r.moments.join(' · ')}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ font: '600 13px Satoshi', marginBottom: 6 }}>Choose any other pack</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            {notApproved.filter((p) => !recs.some((r) => r.packId === p.id)).map((p) => (
              <label key={p.id} style={{ border: `1px solid ${pick.has(p.id) ? '#6C47FF' : '#E4E4E0'}`, borderRadius: 8, padding: '5px 10px', font: '500 12px Satoshi', cursor: 'pointer', background: pick.has(p.id) ? '#F5F3FF' : '#fff' }}>
                <input type="checkbox" checked={pick.has(p.id)} onChange={(e) => setPick((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} style={{ marginRight: 6 }} />{p.name} <span style={{ color: '#75757C' }}>({p.assetCount})</span>
              </label>
            ))}
            {notApproved.length === 0 && <span style={{ font: '400 12px Satoshi', color: '#75757C' }}>Every pack is approved.</span>}
          </div>
          <button className="btn btn-primary" disabled={!!busy || pick.size === 0} onClick={() => void approve([...pick])}>{pick.size ? `Approve ${pick.size} pack${pick.size > 1 ? 's' : ''}` : 'Approve selected packs'}</button>
        </div>

        {/* 4. Approved packs and their images */}
        <div style={box}>
          <div style={h}>4. Images in approved packs</div>
          {packs.length === 0 && <div style={{ font: '400 13px Satoshi', color: '#75757C' }}>Approve a pack above to see its images. No images are shown before that.</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {packs.map((p) => (
              <span key={p.packId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1.5px solid ${openPack === p.packId ? '#6C47FF' : '#E4E4E0'}`, background: openPack === p.packId ? '#F5F3FF' : '#fff', borderRadius: 999, padding: '4px 6px 4px 12px', font: '600 12px Satoshi' }}>
                <button onClick={() => setOpenPack(p.packId)} style={{ border: 'none', background: 'none', font: 'inherit', cursor: 'pointer' }}>{p.name} ({p.activeAssetCount}){p.newSinceApproval > 0 && <span style={{ color: '#16A34A' }}> · {p.newSinceApproval} new</span>}</button>
                <button title={p.selectedCount > 0 ? 'Remove its selected images first' : 'Remove this pack'} aria-label={`Remove ${p.name}`} onClick={() => run('revoke', async () => { setPacks((await api<{ packs: ApprovedPack[] }>(`/api/v1/studio/projects/${projectId}/packs/${p.packId}`, { method: 'DELETE' })).packs); if (openPack === p.packId) setOpenPack(null); })} style={{ border: 'none', background: 'none', color: '#75757C', cursor: 'pointer', fontSize: 14 }}>×</button>
              </span>
            ))}
          </div>
          {openPack && (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this pack (optional)" aria-label="Search this pack" style={{ width: 260, height: 32, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 10px', font: '400 13px Satoshi' }} />
                <span style={{ font: '400 12px Satoshi', color: '#75757C' }}>{debounced ? `Showing matches for “${debounced}”. Clear the search to see all ${total} images.` : `All ${total} image${total === 1 ? '' : 's'} in this pack`}</span>
              </div>
              <div style={{ margin: '0 0 8px' }}><button className="btn btn-secondary" disabled={!!busy || assets.length === 0} onClick={() => void selectAllShown()} style={{ height: 28, fontSize: 12 }}>Select all shown</button></div>
              <AssetGrid assets={assets} selectedId={selectedAsset} onSelect={setSelectedAsset} renderExtra={(a) => (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, font: '500 11px Satoshi', color: a.archived ? '#9A9AA0' : '#374151', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedIds.has(a.id)} disabled={!!busy || (a.archived && !selectedIds.has(a.id))} onChange={() => void toggle(a)} aria-label={`Select image ${a.id}`} /> {selectedIds.has(a.id) ? 'Selected' : 'Select'}
                </label>
              )} />
              {cursor && <div style={{ textAlign: 'center', padding: '14px 0' }}><button className="btn btn-secondary" onClick={() => void loadAssets(cursor).catch((e) => setError((e as Error).message))}>Load more</button></div>}
            </>
          )}
        </div>

        <SelectionPanel selection={selection} busy={busy === 'select' || busy === 'generate'} hasCharacter={project.hasCharacter} generation={generation} onRemove={(ids) => void removeFromSelection(ids)} onClear={() => void removeFromSelection()} onGenerate={() => void generate()} />
        <ResultsPanel projectId={projectId} refreshKey={resultsKey} onError={setError} />
      </div>
      {selected && <AssetDetail asset={selected} readOnly onChange={() => {}} onClose={() => setSelectedAsset(null)} />}
    </div>
  );
}
