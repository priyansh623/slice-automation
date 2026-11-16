'use client';

/**
 * Studio > Repository, as supplied: the pack overview (cards), the pack detail (pack list, image grid, image panel), the bulk upload
 * progress card and the New Scene Pack dialog. Markup and styles come from the prototype; data comes from the real Studio APIs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { alertRed, CodeChip, Modal, primaryBtn, Segmented, secondaryBtn, smallBtn, StudioListHeader, TileChip } from './ui/ds';
import { api, newGroupId, runPool, uploadImage, type MetaKey, type Provenance, type StudioAsset, type StudioPack } from '@/lib/studio/client';
import { chipOf, codeOf } from '@/lib/studio/ui';
import ImportPanel from './ImportPanel';

const bg = (url: string | null | undefined) => (url ? `#E4E4E0 url("${url}") center top/cover no-repeat` : '#E4E4E0');
const ACCEPT = 'image/jpeg,image/png,image/webp';
/** The design's fields the library stores, then the three more it stores. (Setting, Time of day and Notes have no data behind them.) */
const FIELDS: Array<[MetaKey, string]> = [['description', 'Scene'], ['environment', 'Environment (indoor / outdoor)'], ['activity', 'Activity'], ['lighting', 'Lighting'], ['framing', 'Camera framing'], ['objects_props', 'Props / objects'], ['tags', 'Free tags'],
  // The library also stores these three; they stay editable (nothing the backend supports is removed).
  ['camera_angle', 'Camera angle'], ['character_position', 'Character position'], ['composition', 'Composition']];
const asText = (v: string | string[] | null | undefined): string => (Array.isArray(v) ? v.join(', ') : (v ?? ''));
const provChip = (p: Provenance, hasValue: boolean) => (p === 'manual' ? ['Edited', '#FEF3C7', '#92400E'] : p === 'imported' ? ['Imported', '#DBEAFE', '#1D4ED8'] : hasValue ? ['AI', '#EDE9FE', '#6D28D9'] : ['Empty', '#F3F4F6', '#6B7280']);

