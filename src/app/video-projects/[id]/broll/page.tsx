'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';
import { api, C, post } from '@/components/composition/types';
import { searchClips } from '@/lib/broll-search';
import { ChevronRight, Eye, Film, Loader2, Sparkles, Trash2, UserRound, X } from 'lucide-react';

interface Scene { screenId: number; sceneNumber: number; dialogue: string }
interface GenericPick { clipId: number; screenId: number; overlayId?: number }
interface CharacterPick { assetId: number; screenId: number; action: string; itemId?: number; overlayId?: number }
interface Selection { generic: GenericPick[]; character: CharacterPick[] }
interface Suggestion { clipId: number; score: number; matches: string[] }
interface Clip { id: number; title: string; signedUrl: string | null; durationSeconds: number | null; userTags: string | null; subject: string | null; activity: string | null; setting: string | null; brand: string | null; description: string | null; categoryIds: number[]; brands?: { brandName: string | null; role: string }[]; createdAt: number }
interface Pack { id: number; name: string; activeCount?: number; imageCount?: number; assetCount?: number }
interface Asset { id: number; thumbUrl: string | null; originalFilename: string | null }
interface PackRec { packId: number; name: string; score: number; reasons: string[]; moments: string[] }

const words = (t: string) => new Set((t.toLowerCase().match(/[a-z]{4,}/g) ?? []));

/**
 * B-roll selection, before generation. Pick Generic B-roll (library clips) and Character B-roll (Scene Pack images) for individual script
 * scenes. Suggestions come from the script but never select anything. Picking only records IDs on the project: nothing is created,
 * generated or charged here. Character B-roll is then made on the existing Generation screen; library clips go straight to Composition.
 */
