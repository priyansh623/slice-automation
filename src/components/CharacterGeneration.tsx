'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, UserRound, X } from 'lucide-react';
import { api, C, post, type Composition } from '@/components/composition/types';
import { ItemCard } from '@/components/CharacterItemCard';
import { backdrop, sheet } from '@/components/composition/LibraryPicker';

interface Pick { assetId: number; screenId: number; action: string; itemId?: number }
interface SceneRef { screenId: number; sceneNumber: number }

/**
 * Character B-roll on the existing Generation screen. It lists the Scene Pack images chosen on the B-roll selection screen and runs the
 * EXISTING process for each one: personalised image (Grok Imagine 2.0, using the project's character) -> your approval -> 5-second video
 * (Kling 3.0 Standard). Nothing starts until you press the button for that image, and the video step stays locked until the image is approved.
 * The finished clip is placed on its scene in Composition automatically.
 */
export default function CharacterGeneration({ projectId }: { projectId: string }) {
  const base = `/api/v1/video-projects/${projectId}`;
  const [picks, setPicks] = useState<Pick[] | null>(null); const [scenes, setScenes] = useState<SceneRef[]>([]);
  const [comp, setComp] = useState<Composition | null>(null);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([api<{ selection: { character: Pick[] }; scenes: SceneRef[] }>(`${base}/broll-selection`), api<Composition>(`${base}/composition`)]);
    if (!s.ok) { setPicks([]); return; }
    setPicks(s.data.selection.character); setScenes(s.data.scenes); if (c.ok) setComp(c.data as unknown as Composition);
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  const active = !!comp && comp.items.some((i) => i.imageStatus === 'generating' || ['queued', 'submitting', 'submit_unknown', 'processing'].includes(i.clipStatus));
  useEffect(() => { if (!active) return; const t = setInterval(() => void load(), 4000); return () => clearInterval(t); }, [active, load]);

  const run = useCallback(async (key: string, fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => {
    setBusy(key); setError('');
    const r = await fn();
    if (!r.ok) setError(r.data.error ?? 'Something went wrong.');
    setBusy(null); await load();
    return r;
  }, [load]);

  if (!picks || picks.length === 0 || !comp) return null;
  const needsReview = comp.items.filter((i) => i.imageStatus === 'ready').length;
  const sceneNo = (sid: number) => scenes.find((s) => s.screenId === sid)?.sceneNumber ?? '?';

  return (
    <>
      <button onClick={() => setOpen(true)} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', borderRadius: 9, background: '#fff', border: `1px solid ${C.borderStrong}`, font: '600 13px/1 Satoshi', cursor: 'pointer', color: C.text, marginRight: 8 }}>
        <UserRound size={14} color={C.character} /> Character B-roll ({picks.length})
        {needsReview > 0 && <span style={{ marginLeft: 4, background: C.primary, color: '#fff', borderRadius: 999, padding: '3px 7px', font: '700 11px/1 Satoshi' }}>{needsReview} to review</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Character B-roll" style={backdrop} onClick={() => setOpen(false)}>
          <div style={{ ...sheet, width: 'min(880px, 100%)', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ font: '700 16px/1.2 Satoshi' }}>Character B-roll</div>
              <button aria-label="Close" onClick={() => setOpen(false)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={18} /></button>
            </div>
            <p style={{ margin: '0 0 8px', font: '400 12px/1.5 Satoshi', color: C.muted }}>The Scene Pack images you chose. Each one is personalised with your character, you approve the image, and only then is the 5-second video made. Finished clips appear in Composition on the scene they were chosen for.</p>
            {!comp.imageGeneration.ready && <div role="alert" style={{ margin: '8px 0', padding: '8px 10px', borderRadius: 8, background: '#FFF4D6', color: C.warn, font: '400 12px/1.4 Satoshi' }}>Personalised images cannot be made right now: {comp.imageGeneration.message ?? 'image generation is not available.'}</div>}
            {comp.imageGeneration.provider === 'mock' && <div style={{ margin: '8px 0', padding: '8px 10px', borderRadius: 8, background: '#EFEBFF', color: C.primary, font: '400 12px/1.4 Satoshi' }}>Test mode: images are placeholders from the mock provider.</div>}
            {error && <div role="alert" className="alert alert-error" style={{ margin: '8px 0' }}>{error}</div>}
            <div style={{ display: 'grid', gap: 14, marginTop: 10 }}>
              {picks.map((p) => {
                const it = p.itemId !== undefined ? comp.items.find((i) => i.id === p.itemId) : undefined;
                const key = `${p.assetId}:${p.screenId}`;
                if (!it) return (
                  <div key={key} data-testid={`pick-${key}`} style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ flex: 1 }}><b style={{ font: '700 13px/1.3 Satoshi' }}>Scene {sceneNo(p.screenId)} · Scene Pack image</b><div style={{ font: '400 12px/1.4 Satoshi', color: C.muted }}>{p.action ? `Action: ${p.action}` : 'No action written.'} Not started: nothing has been generated or charged.</div></div>
                    <button disabled={!!busy || !comp.imageGeneration.ready} onClick={() => void run(key, () => post(`${base}/broll-selection/character-start`, { assetId: p.assetId, screenId: p.screenId }))} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, background: C.primary, color: '#fff', border: 'none', font: '700 13px/1 Satoshi', cursor: 'pointer', opacity: !comp.imageGeneration.ready ? 0.5 : 1 }}>{busy === key ? <Loader2 size={13} className="spin" /> : null} Make the personalised image</button>
                  </div>
                );
                return (
                  <div key={key}>
                    <div style={{ font: '700 12px/1 Satoshi', margin: '0 0 6px', color: C.character }}>Scene {sceneNo(p.screenId)}</div>
                    <ItemCard it={it} base={`${base}/character-broll`} busy={busy} run={run}  videoReady={comp.videoGeneration.ready} videoMessage={comp.videoGeneration.message} onRefresh={() => void load()} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </>
  );
}
