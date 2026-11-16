'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { api, type StudioProject } from '@/lib/studio/client';

/** Character B-roll Studio: every project (shared by all signed-in users). */
export default function StudioProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<StudioProject[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api<{ projects: StudioProject[] }>('/api/v1/studio/projects').then((r) => setProjects(r.projects)).catch((e) => { setError((e as Error).message); setProjects([]); }); }, []);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try { const r = await api<{ project: StudioProject }>('/api/v1/studio/projects', { method: 'POST', body: { name } }); router.push(`/studio/${r.project.id}`); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <AppShell>
      <div className="page-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div style={{ font: '700 24px/1.3 Satoshi' }}>Character B-roll Studio</div>
            <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>Replace the character in scene images with your own. Images come from the <a href="/studio/repository" style={{ color: '#6C47FF' }}>Scene Pack Repository</a>.</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 20, maxWidth: 520 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} placeholder="New project name" aria-label="New project name" style={{ flex: 1, height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px Satoshi' }} />
          <button className="btn btn-primary" onClick={() => void create()} disabled={busy || !name.trim()} style={{ height: 38 }}>{busy ? 'Creating…' : 'Create project'}</button>
        </div>
        {error && <div role="alert" style={{ marginBottom: 14, color: '#991B1B', font: '400 13px Satoshi' }}>{error}</div>}

        {projects === null && <div style={{ color: '#75757C', font: '400 13px Satoshi' }}>Loading…</div>}
        {projects?.length === 0 && <div style={{ color: '#75757C', font: '400 14px/1.6 Satoshi' }}>No projects yet. Create one to start.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
          {projects?.map((p) => (
            <a key={p.id} href={`/studio/${p.id}`} style={{ display: 'flex', gap: 12, padding: 12, border: '1px solid #ECECE8', borderRadius: 12, background: '#fff', textDecoration: 'none', color: 'inherit' }}>
              <div style={{ width: 54, height: 72, borderRadius: 8, background: '#F4F4F0', overflow: 'hidden', flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {p.characterThumbUrl && <img src={p.characterThumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ font: '700 15px/1.3 Satoshi', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                <div style={{ font: '400 12px/1.5 Satoshi', color: '#75757C', marginTop: 3 }}>{p.hasCharacter ? 'Character added' : 'No character yet'} · {p.approvedPackCount ?? 0} pack{p.approvedPackCount === 1 ? '' : 's'}</div>
              </div>
            </a>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
