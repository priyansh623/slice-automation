'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, Play, RefreshCw, Sparkles, UserRound } from 'lucide-react';
import { C, post, type CompItem } from '@/components/composition/types';
import { ReviewImage, type ImageState } from '@/components/ReviewImage';
import type { CharRow, CharacterProduction } from './useCharacterProduction';

const ORANGE = '#C2410C';
/** A queued image job that no worker has picked up for a while (it has not been sent anywhere, so nothing is charged). */
const stuckQueued = (i?: CompItem): number | null => (i && i.imageStatus === 'generating' && i.imageJobStatus === 'queued' && i.imageJobCreatedAt && Date.now() - i.imageJobCreatedAt > 90_000 ? Math.round((Date.now() - i.imageJobCreatedAt) / 60_000) : null);
const clipActive = (i?: CompItem) => !!i && ['queued', 'submitting', 'processing'].includes(i.clipStatus);

/** One line of status for a Character B-roll row. */
export function statusOf(r: CharRow, imageReady: boolean): { text: string; color: string } {
  const i = r.item;
  if (!i) return r.startError ? { text: "Couldn't start", color: C.danger } : r.starting ? { text: 'Starting…', color: '#6C47FF' } : imageReady ? { text: 'Not started', color: C.muted } : { text: 'Waiting', color: C.warn };
  if (i.imageJobStatus === 'submit_unknown' || i.clipStatus === 'submit_unknown') return { text: 'Needs a decision', color: C.warn };
  if (i.clipStatus === 'ready') return { text: 'Ready', color: C.ok };
  if (clipActive(i)) return { text: 'Animating…', color: '#6C47FF' };
  if (i.clipStatus === 'failed') return { text: 'Video failed', color: C.danger };
  if (stuckQueued(i) !== null) return { text: 'Waiting for the worker', color: C.warn };
  if (i.imageStatus === 'generating' || i.imageStatus === 'pending') return { text: 'Making image…', color: '#6C47FF' };
  if (i.imageStatus === 'ready') return { text: 'Needs approval', color: '#6C47FF' };
  if (i.imageStatus === 'approved') return { text: 'Make the video', color: '#6C47FF' };
  if (i.imageStatus === 'rejected') return { text: 'Rejected', color: C.danger };
  return { text: 'Image failed', color: C.danger };
}

