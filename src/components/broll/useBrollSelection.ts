'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/components/composition/types';

export interface Scene { screenId: number; sceneNumber: number; dialogue: string }
export interface GenericPick { clipId: number; screenId: number; overlayId?: number }
export interface CharacterPick { assetId: number; screenId: number; action: string; itemId?: number; overlayId?: number }
export interface Selection { generic: GenericPick[]; character: CharacterPick[] }

/**
 * The B-roll picks of a project: loaded from the server, and saved as a whole every time they change (one save at a time, so quick clicks cannot
 * overwrite each other). Picks are IDs only; nothing is generated or charged by saving.
 */
export function useBrollSelection(projectId: string) {
  const base = `/api/v1/video-projects/${projectId}`;
  const [state, setState] = useState<'loading' | 'off' | 'error' | 'ready'>('loading');
  const [name, setName] = useState('');
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sel, setSel] = useState<Selection>({ generic: [], character: [] });
  const [previews, setPreviews] = useState<Record<number, string | null>>({});
  const [saving, setSaving] = useState(false); const [message, setMessage] = useState('');
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(async () => {
    const [p, s] = await Promise.all([api<{ name: string }>(base), api<{ selection: Selection; scenes: Scene[]; previews?: { assets: Record<number, string | null> } }>(`${base}/broll-selection`)]);
    if (s.status === 404) { setState('off'); return; }
    if (!p.ok || !s.ok) { setState('error'); return; }
    setName(p.data.name ?? ''); setScenes(s.data.scenes); setSel(s.data.selection); setPreviews(s.data.previews?.assets ?? {}); setState('ready');
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback((next: Selection) => {
    setSel(next); setMessage(''); setSaving(true);
    queue.current = queue.current.then(async () => {
      const r = await api<{ selection: Selection }>(`${base}/broll-selection`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generic: next.generic.map(({ clipId, screenId }) => ({ clipId, screenId })), character: next.character.map(({ assetId, screenId, action }) => ({ assetId, screenId, action })) }) });
      if (r.ok) setSel(r.data.selection); else { setMessage(r.data.error ?? 'That could not be saved.'); await load(); }
      setSaving(false);
    });
  }, [base, load]);

  /** Sets exactly which scenes a clip is used in. */
  const setClipScenes = (clipId: number, screenIds: number[]) => save({ ...sel, generic: [...sel.generic.filter((g) => g.clipId !== clipId || screenIds.includes(g.screenId)), ...screenIds.filter((sid) => !sel.generic.some((g) => g.clipId === clipId && g.screenId === sid)).map((screenId) => ({ clipId, screenId }))] });
  /** Sets exactly which scenes an image is used in; new picks get `action` (what the character does). */
  const setAssetScenes = (assetIds: number[], screenIds: number[], action: string, replace: boolean) => {
    let character = sel.character;
    if (replace) character = character.filter((c) => !assetIds.includes(c.assetId) || screenIds.includes(c.screenId));
    for (const assetId of assetIds) for (const screenId of screenIds) if (!character.some((c) => c.assetId === assetId && c.screenId === screenId)) character = [...character, { assetId, screenId, action }];
    save({ ...sel, character });
  };
  const removeClip = (clipId: number, screenId: number) => save({ ...sel, generic: sel.generic.filter((g) => !(g.clipId === clipId && g.screenId === screenId)) });
  const removeAsset = (assetId: number, screenId: number) => save({ ...sel, character: sel.character.filter((c) => !(c.assetId === assetId && c.screenId === screenId)) });
  return { base, state, name, scenes, sel, previews, saving, message, save, setClipScenes, setAssetScenes, removeClip, removeAsset, reload: load };
}
