'use client';

import { workflowSteps } from '@/lib/steps';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';
import Preview, { type PreviewHandle } from '@/components/composition/Preview';
import Timelines from '@/components/composition/Timelines';
import Details from '@/components/composition/Details';
import LibraryPicker from '@/components/composition/LibraryPicker';
import { api, C, patch, post, type Composition, type FillResult } from '@/components/composition/types';
import { AlertTriangle, ChevronRight, Film } from 'lucide-react';

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
  const preview = useRef<PreviewHandle>(null);
  const base = `/api/v1/video-projects/${id}`;

  // The timeline is filled in from the B-roll selection (library clips, and Character clips that finished on the Generation screen). Safe to
  // repeat: it makes nothing twice, never brings back a clip you removed and never moves a clip you placed or edited.
  const [fill, setFill] = useState<FillResult | null>(null);
  const load = useCallback(async (populate = false) => {
    if (populate) { const f = await api<FillResult>(`${base}/overlays/populate`, { method: 'POST' }); if (f.ok) setFill(f.data as FillResult); }
    const r = await api<Composition>(`${base}/composition`);
    if (r.status === 404) { setState('off'); return; }
    if (!r.ok) { setState('error'); return; }
    setData(r.data as unknown as Composition); setState('ready');
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

  const selected = data.overlays.find((o) => o.id === selectedId) ?? null;
  const item = selected?.characterItemId ? data.items.find((i) => i.id === selected.characterItemId) ?? null : null;
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

  return (
    <AppShell>
      <ProjectHeader projectId={id} projectName={data.project.name ?? `Project ${id}`} steps={steps} actions={<Link href={`/video-projects/${id}/compile`} style={{ textDecoration: 'none' }}><button style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, background: C.primary, color: '#fff', border: 'none', font: '700 13px/1 Satoshi', cursor: 'pointer' }}>Go to Compile <ChevronRight size={14} /></button></Link>} />
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 28px 64px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, font: '700 24px/1.2 Satoshi', letterSpacing: '-0.02em' }}>Composition</h1>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ font: '400 12px/1 Satoshi', color: C.muted }}>{data.overlays.length} / {data.limit} B-roll</span>
              <button disabled={atLimit} onClick={() => setPicker({ mode: 'add' })} style={tool}><Film size={14} /> Add library B-roll</button>
            </div>
          </div>
          <p style={{ font: '400 13px/1.5 Satoshi', color: C.muted, margin: '6px 0 16px' }}>B-roll sits on top of your Flow scenes and is silent. It was placed for you from the scenes you chose it for; drag, trim or remove anything and your changes are kept. The Flow narration keeps playing, and the Flow footage comes back when a clip ends.</p>

          {message && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{message}</div>}
          {fill && fill.waiting > 0 && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', borderRadius: 9, background: '#FFF4D6', color: C.warn, font: '500 12px/1.4 Satoshi' }}>{fill.waiting} Character B-roll clip{fill.waiting === 1 ? ' is' : 's are'} still being made. {fill.waiting === 1 ? 'It' : 'They'} will appear here, on the right scene, once the video is ready. <Link href={`/video-projects/${id}/screens/1`} style={{ color: 'inherit', textDecoration: 'underline' }}>Open Generation</Link></div>}
          {fill && fill.unplaced > 0 && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', borderRadius: 9, background: '#FFF4D6', color: C.warn, font: '500 12px/1.4 Satoshi' }}>{fill.unplaced} selected clip{fill.unplaced === 1 ? '' : 's'} did not fit inside {fill.unplaced === 1 ? 'its' : 'their'} scene without overlapping another clip, so {fill.unplaced === 1 ? 'it was' : 'they were'} not placed. Make room or choose another scene.</div>}
          {fill && fill.sceneMissing > 0 && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', borderRadius: 9, background: '#FDECEA', color: C.danger, font: '500 12px/1.4 Satoshi' }}>{fill.sceneMissing} selected clip{fill.sceneMissing === 1 ? ' belongs' : 's belong'} to a scene that was deleted. {fill.sceneMissing === 1 ? 'It was' : 'They were'} not placed. <Link href={`/video-projects/${id}/broll`} style={{ color: 'inherit', textDecoration: 'underline' }}>Choose B-roll again</Link></div>}
          {attention.length > 0 && <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', borderRadius: 9, background: '#FDECEA', color: C.danger, font: '500 12px/1.4 Satoshi' }}><AlertTriangle size={14} /> {attention.length} B-roll clip{attention.length === 1 ? ' needs' : 's need'} attention before you can compile.</div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
            <Preview ref={preview} scenes={data.scenes} overlays={data.overlays} totalMs={data.totalMs} time={time} onTime={setTime} />
            <div style={{ display: 'grid', gap: 16 }}>
              <Timelines scenes={data.scenes} overlays={data.overlays} totalMs={data.totalMs} time={time} selectedId={selectedId}
                onSeek={(ms) => preview.current?.seek(ms)} onSelect={setSelectedId}
                onMove={(oid, to) => void run(() => patch(`${base}/overlays/${oid}`, to))}
                onResize={(oid, durationMs) => void run(() => patch(`${base}/overlays/${oid}`, { durationMs }))} />
              <Details overlay={selected} scenes={data.scenes} item={item}
                onChange={(oid, p) => run(() => patch(`${base}/overlays/${oid}`, p))}
                onRemove={(oid) => { if (window.confirm('Remove this B-roll from the video? The clip stays in your library.')) { setSelectedId(null); void run(() => api(`${base}/overlays/${oid}`, { method: 'DELETE' })); } }}
                onReplace={(oid) => setPicker({ mode: 'replace', id: oid })} onRetry={(oid) => void run(() => post(`${base}/overlays/${oid}/retry`))} />
            </div>
          </div>
        </div>
      </div>

      {picker && <LibraryPicker title={picker.mode === 'replace' ? 'Replace with another library clip' : 'Add library B-roll'} onPick={(cid) => void addLibrary(cid)} onClose={() => setPicker(null)} />}
    </AppShell>
  );
}
const tool: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, background: '#fff', border: `1px solid ${C.borderStrong}`, font: '500 13px/1 Satoshi', cursor: 'pointer', color: C.text };
