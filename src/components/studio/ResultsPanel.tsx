'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isActiveBatch, type BatchListItem, type BatchSummary, type JobRow, type OutputRow } from '@/lib/studio/client';

const STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  queued: { label: 'Queued', bg: '#F3F4F6', fg: '#6B7280' }, submitting: { label: 'Sending…', bg: '#EDE9FE', fg: '#6D28D9' },
  submit_unknown: { label: 'Needs attention', bg: '#FEF3C7', fg: '#92400E' },
  processing: { label: 'Generating…', bg: '#EDE9FE', fg: '#6D28D9' }, succeeded: { label: 'Done', bg: '#DCFCE7', fg: '#16A34A' },
  failed: { label: 'Failed', bg: '#FEE2E2', fg: '#B91C1C' }, canceled: { label: 'Canceled', bg: '#F3F4F6', fg: '#6B7280' },
};
const Chip = ({ s }: { s: string }) => { const c = STATUS[s] ?? STATUS.queued; return <span style={{ padding: '1px 8px', borderRadius: 999, background: c.bg, color: c.fg, font: '500 11px/1.6 Satoshi' }}>{c.label}</span>; };

const sumText = (s: BatchSummary) => `${s.succeeded} done · ${s.processing + s.submitting + s.queued} running · ${s.failed} failed${s.submit_unknown ? ` · ${s.submit_unknown} unconfirmed` : ''}`;
/** Marks an image that came from the test provider. Shown on every generated image, saved or not. */
const TestBadge = () => <span title="Made by the test provider: a placeholder, not a real result" style={{ padding: '1px 7px', borderRadius: 999, background: '#7C3AED', color: '#fff', font: '700 10px/1.6 Satoshi', letterSpacing: '.04em' }}>TEST · NOT REAL</span>;

interface Props { projectId: number; refreshKey: number; onError: (m: string) => void }

