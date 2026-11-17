'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, Sparkles } from 'lucide-react';
import { api } from '@/components/composition/types';
import { searchClips } from '@/lib/broll-search';
import { recommendClips } from '@/lib/broll-recommend';
import { SceneHint, ScenePicker, ScriptRail, Tray, type TrayItem } from './parts';
import type { useBrollSelection } from './useBrollSelection';

interface Clip { id: number; title: string; signedUrl: string | null; durationSeconds: number | null; userTags: string | null; subject: string | null; activity: string | null; setting: string | null; brand: string | null; description: string | null; categoryIds: number[]; brands?: { brandName: string | null; role: string }[]; createdAt: number }
interface Cat { id: number; name: string; slug: string; scope: string; brandScope: string | null; parentId: number | null; sortOrder: number; children: Cat[] }
const tagsOf = (raw: string | null): string[] => { if (!raw) return []; try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; } };
const dur = (s: number | null) => (s ? `0:${String(Math.floor(s)).padStart(2, '0')}` : '');
const flat = (nodes: Cat[]): Cat[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);

/**
 * Generic B-roll selection, laid out like the B-roll library: search, category chips, clip cards. The categories and clips the script points to
 * are highlighted and shown first. They come from the library's own search (its concept lexicon, tags and categories), never an AI call.
 * Ticking a clip asks which scene it is for. Nothing is generated here.
 */
