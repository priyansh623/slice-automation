'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import PackSidebar from '@/components/studio/PackSidebar';
import UploadPanel from '@/components/studio/UploadPanel';
import AssetGrid from '@/components/studio/AssetGrid';
import AssetDetail from '@/components/studio/AssetDetail';
import { api, type StudioAsset, type StudioPack } from '@/lib/studio/client';

/** Scene Pack Repository: create packs, add images, see every image of a pack, edit metadata. Shared by every signed-in user. */
export default function RepositoryPage() {
  const [packs, setPacks] = useState<StudioPack[]>([]);
  const [showArchivedPacks, setShowArchivedPacks] = useState(false);
  const [packId, setPackId] = useState<number | null>(null);
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [totalActive, setTotalActive] = useState(0);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingPack, setEditingPack] = useState(false);
  const [packName, setPackName] = useState('');
  const [packDesc, setPackDesc] = useState('');
  const loadSeq = useRef(0);

  const pack = packs.find((p) => p.id === packId) ?? null;

  const loadPacks = useCallback(async () => {
    try { setPacks((await api<{ packs: StudioPack[] }>(`/api/v1/studio/packs${showArchivedPacks ? '?includeArchived=1' : ''}`)).packs); }
    catch (e) { setError((e as Error).message); }
  }, [showArchivedPacks]);
  useEffect(() => { void loadPacks(); }, [loadPacks]);
  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(t); }, [search]);

  const query = useCallback((after?: number) => {
    const p = new URLSearchParams({ limit: '60' });
    if (after) p.set('after', String(after));
    if (includeArchived) p.set('includeArchived', '1');
    if (debounced) p.set('q', debounced);
    return p.toString();
  }, [includeArchived, debounced]);

  const loadFirstPage = useCallback(async () => {
    if (!packId) return;
    const mine = ++loadSeq.current;
    setLoading(true); setError('');
    try {
      const r = await api<{ assets: StudioAsset[]; nextCursor: number | null; totalActive: number }>(`/api/v1/studio/packs/${packId}/assets?${query()}`);
      if (mine !== loadSeq.current) return;
      setAssets(r.assets); setCursor(r.nextCursor); setTotalActive(r.totalActive);
    } catch (e) { if (mine === loadSeq.current) setError((e as Error).message); } finally { if (mine === loadSeq.current) setLoading(false); }
  }, [packId, query]);
  useEffect(() => { setSelectedId(null); setAssets([]); void loadFirstPage(); }, [loadFirstPage]);
  useEffect(() => { setEditingPack(false); }, [packId]);

  async function loadMore() {
    if (!packId || !cursor) return;
    setLoading(true);
    try {
      const r = await api<{ assets: StudioAsset[]; nextCursor: number | null }>(`/api/v1/studio/packs/${packId}/assets?${query(cursor)}`);
      setAssets((cur) => [...cur, ...r.assets]); setCursor(r.nextCursor);
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }

  // While images are waiting to be (or being) analysed, refresh just those images every few seconds.
  const waiting = assets.filter((a) => a.analysisStatus === 'pending' || a.analysisStatus === 'processing').map((a) => a.id);
  const waitingKey = waiting.join(',');
  useEffect(() => {
    if (waiting.length === 0) return;
    const timer = setInterval(async () => {
      const fresh = await Promise.all(waiting.slice(0, 20).map((id) => api<{ asset: StudioAsset }>(`/api/v1/studio/assets/${id}`).then((r) => r.asset).catch(() => null)));
      setAssets((cur) => cur.map((a) => fresh.find((f) => f && f.id === a.id) ?? a));
      void loadPacks();
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey, loadPacks]);

  async function createPack(name: string) {
    const r = await api<{ pack: { id: number } }>('/api/v1/studio/packs', { method: 'POST', body: { name } });
    await loadPacks();
    setPackId(r.pack.id);
  }

  async function savePack() {
    if (!pack) return;
    try {
      await api(`/api/v1/studio/packs/${pack.id}`, { method: 'PUT', body: { name: packName, description: packDesc } });
      setEditingPack(false); await loadPacks();
    } catch (e) { setError((e as Error).message); }
  }
  async function archivePack(archived: boolean) {
    if (!pack) return;
    if (archived && !window.confirm('Archive this Scene Pack? Nothing is deleted. Projects that approved it keep their history.')) return;
    try { await api(`/api/v1/studio/packs/${pack.id}/archive`, { method: 'POST', body: { archived } }); await loadPacks(); }
    catch (e) { setError((e as Error).message); }
  }

  const onUploaded = useCallback((asset: StudioAsset, duplicate: boolean) => {
    if (!duplicate) setAssets((cur) => (cur.some((a) => a.id === asset.id) ? cur : [...cur, asset]));
    setTotalActive((n) => (duplicate ? n : n + 1));
    void loadPacks();
  }, [loadPacks]);

  const selected = assets.find((a) => a.id === selectedId) ?? null;

  return (
    <AppShell fullscreen>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <PackSidebar packs={packs} selectedId={packId} showArchived={showArchivedPacks} onShowArchived={setShowArchivedPacks} onSelect={setPackId} onCreate={createPack} />

        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '20px 24px' }}>
          {!pack && <div style={{ padding: '60px 0', textAlign: 'center', font: '400 14px/1.6 Satoshi', color: '#75757C' }}>Pick a Scene Pack on the left, or create a new one.</div>}
          {pack && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 14 }}>
                {editingPack ? (
                  <div style={{ flex: 1 }}>
                    <input value={packName} onChange={(e) => setPackName(e.target.value)} aria-label="Pack name" style={{ width: '100%', boxSizing: 'border-box', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 10px', font: '700 18px Satoshi' }} />
                    <textarea value={packDesc} onChange={(e) => setPackDesc(e.target.value)} rows={2} aria-label="Pack description" placeholder="What kind of scenes does this pack hold?" style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, border: '1px solid #E4E4E0', borderRadius: 8, padding: '8px 10px', font: '400 13px/1.5 Satoshi' }} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button className="btn btn-primary" onClick={() => void savePack()} style={{ height: 32 }}>Save</button>
                      <button className="btn btn-secondary" onClick={() => setEditingPack(false)} style={{ height: 32 }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ minWidth: 0 }}>
                    <div style={{ font: '700 22px/1.3 Satoshi' }}>{pack.name}{pack.archivedAt ? ' (archived)' : ''}</div>
                    <div style={{ font: '400 13px/1.5 Satoshi', color: '#5E5E65', marginTop: 3, maxWidth: 640 }}>{pack.description || 'No description yet.'}</div>
                    <div style={{ font: '400 12px Satoshi', color: '#75757C', marginTop: 4 }}>{totalActive} active image{totalActive === 1 ? '' : 's'}</div>
                  </div>
                )}
                {!editingPack && (
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button className="btn btn-secondary" onClick={() => { setPackName(pack.name); setPackDesc(pack.description ?? ''); setEditingPack(true); }} style={{ height: 32 }}>Edit pack</button>
                    <button className="btn btn-secondary" onClick={() => void archivePack(!pack.archivedAt)} style={{ height: 32 }}>{pack.archivedAt ? 'Restore pack' : 'Archive pack'}</button>
                  </div>
                )}
              </div>

              {error && <div role="alert" style={{ marginBottom: 12, padding: '9px 12px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, font: '400 13px/1.4 Satoshi', color: '#991B1B', display: 'flex', justifyContent: 'space-between' }}><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit' }}>×</button></div>}

              <UploadPanel packId={pack.id} disabled={!!pack.archivedAt} onUploaded={onUploaded} />

              <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this pack (optional)" aria-label="Search this pack" style={{ width: 280, height: 34, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 10px', font: '400 13px Satoshi' }} />
                <label style={{ font: '400 12px Satoshi', color: '#5E5E65', display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> Show archived images
                </label>
                {debounced && <span style={{ font: '400 12px Satoshi', color: '#75757C' }}>Showing images matching “{debounced}”. Clear the search to see every image.</span>}
              </div>

              <AssetGrid assets={assets} selectedId={selectedId} onSelect={setSelectedId} />
              {cursor && <div style={{ textAlign: 'center', padding: '16px 0' }}><button className="btn btn-secondary" onClick={() => void loadMore()} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button></div>}
              {loading && assets.length === 0 && <div style={{ padding: '30px 0', textAlign: 'center', font: '400 13px Satoshi', color: '#75757C' }}>Loading images…</div>}
            </>
          )}
        </div>

        {selected && <AssetDetail asset={selected} onClose={() => setSelectedId(null)} onChange={(a) => {
          const leavesView = a.archived && !includeArchived;
          setAssets((cur) => (leavesView ? cur.filter((x) => x.id !== a.id) : cur.map((x) => (x.id === a.id ? a : x))));
          if (leavesView) { setSelectedId(null); setTotalActive((n) => Math.max(0, n - 1)); }
          else if (!a.archived) void loadFirstPage();
          void loadPacks();
        }} />}
      </div>
    </AppShell>
  );
}
