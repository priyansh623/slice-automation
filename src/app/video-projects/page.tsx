'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';

interface VideoProject {
  id: number;
  name: string;
  originalScript: string;
  breakdownApprovedAt: number | null;
  createdAt: number;
  approvedSceneCount: number;
  totalSceneCount: number;
  ownerEmail: string | null;
}

type StatusKey = 'breakdown-review' | 'in-production' | 'ready-to-compile';
type FilterKey = 'all' | 'needs-attention' | 'in-production' | 'compiled';

const FILTER_LABELS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs-attention', label: 'Needs attention' },
  { key: 'in-production', label: 'In production' },
  { key: 'compiled', label: 'Compiled' },
];

function getStatus(p: VideoProject): StatusKey {
  if (!p.breakdownApprovedAt) return 'breakdown-review';
  if (p.totalSceneCount > 0 && p.approvedSceneCount === p.totalSceneCount) return 'ready-to-compile';
  return 'in-production';
}

function getFilterKey(status: StatusKey): FilterKey {
  if (status === 'breakdown-review' || status === 'ready-to-compile') return 'needs-attention';
  return 'in-production';
}

function getStatusPill(key: StatusKey) {
  if (key === 'breakdown-review') return { label: 'Breakdown review', bg: '#F0F0EC', fg: '#111113' };
  if (key === 'ready-to-compile') return { label: 'Ready to compile', bg: '#6C47FF', fg: '#FFFFFF' };
  return { label: 'In production', bg: '#EFEFEC', fg: '#5E5E65' };
}

