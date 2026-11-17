'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post, type CompItem, type Composition } from '@/components/composition/types';

export interface CharRow {
  key: string; assetId: number; screenId: number; sceneNumber: number | string; action: string;
  itemId?: number; item?: CompItem; /** the Scene Pack image the pick came from */ thumb: string | null; startError?: string; starting: boolean;
}
interface SelResponse { selection: { character: Array<{ assetId: number; screenId: number; action: string; itemId?: number }> }; scenes: Array<{ screenId: number; sceneNumber: number }>; previews?: { assets: Record<number, string | null> } }

/**
 * The Character B-roll of a project on the Generation screen. Entering the screen starts the personalised image (once) for every picked image
 * that has not been started: the item is created and its single paid image job is queued by the existing process. Nothing is repeated on a later
 * visit (a started pick has an item), the video is never started here, and everything else (approval, motion prompt, video, retries, the
 * outcome-unknown confirmation) stays exactly as it was.
 */
export function useCharacterProduction(projectId: string) {
  const base = `/api/v1/video-projects/${projectId}`;
  const [rows, setRows] = useState<CharRow[]>([]);
  const [comp, setComp] = useState<Composition | null>(null);
  const [enabled, setEnabled] = useState(false); const [loaded, setLoaded] = useState(false);
  const [startErrors, setStartErrors] = useState<Record<string, string>>({}); const [starting, setStarting] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState('');
  const attempted = useRef<Set<string>>(new Set());
  const startErrorsRef = useRef(startErrors); startErrorsRef.current = startErrors;

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([api<SelResponse>(`${base}/broll-selection`), api<Composition>(`${base}/composition`)]);
    if (!s.ok || !c.ok) { setLoaded(true); return null; }
    const comp2 = c.data as unknown as Composition; setComp(comp2); setEnabled(true);
    const no = new Map(s.data.scenes.map((x) => [x.screenId, x.sceneNumber]));
    const next: CharRow[] = s.data.selection.character.map((p) => ({
      key: `${p.assetId}-${p.screenId}`, assetId: p.assetId, screenId: p.screenId, sceneNumber: no.get(p.screenId) ?? '?', action: p.action, itemId: p.itemId,
      item: p.itemId !== undefined ? comp2.items.find((i) => i.id === p.itemId) : undefined, thumb: s.data.previews?.assets?.[p.assetId] ?? null,
      startError: startErrorsRef.current[`${p.assetId}-${p.screenId}`], starting: false,
    }));
    setRows(next); setLoaded(true);
    return { rows: next, comp: comp2 };
  }, [base]);

  const startOne = useCallback(async (r: Pick<CharRow, 'key' | 'assetId' | 'screenId'>) => {
    setStarting((p) => new Set(p).add(r.key));
    const res = await post(`${base}/broll-selection/character-start`, { assetId: r.assetId, screenId: r.screenId });
    setStarting((p) => { const n = new Set(p); n.delete(r.key); return n; });
    if (!res.ok && res.data.code !== 'already_started') setStartErrors((p) => ({ ...p, [r.key]: res.data.error ?? 'Could not start this image.' }));
    else setStartErrors((p) => { const { [r.key]: _gone, ...rest } = p; void _gone; return rest; });
    await load();
  }, [base, load]);

  // Entering the screen: read everything, then start the picks that were never started (each at most once from here).
  useEffect(() => {
    void (async () => {
      const first = await load();
      if (!first || !first.comp.imageGeneration.ready) return;
      for (const r of first.rows.filter((x) => x.itemId === undefined)) {
        if (attempted.current.has(r.key)) continue;
        attempted.current.add(r.key);
        await startOne(r);
      }
    })();
  }, [load, startOne]);

  const active = rows.some((r) => starting.has(r.key) || r.item?.imageStatus === 'generating' || ['queued', 'submitting', 'processing'].includes(r.item?.clipStatus ?? ''));
  useEffect(() => { if (!active) return; const t = setInterval(() => void load(), 4000); return () => clearInterval(t); }, [active, load]);

  const run = useCallback(async (key: string, fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => {
    setBusy(key); setError('');
    const r = await fn();
    if (!r.ok) setError(r.data.error ?? 'Something went wrong.');
    setBusy(null); await load();
    return r;
  }, [load]);

  const withState = rows.map((r) => ({ ...r, starting: starting.has(r.key), startError: startErrors[r.key] }));
  const imageReady = comp?.imageGeneration.ready ?? false;
  return { base, enabled, loaded, rows: withState, comp, imageReady, busy, error, setError, run, reload: load, startOne };
}
export type CharacterProduction = ReturnType<typeof useCharacterProduction>;
