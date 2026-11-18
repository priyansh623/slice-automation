'use client';

import { workflowSteps } from '@/lib/steps';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';
import Preview, { type PreviewHandle } from '@/components/composition/Preview';
import Timelines, { clock } from '@/components/composition/Timelines';
import LibraryPicker from '@/components/composition/LibraryPicker';
import { api, C, patch, post, type Composition, type FillResult } from '@/components/composition/types';
import { makeUrlStabiliser } from '@/lib/overlays/ui-math';
import { AlertTriangle, ChevronRight, Pause, Play, SkipBack } from 'lucide-react';

/**
 * Composition: the Flow sequence (primary timeline, in compile order) with B-roll overlays placed on top of it. Overlays are silent and
 * never replace Flow footage, so the narration inside the Flow clips plays straight through. Compiling is done from the Compile page,
 * which freezes these overlays into that version.
 */
export default function CompositionPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Composition | null>(null);
  const [state, setState] = useState<'loading' | 'off' | 'error' | 'ready'>('loading');
  const [time, setTime] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [picker, setPicker] = useState<null | { mode: 'add' } | { mode: 'replace'; id: number }>(null);
  const [message, setMessage] = useState('');
  const [playing, setPlaying] = useState(false);
  const preview = useRef<PreviewHandle>(null);
  const base = `/api/v1/video-projects/${id}`;

  // The timeline is filled in from the B-roll selection (library clips, and Character clips that finished on the Generation screen). Safe to
  // repeat: it makes nothing twice, never brings back a clip you removed and never moves a clip you placed or edited.
  const [fill, setFill] = useState<FillResult | null>(null);
  // Only the newest answer is shown: a slower, older read (the 4 second refresh) can never put a clip back where it was before a move.
  const loadSeq = useRef(0);
  // The same file keeps the same link across refreshes, so an edit does not make every video download again.
  const stableUrl = useRef(makeUrlStabiliser());
  const load = useCallback(async (populate = false) => {
    const seq = ++loadSeq.current;
    if (populate) { const f = await api<FillResult>(`${base}/overlays/populate`, { method: 'POST' }); if (f.ok && seq === loadSeq.current) setFill(f.data as FillResult); }
    const r = await api<Composition>(`${base}/composition`);
    if (seq !== loadSeq.current) return;
    if (r.status === 404) { setState('off'); return; }
    if (!r.ok) { setState('error'); return; }
    const next = r.data as unknown as Composition;
    const stable = stableUrl.current;
    setData({
      ...next,
      scenes: next.scenes.map((sc) => ({ ...sc, clipUrl: stable(`scene:${sc.screenId}:${sc.generationId}`, sc.clipUrl) })),
      overlays: next.overlays.map((o) => ({ ...o, assetUrl: stable(`overlay:${o.id}:${(o as unknown as { assetStoragePath?: string | null }).assetStoragePath ?? ''}`, o.assetUrl) })),
    });
    setState('ready');
  }, [base]);
  useEffect(() => { void load(true); }, [load]);

  // Keep fresh while something is being prepared or generated.
  const busy = !!data && (data.overlays.some((o) => o.status === 'preparing') || data.items.some((i) => i.imageStatus === 'generating' || ['queued', 'submitting', 'submit_unknown', 'processing'].includes(i.clipStatus)));
  useEffect(() => { if (!busy) return; const t = setInterval(() => void load(true), 4000); return () => clearInterval(t); }, [busy, load]);

  const run = async (fn: () => Promise<{ ok: boolean; data: { error?: string } }>): Promise<string | null> => {
    setMessage('');
    const r = await fn();
    if (!r.ok) { const m = r.data.error ?? 'That did not work.'; setMessage(m); return m; }
    await load(); return null;
  };

  if (state === 'loading') return <AppShell><div className="page-body"><div className="skeleton" style={{ height: 28, width: '40%' }} /></div></AppShell>;
  if (state === 'off' || state === 'error' || !data) {
    return <AppShell><div className="page-body" style={{ maxWidth: 560 }}><h1 style={{ font: '700 22px/1.2 Satoshi' }}>{state === 'off' ? 'B-roll overlays are not turned on' : 'Could not load the composition'}</h1><p style={{ font: '400 14px/1.5 Satoshi', color: C.muted }}>{state === 'off' ? 'This feature is switched off for now. Your Flow video and compile work as before.' : 'Reload the page to try again.'}</p><Link href={`/video-projects/${id}/compile`}>Back to Compile</Link></div></AppShell>;
  }

  const attention = data.overlays.filter((o) => o.needsAttention);
  const atLimit = data.overlays.length >= data.limit;
  const steps = workflowSteps('Composition');

  const addLibrary = async (clipId: number) => {
    const p = picker; setPicker(null);
    if (!p) return;
    if (p.mode === 'replace') { await run(() => patch(`${base}/overlays/${p.id}`, { replaceWithBrollClipId: clipId })); return; }
    const cur = preview.current ? time : 0;
    const scene = [...data.scenes].reverse().find((s) => s.startMs <= cur) ?? data.scenes[0];
    const r = await api<{ id?: number }>(`${base}/overlays`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brollClipId: clipId, anchorScreenId: scene?.screenId, startOffsetMs: scene ? Math.max(0, Math.round(cur - scene.startMs)) : 0 }) });
    if (!r.ok) {
      // The playhead spot is taken: let the server find the first free place instead.
      const again = await api<{ id?: number }>(`${base}/overlays`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brollClipId: clipId }) });
      if (!again.ok) { setMessage(again.data.error ?? r.data.error ?? 'Could not add the clip.'); return; }
      setSelectedId(again.data.id ?? null);
    } else setSelectedId(r.data.id ?? null);
    await load();
  };

  const anyManual = data.overlays.some((o) => o.placementSource === 'manual');
  const removeClip = (oid: number) => { if (window.confirm('Remove this B-roll from the video? The clip stays in your library.')) { setSelectedId(null); void run(() => api(`${base}/overlays/${oid}`, { method: 'DELETE' })); } };

  return (
    <AppShell>
      <ProjectHeader projectId={id} projectName={data.project.name ?? `Project ${id}`} steps={steps} actions={<Link href={`/video-projects/${id}/compile`} style={{ textDecoration: 'none' }}><button style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, background: C.primary, color: '#fff', border: 'none', font: '700 13px/1 Satoshi', cursor: 'pointer' }}>Go to Compile <ChevronRight size={14} /></button></Link>} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ height: '100%', maxWidth: 1560, margin: '0 auto', padding: '12px 24px 16px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {message && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{message}</div>}
          {fill && fill.waiting > 0 && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', borderRadius: 9, background: '#FFF4D6', color: C.warn, font: '500 12px/1.4 Satoshi' }}>{fill.waiting} Character B-roll clip{fill.waiting === 1 ? ' is' : 's are'} still being made. {fill.waiting === 1 ? 'It' : 'They'} will appear here, on the right scene, once the video is ready. <Link href={`/video-projects/${id}/screens/1`} style={{ color: 'inherit', textDecoration: 'underline' }}>Open Generation</Link></div>}
          {fill && fill.unplaced > 0 && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', borderRadius: 9, background: '#FFF4D6', color: C.warn, font: '500 12px/1.4 Satoshi' }}>{fill.unplaced} selected clip{fill.unplaced === 1 ? '' : 's'} did not fit inside {fill.unplaced === 1 ? 'its' : 'their'} scene without overlapping another clip, so {fill.unplaced === 1 ? 'it was' : 'they were'} not placed. Make room or choose another scene.</div>}
          {fill && fill.sceneMissing > 0 && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', borderRadius: 9, background: '#FDECEA', color: C.danger, font: '500 12px/1.4 Satoshi' }}>{fill.sceneMissing} selected clip{fill.sceneMissing === 1 ? ' belongs' : 's belong'} to a scene that was deleted. {fill.sceneMissing === 1 ? 'It was' : 'They were'} not placed. <Link href={`/video-projects/${id}/broll`} style={{ color: 'inherit', textDecoration: 'underline' }}>Choose B-roll again</Link></div>}
          {attention.length > 0 && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', borderRadius: 9, background: '#FDECEA', color: C.danger, font: '500 12px/1.4 Satoshi' }}><AlertTriangle size={14} /> {attention.length} B-roll clip{attention.length === 1 ? ' needs' : 's need'} attention before you can compile.</div>}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center', padding: '4px 0 12px' }}>
            <Preview ref={preview} scenes={data.scenes} overlays={data.overlays} totalMs={data.totalMs} time={time} onTime={setTime} onPlaying={setPlaying} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', marginBottom: 10, flexShrink: 0, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14 }}>
            <button aria-label="Back to start" onClick={() => preview.current?.restart()} style={tbtn}><SkipBack size={16} /></button>
            <button aria-label={playing ? 'Pause' : 'Play'} onClick={() => preview.current?.toggle()} style={{ ...tbtn, background: '#111113', color: '#fff', border: 'none', width: 50 }}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
            <span style={{ font: '500 20px/1 Satoshi', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>{clock(time)} <span style={{ color: C.muted }}>/ {clock(data.totalMs)}</span></span>
            <span style={{ flex: 1 }} />
            {data.overlays.length > 0 && <span data-testid="arrangement-badge" style={{ height: 32, padding: '0 14px', borderRadius: 999, background: anyManual ? '#F0F0EC' : '#EFEBFF', color: anyManual ? '#5E5E65' : C.primary, font: '500 13px/32px Satoshi' }}>{anyManual ? 'Auto-arranged, edited by you' : 'Auto-arranged from script'}</span>}
          </div>
          <Timelines scenes={data.scenes} overlays={data.overlays} totalMs={data.totalMs} time={time} selectedId={selectedId} atLimit={atLimit}
            onSeek={(ms) => preview.current?.seek(ms)} onSelect={setSelectedId}
            onMove={(oid, to) => run(() => patch(`${base}/overlays/${oid}`, to))}
            onResize={(oid, durationMs) => run(() => patch(`${base}/overlays/${oid}`, { durationMs }))}
            onReplace={(oid) => setPicker({ mode: 'replace', id: oid })} onRemove={removeClip}
            onTrim={(oid, to) => run(() => patch(`${base}/overlays/${oid}`, to))}
            onScene={(oid, screenId) => { const sc = data.scenes.find((x) => x.screenId === screenId); const ov = data.overlays.find((x) => x.id === oid); const off = sc && ov ? Math.max(0, Math.round((sc.durationMs - ov.durationMs) / 2 / 100) * 100) : 0; void run(() => patch(`${base}/overlays/${oid}`, { anchorScreenId: screenId, startOffsetMs: off })); }}
            onRetry={(oid) => void run(() => post(`${base}/overlays/${oid}/retry`))}
            onAddGeneric={() => setPicker({ mode: 'add' })} />
        </div>
      </div>

      {picker && <LibraryPicker title={picker.mode === 'replace' ? 'Replace with another library clip' : 'Add library B-roll'} onPick={(cid) => void addLibrary(cid)} onClose={() => setPicker(null)} />}
    </AppShell>
  );
}
const tbtn: React.CSSProperties = { height: 40, width: 40, borderRadius: 11, border: `1px solid ${C.borderStrong}`, background: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer', color: C.text };
