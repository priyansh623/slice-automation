'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { C, post, type CompItem } from '@/components/composition/types';

const imageText: Record<CompItem['imageStatus'], string> = { pending: 'Waiting', generating: 'Making the personalised image…', ready: 'Ready for your review', approved: 'Approved', rejected: 'Rejected', failed: 'Image failed' };
const clipText: Record<CompItem['clipStatus'], string> = { not_started: 'Video not started', queued: 'Video queued', submitting: 'Sending to the video model…', submit_unknown: 'Could not confirm the request was accepted', processing: 'Making the 5-second video…', ready: 'Video ready', failed: 'Video failed' };

/**
 * One Character B-roll item on the Generation screen: the personalised image (review, approve, reject, make again), the motion prompt, and the
 * paid 5-second video (only after the image is approved), with the outcome-unknown and retry rules. This is the ONLY place these controls exist.
 */
export function ItemCard({ it, base, busy, run, videoReady, videoMessage, onRefresh }: { onRefresh: () => void; videoReady: boolean; videoMessage: string | null; it: CompItem; base: string; busy: string | null; run: (k: string, f: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<{ ok: boolean; data: unknown }> }) {
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
              {it.clipStatus === 'ready' && <div style={{ font: '400 12px/1.4 Satoshi', color: C.ok, marginTop: 4 }}>Ready. It is placed on its scene in Composition automatically.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
const primary: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, background: C.primary, color: '#fff', border: 'none', font: '700 13px/1 Satoshi', cursor: 'pointer' };
const ghost: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, background: '#fff', border: `1px solid ${C.borderStrong}`, font: '500 12px/1 Satoshi', cursor: 'pointer', color: C.text };

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
