'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { C, type CompItem } from '@/components/composition/types';

export type ImageState = 'loading' | 'ok' | 'failed';

/**
 * The personalised image, whole (never cropped or stretched). It tries the thumbnail, then the original, and reports whether the person
 * can actually SEE it: Approve is only offered when it loaded. A missing or unreachable file shows a clear message and a retry.
 */
export function ReviewImage({ item, onState, onRetry, width = 150 }: { item: CompItem; onState: (s: ImageState) => void; onRetry: () => void; width?: number | string }) {
  const candidates = [item.imageUrl, item.fullImageUrl].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
  const [idx, setIdx] = useState(0);
  const [state, setState] = useState<ImageState>(candidates.length ? 'loading' : 'failed');
  const [zoom, setZoom] = useState(false);
  const [zoomState, setZoomState] = useState<ImageState>('loading');
  const key = candidates.join('|');
  useEffect(() => { setIdx(0); setState(candidates.length ? 'loading' : 'failed'); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onState(state); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const box: React.CSSProperties = { width, aspectRatio: item.imageWidth && item.imageHeight ? `${item.imageWidth} / ${item.imageHeight}` : '3 / 5.5', borderRadius: 8, background: C.soft, border: `1px solid ${C.border}`, overflow: 'hidden', position: 'relative', boxSizing: 'border-box' };

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
        <img key={candidates[idx]} src={candidates[idx]} alt="Personalised image" ref={(el) => { if (el && el.complete && el.naturalWidth > 0) setState((cur) => (cur === 'loading' ? 'ok' : cur)); }} onLoad={() => setState('ok')} onError={() => (idx + 1 < candidates.length ? setIdx(idx + 1) : setState('failed'))}
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
