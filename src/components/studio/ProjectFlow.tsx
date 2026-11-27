'use client';

/**
 * Character B-roll Studio project flow, as supplied: Setup, Script, Select, Generate, Review. Markup and styles are copied from the
 * prototype (Character B-roll Studio.dc.html); the prototype's mock data is replaced by the real Studio APIs.
 */
import { visibleInterval } from '@/lib/client/visible-interval';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { createClient } from '@/lib/supabase/client';
import { alertGreen, alertRed, CodeChip, Modal, PulseDots, primaryBtn, secondaryBtn, Segmented, smallBtn, TileChip } from './ui/ds';
import {
  api, isActiveBatch, uploadCharacter, type ApprovedPack, type BatchListItem, type GenerationConfig, type JobRow, type OutputRow, type SelectionRow, type StudioAsset, type StudioPack, type StudioProject,
} from '@/lib/studio/client';
import { chipOf, codeOf, STEP_NAMES } from '@/lib/studio/ui';

const SAMPLE = 'I used to scroll my phone in bed until late, never really tracking where my money went.\n\nLast month I picked up the Super Slicer card. At the cafe counter I just tapped and paid, no cash, no fuss.\n\nBack home I sat on the sofa with my coffee and checked my spends on the laptop.\n\nNow I show it to everyone. This is the card I carry.';
const bg = (url: string | null | undefined) => (url ? `#E4E4E0 url("${url}") center top/cover no-repeat` : '#E4E4E0');
const STEPS = ['Setup', 'Script', 'Select', 'Generate', 'Review'];
// The design's four states, plus the existing "Needs attention" (the provider never confirmed the image: it is never retried automatically).
const DESIGN_STATUS = { queued: ['Queued', '#F3F4F6', '#6B7280'], running: ['Generating', '#EDE9FE', '#6D28D9'], done: ['Done', '#DCFCE7', '#16A34A'], failed: ['Failed', '#FEE2E2', '#B91C1C'], attention: ['Needs attention', '#FEF3C7', '#92400E'] } as const;
type DStatus = keyof typeof DESIGN_STATUS;
const dStatus = (j: JobRow): DStatus => (j.status === 'queued' ? 'queued' : j.status === 'submitting' || j.status === 'processing' ? 'running' : j.status === 'succeeded' ? 'done' : j.status === 'submit_unknown' ? 'attention' : 'failed');
const isFail = (st: DStatus) => st === 'failed' || st === 'attention';
const failMsg = (j: JobRow) => (j.status === 'submit_unknown' ? 'The provider did not confirm this image.' : j.error?.message || (j.status === 'canceled' ? 'Canceled' : 'Generation failed'));
/** Marks an image that came from the test provider. Shown on every generated image, saved or not. */
const TestBadge = () => <span title="Made by the test provider: a placeholder, not a real result" style={{ padding: '1px 7px', borderRadius: 999, background: '#7C3AED', color: '#fff', font: '700 10px/1.6 Satoshi', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>TEST · NOT REAL</span>;

export default function ProjectFlow({ projectId: initialId }: { projectId: number | null }) {
  const router = useRouter();
  const [projectId, setProjectId] = useState<number | null>(initialId);
  const [project, setProject] = useState<StudioProject | null>(null);
  const [loaded, setLoaded] = useState(initialId === null);
  const [step, setStep] = useState(initialId === null ? 0 : -1); // -1: an existing project whose step is not known yet
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [charFile, setCharFile] = useState<File | null>(null);
  const [charPreview, setCharPreview] = useState<string | null>(null);
  const [charName, setCharName] = useState('');
  const [script, setScript] = useState('');
  const [aStatus, setAStatus] = useState<'idle' | 'running' | 'failed'>('idle');
  const [aStage, setAStage] = useState(0);
  const [packs, setPacks] = useState<StudioPack[]>([]);
  const [packAssets, setPackAssets] = useState<Record<number, StudioAsset[]>>({});
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [selection, setSelection] = useState<SelectionRow[]>([]);
  const [focus, setFocus] = useState(-1);
  const [busy, setBusy] = useState('');
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [outputs, setOutputs] = useState<OutputRow[]>([]);
  const [retryOpen, setRetryOpen] = useState<number | null>(null);
  const [retryNote, setRetryNote] = useState('');
  const [rFilter, setRFilter] = useState<'all' | 'pending' | 'saved' | 'rejected' | 'failed'>('all');
  const [srcShow, setSrcShow] = useState<number | null>(null);
  const [modal, setModal] = useState<'save' | null>(null);
  const [saveDl, setSaveDl] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GenerationConfig | null>(null);
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => { createClient().auth.getUser().then((r) => setMe(r.data.user?.email ?? null)).catch(() => {}); }, []);
  const file = useRef<HTMLInputElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const reloadProject = useCallback(async (id: number) => { const r = await api<{ project: StudioProject }>(`/api/v1/studio/projects/${id}`); setProject(r.project); return r.project; }, []);
  const reloadSelection = useCallback(async (id: number) => { setSelection((await api<{ selection: SelectionRow[] }>(`/api/v1/studio/projects/${id}/selection`)).selection); }, []);
  const reloadApproved = useCallback(async (id: number) => { setApproved(new Set((await api<{ packs: ApprovedPack[] }>(`/api/v1/studio/projects/${id}/packs`)).packs.map((p) => p.packId))); }, []);
  const reloadBatches = useCallback(async (id: number) => {
    const b = (await api<{ batches: BatchListItem[] }>(`/api/v1/studio/projects/${id}/batches`)).batches;
    setBatches(b);
    // Signed URLs change on every request; an image whose file is unchanged keeps its URL so a poll never reloads it.
    const keep = (prev?: string | null, next?: string | null) => (prev && next && prev.split('?')[0] === next.split('?')[0] ? prev : next ?? null);
    if (b[0]) {
      const fresh = (await api<{ jobs: JobRow[] }>(`/api/v1/studio/projects/${id}/batches/${b[0].id}`)).jobs;
      setJobs((cur) => fresh.map((j) => { const p = cur.find((x) => x.id === j.id); return p ? { ...j, source: { ...j.source, thumbUrl: keep(p.source.thumbUrl, j.source.thumbUrl) }, outputs: j.outputs.map((o) => ({ ...o, thumbUrl: keep(p.outputs.find((q) => q.id === o.id)?.thumbUrl, o.thumbUrl) })) } : j; }));
    } else setJobs([]);
    const freshOuts = (await api<{ outputs: OutputRow[] }>(`/api/v1/studio/projects/${id}/outputs`)).outputs;
    setOutputs((cur) => freshOuts.map((o) => { const p = cur.find((x) => x.id === o.id); return p ? { ...o, thumbUrl: keep(p.thumbUrl, o.thumbUrl), source: { ...o.source, thumbUrl: keep(p.source.thumbUrl, o.source.thumbUrl) } } : o; }));
    return b;
  }, []);

  // Initial load of an existing project, and the step it is at (or the one asked for in the address, after Setup created it).
  useEffect(() => {
    if (initialId === null) return;
    void (async () => {
      try {
        const p = await reloadProject(initialId);
        setName(p.name); setScript(p.script);
        await Promise.all([reloadSelection(initialId), reloadApproved(initialId)]);
        const b = await reloadBatches(initialId);
        const want = new URLSearchParams(window.location.search).get('step');
        const sel = (await api<{ selection: SelectionRow[] }>(`/api/v1/studio/projects/${initialId}/selection`)).selection.length;
        const derived = !p.hasCharacter ? 0 : !p.script.trim() || (p.recommendations.length === 0 && sel === 0) ? 1 : b.length === 0 ? 2 : b[0] && isActiveBatch(b[0].summary) ? 3 : 4;
        setStep(want !== null && Number(want) >= 0 && Number(want) <= 4 ? Number(want) : derived);
      } catch (e) { setError((e as Error).message); }
      setLoaded(true);
    })();
  }, [initialId, reloadProject, reloadSelection, reloadApproved, reloadBatches]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  // Whether generation can run changes when a worker starts, stops or is reconfigured, so it is checked again every 30 seconds.
  useEffect(() => {
    const load = () => { api<{ generation: GenerationConfig }>('/api/v1/studio/config').then((r) => setGeneration(r.generation)).catch(() => {}); };
    load(); return visibleInterval(load, 30_000);
  }, []);

  // Every pack and every image of every pack (Select shows them all; none is hidden until a pack is chosen).
  useEffect(() => {
    if (step !== 2 || packs.length > 0) return;
    void (async () => {
      try {
        const list = (await api<{ packs: StudioPack[] }>('/api/v1/studio/packs')).packs;
        setPacks(list);
        const entries = await Promise.all(list.map(async (p) => {
          const all: StudioAsset[] = []; let after: number | null = null;
          do {
            const q = new URLSearchParams({ limit: '60' }); if (after) q.set('after', String(after));
            const r: { assets: StudioAsset[]; nextCursor: number | null } = await api(`/api/v1/studio/packs/${p.id}/assets?${q}`);
            all.push(...r.assets); after = r.nextCursor;
          } while (after);
          return [p.id, all] as const;
        }));
        setPackAssets(Object.fromEntries(entries));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [step, packs.length]);

  // While images are generating, look again every few seconds.
  const running = batches.some((b) => isActiveBatch(b.summary));
  useEffect(() => {
    if (!running || !projectId) return;
    return visibleInterval(() => reloadBatches(projectId), 3000);
  }, [running, projectId, reloadBatches]);
  useEffect(() => { if ((step === 3 || step === 4) && projectId) void reloadBatches(projectId).catch((e) => setError((e as Error).message)); }, [step, projectId, reloadBatches]);

  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); } };

  // ── Setup ──
  const hasChar = !!(charFile || project?.hasCharacter);
  const s0ok = !!name.trim() && hasChar;
  const pickChar = (f: File) => {
    setCharName(f.name);
    if (projectId) { void run('character', async () => { setProject(await uploadCharacter(projectId, f)); setCharPreview(null); }); return; }
    setCharFile(f); setCharPreview(URL.createObjectURL(f));
  };
  const toScript = () => run('setup', async () => {
    if (!s0ok) return;
    if (!projectId) {
      const r = await api<{ project: StudioProject }>('/api/v1/studio/projects', { method: 'POST', body: { name: name.trim() } });
      await uploadCharacter(r.project.id, charFile!);
      router.replace(`/studio/${r.project.id}?step=1`);
      return;
    }
    if (project && name.trim() !== project.name) setProject((await api<{ project: StudioProject }>(`/api/v1/studio/projects/${projectId}`, { method: 'PUT', body: { name: name.trim() } })).project);
    setStep(1);
  });

  // ── Script ──
  const analyse = async () => {
    if (!script.trim() || !projectId || !project) return;
    setAStatus('running'); setAStage(0); setError('');
    timers.current.push(setTimeout(() => setAStage(1), 900));
    try {
      if (script !== project.script) setProject((await api<{ project: StudioProject }>(`/api/v1/studio/projects/${projectId}`, { method: 'PUT', body: { script } })).project);
      const r = await api<{ project: StudioProject }>(`/api/v1/studio/projects/${projectId}/analyze`, { method: 'POST', body: { force: project.analysis.status === 'failed' || (project.recommendations.length > 0 && !project.analysis.current) } });
      setProject(r.project); setAStatus('idle'); setStep(2);
    } catch { setAStatus('failed'); }
  };

  // ── Select ──
  const recs = useMemo(() => (project?.recommendations ?? []).filter((r) => !r.packArchived), [project]);
  const recIds = recs.map((r) => r.packId);
  const sections = useMemo(() => {
    const live = packs.filter((p) => !p.archivedAt);
    const ordered = recIds.map((id) => live.find((p) => p.id === id)).filter((p): p is StudioPack => !!p).concat(live.filter((p) => !recIds.includes(p.id)));
    return ordered.map((p, idx) => ({ p, rec: recIds.includes(p.id), otherHead: !recIds.includes(p.id) && (idx === 0 || recIds.includes(ordered[idx - 1].id)), items: (packAssets[p.id] ?? []).filter((a) => !a.archived) }));
  }, [packs, packAssets, recIds]);
  const beats = script.split(/\n\s*\n/).filter((t) => t.trim());
  const beatPacks = (i: number): number[] => { const t = (beats[i] ?? '').toLowerCase(); return recs.filter((r) => r.moments.some((m) => { const x = m.toLowerCase().trim(); return x.length > 2 && (t.includes(x) || x.includes(t.slice(0, 40))); })).map((r) => r.packId); };
  const hlIds = focus >= 0 ? beatPacks(focus) : [];
  const selectedIds = new Set(selection.map((x) => x.assetId));
  const ensureApproved = async (ids: number[]) => { const need = ids.filter((id) => !approved.has(id)); if (need.length) { await api(`/api/v1/studio/projects/${projectId}/packs`, { method: 'POST', body: { packIds: need } }); await reloadApproved(projectId!); } };
  const toggle = (a: StudioAsset) => run('select', async () => {
    if (selectedIds.has(a.id)) await api(`/api/v1/studio/projects/${projectId}/selection`, { method: 'DELETE', body: { assetIds: [a.id] } });
    else { await ensureApproved([a.packId]); await api(`/api/v1/studio/projects/${projectId}/selection`, { method: 'POST', body: { assetIds: [a.id] } }); }
    await reloadSelection(projectId!);
  });
  const toggleAll = (packId: number, items: StudioAsset[]) => run('select', async () => {
    const ids = items.map((i) => i.id); const allOn = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    if (allOn) await api(`/api/v1/studio/projects/${projectId}/selection`, { method: 'DELETE', body: { assetIds: ids } });
    else { await ensureApproved([packId]); await api(`/api/v1/studio/projects/${projectId}/selection`, { method: 'POST', body: { assetIds: ids.filter((id) => !selectedIds.has(id)) } }); }
    await reloadSelection(projectId!);
  });
  const removeSel = (ids?: number[]) => run('select', async () => { await api(`/api/v1/studio/projects/${projectId}/selection`, { method: 'DELETE', body: ids ? { assetIds: ids } : {} }); await reloadSelection(projectId!); });
  const startGen = () => run('generate', async () => {
    if (!selection.length) return;
    await api(`/api/v1/studio/projects/${projectId}/batches`, { method: 'POST', body: {} });
    await reloadBatches(projectId!); setRetryOpen(null); setStep(3);
  });
  const focusBeat = (i: number) => { setFocus(i); const ids = beatPacks(i); const el = ids.length ? document.getElementById(`sec-${ids[0]}`) : null; const sc = scrollRef.current; if (el && sc) sc.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' }); };

  // ── Generate / Review ──
  const retry = (j: JobRow) => run(`job-${j.id}`, async () => {
    if (j.status === 'submit_unknown' && !window.confirm('The provider never confirmed this image, so it may already be generating it. Generating it again could be charged twice. Generate it again anyway?')) return;
    await api(`/api/v1/studio/jobs/${j.id}/retry`, { method: 'POST', body: { ...(j.status === 'submit_unknown' ? { confirmDuplicate: true } : {}) } });
    setRetryOpen(null); setRetryNote(''); await reloadBatches(projectId!);
  });
  const review = (o: OutputRow, status: 'saved' | 'rejected' | 'pending') => run(`out-${o.id}`, async () => { await api(`/api/v1/studio/outputs/${o.id}/review`, { method: 'POST', body: { status } }); await reloadBatches(projectId!); });
  const approveAll = () => run('approveAll', async () => { for (const o of outputs.filter((x) => x.reviewStatus === 'pending')) await api(`/api/v1/studio/outputs/${o.id}/review`, { method: 'POST', body: { status: 'saved' } }); await reloadBatches(projectId!); });
  const confirmSave = () => run('save', async () => {
    if (!saveDl) return;
    const ok = outputs.filter((o) => o.reviewStatus === 'saved');
    if (saveDl) {
      for (const o of ok) {
        const r = await api<{ output: OutputRow }>(`/api/v1/studio/outputs/${o.id}`);
        const url = r.output.imageUrl; if (!url) continue;
        const a = document.createElement('a'); a.download = `${(name || 'output').replace(/[^\w.-]+/g, '_')}-${o.id}.png`;
        // A cross-origin link ignores `download`, so the file is fetched and saved from memory; if the bucket does not allow that, it opens in a new tab.
        try { const blob = await (await fetch(url)).blob(); a.href = URL.createObjectURL(blob); }
        catch { a.href = url; a.target = '_blank'; a.rel = 'noopener'; }
        document.body.appendChild(a); a.click(); a.remove();
      }
    }
    setModal(null);
    setSaved(saveDl ? `Saved ${ok.length} images. Download started.` : `Saved ${ok.length} images.`);
  });

  const stepper = STEPS.map((l, i) => ({ l, i, done: i < step, act: i === step }));
  // A retry is a new job for the same image: each image shows only its latest attempt, so a retry changes only that row.
  const latestJobs = jobs.filter((j) => !jobs.some((k) => k.retryOfJobId === j.id));
  const idsOf = (j: JobRow) => j.source.importKey ?? j.source.originalFilename ?? `#${j.assetId}`;
  const nd = latestJobs.filter((j) => dStatus(j) === 'done').length, nr = latestJobs.filter((j) => dStatus(j) === 'running').length, nq = latestJobs.filter((j) => dStatus(j) === 'queued').length, nf = latestJobs.filter((j) => isFail(dStatus(j))).length;
  const settled = nr + nq === 0;
  const gPct = latestJobs.length ? Math.round(((nd + nf) / latestJobs.length) * 100) : 0;
  const okOuts = outputs; const apN = okOuts.filter((o) => o.reviewStatus === 'saved').length;
  const outByJob = new Map(okOuts.map((o) => [o.job.id, o]));
  const fx = { all: latestJobs.length, pending: okOuts.filter((o) => o.reviewStatus === 'pending').length, saved: apN, rejected: okOuts.filter((o) => o.reviewStatus === 'rejected').length, failed: nf };
  const cards = latestJobs.filter((j) => { const o = outByJob.get(j.id); const st = dStatus(j); return rFilter === 'all' || (rFilter === 'pending' && o?.reviewStatus === 'pending') || (rFilter === 'saved' && o?.reviewStatus === 'saved') || (rFilter === 'rejected' && o?.reviewStatus === 'rejected') || (rFilter === 'failed' && isFail(st)); });

  const headerPill = { bg: step === 4 ? '#6C47FF' : '#EFEFEC', fg: step === 4 ? '#fff' : '#5E5E65' };
  const Body = () => {
    if (!loaded) return <div style={{ padding: 40, font: '400 14px Satoshi', color: '#75757C' }}>{error || 'Loading…'}</div>;
    if (step === 0) return (
      <div style={{ maxWidth: 600, width: '100%', margin: '0 auto', padding: '48px 24px 80px', boxSizing: 'border-box' }}>
        <h1 style={{ margin: '0 0 24px', font: '700 24px/1.3 Satoshi' }}>New project</h1>
        <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: 24, display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><label style={{ font: '500 13px/1 Satoshi' }}>Project name</label>
            <input className="stu-focus" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Super Slicer: Card Launch" style={{ height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', outline: 'none' }} /></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><label style={{ font: '500 13px/1 Satoshi' }}>Character</label>
            {!hasChar && <button className="stu-dash" onClick={() => file.current?.click()} disabled={busy === 'character'} style={{ border: '1px dashed #6C47FF', background: '#F5F3FF', borderRadius: 12, padding: '40px 20px', cursor: 'pointer', color: '#6C47FF', font: '700 14px/1 Satoshi' }}>{busy === 'character' ? 'Uploading…' : 'Upload character image'}</button>}
            {hasChar && (
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', border: '1px solid #ECECE8', borderRadius: 12, padding: 12 }}>
                <div style={{ width: 90, height: 160, borderRadius: 8, background: bg(charPreview ?? project?.characterThumbUrl), flexShrink: 0 }} />
                <div style={{ flex: 1, font: '500 13px/1.4 Satoshi' }}>{charName || 'Character image'}<div style={{ font: '400 12px/1.5 Satoshi', color: '#75757C' }}>Used for every image in this project</div></div>
                <button className="stu-ghost" onClick={() => file.current?.click()} style={{ height: 32, padding: '0 12px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 13px/1 Satoshi', cursor: 'pointer' }}>Replace</button>
              </div>
            )}
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pickChar(f); }} />
          </div>
        </div>
        {error && <div role="alert" style={{ ...alertRed, marginTop: 14 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}><button className="stu-primary" onClick={() => void toScript()} disabled={busy === 'setup'} style={{ ...primaryBtn, opacity: s0ok ? 1 : 0.45 }}>Continue</button></div>
      </div>
    );
    if (step === 1) return (
      <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', padding: '48px 24px 80px', boxSizing: 'border-box' }}>
        <h1 style={{ margin: '0 0 20px', font: '700 24px/1.3 Satoshi' }}>Paste your script</h1>
        {aStatus !== 'running' && (<>
          <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: 16 }}>
            <textarea className="stu-focus" value={script} onChange={(e) => setScript(e.target.value)} placeholder="Paste the complete video script" style={{ width: '100%', minHeight: 300, border: '1px solid #E4E4E0', borderRadius: 8, padding: 12, font: '400 14px/1.55 Satoshi', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}><span style={{ font: '400 12px/1 Satoshi', color: '#75757C' }}>{script.trim().split(/\s+/).filter(Boolean).length} words</span><button onClick={() => setScript(SAMPLE)} style={{ border: 'none', background: 'transparent', color: '#6C47FF', font: '500 13px/1 Satoshi', cursor: 'pointer' }}>Use sample script</button></div>
          </div>
          {aStatus === 'failed' && <div role="alert" style={{ ...alertRed, marginTop: 14 }}>The script could not be analysed. Your script is saved; try again.</div>}
          {error && aStatus !== 'failed' && <div role="alert" style={{ ...alertRed, marginTop: 14 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}><button className="stu-primary" onClick={() => void analyse()} style={{ ...primaryBtn, opacity: script.trim() ? 1 : 0.45 }}>{aStatus === 'failed' ? 'Try again' : 'Analyse script'}</button></div>
        </>)}
        {aStatus === 'running' && (
          <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}><div style={{ display: 'flex', gap: 5 }}><span className="stu-pd" /><span className="stu-pd" /><span className="stu-pd" /></div><div style={{ font: '700 16px/1.3 Satoshi' }}>{['Reading your script', 'Finding matching scenes'][Math.min(aStage, 1)]}</div></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>{[0, 1, 2, 3].map((k) => <div key={k} className="stu-sk" style={{ aspectRatio: '9/16', borderRadius: 12 }} />)}</div>
          </div>
        )}
      </div>
    );
    if (step === 2) return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <aside style={{ width: 300, flexShrink: 0, borderRight: '1px solid #ECECE8', background: '#fff', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: '16px 18px 8px', font: '700 15px/1.3 Satoshi' }}>Script</div>
            <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>{beats.map((t, i) => <div key={i} onClick={() => focusBeat(i)} style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', background: focus === i ? '#EFEBFF' : 'transparent', font: '400 14px/1.55 Satoshi', color: '#111113' }}>{t}</div>)}</div>
          </aside>
          <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '16px 20px 40px', position: 'relative' }}>
            {packs.length === 0 && !error && <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>Loading…</div>}
            {sections.map(({ p, rec, otherHead, items }) => {
              const allOn = items.length > 0 && items.every((i) => selectedIds.has(i.id));
              return (
                <div key={p.id} id={`sec-${p.id}`} style={{ marginBottom: 12, background: hlIds.includes(p.id) ? '#F5F3FF' : 'transparent', borderRadius: 14, padding: 12 }}>
                  {otherHead && <div style={{ font: '600 11px/1 Satoshi', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#9A9AA0', margin: '4px 0 18px' }}>Other packs</div>}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <div style={{ font: '700 16px/1.3 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{p.name}</div>
                    {rec && <span style={{ height: 20, padding: '0 8px', borderRadius: 999, background: '#EFEBFF', color: '#6C47FF', font: '500 11px/20px Satoshi', whiteSpace: 'nowrap' }}>Recommended</span>}
                    <div style={{ flex: 1 }} />
                    <button className="stu-ghost" onClick={() => void toggleAll(p.id, items)} disabled={!!busy} style={{ height: 28, padding: '0 10px', borderRadius: 8, background: '#fff', border: '1px solid #E4E4E0', font: '500 12px/1 Satoshi', cursor: 'pointer' }}>{allOn ? 'Clear' : 'Select all'}</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 12 }}>
                    {items.map((g) => { const on = selectedIds.has(g.id); const c0 = chipOf(g); const c = c0 && c0.text === 'Needs review' ? null : c0; return (
                      <div key={g.id} className="stu-tile" onClick={() => void toggle(g)} style={{ position: 'relative', aspectRatio: '9/16', borderRadius: 14, background: bg(g.thumbUrl), border: `2px solid ${on ? '#6C47FF' : 'transparent'}`, boxSizing: 'border-box', overflow: 'hidden', cursor: 'pointer' }}>
                        <span style={{ position: 'absolute', top: 8, left: 8, width: 22, height: 22, borderRadius: 6, background: on ? '#6C47FF' : 'rgba(0,0,0,0.35)', border: `1.5px solid ${on ? '#6C47FF' : 'rgba(255,255,255,0.85)'}`, color: '#fff', font: '700 13px/19px Satoshi', textAlign: 'center', boxSizing: 'border-box' }}>{on ? '✓' : ''}</span>
                        {c && <TileChip text={c.text} bg={c.bg} fg={c.fg} />}
                        <CodeChip code={codeOf(g)} />
                      </div>
                    ); })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {generation && !generation.ready && <div role="alert" style={{ ...alertRed, margin: '0 20px 10px' }}>{generation.worker?.status === 'provider_mismatch' ? 'Provider mismatch: ' : ''}{generation.message ?? generation.reason ?? 'Image generation is not switched on yet.'}</div>}
        {generation?.mode === 'mock' && <div role="status" style={{ margin: '0 20px 10px', font: '500 12px/1.5 Satoshi', color: '#6D28D9' }}>TEST MODE: generated images are placeholders, not real results. No real provider is being used.</div>}
        {error && <div role="alert" style={{ ...alertRed, margin: '0 20px 10px' }}>{error}</div>}
        <div style={{ flexShrink: 0, background: '#fff', borderTop: '1px solid #ECECE8', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 8, overflowX: 'auto', alignItems: 'center', minHeight: 64 }}>
            {selection.length === 0 && <span style={{ font: '400 13px/1.5 Satoshi', color: '#A3A3A9' }}>Tap images to select them.</span>}
            {selection.map((it) => <div key={it.assetId} style={{ position: 'relative', width: 36, height: 64, borderRadius: 6, background: bg(it.image.thumbUrl), flexShrink: 0 }}><button onClick={() => void removeSel([it.assetId])} style={{ position: 'absolute', top: 2, right: 2, width: 16, height: 16, border: 'none', borderRadius: '50%', background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', font: '700 10px/16px Satoshi', padding: 0 }}>×</button></div>)}
          </div>
          <button className="stu-ghost" onClick={() => void removeSel()} style={{ height: 38, padding: '0 14px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer' }}>Clear</button>
          <button className="stu-primary" onClick={() => { if (!generation || generation.ready) void startGen(); }} style={{ ...primaryBtn, opacity: selection.length && (!generation || generation.ready) ? 1 : 0.45 }}>{selection.length ? `Generate ${selection.length}` : 'Generate'}</button>
        </div>
      </div>
    );
    if (step === 3) return (
      <div style={{ maxWidth: 820, width: '100%', margin: '0 auto', padding: '40px 24px 80px', boxSizing: 'border-box' }}>
        <h1 style={{ margin: '0 0 16px', font: '700 24px/1.3 Satoshi' }}>{nr + nq > 0 ? `Generating ${latestJobs.length} images` : nf > 0 ? `${nd} of ${latestJobs.length} generated` : `All ${latestJobs.length} generated`}</h1>
        {error && <div role="alert" style={{ ...alertRed, marginBottom: 16 }}>{error}</div>}
        <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '16px 20px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', font: '500 13px/1 Satoshi', marginBottom: 10 }}><span>{`${nd} done · ${nr} running · ${nq} queued · ${nf} failed`}</span><span style={{ color: '#75757C' }}>{gPct}%</span></div>
          <div style={{ height: 4, borderRadius: 2, background: '#EFEFEC', overflow: 'hidden' }}><div style={{ height: '100%', width: `${gPct}%`, background: '#6C47FF', transition: 'width 0.4s' }} /></div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
          {latestJobs.map((j) => { const st = dStatus(j); const m = DESIGN_STATUS[st]; const out = outByJob.get(j.id); return (
            <div key={j.id} style={{ borderBottom: '1px solid #F3F3F1' }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '10px 20px' }}>
                <div style={{ width: 40, height: 72, borderRadius: 6, background: bg(j.source.thumbUrl), flexShrink: 0 }} />
                <span style={{ color: '#A3A3A9' }}>→</span>
                <div style={{ position: 'relative', width: 40, height: 72, borderRadius: 6, background: st === 'done' ? bg(out?.thumbUrl ?? j.outputs[0]?.thumbUrl) : 'transparent', border: `1px dashed ${st === 'done' ? 'transparent' : '#E4E4E0'}`, boxSizing: 'border-box', flexShrink: 0, overflow: 'hidden' }} />
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ font: '600 13px/1.3 Satoshi' }}>{idsOf(j)}</div><div style={{ font: '400 12px/1.4 Satoshi', color: '#B91C1C' }}>{isFail(st) ? failMsg(j) : ''}</div></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {st === 'running' && <PulseDots />}
                  {j.isTest && <TestBadge />}
                  <span style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 9px', borderRadius: 999, font: '500 12px/1 Satoshi', background: m[1], color: m[2] }}>{m[0]}</span>
                  {st === 'attention' && <button className="stu-ghost" onClick={() => void retry(j)} disabled={busy === `job-${j.id}`} style={smallBtn}>Generate again anyway</button>}
                  {st === 'failed' && <><button className="stu-ghost" onClick={() => void retry(j)} disabled={busy === `job-${j.id}`} style={smallBtn}>Retry</button><button className="stu-ghost" onClick={() => { setRetryOpen(retryOpen === j.id ? null : j.id); setRetryNote(''); }} style={smallBtn}>Retry with note</button></>}
                </div>
              </div>
              {retryOpen === j.id && <div style={{ display: 'flex', gap: 8, padding: '0 20px 14px 114px' }}><input className="stu-focus-b" value={retryNote} onChange={(e) => setRetryNote(e.target.value)} placeholder="What should change?" style={{ flex: 1, height: 34, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 13px/1 Satoshi', outline: 'none' }} /><button onClick={() => void retry(j)} style={{ height: 34, padding: '0 14px', borderRadius: 8, background: '#6C47FF', color: '#fff', border: 'none', font: '500 13px/1 Satoshi', cursor: 'pointer' }}>Retry</button></div>}
              {retryOpen === j.id && <div style={{ padding: '0 20px 14px 114px', font: '400 12px/1.4 Satoshi', color: '#75757C', marginTop: -6 }}>The note is not sent to the provider yet. Retry runs the same inputs again.</div>}
            </div>
          ); })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20 }}>
          <button className="stu-ghost" onClick={() => setStep(2)} style={secondaryBtn}>Edit selection</button>
          <button className="stu-primary" onClick={() => { if (settled && nd > 0) setStep(4); }} style={{ ...primaryBtn, opacity: settled && nd > 0 ? 1 : 0.45 }}>{nf > 0 && settled ? `Review ${nd} generated` : 'Continue to review'}</button>
        </div>
      </div>
    );
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 16 }}><h1 style={{ margin: 0, font: '700 24px/1.3 Satoshi' }}>Review</h1>
            <Segmented items={([['all', 'All'], ['pending', 'To review'], ['saved', 'Approved'], ['rejected', 'Rejected'], ['failed', 'Failed']] as const).map(([k, label]) => ({ label, count: fx[k], active: rFilter === k, onClick: () => setRFilter(k) }))} /></div>
          {error && <div role="alert" style={{ ...alertRed, marginBottom: 16 }}>{error}</div>}
          {saved && <div style={{ ...alertGreen, marginBottom: 16 }}>{saved}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 16 }}>
            {cards.map((j) => { const o = outByJob.get(j.id); const st = dStatus(j); const done = st === 'done' && !!o; const src = srcShow === j.id; const r = o?.reviewStatus; return (
              <div key={j.id} style={{ position: 'relative', aspectRatio: '9/16', borderRadius: 14, overflow: 'hidden', background: bg(done && !src ? o!.thumbUrl : j.source.thumbUrl), border: `2px solid ${r === 'saved' ? '#6C47FF' : 'transparent'}`, boxSizing: 'border-box' }}>
                <span style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,0.5)', color: '#fff', font: '500 11px/1 Satoshi', padding: '4px 7px', borderRadius: 6 }}>{done ? (src ? `Source ${idsOf(j)}` : `Output · ${idsOf(j)}`) : idsOf(j)}</span>
                {done && o!.isTest && <span style={{ position: 'absolute', top: 36, left: 8 }}><TestBadge /></span>}
                {done && <>
                  <button onMouseDown={() => setSrcShow(j.id)} onMouseUp={() => setSrcShow(null)} onMouseLeave={() => setSrcShow(null)} style={{ position: 'absolute', top: 8, right: 8, height: 26, padding: '0 9px', borderRadius: 7, background: '#fff', border: 'none', font: '500 11px/1 Satoshi', cursor: 'pointer' }}>Compare</button>
                  <div style={{ position: 'absolute', bottom: 10, left: 10, right: 10, display: 'flex', gap: 8 }}>
                    <button onClick={() => void review(o!, r === 'saved' ? 'pending' : 'saved')} style={{ flex: 1, height: 34, borderRadius: 9, background: r === 'saved' ? '#6C47FF' : 'rgba(255,255,255,0.95)', color: r === 'saved' ? '#fff' : '#111113', border: 'none', font: '700 15px/1 Satoshi', cursor: 'pointer' }}>{r === 'saved' ? '✓ Approved' : '✓ Approve'}</button>
                    <button onClick={() => void review(o!, r === 'rejected' ? 'pending' : 'rejected')} style={{ width: 34, height: 34, borderRadius: 9, background: r === 'rejected' ? '#DC2626' : 'rgba(255,255,255,0.95)', color: r === 'rejected' ? '#fff' : '#111113', border: 'none', font: '700 15px/1 Satoshi', cursor: 'pointer', padding: 0 }}>✕</button>
                  </div></>}
                {isFail(st) && <div style={{ position: 'absolute', inset: 0, background: 'rgba(17,17,19,0.7)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16, textAlign: 'center' }}><span style={{ font: '500 12px/1.4 Satoshi', color: '#FECACA' }}>{failMsg(j)}</span><button onClick={() => void retry(j)} style={{ height: 30, padding: '0 12px', borderRadius: 8, background: '#fff', border: 'none', font: '500 12px/1 Satoshi', cursor: 'pointer' }}>{st === 'attention' ? 'Generate again anyway' : 'Retry'}</button></div>}
              </div>
            ); })}
          </div>
        </div>
        <div style={{ flexShrink: 0, background: '#fff', borderTop: '1px solid #ECECE8', padding: '12px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ font: '500 13px/1 Satoshi' }}>{`${apN} approved of ${okOuts.length}${nf ? ` · ${nf} failed` : ''}`}</span>
          <div style={{ display: 'flex', gap: 8 }}><button className="stu-ghost" onClick={() => void approveAll()} style={secondaryBtn}>Approve all</button><button className="stu-primary" onClick={() => { if (apN) setModal('save'); }} style={{ ...primaryBtn, opacity: apN ? 1 : 0.45 }}>Save approved</button></div>
        </div>
      </div>
    );
  };

  return (
    <AppShell fullscreen>
      <main className="stu-scope" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <header style={{ height: 64, flexShrink: 0, background: '#fff', borderBottom: '1px solid #ECECE8', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center', gap: 16, padding: '0 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <button onClick={() => router.push('/studio')} title="All projects" style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 8, border: '1px solid #E4E4E0', background: '#fff', cursor: 'pointer', fontSize: 16 }}>←</button>
            <div style={{ minWidth: 0 }}><div style={{ font: '700 15px/1.25 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{initialId === null ? (name || 'New project') : name}</div><div style={{ font: '400 12px/1.3 Satoshi', color: '#75757C', marginTop: 2 }}>{[(project?.ownerEmail ?? (projectId === null ? me : null))?.split('@')[0], 'Character B-roll'].filter(Boolean).join(' · ')}</div></div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {stepper.map((s) => (
              <div key={s.l} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button onClick={() => { if (s.done) setStep(s.i); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: 'none', background: 'transparent', borderRadius: 8, cursor: s.done ? 'pointer' : 'default', font: `${s.act ? 700 : s.done ? 500 : 400} 13px/1 Satoshi`, color: s.act || s.done ? '#111113' : '#9A9AA0' }}>
                  <span style={{ width: 20, height: 20, borderRadius: '50%', background: s.act ? '#6C47FF' : s.done ? '#EFEBFF' : '#EFEFEC', color: s.act ? '#fff' : s.done ? '#6C47FF' : '#9A9AA0', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '700 11px/1 Satoshi' }}>{s.done ? '✓' : s.i + 1}</span>{s.l}
                </button>
                <span style={{ color: '#C4C4C9', fontSize: 14 }}>{s.i < 4 ? '›' : ''}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{step >= 0 && <span style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 9px', borderRadius: 999, font: '500 12px/1 Satoshi', background: headerPill.bg, color: headerPill.fg }}>{STEP_NAMES[step] ?? ''}</span>}</div>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>{Body()}</div>
      </main>
      {modal === 'save' && (
        <Modal width={420} onClose={() => setModal(null)}>
          <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 16 }}>Save {apN} approved images</div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 12, border: '1px solid #ECECE8', borderRadius: 10, marginBottom: 8, cursor: 'pointer', font: '600 14px/1.3 Satoshi' }}><input type="checkbox" checked={saveDl} onChange={() => setSaveDl((v) => !v)} />Download</label>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 12, border: '1px solid #ECECE8', borderRadius: 10, marginBottom: 22, cursor: 'not-allowed', font: '600 14px/1.3 Satoshi', opacity: 0.6 }}><input type="checkbox" checked={false} disabled />Add to B-roll Library<span style={{ marginLeft: 'auto', font: '500 12px/1 Satoshi', color: '#75757C' }}>Not available yet</span></label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button className="stu-ghost" onClick={() => setModal(null)} style={secondaryBtn}>Cancel</button><button className="stu-primary" onClick={() => void confirmSave()} style={{ ...primaryBtn, opacity: saveDl ? 1 : 0.45 }}>Save</button></div>
        </Modal>
      )}
    </AppShell>
  );
}