/** Batches (every image its own job, with its own status and Retry) and the generated images to review, save or reject. */
export default function ResultsPanel({ projectId, refreshKey, onError }: Props) {
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [outputs, setOutputs] = useState<OutputRow[]>([]);
  const [counts, setCounts] = useState({ pending: 0, saved: 0, rejected: 0 });
  const [tab, setTab] = useState<'all' | 'pending' | 'saved' | 'rejected'>('all');
  const [busy, setBusy] = useState<number | null>(null);
  const [zoom, setZoom] = useState<OutputRow | null>(null);

  const loadBatches = useCallback(async () => {
    const r = await api<{ batches: BatchListItem[] }>(`/api/v1/studio/projects/${projectId}/batches`);
    setBatches(r.batches);
    return r.batches;
  }, [projectId]);
  // The finished-job count the outputs list was last loaded for: while jobs are running, outputs are only reloaded when it changes.
  const succeededSeen = useRef(-1);
  const loadJobs = useCallback(async (id: number) => {
    const r = await api<{ jobs: JobRow[]; summary: BatchSummary }>(`/api/v1/studio/projects/${projectId}/batches/${id}`);
    setJobs(r.jobs);
    return r.summary.succeeded;
  }, [projectId]);
  const loadOutputs = useCallback(async () => {
    const r = await api<{ outputs: OutputRow[]; counts: { pending: number; saved: number; rejected: number } }>(`/api/v1/studio/projects/${projectId}/outputs${tab === 'all' ? '' : `?status=${tab}`}`);
    setOutputs(r.outputs); setCounts(r.counts);
  }, [projectId, tab]);

  const refresh = useCallback(async (opts: { poll?: boolean } = {}) => {
    try {
      const b = await loadBatches();
      const target = open ?? b[0]?.id ?? null;
      if (open === null && target) setOpen(target);
      const succeeded = target ? await loadJobs(target) : 0;
      // A background poll reloads the (larger) outputs list only when another image has finished since the last load.
      if (!opts.poll || succeeded !== succeededSeen.current) { await loadOutputs(); succeededSeen.current = succeeded; }
    } catch (e) { onError((e as Error).message); }
  }, [loadBatches, loadJobs, loadOutputs, open, onError]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  // The full-size image is fetched for the one result that is open (the list only carries thumbnails).
  const [zoomFull, setZoomFull] = useState<string | null>(null);
  useEffect(() => {
    setZoomFull(null);
    if (!zoom) return;
    let cancelled = false;
    api<{ output: OutputRow }>(`/api/v1/studio/outputs/${zoom.id}`).then((r) => { if (!cancelled) setZoomFull(r.output.imageUrl); }).catch(() => {});
    return () => { cancelled = true; };
  }, [zoom]);

  // While any batch has running jobs, look again every few seconds.
  const running = batches.some((b) => isActiveBatch(b.summary));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void refresh({ poll: true }); }, 4000);
    return () => clearInterval(t);
  }, [running, refresh]);

  const act = async (key: number, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); await refresh(); } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  const review = (o: OutputRow, status: 'saved' | 'rejected' | 'pending') => act(o.id, () => api(`/api/v1/studio/outputs/${o.id}/review`, { method: 'POST', body: { status } }));
  const again = (jobId: number, kind: 'retry' | 'regenerate', confirmDuplicate = false) => act(jobId, () => api(`/api/v1/studio/jobs/${jobId}/${kind}`, { method: 'POST', ...(confirmDuplicate ? { body: { confirmDuplicate: true } } : {}) }));
  const generateAnyway = (jobId: number) => {
    if (window.confirm('The provider never confirmed this image, so it may already be generating it. Generating it again could be charged twice. Generate it again anyway?')) void again(jobId, 'retry', true);
  };

  if (batches.length === 0 && outputs.length === 0) return null;
  const openBatch = batches.find((b) => b.id === open);

  return (
    <>
      <div style={{ border: '1px solid #ECECE8', borderRadius: 12, background: '#fff', padding: '16px 18px', marginBottom: 16 }}>
        <div style={{ font: '700 15px/1.3 Satoshi', marginBottom: 8 }}>6. Generation</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {batches.map((b) => (
            <button key={b.id} onClick={() => { setOpen(b.id); void loadJobs(b.id); }} style={{ border: `1.5px solid ${open === b.id ? '#6C47FF' : '#E4E4E0'}`, background: open === b.id ? '#F5F3FF' : '#fff', borderRadius: 8, padding: '5px 10px', font: '500 12px Satoshi', cursor: 'pointer' }}>
              Batch {b.id} · {b.totalJobs} image{b.totalJobs === 1 ? '' : 's'} · {sumText(b.summary)}
            </button>
          ))}
        </div>
        {openBatch && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
            {jobs.map((j) => (
              <div key={j.id} style={{ border: '1px solid #ECECE8', borderRadius: 10, padding: 8, display: 'flex', gap: 8 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {j.source.thumbUrl ? <img src={j.source.thumbUrl} alt="" style={{ width: 64, height: 48, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} /> : <div style={{ width: 64, height: 48, background: '#F4F4F0', borderRadius: 6 }} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Chip s={j.status} /><span style={{ font: '400 11px Satoshi', color: '#75757C' }}>Job {j.id}{j.attempt > 1 ? ` · attempt ${j.attempt}` : ''}</span>{j.isTest && <TestBadge />}</div>
                  {j.status === 'submit_unknown' && <button className="btn btn-secondary" disabled={busy === j.id} onClick={() => generateAnyway(j.id)} style={{ height: 24, padding: '0 8px', fontSize: 11, marginTop: 4 }}>Generate again anyway…</button>}
                  {j.error && <div role="alert" style={{ font: '400 11px/1.4 Satoshi', color: '#B91C1C', marginTop: 3 }}>{j.error.message}</div>}
                  {j.status === 'failed' && j.error?.retryable === false && <div style={{ font: '400 11px/1.4 Satoshi', color: '#75757C', marginTop: 3 }}>Retrying will not help. Change the image or the character and generate again.</div>}
                  {j.status === 'failed' && j.error?.retryable !== false && <button className="btn btn-secondary" disabled={busy === j.id} onClick={() => void again(j.id, 'retry')} style={{ height: 24, padding: '0 8px', fontSize: 11, marginTop: 4 }}>{busy === j.id ? 'Retrying…' : 'Retry this image'}</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ border: '1px solid #ECECE8', borderRadius: 12, background: '#fff', padding: '16px 18px', marginBottom: 16 }}>
        <div style={{ font: '700 15px/1.3 Satoshi', marginBottom: 8 }}>7. Review generated images</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {(['all', 'pending', 'saved', 'rejected'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ border: 'none', borderRadius: 999, padding: '4px 12px', font: '600 12px Satoshi', cursor: 'pointer', background: tab === t ? '#111113' : '#F3F4F6', color: tab === t ? '#fff' : '#374151' }}>
              {t === 'all' ? `All (${counts.pending + counts.saved + counts.rejected})` : `${t[0].toUpperCase()}${t.slice(1)} (${counts[t]})`}
            </button>
          ))}
        </div>
        {outputs.length === 0 && <div style={{ font: '400 13px Satoshi', color: '#75757C' }}>Nothing to review yet.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
          {outputs.map((o) => (
            <div key={o.id} style={{ border: `2px solid ${o.reviewStatus === 'saved' ? '#16A34A' : o.reviewStatus === 'rejected' ? '#E4E4E0' : '#ECECE8'}`, borderRadius: 12, overflow: 'hidden', opacity: o.reviewStatus === 'rejected' ? 0.6 : 1 }}>
              <button onClick={() => setZoom(o)} aria-label={`Open generated image ${o.id}`} style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: '#F4F4F0', cursor: 'zoom-in' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {o.thumbUrl && <img src={o.thumbUrl} alt="" style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', display: 'block' }} />}
              </button>
              {o.isTest && <div style={{ padding: '5px 9px 0' }}><TestBadge /></div>}
              <div style={{ padding: '7px 9px 9px' }}>
                <div style={{ font: '500 11px/1.4 Satoshi', color: '#5E5E65' }}>From {o.source.packName} · attempt {o.job.attempt}</div>
                <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
                  <button className={o.reviewStatus === 'saved' ? 'btn btn-primary' : 'btn btn-secondary'} disabled={busy === o.id} onClick={() => void review(o, o.reviewStatus === 'saved' ? 'pending' : 'saved')} style={{ height: 26, padding: '0 9px', fontSize: 11 }}>{o.reviewStatus === 'saved' ? 'Saved ✓' : 'Save'}</button>
                  <button className="btn btn-secondary" disabled={busy === o.id} onClick={() => void review(o, o.reviewStatus === 'rejected' ? 'pending' : 'rejected')} style={{ height: 26, padding: '0 9px', fontSize: 11 }}>{o.reviewStatus === 'rejected' ? 'Undo reject' : 'Reject'}</button>
                  <button className="btn btn-secondary" disabled={busy === o.job.id || o.source.archived} title={o.source.archived ? 'The source image is archived' : 'Generate this image again'} onClick={() => void again(o.job.id, 'regenerate')} style={{ height: 26, padding: '0 9px', fontSize: 11 }}>Regenerate</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {zoom && (
        <div role="dialog" aria-label="Generated image" onClick={() => setZoom(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 16, maxWidth: 760, width: '100%', maxHeight: '92vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', gap: 12 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={zoomFull ?? zoom.imageUrl ?? zoom.thumbUrl ?? ''} alt="" style={{ maxWidth: '60%', maxHeight: '70vh', borderRadius: 10, objectFit: 'contain' }} />
              <div style={{ font: '400 12px/1.6 Satoshi', color: '#3F3F46' }}>
                {zoom.isTest && <div style={{ marginBottom: 8 }}><TestBadge /></div>}
                <div style={{ font: '700 14px Satoshi', marginBottom: 6 }}>Where this came from</div>
                <div>Source image from <strong>{zoom.source.packName}</strong></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {zoom.source.thumbUrl && <img src={zoom.source.thumbUrl} alt="" style={{ width: 120, borderRadius: 6, margin: '4px 0' }} />}
                <div>Character</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {zoom.character.thumbUrl && <img src={zoom.character.thumbUrl} alt="" style={{ width: 60, borderRadius: 6, margin: '4px 0' }} />}
                <div>Batch {zoom.batch.id} · job {zoom.job.id} · attempt {zoom.job.attempt}</div>
                <div>Status: {zoom.reviewStatus}</div>
              </div>
            </div>
            <div style={{ textAlign: 'right', marginTop: 10 }}><button className="btn btn-secondary" onClick={() => setZoom(null)}>Close</button></div>
          </div>
        </div>
      )}
    </>
  );
}
