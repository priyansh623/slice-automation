'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { alertRed, Modal, Segmented, secondaryBtn, StudioListHeader } from './ui/ds';
import { api, type StudioProject } from '@/lib/studio/client';
import { initialsOf, projectInfo } from '@/lib/studio/ui';

const GRID = 'minmax(0,2.4fr) minmax(0,1.2fr) minmax(0,1.5fr) minmax(130px,1.3fr) 20px 32px';

/** Studio > Projects (supplied design): search, segmented filter, table, delete confirmation. */
export default function ProjectsList() {
  const router = useRouter();
  const [projects, setProjects] = useState<StudioProject[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'attn' | 'prod' | 'saved'>('all');
  const [delId, setDelId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ projects: StudioProject[] }>('/api/v1/studio/projects').then((r) => setProjects(r.projects)).catch((e) => { setError((e as Error).message); setProjects([]); });
  useEffect(() => { void load(); }, []);

  const rows = (projects ?? []).map((p) => ({ p, i: projectInfo(p) }));
  const attn = (r: (typeof rows)[number]) => r.i.key === 'attn' || r.i.pill === 'Ready to review';
  const shown = rows.filter((r) => (filter === 'all' || (filter === 'attn' ? attn(r) : r.i.key === filter)) && (!q || (r.p.name + (r.p.ownerEmail ?? '')).toLowerCase().includes(q.toLowerCase())));
  const count = (f: string) => (f === 'all' ? rows.length : rows.filter((r) => (f === 'attn' ? attn(r) : r.i.key === f)).length);
  const del = projects?.find((p) => p.id === delId);

  async function confirmDelete() {
    if (!del || busy) return;
    setBusy(true);
    try { await api(`/api/v1/studio/projects/${del.id}`, { method: 'PUT', body: { archived: true } }); setDelId(null); await load(); }
    catch (e) { setError((e as Error).message); setDelId(null); } finally { setBusy(false); }
  }

  return (
    <AppShell fullscreen>
      <main className="stu-scope" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <StudioListHeader tab="projects" onProjects={() => {}} onRepository={() => router.push('/studio/repository')} action={{ label: 'New project', icon: '+', onClick: () => router.push('/studio/new') }} />
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ maxWidth: 1160, width: '100%', margin: '0 auto', padding: '44px 40px 140px', boxSizing: 'border-box' }}>
            <h1 style={{ margin: 0, font: '700 30px/1.1 Satoshi', letterSpacing: '-0.025em' }}>Projects</h1>
            <p style={{ margin: '8px 0 28px', color: '#75757C', font: '400 15px/1.4 Satoshi' }}>Swap your character into Scene Pack images.</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <input className="stu-focus" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects or creators" style={{ width: 300, height: 36, border: '1px solid #E4E4E0', borderRadius: 9, padding: '0 12px', font: '400 14px/1 Satoshi', background: '#fff', outline: 'none', boxSizing: 'border-box' }} />
              <Segmented items={([['all', 'All'], ['attn', 'Needs attention'], ['prod', 'In production'], ['saved', 'Saved']] as const).map(([k, label]) => ({ label, count: count(k), active: filter === k, onClick: () => setFilter(k) }))} />
            </div>
            {error && <div role="alert" style={{ ...alertRed, marginBottom: 14 }}>{error}</div>}
            <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 20, padding: '12px 20px', borderBottom: '1px solid #F0F0EE', font: '500 12px/1 Satoshi', color: '#9A9AA0' }}><span>Project</span><span>Owner</span><span>Progress</span><span>Status</span><span /><span /></div>
              {projects === null && <div style={{ padding: '16px 20px', font: '400 13px/1.5 Satoshi', color: '#75757C' }}>Loading…</div>}
              {projects !== null && shown.length === 0 && <div style={{ padding: '16px 20px', font: '400 13px/1.5 Satoshi', color: '#75757C' }}>{rows.length === 0 ? 'No projects yet. Create one to start.' : 'No projects match.'}</div>}
              {shown.map(({ p, i }) => (
                <div key={p.id} className="stu-row" onClick={() => router.push(`/studio/${p.id}`)} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 20, alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #F3F3F1', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                    <div style={{ width: 34, height: 50, flexShrink: 0, borderRadius: 6, background: p.characterThumbUrl ? `#E4E4E0 url('${p.characterThumbUrl}') center top/cover no-repeat` : '#E4E4E0' }} />
                    <div style={{ font: '700 15px/1.3 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 24, height: 24, borderRadius: '50%', background: '#F0F0EC', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '700 10px/1 Satoshi', color: '#3A3A3F' }}>{initialsOf(p.ownerEmail)}</span>
                    <span style={{ font: '500 13px/1.3 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.ownerEmail ? p.ownerEmail.split('@')[0] : '-'}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    <div style={{ font: '500 13px/1 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.progress}</div>
                    <div style={{ height: 4, borderRadius: 2, background: '#EFEFEC', overflow: 'hidden' }}><div style={{ height: '100%', width: `${i.pct}%`, background: i.bar }} /></div>
                  </div>
                  <div><span style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 9px', borderRadius: 999, font: '500 12px/1 Satoshi', whiteSpace: 'nowrap', background: i.pillBg, color: i.pillFg }}>{i.pill}</span></div>
                  <span style={{ color: '#A3A3A9' }}>›</span>
                  <button className="stu-trash" onClick={(e) => { e.stopPropagation(); setDelId(p.id); }} title="Archive project" style={{ width: 32, height: 32, borderRadius: 8, background: 'transparent', border: '1px solid transparent', color: '#C4C4CC', cursor: 'pointer', fontSize: 15, padding: 0 }}>🗑</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
      {del && (
        <Modal width={380} onClose={() => setDelId(null)}>
          <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 8 }}>Archive project?</div>
          <div style={{ font: '400 14px/1.55 Satoshi', color: '#5E5E65', marginBottom: 24 }}>“{del.name}” will be archived and removed from this list. Its selections and generated outputs are kept, and source images in the Repository are not affected. Nothing is permanently deleted.</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="stu-ghost" onClick={() => setDelId(null)} style={secondaryBtn}>Cancel</button>
            <button onClick={() => void confirmDelete()} disabled={busy} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#DC2626', color: '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: 'pointer' }}>Archive</button>
          </div>
        </Modal>
      )}
    </AppShell>
  );
}