function initials(email: string | null): string {
  if (!email) return '?';
  const name = email.split('@')[0];
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function ownerName(email: string | null): string {
  if (!email) return '—';
  return email.split('@')[0];
}

// Deterministic tone color per project id
function toneColor(id: number): string {
  const tones = ['#E8E3D8', '#D8E3E8', '#E3D8E8', '#D8E8E3', '#E8DDD8', '#E3E8D8'];
  return tones[id % tones.length];
}

export default function VideoProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');

  useEffect(() => {
    fetch('/api/v1/video-projects')
      .then((r) => r.json())
      .then((data) => { setProjects(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = projects.filter((p) => {
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.ownerEmail || '').toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === 'all' || getFilterKey(getStatus(p)) === filter;
    return matchSearch && matchFilter;
  });

  const countFor = (key: FilterKey) => key === 'all' ? projects.length : projects.filter(p => getFilterKey(getStatus(p)) === key).length;

  return (
    <AppShell>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 1160, margin: '0 auto', padding: '44px 40px 80px' }}>
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
            <div>
              <h1 style={{ margin: 0, font: '700 30px/1.1 Satoshi', letterSpacing: '-0.025em' }}>Projects</h1>
              <p style={{ margin: '8px 0 0', color: '#75757C', font: '400 15px/1.4 Satoshi' }}>
                Start a new UGC video or pick up where you left off.
              </p>
            </div>
            <button
              onClick={() => router.push('/video-projects/new')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 16px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '500 14px/1 Satoshi', cursor: 'pointer', flexShrink: 0 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#5A36E8')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#6C47FF')}
            >
              <i className="icon-plus" style={{ fontSize: 16 }} />
              New project
            </button>
          </div>

          {loading ? (
            <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
              {[1, 2, 3, 4].map((i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.3fr) minmax(0,1.5fr) minmax(0,1.6fr) 110px', gap: 20, alignItems: 'center', padding: 20, borderBottom: i < 4 ? '1px solid #F3F3F1' : 'none', animation: 'pulse 1.4s ease-in-out infinite' }}>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                    <div style={{ width: 34, height: 50, borderRadius: 6, background: '#EFEFEC', flexShrink: 0 }} />
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ height: 12, width: '70%', borderRadius: 4, background: '#EFEFEC' }} />
                    </div>
                  </div>
                  <div style={{ height: 10, borderRadius: 4, background: '#EFEFEC' }} />
                  <div style={{ height: 20, width: 110, borderRadius: 999, background: '#EFEFEC' }} />
                  <div style={{ height: 10, width: 70, borderRadius: 4, background: '#F3F3F1' }} />
                </div>
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '72px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: '#F0F0EC', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
                <i className="icon-clapperboard" style={{ fontSize: 22 }} />
              </div>
              <h2 style={{ margin: 0, font: '700 20px/1.3 Satoshi' }}>Create your first project</h2>
              <p style={{ margin: '8px 0 28px', maxWidth: 440, color: '#75757C', font: '400 14px/1.55 Satoshi' }}>
                Upload a creator reference and paste a UGC script. Soma breaks it into scenes, writes the prompts and generates clips, you review and approve every one.
              </p>
              <button
                onClick={() => router.push('/video-projects/new')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 16px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '500 14px/1 Satoshi', cursor: 'pointer' }}
              >
                <i className="icon-plus" style={{ fontSize: 16 }} />
                New project
              </button>
            </div>
          ) : (
            <>
              {/* Search + filter */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <div style={{ position: 'relative', width: 300 }}>
                  <i className="icon-search" style={{ position: 'absolute', left: 12, top: 10, fontSize: 15, color: '#A3A3A9' }} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search projects or creators"
                    style={{ width: '100%', height: 36, border: '1px solid #E4E4E0', borderRadius: 9, padding: '0 12px 0 34px', font: '400 14px/1 Satoshi', background: '#fff', outline: 'none' }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                  />
                </div>
                <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 10, background: '#EFEFEC' }}>
                  {FILTER_LABELS.map((f) => {
                    const active = filter === f.key;
                    const count = countFor(f.key);
                    return (
                      <button
                        key={f.key}
                        onClick={() => setFilter(f.key)}
                        style={{
                          height: 30, padding: '0 12px', border: 'none', borderRadius: 7,
                          background: active ? '#fff' : 'transparent',
                          color: active ? '#111113' : '#75757C',
                          font: '500 13px/1 Satoshi', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 6,
                          boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        }}
                      >
                        {f.label}
                        <span style={{ color: active ? '#9A9AA0' : '#A3A3A9' }}>{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Table */}
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
                {/* Header row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.4fr) minmax(0,1.2fr) minmax(0,1.5fr) minmax(0,1.3fr) 20px', gap: 20, padding: '12px 20px', borderBottom: '1px solid #F0F0EE', font: '500 12px/1 Satoshi', color: '#9A9AA0' }}>
                  <span>Project</span>
                  <span>Owner</span>
                  <span>Progress</span>
                  <span>Status</span>
                  <span />
                </div>

                {/* Data rows */}
                {filtered.length === 0 ? (
                  <div style={{ padding: '48px 20px', textAlign: 'center', color: '#75757C', font: '400 14px/1.5 Satoshi' }}>
                    No projects match your search or filter.
                  </div>
                ) : (
                  filtered.map((p, i) => {
                    const statusKey = getStatus(p);
                    const pill = getStatusPill(statusKey);
                    const pct = p.totalSceneCount > 0 ? Math.round((p.approvedSceneCount / p.totalSceneCount) * 100) : 0;
                    const barColor = statusKey === 'ready-to-compile' ? '#6C47FF' : '#111113';

                    return (
                      <div
                        key={p.id}
                        onClick={() => router.push(`/video-projects/${p.id}`)}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0,2.4fr) minmax(0,1.2fr) minmax(0,1.5fr) minmax(0,1.3fr) 20px',
                          gap: 20,
                          alignItems: 'center',
                          padding: '16px 20px',
                          borderBottom: i < filtered.length - 1 ? '1px solid #F3F3F1' : 'none',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFAF8')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        {/* Project col: thumbnail + name */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                          <div style={{
                            width: 34, height: 50, flexShrink: 0, borderRadius: 6,
                            backgroundColor: toneColor(p.id),
                            backgroundImage: 'repeating-linear-gradient(135deg,rgba(255,255,255,0.06) 0 1px,transparent 1px 7px)',
                          }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ font: '700 15px/1.3 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {p.name}
                            </div>
                          </div>
                        </div>

                        {/* Owner col */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{
                            width: 24, height: 24, flexShrink: 0, borderRadius: '50%',
                            background: '#F0F0EC',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            font: '700 10px/1 Satoshi', color: '#3A3A3F',
                          }}>
                            {initials(p.ownerEmail)}
                          </span>
                          <span style={{ font: '500 13px/1.3 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {ownerName(p.ownerEmail)}
                          </span>
                        </div>

                        {/* Progress col: text + bar */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                          <div style={{ font: '500 13px/1 Satoshi' }}>
                            {p.totalSceneCount > 0 ? `${p.approvedSceneCount} / ${p.totalSceneCount} approved` : '—'}
                          </div>
                          {p.totalSceneCount > 0 && (
                            <div style={{ height: 4, borderRadius: 2, background: '#EFEFEC', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 2 }} />
                            </div>
                          )}
                        </div>

                        {/* Status col */}
                        <div>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center',
                            height: 22, padding: '0 9px', borderRadius: 999,
                            font: '500 12px/1 Satoshi',
                            background: pill.bg, color: pill.fg,
                          }}>
                            {pill.label}
                          </span>
                        </div>

                        {/* Chevron */}
                        <i className="icon-chevron-right" style={{ fontSize: 16, color: '#A3A3A9' }} />
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
