'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronLeft, Loader2, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import { api, C, post, type CompItem, type Composition } from './types';
import { backdrop, sheet } from './LibraryPicker';

interface Pack { id: number; name: string; assetCount?: number; imageCount?: number; activeCount?: number }
interface Asset { id: number; thumbUrl: string | null; originalFilename: string | null }

const imageText: Record<CompItem['imageStatus'], string> = { pending: 'Waiting', generating: 'Making the personalised image…', ready: 'Ready for your review', approved: 'Approved', rejected: 'Rejected', failed: 'Image failed' };
const clipText: Record<CompItem['clipStatus'], string> = { not_started: 'Video not started', queued: 'Video queued', submitting: 'Sending to the video model…', submit_unknown: 'Could not confirm the request was accepted', processing: 'Making the 5-second video…', ready: 'Video ready', failed: 'Video failed' };

/**
 * Character B-roll: choose a Scene Pack image, review the personalised image (the project's character swapped in), approve it, review
 * or edit the motion prompt, then start the 5-second silent video. The video step is paid and only unlocks after the image is approved.
 */
export default function CharacterPanel({ projectId, data, onClose, onChanged, onPlaced }: { projectId: string; data: Composition; onClose: () => void; onChanged: () => void; onPlaced: (overlayId: number | null) => void }) {
  const [picking, setPicking] = useState(false);
  const [packs, setPacks] = useState<Pack[]>([]); const [packId, setPackId] = useState<number | null>(null); const [assets, setAssets] = useState<Asset[]>([]);
  const [action, setAction] = useState(''); const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState('');
  const base = `/api/v1/video-projects/${projectId}/character-broll`;

  useEffect(() => { if (picking && packs.length === 0) api<{ packs: Pack[] }>('/api/v1/studio/packs').then((r) => r.ok && setPacks(r.data.packs ?? [])); }, [picking, packs.length]);
  useEffect(() => { if (packId != null) api<{ assets: Asset[] }>(`/api/v1/studio/packs/${packId}/assets?limit=60`).then((r) => r.ok && setAssets(r.data.assets ?? [])); }, [packId]);

  const run = useCallback(async (key: string, fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => {
    setBusy(key); setError('');
    const r = await fn();
    if (!r.ok) setError(r.data.error ?? 'Something went wrong.');
    setBusy(null); onChanged();
    return r;
  }, [onChanged]);

  const create = async () => { if (chosen == null) return; const r = await run('create', () => post(base, { studioAssetId: chosen, intendedAction: action })); if (r.ok) { setPicking(false); setChosen(null); setAction(''); } };

  return (
    <div role="dialog" aria-label="Character B-roll" style={backdrop} onClick={onClose}>
      <div style={{ ...sheet, width: 'min(880px, 100%)', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{ font: '700 16px/1.2 Satoshi' }}>{picking ? 'Choose a Scene Pack image' : 'Character B-roll'}</div>
          <button aria-label="Close" onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        {!data.imageGeneration.ready && <div role="alert" style={{ margin: '8px 0', padding: '8px 10px', borderRadius: 8, background: '#FFF4D6', color: C.warn, font: '400 12px/1.4 Satoshi' }}>Personalised images cannot be made right now: {data.imageGeneration.message ?? 'image generation is not available.'} You can still review existing ones.</div>}
        {data.imageGeneration.provider === 'mock' && <div style={{ margin: '8px 0', padding: '8px 10px', borderRadius: 8, background: '#EFEBFF', color: C.primary, font: '400 12px/1.4 Satoshi' }}>Test mode: images are placeholders from the mock provider, not real replacements.</div>}
        {error && <div role="alert" className="alert alert-error" style={{ margin: '8px 0' }}>{error}</div>}

        {picking ? (
          <div>
            <button onClick={() => (packId != null ? setPackId(null) : setPicking(false))} style={link}><ChevronLeft size={14} /> Back</button>
            {packId == null ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                {packs.map((p) => <button key={p.id} onClick={() => setPackId(p.id)} style={row}>{p.name}<span style={{ color: C.muted }}>{p.activeCount ?? p.imageCount ?? p.assetCount ?? ''}</span></button>)}
                {packs.length === 0 && <div style={{ color: C.muted, font: '400 13px/1.4 Satoshi' }}>No Scene Packs yet.</div>}
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8, margin: '10px 0', maxHeight: '40vh', overflow: 'auto' }}>
                  {assets.map((a) => <button key={a.id} onClick={() => setChosen(a.id)} aria-pressed={chosen === a.id} style={{ padding: 0, border: chosen === a.id ? `3px solid ${C.primary}` : `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', cursor: 'pointer', background: '#fff' }}>{a.thumbUrl ? <img src={a.thumbUrl} alt={a.originalFilename ?? 'Scene Pack image'} style={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', display: 'block' }} /> : <div style={{ aspectRatio: '3 / 4', background: C.soft }} />}</button>)}
                </div>
                <label style={{ display: 'block', font: '500 12px/1.4 Satoshi', color: C.muted }}>What should the character do? (used to write the motion prompt)
                  <textarea value={action} onChange={(e) => setAction(e.target.value)} rows={2} placeholder="For example: she picks up her coffee and smiles" style={{ width: '100%', marginTop: 4, borderRadius: 8, border: `1px solid ${C.borderStrong}`, padding: 8, font: '400 13px/1.4 Satoshi', boxSizing: 'border-box' }} />
                </label>
                <button disabled={chosen == null || busy === 'create' || !data.imageGeneration.ready} onClick={create} style={{ ...primary, marginTop: 10, opacity: chosen == null || !data.imageGeneration.ready ? 0.5 : 1 }}>{busy === 'create' ? 'Starting…' : 'Make the personalised image'}</button>
                <div style={{ font: '400 11px/1.4 Satoshi', color: C.muted, marginTop: 6 }}>This makes an image only. Nothing is charged for video until you approve the image and start the video yourself.</div>
              </>
            )}
          </div>
        ) : (
          <>
            <button onClick={() => setPicking(true)} style={{ ...primary, marginTop: 8 }}><Plus size={14} /> New from a Scene Pack image</button>
            <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>
              {data.items.length === 0 && <div style={{ color: C.muted, font: '400 13px/1.5 Satoshi' }}>No Character B-roll yet. Pick a Scene Pack image to put your character into it.</div>}
              {data.items.map((it) => <ItemCard key={it.id} it={it} base={base} busy={busy} run={run} onPlaced={onPlaced} placed={data.overlays.some((o) => o.characterItemId === it.id)} videoReady={data.videoGeneration.ready} videoMessage={data.videoGeneration.message} onRefresh={onChanged} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ItemCard({ it, base, busy, run, onPlaced, placed, videoReady, videoMessage, onRefresh }: { onRefresh: () => void; videoReady: boolean; videoMessage: string | null; it: CompItem; base: string; busy: string | null; run: (k: string, f: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<{ ok: boolean; data: unknown }>; onPlaced: (id: number | null) => void; placed: boolean }) {
  const [prompt, setPrompt] = useState(it.motionPrompt ?? '');
  useEffect(() => setPrompt(it.motionPrompt ?? ''), [it.motionPrompt]);
  const step = (a: string, body?: unknown) => run(`${it.id}:${a}`, () => post(`${base}/${it.id}/${a}`, body));
  const working = (a: string) => busy === `${it.id}:${a}`;
  const approved = it.imageStatus === 'approved';
  const videoActive = ['queued', 'submitting', 'processing'].includes(it.clipStatus);
  const [imgState, setImgState] = useState<ImageState>('loading');
  const [confirmAgain, setConfirmAgain] = useState(false);
  const imageUnknown = it.imageJobStatus === 'submit_unknown';
  const canStartVideo = !busy && videoReady && !!it.motionPrompt?.trim() && prompt === (it.motionPrompt ?? '');

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, display: 'grid', gridTemplateColumns: '150px 1fr', gap: 14 }} data-testid={`character-item-${it.id}`}>
      <div>
        {it.imageUrl || it.fullImageUrl || ['ready', 'approved', 'rejected'].includes(it.imageStatus)
          ? <ReviewImage item={it} onState={setImgState} onRetry={onRefresh} />
          : <div style={{ width: 150, height: 200, borderRadius: 8, background: C.soft, display: 'grid', placeItems: 'center' }}>{it.imageStatus === 'generating' && !imageUnknown ? <Loader2 size={18} className="spin" /> : null}</div>}
        <div style={{ font: '500 11px/1.3 Satoshi', color: it.imageStatus === 'approved' ? C.ok : it.imageStatus === 'failed' || it.imageStatus === 'rejected' || imageUnknown ? C.danger : C.muted, marginTop: 6 }}>{imageUnknown ? 'Outcome unknown' : imageText[it.imageStatus]}</div>
        {it.imageWidth && it.imageHeight && <div style={{ font: '400 11px/1.3 Satoshi', color: C.muted }}>{it.imageWidth} × {it.imageHeight}{imgState === 'ok' ? ' · click to enlarge' : ''}</div>}
      </div>
      <div>
        {it.intendedAction && <div style={{ font: '400 12px/1.4 Satoshi', color: C.muted, marginBottom: 6 }}>Action: {it.intendedAction}</div>}
        {it.imageError && <div style={{ font: '400 12px/1.4 Satoshi', color: C.danger }}>{it.imageError}</div>}
        {imageUnknown && (
          <div role="alert" style={{ margin: '4px 0 8px', padding: 10, borderRadius: 8, background: '#FFF4D6', color: C.warn, font: '400 12px/1.4 Satoshi' }}>
            {it.imageNote ?? 'We could not confirm that the image request was accepted.'}
            <div style={{ marginTop: 8 }}>
              {!confirmAgain
                ? <button disabled={!!busy} onClick={() => setConfirmAgain(true)} style={ghost}>Generate again anyway (could be charged twice)</button>
                // A second, explicit step: the person says they have checked and accept a possible second charge.
                : <div role="group" aria-label="Confirm generating again" style={{ padding: 8, borderRadius: 8, background: '#fff', border: `1px solid ${C.danger}` }}>
                    <div style={{ font: '500 12px/1.4 Satoshi', color: C.danger, marginBottom: 6 }}>The first request may already have been accepted and charged. Generating again makes a NEW request and may be charged a second time. The first one stays on record.</div>
                    <button disabled={!!busy} onClick={async () => { await step('regenerate', { confirmDuplicate: true }); setConfirmAgain(false); }} style={{ ...ghost, background: C.danger, color: '#fff', border: 'none' }}>{working('regenerate') ? 'Starting…' : 'Yes, I accept a possible second charge'}</button>
                    <button disabled={!!busy} onClick={() => setConfirmAgain(false)} style={{ ...ghost, marginLeft: 8 }}>Cancel</button>
                  </div>}
            </div>
          </div>
        )}

        {(it.imageStatus === 'ready') && (
          <div style={{ display: 'flex', gap: 8, margin: '4px 0 8px' }}>
            <button disabled={!!busy || imgState !== 'ok'} title={imgState !== 'ok' ? 'The image has not loaded, so it cannot be approved yet.' : undefined} onClick={() => step('approve')} style={{ ...primary, opacity: imgState !== 'ok' ? 0.5 : 1 }}><Check size={13} /> {working('approve') ? 'Approving…' : 'Approve image'}</button>
            <button disabled={!!busy} onClick={() => step('reject')} style={ghost}>Reject</button>
          </div>
        )}
        {(it.imageStatus === 'rejected' || it.imageStatus === 'failed') && it.clipStatus === 'not_started' && <button disabled={!!busy} onClick={() => step('regenerate')} style={ghost}><RefreshCw size={13} /> Make it again</button>}
        {approved && it.clipStatus === 'not_started' && <button disabled={!!busy} onClick={() => step('reject')} style={{ ...ghost, marginBottom: 8 }}>Withdraw approval</button>}

        {approved && (
          <div style={{ marginTop: 6 }}>
            <label style={{ font: '500 12px/1.4 Satoshi', color: C.muted }}>Motion prompt (you can edit it)
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} disabled={videoActive || it.clipStatus === 'ready'} placeholder="Describe how the image should move" style={{ width: '100%', marginTop: 4, borderRadius: 8, border: `1px solid ${C.borderStrong}`, padding: 8, font: '400 13px/1.4 Satoshi', boxSizing: 'border-box' }} />
            </label>
            {!videoActive && it.clipStatus !== 'ready' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <button disabled={!!busy} onClick={() => step('suggest-prompt')} style={ghost}><Sparkles size={13} /> {working('suggest-prompt') ? 'Writing…' : 'Suggest from the image'}</button>
                <button disabled={!!busy || !prompt.trim() || prompt === (it.motionPrompt ?? '')} onClick={() => step('prompt', { motionPrompt: prompt })} style={ghost}>Save prompt</button>
              </div>
            )}
            <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: C.soft }}>
              <div style={{ font: '500 12px/1.4 Satoshi' }}>{clipText[it.clipStatus]}</div>
              {it.clipErrorMessage && <div style={{ font: '400 12px/1.4 Satoshi', color: C.danger, marginTop: 4 }}>{it.clipErrorMessage}</div>}
              {(it.clipStatus === 'not_started' || it.clipStatus === 'failed') && (
                <>
                  <button disabled={!canStartVideo} aria-disabled={!canStartVideo} onClick={() => step('generate')} style={{ ...primary, marginTop: 8, opacity: canStartVideo ? 1 : 0.45, cursor: canStartVideo ? 'pointer' : 'not-allowed' }}>{working('generate') ? 'Starting…' : it.clipStatus === 'failed' ? 'Try the video again' : 'Make the 5-second video'}</button>
                  {!videoReady && <div role="alert" style={{ font: '400 12px/1.4 Satoshi', color: C.danger, marginTop: 4 }}>{videoMessage ?? 'Video generation is not available right now.'}</div>}
                  <div style={{ font: '400 11px/1.4 Satoshi', color: C.muted, marginTop: 4 }}>Paid step: one Kling 3.0 Standard video, 5 seconds, silent. Failed or blocked requests are not charged.</div>
                </>
              )}
              {it.clipStatus === 'submit_unknown' && <button disabled={!!busy} onClick={() => step('generate', { confirmDuplicate: true })} style={{ ...ghost, marginTop: 8 }}>Try again anyway (could be charged twice)</button>}
              {it.clipStatus === 'ready' && !placed && <button disabled={!!busy} onClick={async () => { const r = await run(`${it.id}:place`, () => post(`${base}/${it.id}/place`)); if (r.ok) onPlaced((r.data as { id?: number }).id ?? null); }} style={{ ...primary, marginTop: 8 }}>Add to the timeline</button>}
              {it.clipStatus === 'ready' && placed && <div style={{ font: '400 12px/1.4 Satoshi', color: C.ok, marginTop: 4 }}>On the timeline.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
const primary: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, background: C.primary, color: '#fff', border: 'none', font: '700 13px/1 Satoshi', cursor: 'pointer' };
const ghost: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, background: '#fff', border: `1px solid ${C.borderStrong}`, font: '500 12px/1 Satoshi', cursor: 'pointer', color: C.text };
const link: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'none', cursor: 'pointer', font: '500 12px/1 Satoshi', color: C.muted, padding: 0 };
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 40, padding: '0 12px', borderRadius: 9, border: `1px solid ${C.border}`, background: '#fff', font: '500 13px/1 Satoshi', cursor: 'pointer' };

type ImageState = 'loading' | 'ok' | 'failed';

/**
 * The personalised image, whole (never cropped or stretched). It tries the thumbnail, then the original, and reports whether the person
 * can actually SEE it: Approve is only offered when it loaded. A missing or unreachable file shows a clear message and a retry.
 */
function ReviewImage({ item, onState, onRetry }: { item: CompItem; onState: (s: ImageState) => void; onRetry: () => void }) {
  const candidates = [item.imageUrl, item.fullImageUrl].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
  const [idx, setIdx] = useState(0);
  const [state, setState] = useState<ImageState>(candidates.length ? 'loading' : 'failed');
  const [zoom, setZoom] = useState(false);
  const [zoomState, setZoomState] = useState<ImageState>('loading');
  const key = candidates.join('|');
  useEffect(() => { setIdx(0); setState(candidates.length ? 'loading' : 'failed'); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onState(state); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const box: React.CSSProperties = { width: 150, aspectRatio: item.imageWidth && item.imageHeight ? `${item.imageWidth} / ${item.imageHeight}` : '3 / 5.5', borderRadius: 8, background: C.soft, border: `1px solid ${C.border}`, overflow: 'hidden', position: 'relative', boxSizing: 'border-box' };

  if (state === 'failed') {
    return (
      <div style={{ ...box, display: 'grid', placeItems: 'center', padding: 8, textAlign: 'center' }} role="alert" data-testid="image-unavailable">
        <div>
          <div style={{ font: '700 12px/1.3 Satoshi', color: C.danger }}>Image unavailable</div>
          <div style={{ font: '400 11px/1.4 Satoshi', color: C.muted, margin: '4px 0 8px' }}>{candidates.length ? 'The file could not be loaded.' : 'There is no image file to show.'} You cannot approve an image you cannot see.</div>
          <button type="button" onClick={() => { setIdx(0); setState(candidates.length ? 'loading' : 'failed'); onRetry(); }} style={{ height: 26, padding: '0 10px', borderRadius: 7, border: `1px solid ${C.borderStrong}`, background: '#fff', font: '500 11px/1 Satoshi', cursor: 'pointer' }}>Try again</button>
        </div>
      </div>
    );
  }
  return (
    <>
      <button type="button" onClick={() => { setZoom(true); setZoomState('loading'); }} aria-label="Inspect the personalised image at full size" style={{ ...box, padding: 0, cursor: 'zoom-in', display: 'block' }}>
        {state === 'loading' && <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }} data-testid="image-loading"><Loader2 size={18} className="spin" /></span>}
        <img key={candidates[idx]} src={candidates[idx]} alt="Personalised image" onLoad={() => setState('ok')} onError={() => (idx + 1 < candidates.length ? setIdx(idx + 1) : setState('failed'))}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', opacity: state === 'ok' ? 1 : 0 }} />
      </button>
      {zoom && (
        <div role="dialog" aria-label="Personalised image, full size" onClick={() => setZoom(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.8)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16, cursor: 'zoom-out' }}>
          {item.fullImageUrl && zoomState !== 'failed' && <img src={item.fullImageUrl} alt="Personalised image, full size" onLoad={() => setZoomState('ok')} onError={() => setZoomState('failed')} style={{ maxWidth: '100%', maxHeight: '92vh', objectFit: 'contain', borderRadius: 8, display: zoomState === 'ok' ? 'block' : 'none' }} />}
          {zoomState === 'loading' && item.fullImageUrl && <div style={{ color: '#fff', font: '500 13px/1 Satoshi' }}>Loading the full-size image…</div>}
          {(zoomState === 'failed' || !item.fullImageUrl) && <div role="alert" style={{ color: '#fff', font: '500 13px/1.5 Satoshi', textAlign: 'center' }}>The full-size image could not be loaded.<br />Click anywhere to close.</div>}
        </div>
      )}
    </>
  );
}