export default function RepositoryView() {
  const router = useRouter();
  const [view, setView] = useState<'overview' | 'pack'>('overview');
  const [packs, setPacks] = useState<StudioPack[]>([]);
  const [first, setFirst] = useState<Record<number, StudioAsset[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rq, setRq] = useState('');
  const [rpFilter, setRpFilter] = useState<'all' | 'review' | 'proc' | 'arch'>('all');
  const [packId, setPackId] = useState<number | null>(null);
  const [showArchPacks, setShowArchPacks] = useState(false);
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [imgFilter, setImgFilter] = useState<'all' | 'processing' | 'review' | 'archived'>('all');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [upload, setUpload] = useState<{ phase: 'uploading' | 'analysing'; total: number; done: number } | null>(null);
  const [newPack, setNewPack] = useState(false);
  const [editPack, setEditPack] = useState<{ name: string; desc: string } | null>(null);
  const [np, setNp] = useState({ name: '', env: 'Indoor', setting: '', act: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const loadPacks = useCallback(async () => {
    const list = (await api<{ packs: StudioPack[] }>('/api/v1/studio/packs?includeArchived=1')).packs;
    setPacks(list);
    const entries = await Promise.all(list.map(async (p) => [p.id, (await api<{ assets: StudioAsset[] }>(`/api/v1/studio/packs/${p.id}/assets?limit=60`)).assets] as const));
    setFirst(Object.fromEntries(entries));
    return list;
  }, []);
  useEffect(() => { void loadPacks().catch((e) => setError((e as Error).message)).finally(() => setLoading(false)); }, [loadPacks]);

  const loadAssets = useCallback(async (id: number) => {
    const mine = ++seq.current; setAssetsLoading(true);
    try {
      const all: StudioAsset[] = []; let after: number | null = null;
      do {
        const q = new URLSearchParams({ limit: '60', includeArchived: '1' }); if (after) q.set('after', String(after));
        const r: { assets: StudioAsset[]; nextCursor: number | null } = await api(`/api/v1/studio/packs/${id}/assets?${q}`);
        all.push(...r.assets); after = r.nextCursor;
      } while (after);
      if (mine === seq.current) setAssets(all);
    } catch (e) { if (mine === seq.current) setError((e as Error).message); } finally { if (mine === seq.current) setAssetsLoading(false); }
  }, []);
  useEffect(() => { setAssets([]); setActiveId(null); if (view === 'pack' && packId) void loadAssets(packId); }, [view, packId, loadAssets]);

  // Images still waiting for analysis are refreshed every few seconds.
  const waiting = assets.filter((a) => a.analysisStatus === 'pending' || a.analysisStatus === 'processing').map((a) => a.id);
  const waitingKey = waiting.join(',');
  useEffect(() => {
    if (!waiting.length) return;
    const t = setInterval(async () => {
      const fresh = await Promise.all(waiting.slice(0, 20).map((id) => api<{ asset: StudioAsset }>(`/api/v1/studio/assets/${id}`).then((r) => r.asset).catch(() => null)));
      setAssets((cur) => cur.map((a) => fresh.find((f) => f && f.id === a.id) ?? a));
      void loadPacks().catch(() => {});
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey, loadPacks]);

  const stat = (p: StudioPack) => { const l = (first[p.id] ?? []).filter((a) => !a.archived); return { n: p.assetCount, proc: p.analysisPending, rev: l.filter((a) => chipOf(a)?.text === 'Needs review').length }; };
  const live = packs.filter((p) => !p.archivedAt);
  const rpc = { all: live.length, review: live.filter((p) => stat(p).rev > 0).length, proc: live.filter((p) => stat(p).proc > 0).length, arch: packs.filter((p) => p.archivedAt).length };
  const cards = packs.filter((p) => { const s = stat(p), f = rpFilter; return (f === 'arch' ? !!p.archivedAt : !p.archivedAt && (f === 'all' || (f === 'review' && s.rev > 0) || (f === 'proc' && s.proc > 0))) && (!rq || p.name.toLowerCase().includes(rq.toLowerCase())); });

  const pk = packs.find((p) => p.id === packId) ?? null;
  const act = assets.find((a) => a.id === activeId) ?? null;
  const cF = { all: assets.filter((a) => !a.archived).length, processing: assets.filter((a) => !a.archived && (a.analysisStatus === 'pending' || a.analysisStatus === 'processing')).length, review: assets.filter((a) => !a.archived && chipOf(a)?.text === 'Needs review').length, archived: assets.filter((a) => a.archived).length };
  const shown = assets.filter((a) => (imgFilter === 'archived' ? a.archived : !a.archived && (imgFilter === 'all' || (imgFilter === 'processing' ? a.analysisStatus === 'pending' || a.analysisStatus === 'processing' : chipOf(a)?.text === 'Needs review'))));

  const openPack = (id: number) => { setPackId(id); setView('pack'); setImgFilter('all'); setActiveId(null); };
  const startUpload = () => fileRef.current?.click();
  const addFiles = async (files: FileList) => {
    if (!packId) return;
    const accepted = [...files].filter((f) => ACCEPT.split(',').includes(f.type));
    if (accepted.length < files.length) setError('Only JPEG, PNG and WEBP images can be added.');
    if (!accepted.length) return;
    const group = newGroupId(); let done = 0;
    setUpload({ phase: 'uploading', total: accepted.length, done: 0 });
    await runPool(accepted, 3, async (f) => {
      try { await uploadImage(packId, f, group); } catch (e) { setError((e as Error).message); }
      done += 1; setUpload({ phase: 'uploading', total: accepted.length, done });
    });
    setUpload({ phase: 'analysing', total: accepted.length, done: accepted.length });
    await loadAssets(packId); await loadPacks().catch(() => {});
    setUpload(null);
  };

  async function savePack() {
    if (!pk || !editPack || !editPack.name.trim()) return;
    try { await api(`/api/v1/studio/packs/${pk.id}`, { method: 'PUT', body: { name: editPack.name.trim(), description: editPack.desc } }); setEditPack(null); await loadPacks(); }
    catch (e) { setError((e as Error).message); setEditPack(null); }
  }
  async function archivePack(archived: boolean) {
    if (!pk) return;
    if (archived && !window.confirm('Archive this Scene Pack? Nothing is deleted. Projects that approved it keep their history.')) return;
    try { await api(`/api/v1/studio/packs/${pk.id}/archive`, { method: 'POST', body: { archived } }); await loadPacks(); }
    catch (e) { setError((e as Error).message); }
  }
  const reanalyse = async () => {
    if (!act) return;
    if (!window.confirm('Re-analysis runs the AI model (a paid call) and replaces the AI values only. Imported values and your edits are kept. Continue?')) return;
    try { patch((await api<{ asset: StudioAsset }>(`/api/v1/studio/assets/${act.id}/reanalyze`, { method: 'POST' })).asset); }
    catch (e) { setError((e as Error).message); }
  };

  async function createPack() {
    if (!np.name.trim() || !np.setting.trim() || !np.act.trim()) return;
    try {
      const r = await api<{ pack: { id: number } }>('/api/v1/studio/packs', { method: 'POST', body: { name: np.name.trim(), description: [np.env, np.setting.trim(), np.act.trim()].join(' · ') } });
      await loadPacks(); setNewPack(false); setNp({ name: '', env: 'Indoor', setting: '', act: '' }); openPack(r.pack.id);
    } catch (e) { setError((e as Error).message); setNewPack(false); }
  }

  // ── image panel ──
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => {
    if (!act) return;
    setDraft(Object.fromEntries(FIELDS.map(([k]) => [k, asText(act.metadata[k])])));
    setFull(act.imageUrl);
    if (!act.imageUrl) api<{ asset: StudioAsset }>(`/api/v1/studio/assets/${act.id}`).then((r) => setFull(r.asset.imageUrl)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act?.id]);
  const patch = (a: StudioAsset) => { setAssets((cur) => cur.map((x) => (x.id === a.id ? a : x))); setDraft(Object.fromEntries(FIELDS.map(([k]) => [k, asText(a.metadata[k])]))); };
  const saveField = async (k: MetaKey) => {
    if (!act || draft[k] === asText(act.metadata[k])) return;
    try { patch((await api<{ asset: StudioAsset }>(`/api/v1/studio/assets/${act.id}/metadata`, { method: 'PUT', body: { fields: { [k]: k === 'tags' ? draft[k].split(',').map((t) => t.trim()).filter(Boolean) : (draft[k].trim() || null) } } })).asset); }
    catch (e) { setError((e as Error).message); }
  };
  const revert = async (k: MetaKey) => { if (!act) return; try { patch((await api<{ asset: StudioAsset }>(`/api/v1/studio/assets/${act.id}/metadata`, { method: 'PUT', body: { revert: [k] } })).asset); } catch (e) { setError((e as Error).message); } };
  const toggleArchive = async () => {
    if (!act) return;
    try { const r = await api<{ asset: StudioAsset }>(`/api/v1/studio/assets/${act.id}/archive`, { method: 'POST', body: { archived: !act.archived } }); setAssets((cur) => cur.map((x) => (x.id === r.asset.id ? r.asset : x))); setActiveId(null); void loadPacks().catch(() => {}); }
    catch (e) { setError((e as Error).message); }
  };

  const npOk = !!(np.name.trim() && np.setting.trim() && np.act.trim());
  const header = view === 'overview'
    ? { label: 'New pack', icon: '+', onClick: () => setNewPack(true) }
    : { label: 'Upload images', icon: '↑', onClick: startUpload };

  return (
    <AppShell fullscreen>
      <main className="stu-scope" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <StudioListHeader tab="repository" onProjects={() => router.push('/studio')} onRepository={() => setView('overview')} action={header} />
        <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {error && <div role="alert" style={{ ...alertRed, margin: '16px 24px 0', display: 'flex', justifyContent: 'space-between' }}><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit' }}>×</button></div>}
          {view === 'overview' && (
            <div style={{ maxWidth: 1160, width: '100%', margin: '0 auto', padding: '36px 40px 140px', boxSizing: 'border-box' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                <input className="stu-focus" value={rq} onChange={(e) => setRq(e.target.value)} placeholder="Search packs" style={{ width: 300, height: 36, border: '1px solid #E4E4E0', borderRadius: 9, padding: '0 12px', font: '400 14px/1 Satoshi', background: '#fff', outline: 'none' }} />
                <Segmented items={([['all', 'All'], ['review', 'Needs review'], ['proc', 'Processing'], ['arch', 'Archived']] as const).map(([k, label]) => ({ label, count: rpc[k], active: rpFilter === k, onClick: () => setRpFilter(k) }))} />
              </div>
              {loading && <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>Loading…</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 16 }}>
                {cards.map((p) => { const s = stat(p), l = (first[p.id] ?? []).filter((a) => !a.archived); return (
                  <div key={p.id} className="stu-pack" onClick={() => openPack(p.id)} style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden', cursor: 'pointer', opacity: p.archivedAt ? 0.6 : 1, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 2, height: 230, background: '#F4F4F0' }}>{[0, 1, 2].map((k) => <div key={k} style={{ background: l[k] ? bg(l[k].thumbUrl) : '#F4F4F0' }} />)}</div>
                    <div style={{ padding: '12px 16px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ font: '700 15px/1.3 Satoshi', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                      {s.proc > 0 && <span style={{ height: 22, padding: '0 9px', borderRadius: 999, background: '#EDE9FE', color: '#6D28D9', font: '500 11px/22px Satoshi' }}>{s.proc} analysing</span>}
                      {s.rev > 0 && <span style={{ height: 22, padding: '0 9px', borderRadius: 999, background: '#FEF3C7', color: '#92400E', font: '500 11px/22px Satoshi' }}>{s.rev} to review</span>}
                      <span style={{ font: '400 12px/1 Satoshi', color: '#75757C' }}>{s.n} images</span>
                    </div>
                  </div>
                ); })}
              </div>
            </div>
          )}
          {view === 'pack' && pk && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <div style={{ width: 250, flexShrink: 0, borderRight: '1px solid #ECECE8', background: '#fff', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '16px 16px 10px' }}><button className="stu-dash" onClick={() => setNewPack(true)} style={{ width: '100%', height: 36, border: '1px dashed #6C47FF', borderRadius: 8, background: '#F5F3FF', color: '#6C47FF', font: '600 13px/1 Satoshi', cursor: 'pointer' }}>+ New pack</button></div>
                <div style={{ flex: 1, overflow: 'auto' }}>
                  {packs.filter((p) => showArchPacks || !p.archivedAt).map((p) => (
                    <button key={p.id} onClick={() => { setPackId(p.id); setActiveId(null); setImgFilter('all'); }} style={{ width: '100%', textAlign: 'left', border: 'none', borderBottom: '1px solid #F4F4F0', background: p.id === packId ? '#F5F3FF' : '#fff', padding: '10px 16px', cursor: 'pointer', opacity: p.archivedAt ? 0.55 : 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 30, height: 44, borderRadius: 5, background: (first[p.id] ?? []).find((a) => !a.archived) ? bg((first[p.id] ?? []).find((a) => !a.archived)!.thumbUrl) : '#F4F4F0', flexShrink: 0 }} />
                      <span style={{ minWidth: 0 }}><span style={{ display: 'block', font: '600 13px/1.3 Satoshi', color: '#111113', whiteSpace: 'normal' }}>{p.name}</span><span style={{ display: 'block', font: '400 12px/1.4 Satoshi', color: '#75757C' }}>{p.assetCount} images</span></span>
                    </button>
                  ))}
                </div>
                <label style={{ padding: '10px 16px', borderTop: '1px solid #ECECE8', font: '400 12px/1 Satoshi', color: '#5E5E65', display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={showArchPacks} onChange={(e) => setShowArchPacks(e.target.checked)} />Show archived</label>
              </div>
              <div style={{ flex: 1, minWidth: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '18px 24px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                  <div><div style={{ font: '700 22px/1.3 Satoshi' }}>{pk.name}{pk.archivedAt ? ' (archived)' : ''}</div><div style={{ font: '400 13px/1.4 Satoshi', color: '#75757C' }}>{pk.description ?? ''}</div></div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="stu-ghost" onClick={() => setEditPack({ name: pk.name, desc: pk.description ?? '' })} style={secondaryBtn}>Edit pack</button>
                    <button className="stu-ghost" onClick={() => void archivePack(!pk.archivedAt)} style={secondaryBtn}>{pk.archivedAt ? 'Restore pack' : 'Archive pack'}</button>
                    <button className="stu-primary" onClick={() => { if (!pk.archivedAt) startUpload(); }} style={{ ...primaryBtn, opacity: pk.archivedAt ? 0.45 : 1 }}>Upload images</button>
                  </div>
                </div>
                {upload && (
                  <div style={{ margin: '0 24px 12px', border: '1px solid #ECECE8', borderRadius: 12, background: '#fff', padding: '14px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', font: '500 13px/1 Satoshi', marginBottom: 10 }}><span>{upload.phase === 'uploading' ? `Uploading ${upload.total} images` : `Analysing ${upload.total} images`}</span><span style={{ color: '#75757C' }}>{upload.phase === 'uploading' ? Math.round((upload.done / upload.total) * 100) : 100}%</span></div>
                    <div style={{ height: 4, borderRadius: 2, background: '#EFEFEC', overflow: 'hidden' }}><div style={{ height: '100%', width: `${upload.phase === 'uploading' ? Math.round((upload.done / upload.total) * 100) : 100}%`, background: '#6C47FF', transition: 'width 0.2s' }} /></div>
                  </div>
                )}
                <div style={{ padding: '0 24px 14px', display: 'flex', gap: 8 }}>
                  {([['all', 'All'], ['processing', 'Analysing'], ['review', 'Needs review'], ['archived', 'Archived']] as const).map(([k, label]) => { const a = imgFilter === k; return <button key={k} onClick={() => setImgFilter(k)} style={{ height: 30, padding: '0 12px', borderRadius: 8, border: `1px solid ${a ? '#6C47FF' : '#E4E4E0'}`, background: a ? '#EFEBFF' : '#fff', color: a ? '#6C47FF' : '#3A3A3F', font: '500 13px/1 Satoshi', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}>{label} {cF[k]}</button>; })}
                </div>
                {!assetsLoading && assets.length === 0 && <div style={{ margin: 24, background: '#fff', border: '1px dashed #6C47FF', borderRadius: 14, padding: '64px 32px', textAlign: 'center' }}><button className="stu-primary" onClick={startUpload} style={primaryBtn}>Upload images</button></div>}
                {assetsLoading && assets.length === 0 && <div style={{ padding: '0 24px', font: '400 13px/1.5 Satoshi', color: '#75757C' }}>Loading images…</div>}
                <div style={{ padding: '0 24px 32px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 12 }}>
                  {shown.map((a) => { const c = chipOf(a); return (
                    <div key={a.id} className="stu-tile" onClick={() => setActiveId(a.id)} style={{ position: 'relative', aspectRatio: '9/16', border: `2px solid ${activeId === a.id ? '#6C47FF' : 'transparent'}`, borderRadius: 12, background: bg(a.thumbUrl), overflow: 'hidden', cursor: 'pointer', opacity: a.archived ? 0.55 : 1, boxSizing: 'border-box' }}>
                      <CodeChip code={codeOf(a)} />
                      {c && <TileChip text={c.text} bg={c.bg} fg={c.fg} />}
                    </div>
                  ); })}
                </div>
              </div>
              {act && act.packId === packId && (
                <div style={{ width: 380, flexShrink: 0, borderLeft: '1px solid #ECECE8', background: '#fff', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ padding: '14px 16px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div style={{ font: '700 15px/1.3 Satoshi' }}>{codeOf(act)}</div><button onClick={() => setActiveId(null)} style={{ width: 28, height: 28, border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer', fontSize: 18, color: '#75757C' }}>×</button></div>
                  <div style={{ padding: '0 16px' }}>
                    <div style={{ height: 320, borderRadius: 10, background: bg(full ?? act.thumbUrl) }} />
                    <div style={{ padding: '9px 11px', border: '1px solid #ECECE8', borderRadius: 10, background: '#FAFAF8', font: '500 12px/1.4 Satoshi', margin: '10px 0 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span>{act.analysisStatus === 'pending' || act.analysisStatus === 'processing' ? 'Analysis in progress. Fields fill in automatically.' : act.analysisStatus === 'failed' ? (act.analysisError ?? 'Analysis failed.') : act.analysisStatus === 'skipped' ? (chipOf(act)?.text === 'Needs review' ? 'Not analysed. Check each field.' : 'Not analysed.') : chipOf(act)?.text === 'Needs review' ? 'Low confidence. Check each field.' : 'Analysis complete. AI values can be edited.'}</span>
                      {!act.archived && act.analysisStatus !== 'processing' && <button className="stu-ghost" onClick={() => void reanalyse()} style={smallBtn}>{act.analysisStatus === 'failed' ? 'Retry analysis' : 'Re-analyse'}</button>}
                    </div>
                    <ImportPanel asset={act} />
                  </div>
                  <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
                    {FIELDS.map(([k, label]) => { const c = provChip(act.provenance[k], !!draft[k]); return (
                      <div key={k}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <span style={{ font: '600 12px/1 Satoshi' }}>{label} <span style={{ padding: '1px 7px', borderRadius: 999, background: c[1], color: c[2], font: '500 10px/1.5 Satoshi', marginLeft: 4 }}>{c[0]}</span></span>
                          {act.provenance[k] === 'manual' && <button onClick={() => void revert(k)} style={{ border: 'none', background: 'transparent', color: '#6C47FF', font: '500 11px/1 Satoshi', cursor: 'pointer' }}>Use AI value</button>}
                        </div>
                        <input className="stu-focus" value={draft[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} onBlur={() => void saveField(k)} aria-label={label} style={{ width: '100%', border: '1px solid #E4E4E0', borderRadius: 8, padding: '7px 9px', font: '400 13px/1.4 Satoshi', outline: 'none', boxSizing: 'border-box' }} />
                      </div>
                    ); })}
                  </div>
                  <div style={{ position: 'sticky', bottom: 0, background: '#fff', padding: '12px 16px', borderTop: '1px solid #ECECE8', marginTop: 12 }}><button className="stu-ghost" onClick={() => void toggleArchive()} style={{ width: '100%', height: 38, borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer' }}>{act.archived ? 'Restore image' : 'Archive image'}</button></div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      {editPack && (
        <Modal width={440} onClose={() => setEditPack(null)}>
          <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 16 }}>Edit Scene Pack</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 22 }}>
            <input className="stu-focus-b" value={editPack.name} onChange={(e) => setEditPack({ ...editPack, name: e.target.value })} placeholder="Pack name" aria-label="Pack name" style={{ height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', outline: 'none' }} />
            <input className="stu-focus-b" value={editPack.desc} onChange={(e) => setEditPack({ ...editPack, desc: e.target.value })} placeholder="Description" aria-label="Pack description" style={{ height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', outline: 'none' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="stu-ghost" onClick={() => setEditPack(null)} style={secondaryBtn}>Cancel</button><button className="stu-primary" onClick={() => void savePack()} style={{ ...primaryBtn, opacity: editPack.name.trim() ? 1 : 0.45 }}>Save</button></div>
        </Modal>
      )}
      {newPack && (
        <Modal width={440} onClose={() => setNewPack(false)}>
          <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 16 }}>New Scene Pack</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 22 }}>
            <input className="stu-focus-b" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} placeholder="Pack name" style={{ height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', outline: 'none' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <select value={np.env} onChange={(e) => setNp({ ...np, env: e.target.value })} style={{ height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 10px', font: '400 14px/1 Satoshi', background: '#fff' }}><option>Indoor</option><option>Outdoor</option></select>
              <input className="stu-focus-b" value={np.setting} onChange={(e) => setNp({ ...np, setting: e.target.value })} placeholder="Setting" style={{ height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', outline: 'none' }} />
            </div>
            <input className="stu-focus-b" value={np.act} onChange={(e) => setNp({ ...np, act: e.target.value })} placeholder="Activity" style={{ height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', outline: 'none' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="stu-ghost" onClick={() => setNewPack(false)} style={secondaryBtn}>Cancel</button><button className="stu-primary" onClick={() => void createPack()} style={{ ...primaryBtn, opacity: npOk ? 1 : 0.45 }}>Create pack</button></div>
        </Modal>
      )}
    </AppShell>
  );
}
