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

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M12 5v14M5 12h14"/>
    </svg>
  );
}

function IconFilm() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="40" height="40">
      <rect x="2" y="2" width="20" height="20" rx="3"/>
      <path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>
    </svg>
  );
}

function StatusPill({ project }: { project: VideoProject }) {
  const approved = project.approvedSceneCount;
  const total = project.totalSceneCount;

  if (!project.breakdownApprovedAt) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 10px', borderRadius: 999,
        fontSize: 12, fontWeight: 500,
        color: '#111113', background: '#F0F0EC',
      }}>
        Setup
      </span>
    );
  }
  if (total > 0 && approved === total) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 10px', borderRadius: 999,
        fontSize: 12, fontWeight: 500,
        color: '#6C47FF', background: '#EFEBFF',
      }}>
        Complete
      </span>
    );
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 999,
      fontSize: 12, fontWeight: 500,
      color: '#6C47FF', background: '#EFEBFF',
    }}>
      In progress
    </span>
  );
}

function ProgressBar({ approved, total }: { approved: number; total: number }) {
  if (total === 0) return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>;
  const pct = Math.round((approved / total) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', maxWidth: 80 }}>
        <div style={{ height: '100%', background: 'var(--brand)', borderRadius: 2, width: `${pct}%`, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
        {approved}/{total}
      </span>
    </div>
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
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
            Projects
          </h1>
        </div>
        <Link href="/video-projects/new">
          <button className="btn btn-primary">
            <IconPlus />
            New Project
          </button>
        </Link>
      </div>

      <div className="page-body" style={{ maxWidth: 1160 }}>
        {loading && (
          <div className="card" style={{ overflow: 'hidden' }}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={{ padding: '16px 24px', borderBottom: i < 3 ? '1px solid var(--border-row)' : 'none', display: 'flex', gap: 24 }}>
                <div className="skeleton" style={{ height: 14, width: '30%' }} />
                <div className="skeleton" style={{ height: 14, width: '12%', marginLeft: 'auto' }} />
                <div className="skeleton" style={{ height: 14, width: '10%' }} />
                <div className="skeleton" style={{ height: 14, width: '10%' }} />
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
          <div className="card" style={{ overflow: 'hidden' }}>
            {/* Table header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '2.4fr 1.2fr 1.5fr 1.3fr',
              padding: '12px 24px',
              borderBottom: '1px solid var(--border)',
              gap: 16,
            }}>
              {['Project', 'Created', 'Progress', 'Status'].map((label) => (
                <span key={label} style={{
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                }}>
                  {label}
                </span>
              ))}
            </div>

            {/* Table rows */}
            {projects.map((p, i) => (
              <Link key={p.id} href={`/video-projects/${p.id}`} style={{ display: 'block', textDecoration: 'none' }}>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '2.4fr 1.2fr 1.5fr 1.3fr',
                  padding: '14px 24px',
                  gap: 16,
                  alignItems: 'center',
                  borderBottom: i < projects.length - 1 ? '1px solid var(--border-row)' : 'none',
                  cursor: 'pointer',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFAF8')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
                      {p.name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                      {p.originalScript.slice(0, 60).replace(/\n/g, ' ')}…
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {new Date(p.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </div>
                  <div>
                    <ProgressBar approved={p.approvedSceneCount} total={p.totalSceneCount} />
                  </div>
                  <div>
                    <StatusPill project={p} />
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
