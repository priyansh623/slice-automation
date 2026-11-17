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
import { ArrowLeft, ChevronRight, Film, UserRound } from 'lucide-react';

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
  const [clipThumbs, setClipThumbs] = useState<string[]>([]); const [packThumbs, setPackThumbs] = useState<string[]>([]);

  // A few real items for the two cards' pictures (no choice is made by showing them).
  useEffect(() => {
    api<Array<{ signedUrl: string | null }>>('/api/v1/broll').then((r) => { if (!r.ok) return; const list = r.data as unknown as Array<{ signedUrl: string | null }>; setClipThumbs(list.map((c) => c.signedUrl).filter((u): u is string => !!u).slice(0, 4)); });
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

  const card = (kind: 'generic' | 'character', title: string, text: string, n: number, thumbs: string[], icon: React.ReactNode) => (
    <div style={{ background: '#fff', borderRadius: 22, padding: 22, boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(17,17,19,.05)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ aspectRatio: '3/4.2', borderRadius: 12, background: '#E4E4E0', overflow: 'hidden' }}>{thumbs[i] && (kind === 'generic' ? <video src={`${thumbs[i]}#t=0.5`} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : <img src={thumbs[i]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />)}</div>)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{icon}<b style={{ font: '700 20px/1.2 Satoshi' }}>{title}</b><span style={{ flex: 1 }} /><span style={{ font: '500 14px/1 Satoshi', color: n ? '#6C47FF' : C.muted }}>{n ? `${n} selected` : 'None selected'}</span></div>
      <div style={{ font: '400 15px/1.5 Satoshi', color: '#5E5E65', minHeight: 44 }}>{text}</div>
      <button onClick={() => go(kind)} style={{ height: 46, borderRadius: 12, background: '#6C47FF', color: '#fff', border: 'none', font: '700 16px/1 Satoshi', cursor: 'pointer' }}>{n ? 'Review and change' : 'Browse and select'}</button>
    </div>
  );
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 28 }}>
            {card('generic', 'Add Generic B-roll', 'Ready-to-use clips from the Generic B-roll library.', nGen, clipThumbs, <Film size={22} />)}
            {card('character', 'Add Character B-roll', 'Pick scenes from the Scene Pack. Your character takes the place of the person in them.', nChar, packThumbs, <UserRound size={22} color="#6C47FF" />)}
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
