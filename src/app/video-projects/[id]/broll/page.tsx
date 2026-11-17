'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';
import CharacterSelect from '@/components/broll/CharacterSelect';
import GenericSelect from '@/components/broll/GenericSelect';
import { useBrollSelection } from '@/components/broll/useBrollSelection';
import { api, C } from '@/components/composition/types';
import { api as studioApi, type StudioAsset, type StudioPack } from '@/lib/studio/client';
import { workflowSteps } from '@/lib/steps';
import { ArrowLeft, Check, ChevronRight, Film, Plus, UserRound } from 'lucide-react';

/**
 * Step 3, B-roll. It opens on two choices, Generic B-roll (library clips) and Character B-roll (Scene Pack images), each optional. Inside a choice the
 * screen becomes the library / Studio style picker, with the script beside it and the matches for it first. Picks are saved as you go, are kept when
 * you move between the two, and each is tied to the scene you choose. Nothing is generated or charged here.
 */
export default function BrollPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const view = params.get('view');
  const b = useBrollSelection(id);
  const [clipUrls, setClipUrls] = useState<Record<number, string | null>>({}); const [clipThumbs, setClipThumbs] = useState<string[]>([]); const [packThumbs, setPackThumbs] = useState<string[]>([]);

  // A few real items for the two cards' pictures (no choice is made by showing them).
  useEffect(() => {
    api<Array<{ id: number; signedUrl: string | null }>>('/api/v1/broll').then((r) => { if (!r.ok) return; const list = r.data as unknown as Array<{ id: number; signedUrl: string | null }>; setClipThumbs(list.map((c) => c.signedUrl).filter((u): u is string => !!u).slice(0, 4)); setClipUrls(Object.fromEntries(list.map((c) => [c.id, c.signedUrl]))); });
    void (async () => { try {
      const packs = (await studioApi<{ packs: StudioPack[] }>('/api/v1/studio/packs')).packs.filter((p) => !p.archivedAt && p.assetCount > 0);
      const first = packs[0]; if (!first) return;
      const r = await studioApi<{ assets: StudioAsset[] }>(`/api/v1/studio/packs/${first.id}/assets?limit=4`);
      setPackThumbs(r.assets.map((a) => a.thumbUrl).filter((u): u is string => !!u).slice(0, 4));
    } catch { /* the cards still work without pictures */ } })();
  }, []);

  const steps = workflowSteps('B-roll');
  const go = (v: string | null) => router.push(v ? `/video-projects/${id}/broll?view=${v}` : `/video-projects/${id}/broll`);
  if (b.state === 'loading') return <AppShell><div className="page-body"><div className="skeleton" style={{ height: 28, width: '40%' }} /></div></AppShell>;
  if (b.state !== 'ready') return <AppShell><div className="page-body" style={{ maxWidth: 560 }}><h1 style={{ font: '700 22px/1.2 Satoshi' }}>{b.state === 'off' ? 'B-roll is not turned on' : 'Could not load this step'}</h1><p style={{ font: '400 14px/1.5 Satoshi', color: C.muted }}>{b.state === 'off' ? 'Continue to scene generation.' : 'Reload the page to try again.'}</p><a href={`/video-projects/${id}/screens/1`}>Continue</a></div></AppShell>;

  const nGen = b.sel.generic.length; const nChar = b.sel.character.length;
  const header = <ProjectHeader projectId={id} projectName={b.name} steps={steps} statusLabel={view === 'generic' ? 'Generic B-roll' : view === 'character' ? 'Character B-roll' : 'Choose B-roll'} />;

  if (view === 'generic' || view === 'character') {
    return (
      <AppShell>
        {header}
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid #ECECE8', background: '#fff' }}>
          <button onClick={() => go(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'none', cursor: 'pointer', font: '500 13px/1 Satoshi', color: C.muted }}><ArrowLeft size={14} /> B-roll</button>
          <span style={{ color: '#C4C4C9' }}>/</span><b style={{ font: '700 14px/1 Satoshi' }}>{view === 'generic' ? 'Add Generic B-roll' : 'Add Character B-roll'}</b>
        </div>
        {view === 'generic' ? <GenericSelect b={b} onDone={() => go(null)} /> : <CharacterSelect b={b} onDone={() => go(null)} />}
      </AppShell>
    );
  }

  const sceneNo = (sid: number) => b.scenes.find((x) => x.screenId === sid)?.sceneNumber ?? '?';
  const picks = {
    generic: b.sel.generic.map((g) => ({ key: `g${g.clipId}:${g.screenId}`, url: clipUrls[g.clipId] ?? null, scene: sceneNo(g.screenId), screenId: g.screenId })),
    character: b.sel.character.map((c) => ({ key: `c${c.assetId}:${c.screenId}`, url: b.previews[c.assetId] ?? null, scene: sceneNo(c.screenId), screenId: c.screenId })),
  };
  const sceneTotal = new Set([...picks.generic, ...picks.character].map((p) => p.screenId)).size;
  const tileBox: React.CSSProperties = { aspectRatio: '3/4.2', borderRadius: 12, overflow: 'hidden', position: 'relative', boxSizing: 'border-box' };
  const card = (kind: 'generic' | 'character', title: string, text: string, thumbs: string[], icon: React.ReactNode) => {
    const mine = picks[kind]; const n = mine.length; const on = n > 0;
    const scenesHere = new Set(mine.map((p) => p.screenId)).size;
    const unit = kind === 'generic' ? (n === 1 ? 'clip' : 'clips') : (n === 1 ? 'image' : 'images');
    const shown = n > 4 ? mine.slice(0, 3) : mine; const extra = n > 4 ? n - 3 : 0;
    const emptySlots = on && extra === 0 ? 4 - shown.length : 0;
    const media = (url: string | null) => (url ? (kind === 'generic' ? <video src={`${url}#t=0.5`} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />) : null);
    return (
      <div data-testid={`card-${kind}`} style={{ position: 'relative', background: '#fff', borderRadius: 22, padding: 22, border: on ? '2px solid #6C47FF' : '2px solid transparent', boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(17,17,19,.05)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {on && <span style={{ position: 'absolute', top: -13, right: 20, height: 26, padding: '0 12px', borderRadius: 999, background: '#6C47FF', color: '#fff', font: '700 12px/26px Satoshi', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Check size={13} /> Added to your video</span>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {!on && [0, 1, 2, 3].map((i) => <div key={i} style={{ ...tileBox, background: '#E4E4E0' }}>{thumbs[i] && media(thumbs[i])}</div>)}
          {on && shown.map((p) => <div key={p.key} style={{ ...tileBox, background: '#E4E4E0' }}>{media(p.url)}<span style={{ position: 'absolute', left: 6, bottom: 6, background: '#6C47FF', color: '#fff', font: '700 11px/1 Satoshi', padding: '4px 7px', borderRadius: 6 }}>Scene {p.scene}</span></div>)}
          {on && extra > 0 && <button onClick={() => go(kind)} aria-label={`${extra} more, review`} style={{ ...tileBox, border: '2px dashed #B7A6FF', background: '#F5F3FF', color: '#6C47FF', font: '700 20px/1 Satoshi', cursor: 'pointer' }}>+{extra}<br /><span style={{ font: '500 11px/1.4 Satoshi' }}>more</span></button>}
          {Array.from({ length: emptySlots }).map((_, i) => i === 0
            ? <button key={`e${i}`} onClick={() => go(kind)} aria-label={`Add more ${kind} B-roll`} style={{ ...tileBox, border: '2px dashed #B7A6FF', background: '#F5F3FF', color: '#6C47FF', cursor: 'pointer', display: 'grid', placeItems: 'center', alignContent: 'center', gap: 4, font: '600 12px/1 Satoshi' }}><Plus size={22} />Add</button>
            : <div key={`e${i}`} aria-hidden style={{ ...tileBox, border: '2px dashed #E4E4E0', background: 'transparent' }} />)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{icon}<b style={{ font: '700 20px/1.2 Satoshi' }}>{title}</b><span style={{ flex: 1 }} /><span style={{ font: '600 14px/1 Satoshi', color: on ? '#6C47FF' : C.muted }}>{on ? `${n} ${unit} across ${scenesHere} scene${scenesHere === 1 ? '' : 's'}` : 'None selected'}</span></div>
        <div style={{ font: '400 15px/1.5 Satoshi', color: '#5E5E65', minHeight: 44 }}>{text}</div>
        <button onClick={() => go(kind)} style={{ height: 46, borderRadius: 12, background: '#6C47FF', color: '#fff', border: 'none', font: '700 16px/1 Satoshi', cursor: 'pointer' }}>{on ? 'Review and change' : 'Browse and select'}</button>
      </div>
    );
  };
  return (
    <AppShell>
      {header}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '40px 32px 64px' }}>
          <h1 style={{ margin: 0, font: '700 34px/1.15 Satoshi', letterSpacing: '-0.02em' }}>B-roll</h1>
          <p style={{ margin: '8px 0 20px', font: '400 17px/1.5 Satoshi', color: '#75757C' }}>Optional. Add supporting visuals to your script, from either library or both.</p>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '0 0 28px' }}>
            {[['1', 'Pick B-roll', 'Choose clips or images that match your script.'], ['2', 'Choose its scene', 'Every B-roll plays during one scene of your script.'], ['3', 'It lands on the timeline', 'Placed on that scene automatically. You can move it later.']].map(([n, t, d]) => (
              <div key={n} style={{ flex: '1 1 260px', display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 14, background: '#fff', border: '1px solid #ECECE8' }}>
                <span style={{ width: 24, height: 24, borderRadius: '50%', background: '#EFEBFF', color: '#6C47FF', display: 'grid', placeItems: 'center', font: '700 12px/1 Satoshi', flexShrink: 0 }}>{n}</span>
                <span><b style={{ font: '700 14px/1.3 Satoshi' }}>{t}</b><br /><span style={{ font: '400 13px/1.45 Satoshi', color: '#5E5E65' }}>{d}</span></span>
              </div>
            ))}
          </div>
          <div role="status" style={{ margin: '0 0 22px', font: '600 15px/1.4 Satoshi', color: nGen + nChar ? '#6C47FF' : C.muted }}>{nGen + nChar === 0 ? 'No B-roll chosen yet. You can skip this step.' : `${nGen + nChar} B-roll chosen across ${sceneTotal} scene${sceneTotal === 1 ? '' : 's'}. Nothing is generated or charged yet.`}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 28 }}>
            {card('generic', 'Add Generic B-roll', 'Ready-to-use clips from the Generic B-roll library.', clipThumbs, <Film size={22} />)}
            {card('character', 'Add Character B-roll', 'Pick scenes from the Scene Pack. Your character takes the place of the person in them.', packThumbs, <UserRound size={22} color="#6C47FF" />)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14, marginTop: 32 }}>
            <span style={{ font: '400 13px/1.4 Satoshi', color: C.muted }}>{nGen + nChar === 0 ? 'You can skip B-roll and add it later.' : 'Nothing is generated or charged until you start it on the next screen.'}</span>
            <button onClick={() => router.push(`/video-projects/${id}/screens/1`)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 44, padding: '0 20px', borderRadius: 11, background: '#fff', border: '1px solid #E4E4E0', font: '700 15px/1 Satoshi', cursor: 'pointer' }}>Continue to scenes <ChevronRight size={16} /></button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