export default function BrollSelectionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const base = `/api/v1/video-projects/${id}`;
  const [name, setName] = useState('');
  const [state, setState] = useState<'loading' | 'off' | 'error' | 'ready'>('loading');
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sel, setSel] = useState<Selection>({ generic: [], character: [] });
  const [sug, setSug] = useState<Record<number, Suggestion[]>>({});
  const [activeId, setActiveId] = useState<number | null>(null);
  const [tab, setTab] = useState<'generic' | 'character'>('generic');
  const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false);
  const [clips, setClips] = useState<Clip[] | null>(null); const [cats, setCats] = useState<unknown[]>([]); const [q, setQ] = useState('');
  const [packs, setPacks] = useState<Pack[]>([]); const [packId, setPackId] = useState<number | null>(null); const [assets, setAssets] = useState<Asset[] | null>(null);
  const [recs, setRecs] = useState<PackRec[] | null>(null); const [recBusy, setRecBusy] = useState(false); const [recError, setRecError] = useState('');
  const [preview, setPreview] = useState<{ kind: 'clip' | 'image'; url: string; title: string } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(async () => {
    const [p, s] = await Promise.all([api<{ name: string }>(base), api<{ selection: Selection; scenes: Scene[]; genericSuggestions: Record<number, Suggestion[]> }>(`${base}/broll-selection`)]);
    if (s.status === 404) { setState('off'); return; }
    if (!p.ok || !s.ok) { setState('error'); return; }
    setName(p.data.name ?? ''); setScenes(s.data.scenes); setSel(s.data.selection); setSug(s.data.genericSuggestions ?? {}); setState('ready');
    setActiveId((cur) => cur ?? s.data.scenes[0]?.screenId ?? null);
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<Clip[]>('/api/v1/broll').then((r) => r.ok && setClips(r.data as unknown as Clip[]));
    api<unknown>('/api/v1/broll/categories').then((r) => { const d = r.data as unknown; const flat = (Array.isArray(d) ? d : (d as { categories?: unknown[] })?.categories ?? []) as Array<{ id: number; children?: unknown[] }>; const out: unknown[] = []; const walk = (n: Array<{ id: number; children?: unknown[] }>) => n.forEach((x) => { out.push(x); if (x.children) walk(x.children as typeof n); }); walk(flat); setCats(out); }).catch(() => undefined);
    api<{ packs: Pack[] }>('/api/v1/studio/packs').then((r) => { if (r.ok) { setPacks(r.data.packs ?? []); setPackId((cur) => cur ?? r.data.packs?.[0]?.id ?? null); } });
  }, []);
  useEffect(() => { if (packId == null) return; setAssets(null); api<{ assets: Asset[] }>(`/api/v1/studio/packs/${packId}/assets?limit=60`).then((r) => setAssets(r.ok ? r.data.assets ?? [] : [])); }, [packId]);

  // Every change is saved as the whole selection, one at a time, so quick clicks cannot overwrite each other.
  const save = useCallback((next: Selection) => {
    setSel(next); setMessage(''); setSaving(true);
    queue.current = queue.current.then(async () => {
      const r = await api<{ selection: Selection }>(`${base}/broll-selection`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generic: next.generic.map(({ clipId, screenId }) => ({ clipId, screenId })), character: next.character.map(({ assetId, screenId, action }) => ({ assetId, screenId, action })) }) });
      if (r.ok) setSel(r.data.selection); else { setMessage(r.data.error ?? 'That could not be saved.'); await load(); }
      setSaving(false);
    });
  }, [base, load]);

  const active = scenes.find((s) => s.screenId === activeId) ?? null;
  const toggleClip = (clipId: number) => { if (!active) return; const has = sel.generic.some((g) => g.clipId === clipId && g.screenId === active.screenId); save({ ...sel, generic: has ? sel.generic.filter((g) => !(g.clipId === clipId && g.screenId === active.screenId)) : [...sel.generic, { clipId, screenId: active.screenId }] }); };
  const toggleAsset = (assetId: number) => { if (!active) return; const has = sel.character.some((c) => c.assetId === assetId && c.screenId === active.screenId); save({ ...sel, character: has ? sel.character.filter((c) => !(c.assetId === assetId && c.screenId === active.screenId)) : [...sel.character, { assetId, screenId: active.screenId, action: '' }] }); };
  const setAction = (assetId: number, screenId: number, action: string) => setSel((s) => ({ ...s, character: s.character.map((c) => (c.assetId === assetId && c.screenId === screenId ? { ...c, action } : c)) }));

  const shownClips = useMemo(() => { if (!clips) return []; if (!q.trim()) return clips; // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return searchClips(q, clips as any, cats as any).hits.map((h) => h.clip as unknown as Clip); }, [clips, q, cats]);
  const suggested = useMemo(() => (active ? (sug[active.screenId] ?? []).map((s) => ({ ...s, clip: clips?.find((c) => c.id === s.clipId) })).filter((s) => s.clip) : []), [active, sug, clips]);
  const recFor = useMemo(() => { if (!recs || !active) return [] as PackRec[]; const w = words(active.dialogue); return recs.filter((r) => r.moments.some((m) => [...words(m)].some((x) => w.has(x)))); }, [recs, active]);

  const getRecs = async () => {
    setRecBusy(true); setRecError('');
    const r = await post(`${base}/broll-selection/recommendations`);
    if (r.ok) setRecs((r.data as { recommendations: PackRec[] }).recommendations); else setRecError(r.data.error ?? 'Recommendations are not available right now.');
    setRecBusy(false);
  };

  const sceneNo = (sid: number) => scenes.find((s) => s.screenId === sid)?.sceneNumber ?? '?';
  const clipOf = (cid: number) => clips?.find((c) => c.id === cid);

  if (state === 'loading') return <AppShell><div className="page-body"><div className="skeleton" style={{ height: 28, width: '40%' }} /></div></AppShell>;
  if (state !== 'ready') return <AppShell><div className="page-body" style={{ maxWidth: 560 }}><h1 style={{ font: '700 22px/1.2 Satoshi' }}>{state === 'off' ? 'B-roll is not turned on' : 'Could not load this step'}</h1><p style={{ font: '400 14px/1.5 Satoshi', color: C.muted }}>{state === 'off' ? 'Continue to scene generation.' : 'Reload the page to try again.'}</p><a href={`/video-projects/${id}/screens/1`}>Continue</a></div></AppShell>;

  const nGen = sel.generic.length, nChar = sel.character.length;
  const steps = [{ label: 'Script', status: 'complete' as const }, { label: 'Breakdown', status: 'complete' as const }, { label: 'Scenes', status: 'active' as const }, { label: 'Compile', status: 'pending' as const }, { label: 'Review', status: 'pending' as const }];
  const tabBtn = (k: 'generic' | 'character', label: string, n: number, color: string) => (
    <button role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ height: 38, padding: '0 16px', borderRadius: 9, border: tab === k ? `1px solid ${color}` : `1px solid ${C.borderStrong}`, background: tab === k ? '#fff' : C.soft, font: '700 13px/1 Satoshi', color: C.text, cursor: 'pointer' }}>
      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: color, marginRight: 8 }} />{label}<span style={{ marginLeft: 8, color: C.muted, font: '500 12px/1 Satoshi' }}>{n}</span>
    </button>
  );
  const thumbBox = (selected: boolean, h: number): React.CSSProperties => ({ display: 'block', position: 'relative', height: h, borderRadius: 10, overflow: 'hidden', border: selected ? `3px solid ${C.primary}` : `1px solid ${C.border}`, background: C.soft });
  const eye: React.CSSProperties = { position: 'absolute', bottom: 6, right: 6, width: 26, height: 26, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.6)', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer' };

  return (
    <AppShell>
      <ProjectHeader projectId={id} projectName={name} steps={steps} statusLabel="Choose B-roll" />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <nav aria-label="Scenes" style={{ width: 250, flexShrink: 0, borderRight: `1px solid ${C.border}`, background: '#fff', padding: '20px 14px', overflow: 'auto' }}>
          <div style={{ font: '600 11px/1 Satoshi', color: C.muted, textTransform: 'uppercase', letterSpacing: '.06em', padding: '0 8px 10px' }}>Choose a scene</div>
          {scenes.map((s) => {
            const g = sel.generic.filter((x) => x.screenId === s.screenId).length; const c = sel.character.filter((x) => x.screenId === s.screenId).length;
            return (
              <button key={s.screenId} onClick={() => setActiveId(s.screenId)} aria-current={activeId === s.screenId} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 10, marginBottom: 6, borderRadius: 9, border: activeId === s.screenId ? '1px solid #DDD6FE' : '1px solid transparent', background: activeId === s.screenId ? '#EFEBFF' : 'transparent', cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', font: '700 13px/1 Satoshi', color: C.text }}>Scene {s.sceneNumber}<span style={{ font: '500 11px/1 Satoshi', color: c ? C.character : g ? C.generic : C.muted }}>{c || g ? `${c ? `${c} character` : ''}${c && g ? ' · ' : ''}${g ? `${g} clip${g === 1 ? '' : 's'}` : ''}` : 'none'}</span></div>
                <div style={{ font: '400 12px/1.4 Satoshi', color: C.muted, marginTop: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{s.dialogue}</div>
              </button>
            );
          })}
        </nav>

        <section style={{ flex: 1, minWidth: 0, padding: '24px 28px', overflow: 'auto' }}>
          <h1 style={{ margin: 0, font: '700 22px/1.2 Satoshi', letterSpacing: '-0.02em' }}>B-roll for Scene {active?.sceneNumber}</h1>
          <p style={{ margin: '4px 0 6px', font: '400 13px/1.5 Satoshi', color: '#5E5E65' }}>Choosing here only saves your picks. Nothing is generated or charged on this screen.</p>
          {active && <blockquote style={{ margin: '0 0 14px', padding: '8px 12px', borderLeft: `3px solid ${C.border}`, font: '400 13px/1.5 Satoshi', color: '#3D3D45' }}>{active.dialogue}</blockquote>}
          {message && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{message}</div>}
          <div role="tablist" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>{tabBtn('generic', 'Add Generic B-roll', nGen, C.generic)}{tabBtn('character', 'Add Character B-roll', nChar, C.character)}</div>

          {tab === 'generic' ? (
            <>
              <div style={{ font: '700 13px/1 Satoshi', margin: '4px 0 8px' }}><Sparkles size={13} style={{ verticalAlign: -2 }} /> Suggested for this scene</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                {suggested.length === 0 && <span style={{ color: C.muted, font: '400 12px/1.4 Satoshi' }}>No library clip shares words with this scene yet. Search the whole library below.</span>}
                {suggested.map((s) => <ClipCard key={s.clipId} clip={s.clip!} note={`matches: ${s.matches.slice(0, 3).join(', ')}`} selected={!!active && sel.generic.some((g) => g.clipId === s.clipId && g.screenId === active.screenId)} onToggle={() => toggleClip(s.clipId)} onPreview={() => s.clip?.signedUrl && setPreview({ kind: 'clip', url: s.clip.signedUrl, title: s.clip.title })} thumb={thumbBox} eye={eye} />)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 10px' }}>
                <b style={{ font: '700 13px/1 Satoshi' }}><Film size={13} style={{ verticalAlign: -2 }} /> Whole library</b><span style={{ flex: 1 }} />
                <input aria-label="Search the B-roll library" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the library…" style={{ height: 34, borderRadius: 8, border: `1px solid ${C.borderStrong}`, padding: '0 10px', font: '400 12px/1 Satoshi', minWidth: 220 }} />
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {clips === null && <span style={{ color: C.muted, font: '400 13px/1 Satoshi' }}>Loading…</span>}
                {clips && shownClips.length === 0 && <span style={{ color: C.muted, font: '400 13px/1.4 Satoshi' }}>No clips match.</span>}
                {shownClips.map((c) => <ClipCard key={c.id} clip={c} selected={!!active && sel.generic.some((g) => g.clipId === c.id && g.screenId === active.screenId)} onToggle={() => toggleClip(c.id)} onPreview={() => c.signedUrl && setPreview({ kind: 'clip', url: c.signedUrl, title: c.title })} thumb={thumbBox} eye={eye} />)}
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px', flexWrap: 'wrap' }}>
                <b style={{ font: '700 13px/1 Satoshi' }}><UserRound size={13} style={{ verticalAlign: -2 }} /> Scene Pack images your character will be put into</b><span style={{ flex: 1 }} />
                <button onClick={() => void getRecs()} disabled={recBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', borderRadius: 8, border: `1px solid ${C.borderStrong}`, background: '#fff', font: '600 12px/1 Satoshi', cursor: 'pointer' }}>{recBusy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} {recs ? 'Refresh recommendations' : 'Recommend Scene Packs from the script'}</button>
                <select aria-label="Scene Pack" value={packId ?? ''} onChange={(e) => setPackId(Number(e.target.value))} style={{ height: 34, borderRadius: 8, border: `1px solid ${C.borderStrong}`, padding: '0 8px', font: '500 12px/1 Satoshi', background: '#fff' }}>{packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </div>
              {recError && <div role="alert" style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 9, background: '#FFF4D6', color: C.warn, font: '400 12px/1.4 Satoshi' }}>{recError}</div>}
              {recs && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ font: '500 12px/1.4 Satoshi', color: C.muted, marginBottom: 6 }}>{recFor.length ? 'Recommended for this scene' : 'Recommended for the whole script'} (nothing is selected for you)</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(recFor.length ? recFor : recs).slice(0, 6).map((r) => <button key={r.packId} onClick={() => setPackId(r.packId)} title={r.reasons.join(' ')} style={{ padding: '6px 10px', borderRadius: 999, border: packId === r.packId ? `1px solid ${C.primary}` : `1px solid ${C.borderStrong}`, background: packId === r.packId ? '#EFEBFF' : '#fff', font: '500 12px/1.3 Satoshi', cursor: 'pointer', textAlign: 'left' }}>{r.name}{r.reasons[0] ? <span style={{ color: C.muted }}> · {r.reasons[0].slice(0, 60)}</span> : null}</button>)}
                    {recs.length === 0 && <span style={{ color: C.muted, font: '400 12px/1.4 Satoshi' }}>No pack stood out for this script. Browse the packs below.</span>}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {assets === null && <span style={{ color: C.muted, font: '400 13px/1 Satoshi' }}>Loading…</span>}
                {assets?.length === 0 && <span style={{ color: C.muted, font: '400 13px/1.4 Satoshi' }}>This pack has no images.</span>}
                {assets?.map((a) => {
                  const mine = !!active && sel.character.some((c) => c.assetId === a.id && c.screenId === active.screenId);
                  const elsewhere = sel.character.find((c) => c.assetId === a.id && c.screenId !== active?.screenId);
                  return (
                    <div key={a.id} style={{ width: 112 }}>
                      <button onClick={() => toggleAsset(a.id)} aria-pressed={mine} aria-label={`${mine ? 'Deselect' : 'Select'} ${a.originalFilename ?? 'Scene Pack image'}`} style={{ ...thumbBox(mine, 150), width: '100%', padding: 0, cursor: 'pointer' }}>
                        {a.thumbUrl && <img src={a.thumbUrl} alt={a.originalFilename ?? 'Scene Pack image'} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
                        {mine && <span style={{ position: 'absolute', top: 6, right: 6, background: C.primary, color: '#fff', font: '700 11px/1 Satoshi', padding: '4px 6px', borderRadius: 999 }}>✓ Scene {active?.sceneNumber}</span>}
                        {!mine && elsewhere && <span style={{ position: 'absolute', top: 6, right: 6, background: '#F0F0EC', color: C.muted, font: '600 11px/1 Satoshi', padding: '4px 6px', borderRadius: 999 }}>Scene {sceneNo(elsewhere.screenId)}</span>}
                      </button>
                      {a.thumbUrl && <button aria-label="Preview image" onClick={() => setPreview({ kind: 'image', url: a.thumbUrl!, title: a.originalFilename ?? 'Scene Pack image' })} style={{ marginTop: 4, border: 'none', background: 'none', cursor: 'pointer', color: C.muted, font: '500 11px/1 Satoshi' }}><Eye size={12} style={{ verticalAlign: -2 }} /> Preview</button>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        <aside style={{ width: 310, flexShrink: 0, borderLeft: `1px solid ${C.border}`, background: '#fff', padding: '20px 18px', display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
          <div style={{ font: '700 14px/1 Satoshi' }}>Your selections <span style={{ font: '400 12px/1 Satoshi', color: C.muted, marginLeft: 6 }}>{nChar} character · {nGen} clip{nGen === 1 ? '' : 's'}{saving ? ' · saving…' : ''}</span></div>
          {nChar + nGen === 0 && <div style={{ font: '400 12px/1.5 Satoshi', color: C.muted }}>Nothing chosen yet. B-roll is optional: the video still compiles from the Flow scenes alone.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[...sel.generic.map((g) => ({ k: 'g' as const, screenId: g.screenId, g })), ...sel.character.map((c) => ({ k: 'c' as const, screenId: c.screenId, c }))].sort((a, b) => Number(sceneNo(a.screenId)) - Number(sceneNo(b.screenId))).map((e) => e.k === 'g' ? (
              <div key={`g${e.g.clipId}:${e.g.screenId}`} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ width: 6, alignSelf: 'stretch', minHeight: 34, borderRadius: 3, background: C.generic }} />
                <div style={{ flex: 1, minWidth: 0 }}><b style={{ font: '600 12px/1.3 Satoshi' }}>Scene {sceneNo(e.screenId)} · {clipOf(e.g.clipId)?.title ?? 'Library clip'}</b><div style={{ font: '400 11px/1.4 Satoshi', color: C.muted }}>Generic · {e.g.overlayId ? 'on the timeline' : 'goes to Composition'}</div></div>
                <button aria-label="Remove" onClick={() => save({ ...sel, generic: sel.generic.filter((x) => !(x.clipId === e.g.clipId && x.screenId === e.g.screenId)) })} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.danger }}><Trash2 size={14} /></button>
              </div>
            ) : (
              <div key={`c${e.c.assetId}:${e.c.screenId}`} style={{ display: 'flex', gap: 10 }}>
                <span style={{ width: 6, alignSelf: 'stretch', minHeight: 34, borderRadius: 3, background: C.character }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ font: '600 12px/1.3 Satoshi' }}>Scene {sceneNo(e.c.screenId)} · Scene Pack image</b>
                  <div style={{ font: '400 11px/1.4 Satoshi', color: C.muted }}>Character · {e.c.itemId ? 'started on the Generation screen' : 'made on the Generation screen'}</div>
                  <input aria-label="What the character does" value={e.c.action} disabled={e.c.itemId !== undefined} onChange={(ev) => setAction(e.c.assetId, e.c.screenId, ev.target.value)} onBlur={() => save(sel)} placeholder="What should the character do?" style={{ marginTop: 5, width: '100%', boxSizing: 'border-box', height: 30, borderRadius: 7, border: `1px solid ${C.borderStrong}`, padding: '0 8px', font: '400 12px/1 Satoshi' }} />
                </div>
                <button aria-label="Remove" disabled={e.c.itemId !== undefined} title={e.c.itemId !== undefined ? 'Already started: it cannot be removed here' : 'Remove'} onClick={() => save({ ...sel, character: sel.character.filter((x) => !(x.assetId === e.c.assetId && x.screenId === e.c.screenId)) })} style={{ border: 'none', background: 'none', cursor: e.c.itemId !== undefined ? 'not-allowed' : 'pointer', color: C.danger, opacity: e.c.itemId !== undefined ? 0.4 : 1 }}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button onClick={() => router.push(`/video-projects/${id}/screens/1`)} disabled={saving} style={{ display: 'inline-flex', justifyContent: 'center', alignItems: 'center', gap: 6, height: 42, borderRadius: 9, background: C.primary, color: '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>Continue to generation <ChevronRight size={14} /></button>
          <span style={{ font: '400 12px/1.4 Satoshi', color: C.muted, textAlign: 'center' }}>You can skip B-roll, or come back and change it later.</span>
        </aside>
      </div>
      {preview && (
        <div role="dialog" aria-label={`Preview: ${preview.title}`} onClick={() => setPreview(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', maxWidth: 'min(520px, 100%)' }}>
            <button aria-label="Close preview" onClick={() => setPreview(null)} style={{ position: 'absolute', top: -34, right: 0, border: 'none', background: 'none', color: '#fff', cursor: 'pointer' }}><X size={20} /></button>
            {preview.kind === 'clip' ? <video src={preview.url} controls autoPlay muted style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: 10, background: '#000' }} /> : <img src={preview.url} alt={preview.title} style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: 10 }} />}
          </div>
        </div>
      )}
      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </AppShell>
  );
}

function ClipCard({ clip, selected, onToggle, onPreview, note, thumb, eye }: { clip: Clip; selected: boolean; onToggle: () => void; onPreview: () => void; note?: string; thumb: (s: boolean, h: number) => React.CSSProperties; eye: React.CSSProperties }) {
  return (
    <div style={{ width: 112 }}>
      <button onClick={onToggle} aria-pressed={selected} aria-label={`${selected ? 'Deselect' : 'Select'} ${clip.title}`} style={{ ...thumb(selected, 130), width: '100%', padding: 0, cursor: 'pointer', background: '#000' }}>
        {clip.signedUrl && <video src={clip.signedUrl} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
        {clip.durationSeconds ? <span style={{ position: 'absolute', bottom: 6, left: 6, background: 'rgba(0,0,0,.6)', color: '#fff', font: '500 10px/1 Satoshi', padding: '3px 5px', borderRadius: 4 }}>{clip.durationSeconds}s</span> : null}
        {selected && <span style={{ position: 'absolute', top: 6, right: 6, background: C.primary, color: '#fff', font: '700 11px/1 Satoshi', padding: '4px 6px', borderRadius: 999 }}>✓</span>}
      </button>
      <button aria-label={`Preview ${clip.title}`} onClick={onPreview} style={{ ...eye, position: 'relative', bottom: 'auto', right: 'auto', marginTop: -32, marginLeft: 82, display: 'grid' }}><Eye size={13} /></button>
      <span style={{ display: 'block', font: '400 11px/1.3 Satoshi', color: '#5E5E65', marginTop: 5 }}>{clip.title}</span>
      {note && <span style={{ display: 'block', font: '400 10px/1.3 Satoshi', color: C.generic }}>{note}</span>}
    </div>
  );
}
