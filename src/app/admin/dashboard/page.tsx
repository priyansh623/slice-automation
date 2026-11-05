'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { RefreshCw, AlertCircle, CheckCircle2, Clock, Circle } from 'lucide-react';

type FunnelStep = 'created' | 'breakdown' | 'generating' | 'approving' | 'compile' | 'review';

interface ProjectRow {
  id: number;
  name: string;
  userId: string;
  userEmail: string;
  createdAt: number;
  lastActivityAt: number;
  hasBreakdown: boolean;
  screenCount: number;
  approvedScreenCount: number;
  totalGenerations: number;
  completedGenerations: number;
  failedGenerations: number;
  inFlightGenerations: number;
  lastGenerationError: string | null;
  compilationStatus: string | null;
  compilationError: string | null;
  compilationCreatedAt: number | null;
  funnelStep: FunnelStep;
}

const FUNNEL_LABELS: Record<FunnelStep, string> = {
  created: 'Created',
  breakdown: 'Breakdown',
  generating: 'Generating',
  approving: 'Approving',
  compile: 'Compile',
  review: 'Review ✓',
};

const FUNNEL_COLORS: Record<FunnelStep, { bg: string; fg: string }> = {
  created:    { bg: '#F0F0EC', fg: '#75757C' },
  breakdown:  { bg: '#FEF9C3', fg: '#854D0E' },
  generating: { bg: '#EDE9FE', fg: '#5B21B6' },
  approving:  { bg: '#DBEAFE', fg: '#1E40AF' },
  compile:    { bg: '#FEF3C7', fg: '#92400E' },
  review:     { bg: '#DCFCE7', fg: '#14532D' },
};

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function AdminDashboardPage() {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState<number>(0);
  const [refreshing, setRefreshing] = useState(false);
  const [filterStep, setFilterStep] = useState<FunnelStep | 'all'>('all');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load(quiet = false) {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch('/api/v1/admin/dashboard');
      if (!res.ok) { setError('Failed to load dashboard'); return; }
      setRows(await res.json());
      setLastRefreshed(Date.now());
      setError('');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    intervalRef.current = setInterval(() => load(true), 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const filtered = filterStep === 'all' ? rows : rows.filter((r) => r.funnelStep === filterStep);

  // Counts for the filter chips
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.funnelStep] = (acc[r.funnelStep] ?? 0) + 1;
    return acc;
  }, {});

  // Stat cards
  const stats = [
    { label: 'Total projects', value: rows.length },
    { label: 'Videos compiled', value: rows.filter((r) => r.compilationStatus === 'completed').length },
    { label: 'Active generations', value: rows.reduce((s, r) => s + r.inFlightGenerations, 0) },
    { label: 'Failed generations', value: rows.reduce((s, r) => s + r.failedGenerations, 0) },
  ];

  if (loading) {
    return (
      <AppShell>
        <div style={{ padding: '48px 32px' }}>
          <div className="skeleton" style={{ height: 28, width: 220, marginBottom: 32 }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 32 }}>
            {[0,1,2,3].map((i) => <div key={i} className="skeleton" style={{ height: 80, borderRadius: 12 }} />)}
          </div>
          <div className="skeleton" style={{ height: 400, borderRadius: 14 }} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 32px 80px' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
            <div>
              <h1 style={{ margin: 0, font: '700 24px/1.2 Satoshi', letterSpacing: '-0.02em' }}>Tester Dashboard</h1>
              <div style={{ font: '400 13px/1 Satoshi', color: '#75757C', marginTop: 6 }}>
                {lastRefreshed > 0 && `Last refreshed ${relativeTime(lastRefreshed)}`}
              </div>
            </div>
            <button
              onClick={() => load(true)}
              disabled={refreshing}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: 36, padding: '0 14px', borderRadius: 9,
                background: '#fff', border: '1px solid #E4E4E0',
                font: '500 13px/1 Satoshi', cursor: refreshing ? 'default' : 'pointer',
                color: '#111113',
              }}
            >
              <RefreshCw size={14} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
              Refresh
            </button>
          </div>

          {error && (
            <div className="alert alert-error" style={{ marginBottom: 24 }}>{error}</div>
          )}

          {/* Stat cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
            {stats.map((s) => (
              <div key={s.label} style={{
                background: '#fff', border: '1px solid #ECECE8', borderRadius: 12, padding: '18px 20px',
              }}>
                <div style={{ font: '700 26px/1 Satoshi', letterSpacing: '-0.02em' }}>{s.value}</div>
                <div style={{ font: '400 12px/1.3 Satoshi', color: '#75757C', marginTop: 6 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Filter chips */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {(['all', 'created', 'breakdown', 'generating', 'approving', 'compile', 'review'] as const).map((step) => {
              const active = filterStep === step;
              const count = step === 'all' ? rows.length : (counts[step] ?? 0);
              const color = step === 'all' ? { bg: '#111113', fg: '#fff' } : FUNNEL_COLORS[step];
              return (
                <button
                  key={step}
                  onClick={() => setFilterStep(step)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    height: 30, padding: '0 12px', borderRadius: 999,
                    border: active ? 'none' : '1px solid #E4E4E0',
                    background: active ? (step === 'all' ? '#111113' : color.bg) : '#fff',
                    color: active ? (step === 'all' ? '#fff' : color.fg) : '#5E5E65',
                    font: '500 12px/1 Satoshi', cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {step === 'all' ? 'All' : FUNNEL_LABELS[step]}
                  <span style={{
                    minWidth: 18, height: 18, borderRadius: 999,
                    background: active ? 'rgba(255,255,255,0.25)' : '#F0F0EC',
                    color: active ? (step === 'all' ? '#fff' : color.fg) : '#75757C',
                    font: '600 11px/18px Satoshi', textAlign: 'center', padding: '0 4px',
                  }}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '64px 0', color: '#75757C', font: '400 14px/1.4 Satoshi' }}>
              No projects {filterStep !== 'all' ? `in ${FUNNEL_LABELS[filterStep as FunnelStep]}` : ''} yet.
            </div>
          ) : (
            <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
              {/* Table header */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 160px 110px 150px 100px 90px',
                padding: '10px 16px',
                borderBottom: '1px solid #F0F0EE',
                font: '500 11px/1 Satoshi', color: '#9A9AA0', letterSpacing: '0.05em', textTransform: 'uppercase',
              }}>
                <span>Project</span>
                <span>Step</span>
                <span>Scenes</span>
                <span>Generations</span>
                <span>Compile</span>
                <span style={{ textAlign: 'right' }}>Activity</span>
              </div>

              {filtered.map((row, i) => {
                const stepColor = FUNNEL_COLORS[row.funnelStep];
                const hasError = row.failedGenerations > 0 || row.compilationStatus === 'failed';
                const hasInFlight = row.inFlightGenerations > 0 || row.compilationStatus === 'pending' || row.compilationStatus === 'processing';

                return (
                  <div
                    key={row.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 160px 110px 150px 100px 90px',
                      alignItems: 'center',
                      padding: '12px 16px',
                      borderBottom: i < filtered.length - 1 ? '1px solid #F3F3F1' : 'none',
                      gap: 8,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFAF8')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* Project name + user */}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Link
                          href={`/video-projects/${row.id}`}
                          style={{ font: '600 13px/1.3 Satoshi', color: '#111113', textDecoration: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        >
                          {row.name}
                        </Link>
                        {hasError && <AlertCircle size={13} color="#DC2626" style={{ flexShrink: 0 }} />}
                        {!hasError && hasInFlight && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#6C47FF', animation: 'pulse 2s ease-in-out infinite', flexShrink: 0 }} />}
                      </div>
                      <div style={{ font: '400 11px/1.3 Satoshi', color: '#9A9AA0', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {row.userEmail} · {shortDate(row.createdAt)}
                      </div>
                    </div>

                    {/* Step badge */}
                    <div>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px',
                        borderRadius: 999, font: '500 11px/1 Satoshi',
                        background: stepColor.bg, color: stepColor.fg,
                      }}>
                        {FUNNEL_LABELS[row.funnelStep]}
                      </span>
                    </div>

                    {/* Scenes */}
                    <div style={{ font: '400 12px/1 Satoshi', color: '#5E5E65' }}>
                      {row.screenCount === 0
                        ? <span style={{ color: '#C4C4C9' }}>—</span>
                        : (
                          <span>
                            <span style={{ font: '600 13px/1 Satoshi', color: '#111113' }}>{row.approvedScreenCount}</span>
                            /{row.screenCount} approved
                          </span>
                        )}
                    </div>

                    {/* Generations */}
                    <div>
                      {row.totalGenerations === 0
                        ? <span style={{ font: '400 12px/1 Satoshi', color: '#C4C4C9' }}>—</span>
                        : (
                          <div style={{ font: '12px/1.4 Satoshi' }}>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#16A34A' }}>
                                <CheckCircle2 size={11} /> {row.completedGenerations}
                              </span>
                              {row.failedGenerations > 0 && (
                                <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#DC2626' }}>
                                  <AlertCircle size={11} /> {row.failedGenerations}
                                </span>
                              )}
                              {row.inFlightGenerations > 0 && (
                                <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#6C47FF' }}>
                                  <Clock size={11} /> {row.inFlightGenerations}
                                </span>
                              )}
                            </div>
                            {row.lastGenerationError && (
                              <div style={{ font: '400 10px/1.3 Satoshi', color: '#DC2626', marginTop: 2, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={row.lastGenerationError}>
                                {row.lastGenerationError.slice(0, 60)}{row.lastGenerationError.length > 60 ? '…' : ''}
                              </div>
                            )}
                          </div>
                        )}
                    </div>

                    {/* Compile */}
                    <div>
                      {!row.compilationStatus
                        ? <span style={{ font: '400 12px/1 Satoshi', color: '#C4C4C9' }}>—</span>
                        : (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px',
                            borderRadius: 999, font: '500 11px/1 Satoshi',
                            background:
                              row.compilationStatus === 'completed' ? '#DCFCE7' :
                              row.compilationStatus === 'failed'    ? '#FEE2E2' :
                              '#EDE9FE',
                            color:
                              row.compilationStatus === 'completed' ? '#14532D' :
                              row.compilationStatus === 'failed'    ? '#DC2626' :
                              '#5B21B6',
                          }}>
                            {row.compilationStatus}
                          </span>
                        )}
                    </div>

                    {/* Last activity */}
                    <div style={{ font: '400 11px/1 Satoshi', color: '#9A9AA0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {relativeTime(row.lastActivityAt)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </AppShell>
  );
}
