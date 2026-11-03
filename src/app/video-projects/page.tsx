'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';

interface VideoProject {
  id: number;
  name: string;
  originalScript: string;
  breakdownApprovedAt: number | null;
  createdAt: number;
  approvedSceneCount: number;
  totalSceneCount: number;
}

function IconFilm() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="40" height="40">
      <rect x="2" y="2" width="20" height="20" rx="3"/>
      <path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M12 5v14M5 12h14"/>
    </svg>
  );
}

function IconClock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>
  );
}

function IconArrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M5 12h14M12 5l7 7-7 7"/>
    </svg>
  );
}

export default function VideoProjectsPage() {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/v1/video-projects')
      .then((r) => r.json())
      .then((data) => { setProjects(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <AppShell>
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Video Projects</h1>
        </div>
        <Link href="/video-projects/new">
          <button className="btn btn-primary">
            <IconPlus />
            New Project
          </button>
        </Link>
      </div>

      <div className="page-body">
        {loading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="card" style={{ padding: 20, height: 120 }}>
                <div className="skeleton" style={{ height: 16, width: '60%', marginBottom: 12 }} />
                <div className="skeleton" style={{ height: 12, width: '40%', marginBottom: 8 }} />
                <div className="skeleton" style={{ height: 12, width: '30%' }} />
              </div>
            ))}
          </div>
        )}

        {!loading && projects.length === 0 && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">
                <IconFilm />
              </div>
              <p className="empty-state-title">No video projects yet</p>
              <p className="empty-state-desc">Create your first project to start producing UGC video scripts with AI.</p>
              <Link href="/video-projects/new">
                <button className="btn btn-primary">
                  <IconPlus /> New Project
                </button>
              </Link>
            </div>
          </div>
        )}

        {!loading && projects.length > 0 && (
          <div className="project-grid">
            {projects.map((p) => (
              <Link key={p.id} href={`/video-projects/${p.id}`}>
                <div className="project-card">
                  <div>
                    <div className="project-card-name">{p.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                      {p.originalScript.slice(0, 72).replace(/\n/g, ' ')}…
                    </div>
                  </div>
                  <div className="project-card-meta">
                    {p.breakdownApprovedAt ? (
                      <span className="badge badge-green"><span className="dot dot-green" />Breakdown approved</span>
                    ) : (
                      <span className="badge badge-yellow">Breakdown pending</span>
                    )}
                    {p.totalSceneCount > 0 && (
                      <span className="badge badge-gray" style={{ marginLeft: 6 }}>
                        {p.approvedSceneCount}/{p.totalSceneCount} scenes
                        {p.approvedSceneCount === p.totalSceneCount ? ' ✓' : ''}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                      <IconClock /> {new Date(p.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                    <span style={{ color: 'var(--brand)' }}><IconArrow /></span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
