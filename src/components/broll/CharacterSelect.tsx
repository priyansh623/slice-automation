'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { post } from '@/components/composition/types';
import { CodeChip, TileChip, smallBtn } from '@/components/studio/ui/ds';
import { api as studioApi, type StudioAsset, type StudioPack } from '@/lib/studio/client';
import { chipOf, codeOf } from '@/lib/studio/ui';
import { SceneHint, ScenePicker, ScriptRail, Tray, type TrayItem } from './parts';
import type { useBrollSelection } from './useBrollSelection';

interface Rec { packId: number; name: string; score: number; reasons: string[]; moments: string[] }
const words = (t: string) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);
const bg = (url: string | null | undefined) => (url ? `#E4E4E0 url("${url}") center top/cover no-repeat` : '#E4E4E0');

/**
 * Character B-roll selection, laid out like the Studio's Select step: the script on the left, the Scene Packs the script points to first (with a
 * Recommended badge), then every other pack. Ticking an image asks which scene it is for. Nothing is generated here.
 */
export default function CharacterSelect({ b, onDone, initialFocus = null }: { b: ReturnType<typeof useBrollSelection>; onDone: () => void; initialFocus?: number | null }) {
  const { base, scenes, sel, saving, message, save, setAssetScenes, removeAsset } = b;
  const [packs, setPacks] = useState<StudioPack[]>([]); const [assets, setAssets] = useState<Record<number, StudioAsset[]>>({});
  const [recs, setRecs] = useState<Rec[] | null>(null); const [recState, setRecState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [focus, setFocus] = useState<number | null>(initialFocus);
  const [picker, setPicker] = useState<null | { assetIds: number[]; title: string; subtitle?: string; thumb: string | null; packId: number }>(null);
  const [error, setError] = useState('');

  const [loadingPacks, setLoadingPacks] = useState<Set<number>>(new Set());
  // Every pack is shown at once and each fills in as its own images arrive (a big pack no longer holds the others back).
  useEffect(() => {
    void (async () => {
      try {
        const list = (await studioApi<{ packs: StudioPack[] }>('/api/v1/studio/packs')).packs.filter((p) => !p.archivedAt);
        setPacks(list); setLoadingPacks(new Set(list.map((p) => p.id)));
        await Promise.all(list.map(async (p) => {
          try {
            const all: StudioAsset[] = []; let after: number | null = null;
            do {
              const q = new URLSearchParams({ limit: '200' }); if (after) q.set('after', String(after));
              const r: { assets: StudioAsset[]; nextCursor: number | null } = await studioApi(`/api/v1/studio/packs/${p.id}/assets?${q}`);
              all.push(...r.assets.filter((a) => !a.archived)); after = r.nextCursor;
              setAssets((prev) => ({ ...prev, [p.id]: [...all] }));
            } while (after);
          } catch (e) { setError(`Could not load the images of ${p.name}: ${(e as Error).message}`); }
          setLoadingPacks((prev) => { const n = new Set(prev); n.delete(p.id); return n; });
        }));
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);
  // The script is read once (the existing Studio recommender; the stored answer is reused while the script is unchanged).
  useEffect(() => {
    void post(`${base}/broll-selection/recommendations`).then((r) => { if (r.ok) { setRecs((r.data as { recommendations: Rec[] }).recommendations); setRecState('ready'); } else setRecState('unavailable'); }).catch(() => setRecState('unavailable'));
  }, [base]);

  const focusScene = scenes.find((s) => s.screenId === focus) ?? null;
  const fits = (r: Rec, dialogue: string) => { const w = words(dialogue); return r.moments.some((m) => [...words(m)].some((x) => w.has(x))); };
  const suggestedScenes = (packId: number): number[] => { const r = recs?.find((x) => x.packId === packId); return r ? scenes.filter((s) => fits(r, s.dialogue)).map((s) => s.screenId) : []; };
  const sections = useMemo(() => {
    const recIds = new Set((recs ?? []).map((r) => r.packId));
    const hot = (recs ?? []).filter((r) => packs.some((p) => p.id === r.packId)).sort((a, b) => (focusScene ? Number(fits(b, focusScene.dialogue)) - Number(fits(a, focusScene.dialogue)) : 0) || b.score - a.score);
    return [...hot.map((r) => ({ pack: packs.find((p) => p.id === r.packId)!, rec: r })), ...packs.filter((p) => !recIds.has(p.id)).map((p) => ({ pack: p, rec: null as Rec | null }))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packs, recs, focus]);
  const firstOther = sections.findIndex((s) => !s.rec);
  const byId = useMemo(() => new Map(Object.values(assets).flat().map((a) => [a.id, a])), [assets]);
  const counts: Record<number, number> = {}; for (const c of sel.character) counts[c.screenId] = (counts[c.screenId] ?? 0) + 1;
  const sceneNo = (sid: number) => scenes.find((s) => s.screenId === sid)?.sceneNumber ?? '?';
  const tray: TrayItem[] = sel.character.map((c) => ({ key: `${c.assetId}:${c.screenId}`, url: byId.get(c.assetId)?.thumbUrl ?? null, kind: 'image', sceneNumber: sceneNo(c.screenId), onRemove: () => removeAsset(c.assetId, c.screenId) }));
  const started = (assetId: number, screenId: number) => sel.character.find((c) => c.assetId === assetId && c.screenId === screenId)?.itemId !== undefined;

  const open = (a: StudioAsset, packId: number) => setPicker({ assetIds: [a.id], title: codeOf(a), subtitle: a.originalFilename ?? undefined, thumb: a.thumbUrl, packId });
  const pk = picker ? picker : null;
  const existing = pk && pk.assetIds.length === 1 ? sel.character.filter((c) => c.assetId === pk.assetIds[0]).map((c) => c.screenId) : [];
  const pickerInitial = existing.length || !focus ? existing : [focus];
  const pickerAction = pk && pk.assetIds.length === 1 ? sel.character.find((c) => c.assetId === pk.assetIds[0])?.action ?? '' : '';

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ScriptRail scenes={scenes} counts={counts} focus={focus} onFocus={setFocus} />
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '16px 20px 40px' }}>
          <SceneHint scene={focusScene} onClear={() => setFocus(null)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', font: '500 13px/1.4 Satoshi', color: '#5E5E65' }}>
            {recState === 'loading' ? <><Loader2 size={14} className="spin" /> Finding the Scene Packs your script points to…</> : recState === 'unavailable' ? 'Recommendations are not available right now. Every pack is below.' : <><Sparkles size={14} color="#6C47FF" /> Recommended packs come first. Nothing is chosen for you.</>}
          </div>
          {error && <div role="alert" style={{ padding: '10px 14px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', font: '500 13px/1.4 Satoshi', marginBottom: 12 }}>{error}</div>}
          {message && <div role="alert" style={{ padding: '10px 14px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', font: '500 13px/1.4 Satoshi', marginBottom: 12 }}>{message}</div>}
          {packs.length === 0 && !error && <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>Loading…</div>}
          {sections.map(({ pack, rec }, idx) => {
            const items = assets[pack.id] ?? [];
            const hl = !!(rec && focusScene && fits(rec, focusScene.dialogue));
            return (
              <div key={pack.id} style={{ marginBottom: 12, background: hl ? '#F5F3FF' : 'transparent', borderRadius: 14, padding: 12 }}>
                {idx === firstOther && idx > 0 && <div style={{ font: '600 11px/1 Satoshi', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#9A9AA0', margin: '4px 0 18px' }}>Other packs</div>}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <div style={{ font: '700 16px/1.3 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{pack.name}</div>
                  {rec && <span title={rec.reasons.join(' ')} style={{ height: 20, padding: '0 8px', borderRadius: 999, background: '#EFEBFF', color: '#6C47FF', font: '500 11px/20px Satoshi', whiteSpace: 'nowrap' }}>Recommended</span>}
                  <div style={{ flex: 1 }} />
                  <button disabled={items.length === 0} onClick={() => setPicker({ assetIds: items.map((i) => i.id), title: `All ${items.length} images in ${pack.name}`, thumb: items[0]?.thumbUrl ?? null, packId: pack.id })} style={smallBtn}>Select all</button>
                </div>
                {items.length === 0 && <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C', padding: '4px 0 8px' }}>{loadingPacks.has(pack.id) ? <><Loader2 size={13} className="spin" style={{ verticalAlign: -2 }} /> Loading images…</> : 'No images in this pack.'}</div>}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 12 }}>
                  {items.map((g) => {
                    const mine = sel.character.filter((c) => c.assetId === g.id); const on = mine.length > 0; const c = chipOf(g);
                    return (
                      <div key={g.id} role="button" tabIndex={0} aria-pressed={on} aria-label={`${on ? 'Change' : 'Choose'} ${codeOf(g)}`} onClick={() => open(g, pack.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(g, pack.id); }}
                        style={{ position: 'relative', aspectRatio: '9/16', borderRadius: 14, background: bg(g.thumbUrl), border: `2px solid ${on ? '#6C47FF' : 'transparent'}`, boxSizing: 'border-box', overflow: 'hidden', cursor: 'pointer' }}>
                        <span style={{ position: 'absolute', top: 8, left: 8, width: 22, height: 22, borderRadius: 6, background: on ? '#6C47FF' : 'rgba(0,0,0,0.35)', border: `1.5px solid ${on ? '#6C47FF' : 'rgba(255,255,255,0.85)'}`, color: '#fff', display: 'grid', placeItems: 'center' }}>{on && <Check size={14} />}</span>
                        {c && <TileChip text={c.text} bg={c.bg} fg={c.fg} />}
                        <CodeChip code={codeOf(g)} />
                        {on && <span style={{ position: 'absolute', bottom: 8, right: 8, background: '#6C47FF', color: '#fff', font: '600 10px/1 Satoshi', padding: '4px 6px', borderRadius: 6 }}>{mine.length === 1 ? `Scene ${sceneNo(mine[0].screenId)}` : `${mine.length} scenes`}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Tray items={tray} saving={saving} onClear={() => { if (sel.character.every((c) => c.itemId === undefined)) save({ ...sel, character: [] }); else save({ ...sel, character: sel.character.filter((c) => c.itemId !== undefined) }); }} onDone={onDone} doneLabel={sel.character.length ? `Add ${sel.character.length} to project` : 'Done'} />
      {pk && (
        <ScenePicker title={pk.title} subtitle={pk.subtitle ?? (pk.assetIds.length > 1 ? 'Choose the scene(s) for every image in this pack' : undefined)} thumb={{ kind: 'image', url: pk.thumb }} scenes={scenes}
          initial={pickerInitial} suggested={suggestedScenes(pk.packId)} withAction initialAction={pickerAction}
          onSave={(screens, action) => {
            // a pick that already started on the Generation screen cannot be taken off its scene here
            const keep = pk.assetIds.length === 1 ? [...new Set([...screens, ...existing.filter((sid) => started(pk.assetIds[0], sid))])] : screens;
            setAssetScenes(pk.assetIds, keep, action, pk.assetIds.length === 1);
          }}
          onClose={() => setPicker(null)} />
      )}
      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