/** The "Character B-roll" section of the left list, styled like the scene rows. */
export function CharacterRail({ rows, imageReady, selectedKey, onSelect }: { rows: CharRow[]; imageReady: boolean; selectedKey: string | null; onSelect: (key: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ borderTop: '1px solid #ECECE8', marginTop: 8 }} data-testid="character-rail">
      <div style={{ padding: '14px 16px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <UserRound size={15} color={ORANGE} aria-hidden />
        <span style={{ font: '600 13px/1 Satoshi', color: '#111113' }}>Character B-roll</span>
        <span style={{ font: '500 12px/1 Satoshi', color: '#75757C', marginLeft: 'auto' }}>{rows.filter((r) => r.item?.clipStatus === 'ready').length} of {rows.length} ready</span>
      </div>
      {rows.map((r) => {
        const st = statusOf(r, imageReady); const on = selectedKey === r.key;
        return (
          <button key={r.key} onClick={() => onSelect(r.key)} aria-current={on} data-testid={`character-row-${r.key}`}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 16px', border: 'none', borderLeft: `3px solid ${on ? '#6C47FF' : 'transparent'}`, background: on ? '#F5F3FF' : 'transparent', cursor: 'pointer' }}>
            <span style={{ width: 30, height: 42, borderRadius: 6, background: '#E4E4E0', overflow: 'hidden', flexShrink: 0 }}>{(r.item?.imageUrl ?? r.thumb) && <img src={(r.item?.imageUrl ?? r.thumb)!} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', font: '600 13px/1.3 Satoshi', color: '#111113' }}>Scene {r.sceneNumber} · Character</span>
              <span style={{ display: 'block', font: '500 12px/1.3 Satoshi', color: st.color }}>{st.text}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const btn = (kind: 'primary' | 'ghost' | 'danger'): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 40, padding: '0 18px', borderRadius: 10, font: '600 13px/1 Satoshi', cursor: 'pointer', border: kind === 'primary' ? 'none' : `1px solid ${kind === 'danger' ? C.danger : '#E4E4E0'}`, background: kind === 'primary' ? '#6C47FF' : '#fff', color: kind === 'primary' ? '#fff' : kind === 'danger' ? C.danger : '#111113' });

/**
 * The middle and right panels for one Character B-roll item, in the same shape as a Flow scene: tabs in the middle (Image, Animation), the
 * preview and the approve bar on the right. Approve is only offered for an image that loaded; the video only unlocks after approval.
 */
export function CharacterWorkspace({ row, prod }: { row: CharRow; prod: CharacterProduction }) {
  const it = row.item;
  const [tab, setTab] = useState<'image' | 'animation'>(it?.imageStatus === 'approved' ? 'animation' : 'image');
  const [prompt, setPrompt] = useState(it?.motionPrompt ?? ''); const [imgState, setImgState] = useState<ImageState>('loading'); const [confirmAgain, setConfirmAgain] = useState(false);
  useEffect(() => setPrompt(it?.motionPrompt ?? ''), [it?.motionPrompt]);
  useEffect(() => { setTab(it?.imageStatus === 'approved' ? 'animation' : 'image'); }, [row.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, run, comp, base } = prod;
  const step = (a: string, body?: unknown) => run(`${row.key}:${a}`, () => post(`${base}/character-broll/${it!.id}/${a}`, body));
  const working = (a: string) => busy === `${row.key}:${a}`;
  const imageUnknown = it?.imageJobStatus === 'submit_unknown';
  const approved = it?.imageStatus === 'approved';
  const videoActive = clipActive(it);
  const videoReady = comp?.videoGeneration.ready ?? false;
  const canStartVideo = !busy && videoReady && !!it?.motionPrompt?.trim() && prompt === (it?.motionPrompt ?? '');
  const approve = async () => { const r = await step('approve'); if (r.ok) {
      setTab('animation');
      // the motion prompt is written for you right after approval; if that fails you can write it yourself
      if (!it?.motionPrompt) await run(`${row.key}:suggest-prompt`, async () => { const q = await post(`${base}/character-broll/${it!.id}/suggest-prompt`); return q.ok ? q : { ok: false, data: { error: 'The motion prompt could not be written automatically. Write one below, or press Suggest again.' } }; });
    }
  };

  const title = <span style={{ font: '700 18px/1 Satoshi', letterSpacing: '-0.02em' }}>Scene {row.sceneNumber}</span>;
  const centre = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #ECECE8' }}>
      <div style={{ padding: '14px 24px 0', borderBottom: '1px solid #ECECE8', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          {title}
          <span style={{ height: 26, padding: '0 10px', borderRadius: 999, background: '#FFF1E8', color: ORANGE, font: '600 12px/26px Satoshi' }}>Character B-roll</span>
        </div>
        <div style={{ display: 'flex', gap: 22 }}>
          {(['image', 'animation'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 12px', font: `${tab === t ? '600' : '400'} 13px/1 Satoshi`, color: tab === t ? '#111113' : '#75757C', borderBottom: `2px solid ${tab === t ? '#6C47FF' : 'transparent'}` }}>{t === 'image' ? 'Image' : 'Animation'}</button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {prod.error && <div role="alert" style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', font: '400 13px/1.4 Satoshi' }}>{prod.error}</div>}
        {!it ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', font: '400 14px/1.6 Satoshi', color: '#5E5E65', maxWidth: 520, margin: '0 auto' }}>
            {row.starting ? <><Loader2 size={22} className="spin" /><div style={{ font: '700 16px/1.3 Satoshi', margin: '10px 0 4px' }}>Starting the personalised image…</div>Your character is being put into this image.</>
              : <>
                  {row.startError && <div role="alert" style={{ font: '500 13px/1.5 Satoshi', color: C.danger, marginBottom: 14 }}>{row.startError}</div>}
                  <div style={{ width: 120, aspectRatio: '3 / 5.5', borderRadius: 8, background: '#E4E4E0', overflow: 'hidden', margin: '0 auto 16px', border: `1px solid ${C.border}` }}>{row.thumb && <img src={row.thumb} alt="Scene Pack image" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}</div>
                  <div style={{ font: '700 16px/1.3 Satoshi', color: '#111113', marginBottom: 6 }}>Put your character into this image</div>
                  {row.action ? <div style={{ marginBottom: 6 }}>Action: {row.action}</div> : null}
                  {!prod.imageReady ? <div role="alert" style={{ color: C.warn }}>Image generation is not available right now: {comp?.imageGeneration.message ?? 'it is not switched on.'}</div> : <>You review and approve it before any video is made.</>}
                  <div><button disabled={!prod.imageReady || !!busy} onClick={() => void prod.startOne(row)} style={{ ...btn('primary'), marginTop: 16, opacity: prod.imageReady ? 1 : 0.45, cursor: prod.imageReady ? 'pointer' : 'not-allowed' }}>{row.startError ? 'Try again' : 'Make the personalised image'}</button></div>
                  <div style={{ font: '400 12px/1.5 Satoshi', color: C.muted, marginTop: 10 }}>Paid step: one personalised image (Grok Imagine 2.0).</div>
                </>}
          </div>
        ) : tab === 'image' ? (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20, maxWidth: 640 }}>
              <figure style={{ margin: 0 }}>
                <figcaption style={{ font: '600 12px/1 Satoshi', color: C.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>Original</figcaption>
                <div style={{ aspectRatio: '3 / 5.5', borderRadius: 8, background: '#E4E4E0', overflow: 'hidden', border: `1px solid ${C.border}` }}>{row.thumb && <img src={row.thumb} alt="Original Scene Pack image" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />}</div>
              </figure>
              <figure style={{ margin: 0 }}>
                <figcaption style={{ font: '600 12px/1 Satoshi', color: '#6C47FF', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>With your character</figcaption>
                {['ready', 'approved', 'rejected'].includes(it.imageStatus) || it.imageUrl || it.fullImageUrl
                  ? <ReviewImage item={it} onState={setImgState} onRetry={() => void prod.reload()} width="100%" />
                  : <div style={{ aspectRatio: '3 / 5.5', borderRadius: 8, background: C.soft, border: `1px solid ${C.border}`, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 16, font: '500 13px/1.5 Satoshi', color: '#5E5E65' }}>{it.imageStatus === 'failed' ? <span style={{ color: C.danger }}>{it.imageError ?? 'The image failed.'}</span> : stuckQueued(it) !== null ? <span style={{ color: C.warn }}>Still waiting for the worker to pick this up ({stuckQueued(it)} min).<br /><span style={{ color: C.muted }}>It has not been sent yet, so nothing is charged. If this does not change, let us know.</span></span> : <span><Loader2 size={20} className="spin" /><br />Making the personalised image…<br /><span style={{ color: C.muted }}>This takes about a minute.</span></span>}</div>}
              </figure>
            </div>
            {row.action && <div style={{ font: '400 13px/1.5 Satoshi', color: C.muted, margin: '14px 0 0' }}>Action: {row.action}</div>}
            {imageUnknown && (
              <div role="alert" style={{ margin: '16px 0 0', maxWidth: 640, padding: 12, borderRadius: 10, background: '#FFF4D6', color: C.warn, font: '400 13px/1.5 Satoshi' }}>
                {it.imageNote ?? 'We could not confirm that the image request was accepted.'}
                <div style={{ marginTop: 10 }}>
                  {!confirmAgain ? <button disabled={!!busy} onClick={() => setConfirmAgain(true)} style={btn('ghost')}>Generate again anyway (could be charged twice)</button>
                    : <div role="group" aria-label="Confirm generating again" style={{ padding: 10, borderRadius: 8, background: '#fff', border: `1px solid ${C.danger}` }}>
                        <div style={{ font: '500 12px/1.5 Satoshi', color: C.danger, marginBottom: 8 }}>The first request may already have been accepted and charged. Generating again makes a NEW request and may be charged a second time. The first one stays on record.</div>
                        <button disabled={!!busy} onClick={async () => { await step('regenerate', { confirmDuplicate: true }); setConfirmAgain(false); }} style={{ ...btn('danger'), background: C.danger, color: '#fff' }}>{working('regenerate') ? 'Starting…' : 'Yes, I accept a possible second charge'}</button>
                        <button disabled={!!busy} onClick={() => setConfirmAgain(false)} style={{ ...btn('ghost'), marginLeft: 8 }}>Cancel</button>
                      </div>}
                </div>
              </div>
            )}
            {it.imageError && !imageUnknown && it.imageStatus !== 'failed' && <div style={{ marginTop: 12, font: '400 13px/1.5 Satoshi', color: C.danger }}>{it.imageError}</div>}
            {(it.imageStatus === 'rejected' || it.imageStatus === 'failed') && it.clipStatus === 'not_started' && <button disabled={!!busy} onClick={() => void step('regenerate')} style={{ ...btn('ghost'), marginTop: 16 }}><RefreshCw size={14} /> {working('regenerate') ? 'Starting…' : 'Make it again'}</button>}
            <div style={{ font: '400 12px/1.5 Satoshi', color: C.muted, marginTop: 16 }}>Paid step: one personalised image (Grok Imagine 2.0). {comp?.imageGeneration.provider === 'mock' ? 'Test mode: placeholder images.' : ''}</div>
          </div>
        ) : (
          <div style={{ maxWidth: 560 }}>
            {!approved ? (
              <div style={{ textAlign: 'center', padding: '50px 20px', font: '400 14px/1.6 Satoshi', color: '#5E5E65' }}><div style={{ font: '700 16px/1.3 Satoshi', marginBottom: 6 }}>Approve the image first</div>The video is made from the approved image. Nothing is charged for video until you start it.</div>
            ) : (
              <>
                <label style={{ font: '600 13px/1.4 Satoshi' }}>Motion prompt <span style={{ color: C.muted, font: '400 12px/1 Satoshi' }}>(written from your image; you can edit it)</span>
                  <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} disabled={videoActive || it?.clipStatus === 'ready'} placeholder={working('suggest-prompt') ? 'Writing the prompt…' : 'Describe how the image should move'} style={{ width: '100%', marginTop: 8, borderRadius: 10, border: '1px solid #E4E4E0', padding: 12, font: '400 14px/1.5 Satoshi', boxSizing: 'border-box' }} />
                </label>
                {!videoActive && it?.clipStatus !== 'ready' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button disabled={!!busy} onClick={() => void step('suggest-prompt')} style={btn('ghost')}><Sparkles size={14} /> {working('suggest-prompt') ? 'Writing…' : 'Suggest again'}</button>
                    <button disabled={!!busy || !prompt.trim() || prompt === (it?.motionPrompt ?? '')} onClick={() => void step('prompt', { motionPrompt: prompt })} style={btn('ghost')}>Save prompt</button>
                  </div>
                )}
                <div style={{ marginTop: 18, padding: 14, borderRadius: 12, background: C.soft }}>
                  <div style={{ font: '600 13px/1.4 Satoshi' }}>{{ not_started: 'Video not started', queued: 'Video queued', submitting: 'Sending to the video model…', submit_unknown: 'Could not confirm the request was accepted', processing: 'Making the 5-second video…', ready: 'Video ready', failed: 'Video failed' }[it!.clipStatus]}</div>
                  {it!.clipErrorMessage && <div style={{ font: '400 13px/1.5 Satoshi', color: C.danger, marginTop: 6 }}>{it!.clipErrorMessage}</div>}
                  {(it!.clipStatus === 'not_started' || it!.clipStatus === 'failed') && (
                    <>
                      <button disabled={!canStartVideo} aria-disabled={!canStartVideo} onClick={() => void step('generate')} style={{ ...btn('primary'), marginTop: 12, opacity: canStartVideo ? 1 : 0.45, cursor: canStartVideo ? 'pointer' : 'not-allowed' }}>{working('generate') ? 'Starting…' : it!.clipStatus === 'failed' ? 'Try the video again' : 'Make the 5-second video'}</button>
                      {!videoReady && <div role="alert" style={{ font: '400 12px/1.4 Satoshi', color: C.danger, marginTop: 6 }}>{comp?.videoGeneration.message ?? 'Video generation is not available right now.'}</div>}
                      <div style={{ font: '400 12px/1.5 Satoshi', color: C.muted, marginTop: 8 }}>Paid step: one Kling 3.0 Standard video, 5 seconds, silent. Failed or blocked requests are not charged.</div>
                    </>
                  )}
                  {it!.clipStatus === 'submit_unknown' && <button disabled={!!busy} onClick={() => void step('generate', { confirmDuplicate: true })} style={{ ...btn('ghost'), marginTop: 12 }}>Try again anyway (could be charged twice)</button>}
                  {it!.clipStatus === 'ready' && <div style={{ font: '400 13px/1.5 Satoshi', color: C.ok, marginTop: 8 }}>Ready. It will be placed on Scene {row.sceneNumber} in Composition automatically.</div>}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const showVideo = !!it?.clipUrl;
  const previewImg = it?.fullImageUrl ?? it?.imageUrl ?? null;
  const right = (
    <div style={{ width: 420, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff', borderLeft: '1px solid #ECECE8' }}>
      <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid #ECECE8', flexShrink: 0 }}><span style={{ font: '600 14px/1 Satoshi' }}>{showVideo ? 'Animation' : 'Personalised image'}</span></div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflow: 'hidden' }}>
        {showVideo ? <video key={it!.clipUrl!} src={it!.clipUrl!} controls loop playsInline style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 12, background: '#000' }} />
          : previewImg && it && it.imageStatus !== 'generating' ? <img src={previewImg} alt="Personalised image" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 12 }} />
          : <div style={{ textAlign: 'center', color: '#9A9AA0', font: '400 13px/1.5 Satoshi' }}><span style={{ width: 64, height: 64, borderRadius: '50%', background: '#F0F0EC', display: 'grid', placeItems: 'center', margin: '0 auto 12px' }}><Play size={22} color="#9A9AA0" /></span>{row.starting || it?.imageStatus === 'generating' ? 'Making the personalised image…' : !it ? 'Not started yet' : 'Nothing to show yet'}</div>}
      </div>
      <div style={{ padding: '14px 20px', borderTop: '1px solid #ECECE8', background: '#fff', flexShrink: 0, display: 'flex', gap: 8 }}>
        {!it ? <div style={{ flex: 1, textAlign: 'center', font: '400 13px/40px Satoshi', color: '#9A9AA0' }}>{row.starting ? 'Starting…' : 'Make the image to continue'}</div>
          : it.imageStatus === 'ready' ? (<>
              <button disabled={!!busy || imgState !== 'ok'} title={imgState !== 'ok' ? 'The image has not loaded, so it cannot be approved yet.' : undefined} onClick={() => void approve()} style={{ ...btn('primary'), flex: 1, opacity: imgState !== 'ok' ? 0.5 : 1 }}><Check size={14} /> {working('approve') ? 'Approving…' : 'Approve'}</button>
              <button disabled={!!busy} onClick={() => void step('reject')} style={btn('ghost')}>Reject</button></>)
          : approved && it.clipStatus === 'ready' ? <div style={{ flex: 1, textAlign: 'center', font: '600 13px/40px Satoshi', color: C.ok }}><Check size={14} style={{ verticalAlign: -2 }} /> Ready for Composition</div>
          : approved ? (<>
              <div style={{ flex: 1, textAlign: 'center', font: '600 13px/40px Satoshi', color: '#6C47FF' }}><Check size={14} style={{ verticalAlign: -2 }} /> Image approved</div>
              {it.clipStatus === 'not_started' && <button disabled={!!busy} onClick={() => void step('reject')} style={btn('ghost')}>Withdraw</button>}</>)
          : <div style={{ flex: 1, textAlign: 'center', font: '400 13px/40px Satoshi', color: '#9A9AA0' }}>{it.imageStatus === 'generating' || it.imageStatus === 'pending' ? 'Waiting for the image' : 'Make the image again to continue'}</div>}
      </div>
    </div>
  );
  return <>{centre}{right}<style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style></>;
}