export default function GenericSelect({ b, onDone, initialFocus = null }: { b: ReturnType<typeof useBrollSelection>; onDone: () => void; initialFocus?: number | null }) {
  const { scenes, sel, saving, message, save, setClipScenes, removeClip } = b;
  const [clips, setClips] = useState<Clip[] | null>(null); const [cats, setCats] = useState<Cat[]>([]);
  const [q, setQ] = useState(''); const [catId, setCatId] = useState<number | null>(null); const [focus, setFocus] = useState<number | null>(initialFocus);
  const [picker, setPicker] = useState<Clip | null>(null);

  useEffect(() => {
    api<Clip[]>('/api/v1/broll').then((r) => r.ok && setClips(r.data as unknown as Clip[]));
    api<unknown>('/api/v1/broll/categories').then((r) => { const d = r.data as unknown; setCats((Array.isArray(d) ? d : (d as { categories?: Cat[] })?.categories ?? []) as Cat[]); }).catch(() => undefined);
  }, []);
  const all = useMemo(() => flat(cats), [cats]);
  const topOf = useMemo(() => { const parent = new Map(all.map((c) => [c.id, c.parentId])); return (id: number): number => { let cur = id; for (let i = 0; i < 8; i++) { const p = parent.get(cur); if (p == null) return cur; cur = p; } return cur; }; }, [all]);
  const descendants = (c: Cat): number[] => [c.id, ...(c.children ?? []).flatMap(descendants)];

  // What the script points to (see lib/broll-recommend.ts): the clips, and the top-level categories those clips belong to.
  const rec = useMemo(() => {
    const list = clips ? recommendClips(scenes.filter((x) => focus === null || x.screenId === focus), clips, all) : [];
    const catScore = new Map<number, number>();
    for (const e of list) for (const cid of e.clip.categoryIds ?? []) { const t = topOf(cid); catScore.set(t, (catScore.get(t) ?? 0) + 1); }
    return { clips: list, cats: catScore };
  }, [clips, scenes, focus, all, topOf]);

  const top = useMemo(() => cats.filter((c) => c.parentId == null).sort((a, b2) => (rec.cats.get(b2.id) ?? 0) - (rec.cats.get(a.id) ?? 0) || a.sortOrder - b2.sortOrder), [cats, rec]);
  const activeCat = top.find((c) => c.id === catId) ?? null;
  const shown = useMemo(() => {
    if (!clips) return [];
    let list = q.trim() ? searchClips(q, clips, all).hits.map((h) => h.clip) : clips;
    if (activeCat) { const ids = new Set(descendants(activeCat)); list = list.filter((c) => (c.categoryIds ?? []).some((x) => ids.has(x))); }
    return list;
  }, [clips, q, activeCat, all]);
  const recIds = new Set(rec.clips.map((r) => r.clip.id));

  const counts: Record<number, number> = {}; for (const g of sel.generic) counts[g.screenId] = (counts[g.screenId] ?? 0) + 1;
  const sceneNo = (sid: number) => scenes.find((s) => s.screenId === sid)?.sceneNumber ?? '?';
  const clipOf = (id: number) => clips?.find((c) => c.id === id);
  const tray: TrayItem[] = sel.generic.map((g) => ({ key: `${g.clipId}:${g.screenId}`, url: clipOf(g.clipId)?.signedUrl ?? null, kind: 'video', sceneNumber: sceneNo(g.screenId), onRemove: () => removeClip(g.clipId, g.screenId) }));
  const chip = (label: string, active: boolean, recommended: boolean, onClick: () => void) => (
    <button key={label} onClick={onClick} aria-pressed={active} style={{ height: 38, padding: '0 16px', borderRadius: 10, border: active ? '2px solid #6C47FF' : recommended ? '1.5px solid #B7A6FF' : '1px solid #E4E4E0', background: active ? '#fff' : recommended ? '#F5F3FF' : '#fff', font: '500 14px/1 Satoshi', cursor: 'pointer', color: '#111113', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {recommended && <Sparkles size={13} color="#6C47FF" />}{label}
    </button>
  );
  const card = (clip: Clip, note?: string) => <ClipCard key={clip.id} clip={clip} note={note} scenes={sel.generic.filter((g) => g.clipId === clip.id).map((g) => g.screenId)} sceneNo={sceneNo} onOpen={() => setPicker(clip)} />;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ScriptRail scenes={scenes} counts={counts} focus={focus} onFocus={setFocus} />
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '20px 24px 40px' }}>
          <SceneHint scene={scenes.find((x) => x.screenId === focus) ?? null} onClear={() => setFocus(null)} />
          <div style={{ position: 'relative', maxWidth: 560, marginBottom: 16 }}>
            <Search size={16} color="#9A9AA0" style={{ position: 'absolute', left: 14, top: 13 }} />
            <input aria-label="Search the B-roll library" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clips, tags or categories…" style={{ width: '100%', boxSizing: 'border-box', height: 42, borderRadius: 10, border: '1px solid #E4E4E0', padding: '0 14px 0 40px', font: '400 14px/1 Satoshi', background: '#fff' }} />
          </div>
          {message && <div role="alert" style={{ padding: '10px 14px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', font: '500 13px/1.4 Satoshi', marginBottom: 12 }}>{message}</div>}
          <div style={{ font: '600 12px/1 Satoshi', color: '#75757C', marginBottom: 9 }}>Browse categories</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
            {chip('All clips', catId === null, false, () => setCatId(null))}
            {top.map((c) => chip(c.name, catId === c.id, rec.cats.has(c.id), () => setCatId(catId === c.id ? null : c.id)))}
          </div>

          {rec.clips.length > 0 && !q.trim() && (
            <section style={{ marginBottom: 28 }}>
              <div style={{ font: '700 16px/1.3 Satoshi', marginBottom: 4 }}><Sparkles size={15} color="#6C47FF" style={{ verticalAlign: -2 }} /> Recommended for {focus === null ? 'your script' : `Scene ${sceneNo(focus)}`}</div>
              <div style={{ font: '400 12px/1.4 Satoshi', color: '#75757C', marginBottom: 12 }}>Matched on the words in your script. Nothing is chosen for you.</div>
              <Grid>{rec.clips.filter((r) => !activeCat || (r.clip.categoryIds ?? []).some((x) => descendants(activeCat).includes(x))).map((r) => card(r.clip, `fits: ${r.why.slice(0, 2).join(', ')}`))}</Grid>
            </section>
          )}
          <div style={{ font: '700 16px/1.3 Satoshi', marginBottom: 12 }}>{activeCat ? activeCat.name : q.trim() ? 'Search results' : 'All clips'}</div>
          {clips === null && <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>Loading…</div>}
          {clips && shown.length === 0 && <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>No clips match.</div>}
          <Grid>{shown.filter((c) => !(recIds.has(c.id) && !q.trim() && !activeCat && rec.clips.length > 0)).map((c) => card(c))}</Grid>
        </div>
      </div>
      <Tray items={tray} saving={saving} onClear={() => save({ ...sel, generic: [] })} onDone={onDone} doneLabel={sel.generic.length ? `Add ${sel.generic.length} to project` : 'Done'} />
      {picker && (
        <ScenePicker title={picker.title} subtitle={dur(picker.durationSeconds) ? `${dur(picker.durationSeconds)} · library clip` : 'Library clip'} thumb={{ kind: 'video', url: picker.signedUrl }} scenes={scenes}
          initial={(() => { const e = sel.generic.filter((g) => g.clipId === picker.id).map((g) => g.screenId); return e.length || !focus ? e : [focus]; })()} suggested={rec.clips.find((r) => r.clip.id === picker.id)?.scenes ?? []} withAction={false} initialAction=""
          onSave={(screens) => setClipScenes(picker.id, screens)} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}

const Grid = ({ children }: { children: React.ReactNode }) => <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 16 }}>{children}</div>;

/** A library card (plays on hover), with a tick and the scene(s) it is chosen for. Clicking it asks which scene. */
function ClipCard({ clip, note, scenes, sceneNo, onOpen }: { clip: Clip; note?: string; scenes: number[]; sceneNo: (id: number) => number | string; onOpen: () => void }) {
  const v = useRef<HTMLVideoElement>(null); const on = scenes.length > 0;
  const tags = tagsOf(clip.userTags).slice(0, 3);
  return (
    <div role="button" tabIndex={0} aria-pressed={on} aria-label={`${on ? 'Change' : 'Choose'} ${clip.title}`} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      onMouseEnter={() => { v.current?.play().catch(() => {}); }} onMouseLeave={() => { if (v.current) { v.current.pause(); v.current.currentTime = 0; } }}
      style={{ background: '#fff', border: on ? '2px solid #6C47FF' : '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden', cursor: 'pointer', boxSizing: 'border-box' }}>
      <div style={{ position: 'relative', width: '100%', aspectRatio: '9/16', background: '#111113' }}>
        {clip.signedUrl && <video ref={v} src={clip.signedUrl} muted loop playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
        <span style={{ position: 'absolute', top: 8, left: 8, width: 22, height: 22, borderRadius: 6, background: on ? '#6C47FF' : 'rgba(0,0,0,0.35)', border: `1.5px solid ${on ? '#6C47FF' : 'rgba(255,255,255,0.85)'}`, color: '#fff', display: 'grid', placeItems: 'center' }}>{on && <Check size={14} />}</span>
        {clip.durationSeconds ? <span style={{ position: 'absolute', bottom: 8, right: 8, background: 'rgba(0,0,0,.55)', color: '#fff', font: '500 11px/1 Satoshi', padding: '4px 7px', borderRadius: 6 }}>{dur(clip.durationSeconds)}</span> : null}
        {on && <span style={{ position: 'absolute', bottom: 8, left: 8, background: '#6C47FF', color: '#fff', font: '600 10px/1 Satoshi', padding: '4px 6px', borderRadius: 6 }}>{scenes.length === 1 ? `Scene ${sceneNo(scenes[0])}` : `${scenes.length} scenes`}</span>}
      </div>
      <div style={{ padding: '10px 12px 12px' }}>
        <div style={{ font: '600 14px/1.35 Satoshi', color: '#111113', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{clip.title}</div>
        {note && <div style={{ font: '500 11px/1.3 Satoshi', color: '#6C47FF', marginTop: 4 }}>{note}</div>}
        {tags.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{tags.map((t) => <span key={t} style={{ padding: '4px 9px', borderRadius: 8, background: '#F0F0EC', font: '500 12px/1 Satoshi', color: '#3D3D45' }}>{t}</span>)}</div>}
      </div>
    </div>
  );
}
