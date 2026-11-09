'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { RefreshCw, AlertCircle, CheckCircle2, Clock, Circle, MessageSquare } from 'lucide-react';

type FunnelStep = 'created' | 'breakdown' | 'generating' | 'approving' | 'compile' | 'review';

interface SceneDetail {
  screenNumber: number;
  approved: boolean;
  genCount: number;
  failedCount: number;
  creatorFeedback: string | null;
}

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
  avgGensPerScene: number;
  promptRevisionCount: number;
  lastGenerationError: string | null;
  compilationStatus: string | null;
  compilationError: string | null;
  compilationCreatedAt: number | null;
  funnelStep: FunnelStep;
  stuckHours: number | null;
  isStuck: boolean;
  creatorFeedbackCount: number;
  scenes: SceneDetail[];
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

function stuckLabel(hours: number): string {
  if (hours < 24) return `${hours}h idle`;
  return `${Math.floor(hours / 24)}d idle`;
}

export default function AdminDashboardPage() {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState<number>(0);
  const [refreshing, setRefreshing] = useState(false);
  const [filterStep, setFilterStep] = useState<FunnelStep | 'all' | 'stuck'>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState<Record<number, boolean>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load(quiet = false, archived = showArchived) {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const url = `/api/v1/admin/dashboard${archived ? '?archived=1' : ''}`;
      const res = await fetch(url);
      if (!res.ok) { setError('Failed to load dashboard'); return; }
      setRows(await res.json());
      setLastRefreshed(Date.now());
      setError('');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function archiveProject(id: number) {
    setArchiving((prev) => ({ ...prev, [id]: true }));
    try {
      await fetch(`/api/v1/admin/projects/${id}/archive`, { method: 'POST' });
      setRows((prev) => prev.filter((r) => r.id !== id));
      if (expandedId === id) setExpandedId(null);
    } finally {
      setArchiving((prev) => ({ ...prev, [id]: false }));
    }
  }

  async function unarchiveProject(id: number) {
    setArchiving((prev) => ({ ...prev, [id]: true }));
    try {
      await fetch(`/api/v1/admin/projects/${id}/archive`, { method: 'DELETE' });
      setRows((prev) => prev.filter((r) => r.id !== id));
      if (expandedId === id) setExpandedId(null);
    } finally {
      setArchiving((prev) => ({ ...prev, [id]: false }));
    }
  }

  useEffect(() => {
    void load(false, showArchived);
    intervalRef.current = setInterval(() => load(true, showArchived), 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  const filtered = filterStep === 'all'
    ? rows
    : filterStep === 'stuck'
      ? rows.filter((r) => r.isStuck)
      : rows.filter((r) => r.funnelStep === filterStep);

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.funnelStep] = (acc[r.funnelStep] ?? 0) + 1;
    return acc;
  }, {});
  const stuckCount = rows.filter((r) => r.isStuck).length;

  // Stat cards
  const withGens = rows.filter((r) => r.screenCount > 0 && r.avgGensPerScene > 0);
  const globalAvgGens = withGens.length > 0
    ? Math.round((withGens.reduce((s, r) => s + r.avgGensPerScene, 0) / withGens.length) * 10) / 10
    : 0;

  const stats = [
    { label: 'Total projects', value: rows.length },
    { label: 'Videos compiled', value: rows.filter((r) => r.compilationStatus === 'completed').length },
    { label: 'Stuck (12h+ idle)', value: stuckCount, alert: stuckCount > 0 },
    { label: 'Avg gens / scene', value: globalAvgGens || '—', sub: 'higher = more retries' },
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
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '40px 32px 80px' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
            <div>
              <h1 style={{ margin: 0, font: '700 24px/1.2 Satoshi', letterSpacing: '-0.02em' }}>Tester Dashboard</h1>
              <div style={{ font: '400 13px/1 Satoshi', color: '#75757C', marginTop: 6 }}>
                {lastRefreshed > 0 && `Last refreshed ${relativeTime(lastRefreshed)}`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setShowArchived((v) => !v)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  height: 36, padding: '0 14px', borderRadius: 9,
                  background: showArchived ? '#F0F0EC' : '#fff',
                  border: showArchived ? '1px solid #C4C4C9' : '1px solid #E4E4E0',
                  font: '500 13px/1 Satoshi', cursor: 'pointer',
                  color: showArchived ? '#5E5E65' : '#111113',
                }}
              >
                {showArchived ? 'Show active' : 'Show archived'}
              </button>
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
          </div>

          {error && <div className="alert alert-error" style={{ marginBottom: 24 }}>{error}</div>}

          {/* Stat cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
            {stats.map((s) => (
              <div key={s.label} style={{
                background: s.alert ? '#FFF5F5' : '#fff',
                border: s.alert ? '1px solid #FECACA' : '1px solid #ECECE8',
                borderRadius: 12, padding: '18px 20px',
              }}>
                <div style={{ font: '700 26px/1 Satoshi', letterSpacing: '-0.02em', color: s.alert ? '#DC2626' : '#111113' }}>{s.value}</div>
                <div style={{ font: '400 12px/1.3 Satoshi', color: s.alert ? '#DC2626' : '#75757C', marginTop: 6 }}>{s.label}</div>
                {s.sub && <div style={{ font: '400 11px/1.3 Satoshi', color: '#B0B0B8', marginTop: 3 }}>{s.sub}</div>}
              </div>
            ))}
          </div>

          {/* Filter chips */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {/* All chip */}
            {(['all'] as const).map((step) => {
              const active = filterStep === step;
              return (
                <button key={step} onClick={() => setFilterStep(step)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  height: 30, padding: '0 12px', borderRadius: 999,
                  border: active ? 'none' : '1px solid #E4E4E0',
                  background: active ? '#111113' : '#fff',
                  color: active ? '#fff' : '#5E5E65',
                  font: '500 12px/1 Satoshi', cursor: 'pointer',
                }}>
                  All
                  <span style={{ minWidth: 18, height: 18, borderRadius: 999, background: active ? 'rgba(255,255,255,0.25)' : '#F0F0EC', color: active ? '#fff' : '#75757C', font: '600 11px/18px Satoshi', textAlign: 'center', padding: '0 4px' }}>{rows.length}</span>
                </button>
              );
            })}

            {/* Stuck chip */}
            {stuckCount > 0 && (() => {
              const active = filterStep === 'stuck';
              return (
                <button onClick={() => setFilterStep('stuck')} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  height: 30, padding: '0 12px', borderRadius: 999,
                  border: active ? 'none' : '1px solid #FECACA',
                  background: active ? '#DC2626' : '#FFF5F5',
                  color: active ? '#fff' : '#DC2626',
                  font: '500 12px/1 Satoshi', cursor: 'pointer',
                }}>
                  ⚠ Stuck
                  <span style={{ minWidth: 18, height: 18, borderRadius: 999, background: active ? 'rgba(255,255,255,0.25)' : '#FEE2E2', color: active ? '#fff' : '#DC2626', font: '600 11px/18px Satoshi', textAlign: 'center', padding: '0 4px' }}>{stuckCount}</span>
                </button>
              );
            })()}

            {/* Funnel step chips */}
            {(['created', 'breakdown', 'generating', 'approving', 'compile', 'review'] as FunnelStep[]).map((step) => {
              const active = filterStep === step;
              const count = counts[step] ?? 0;
              if (count === 0) return null;
              const color = FUNNEL_COLORS[step];
              return (
                <button key={step} onClick={() => setFilterStep(step)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  height: 30, padding: '0 12px', borderRadius: 999,
                  border: active ? 'none' : '1px solid #E4E4E0',
                  background: active ? color.bg : '#fff',
                  color: active ? color.fg : '#5E5E65',
                  font: '500 12px/1 Satoshi', cursor: 'pointer',
                }}>
                  {FUNNEL_LABELS[step]}
                  <span style={{ minWidth: 18, height: 18, borderRadius: 999, background: active ? 'rgba(0,0,0,0.08)' : '#F0F0EC', color: active ? color.fg : '#75757C', font: '600 11px/18px Satoshi', textAlign: 'center', padding: '0 4px' }}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '64px 0', color: '#75757C', font: '400 14px/1.4 Satoshi' }}>
              No projects {filterStep !== 'all' ? `in this filter` : ''} yet.
            </div>
          ) : (
            <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
              {/* Table header */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 150px 110px 180px 100px 100px',
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
                const isExpanded = expandedId === row.id;

                return (
                  <div key={row.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid #F3F3F1' : 'none' }}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 150px 110px 180px 100px 100px',
                        alignItems: 'center',
                        padding: '12px 16px',
                        gap: 8,
                        cursor: 'pointer',
                        background: isExpanded ? '#FAFAF8' : 'transparent',
                      }}
                      onClick={() => setExpandedId(isExpanded ? null : row.id)}
                      onMouseEnter={(e) => !isExpanded && (e.currentTarget.style.background = '#FAFAF8')}
                      onMouseLeave={(e) => !isExpanded && (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* Project name + user */}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <Link
                            href={`/video-projects/${row.id}`}
                            onClick={(e) => e.stopPropagation()}
                            style={{ font: '600 13px/1.3 Satoshi', color: '#111113', textDecoration: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                          >
                            {row.name}
                          </Link>
                          {hasError && <AlertCircle size={13} color="#DC2626" style={{ flexShrink: 0 }} />}
                          {!hasError && hasInFlight && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#6C47FF', animation: 'pulse 2s ease-in-out infinite', flexShrink: 0 }} />}
                          {row.isStuck && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, height: 18, padding: '0 6px', borderRadius: 999, background: '#FEF3C7', color: '#92400E', font: '500 10px/1 Satoshi', flexShrink: 0 }}>
                              {stuckLabel(row.stuckHours!)}
                            </span>
                          )}
                          {row.creatorFeedbackCount > 0 && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#6C47FF', font: '500 10px/1 Satoshi', flexShrink: 0 }}>
                              <MessageSquare size={11} /> {row.creatorFeedbackCount}
                            </span>
                          )}
                        </div>
                        <div style={{ font: '400 11px/1.3 Satoshi', color: '#9A9AA0', marginTop: 2 }}>
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
                            <div>
                              <span>
                                <span style={{ font: '600 13px/1 Satoshi', color: '#111113' }}>{row.approvedScreenCount}</span>
                                /{row.screenCount} approved
                              </span>
                              {row.promptRevisionCount > 0 && (
                                <div style={{ font: '400 10px/1.3 Satoshi', color: '#9A9AA0', marginTop: 2 }}>
                                  {row.promptRevisionCount} prompt rev{row.promptRevisionCount !== 1 ? 's' : ''}
                                </div>
                              )}
                            </div>
                          )}
                      </div>

                      {/* Generations */}
                      <div>
                        {row.totalGenerations === 0
                          ? <span style={{ font: '400 12px/1 Satoshi', color: '#C4C4C9' }}>—</span>
                          : (
                            <div style={{ font: '12px/1.4 Satoshi' }}>
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
                              {row.avgGensPerScene > 1.5 && (
                                <div style={{ font: '400 10px/1.3 Satoshi', color: row.avgGensPerScene > 3 ? '#DC2626' : '#92400E', marginTop: 2 }}>
                                  {row.avgGensPerScene}x avg / scene
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
                      <div style={{ font: '400 11px/1 Satoshi', color: row.isStuck ? '#92400E' : '#9A9AA0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {relativeTime(row.lastActivityAt)}
                      </div>
                    </div>

                    {/* Expanded detail panel */}
                    {isExpanded && (
                      <div style={{ margin: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>

                        {/* Scene breakdown */}
                        {row.scenes.length > 0 && (
                          <div style={{ background: '#F8F8F6', border: '1px solid #ECECE8', borderRadius: 10, padding: '12px 14px' }}>
                            <div style={{ font: '600 11px/1 Satoshi', color: '#75757C', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                              Scene breakdown
                            </div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              {row.scenes.map((s) => {
                                const bg = s.approved ? '#DCFCE7' : s.failedCount > 0 && s.failedCount === s.genCount ? '#FEE2E2' : s.genCount > 0 ? '#EDE9FE' : '#F0F0EC';
                                const fg = s.approved ? '#14532D' : s.failedCount > 0 && s.failedCount === s.genCount ? '#DC2626' : s.genCount > 0 ? '#5B21B6' : '#75757C';
                                const label = s.approved ? '✓' : s.failedCount > 0 && s.failedCount === s.genCount ? '✗' : s.genCount > 0 ? '…' : '—';
                                return (
                                  <div key={s.screenNumber} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                                    <div style={{
                                      width: 36, height: 36, borderRadius: 8,
                                      background: bg, color: fg,
                                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      font: '600 13px/1 Satoshi',
                                      position: 'relative',
                                    }}>
                                      {label}
                                      {s.creatorFeedback && (
                                        <div style={{ position: 'absolute', top: -4, right: -4, width: 10, height: 10, borderRadius: '50%', background: '#6C47FF', border: '1.5px solid #fff' }} title={s.creatorFeedback} />
                                      )}
                                    </div>
                                    <div style={{ font: '400 10px/1 Satoshi', color: '#9A9AA0' }}>S{s.screenNumber}</div>
                                    {s.genCount > 0 && (
                                      <div style={{ font: '400 10px/1 Satoshi', color: '#B0B0B8' }}>{s.genCount}×</div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            <div style={{ display: 'flex', gap: 16, marginTop: 10, font: '400 11px/1 Satoshi', color: '#9A9AA0' }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: '#DCFCE7', display: 'inline-block' }} />Approved</span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: '#EDE9FE', display: 'inline-block' }} />In progress</span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: '#FEE2E2', display: 'inline-block' }} />All failed</span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#6C47FF', display: 'inline-block' }} />Has feedback</span>
                            </div>
                          </div>
                        )}

                        {/* Creator feedback */}
                        {row.scenes.some((s) => s.creatorFeedback) && (
                          <div style={{ background: '#F3F0FF', border: '1px solid #DDD6FE', borderRadius: 10, padding: '12px 14px' }}>
                            <div style={{ font: '600 11px/1 Satoshi', color: '#5B21B6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                              Creator feedback
                            </div>
                            {row.scenes.filter((s) => s.creatorFeedback).map((s) => (
                              <div key={s.screenNumber} style={{ marginBottom: 6 }}>
                                <span style={{ font: '600 11px/1 Satoshi', color: '#7C3AED' }}>Scene {s.screenNumber}: </span>
                                <span style={{ font: '400 12px/1.5 Satoshi', color: '#4C1D95' }}>{s.creatorFeedback}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Errors */}
                        {(row.lastGenerationError || row.compilationError) && (
                          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '12px 14px' }}>
                            {row.lastGenerationError && (
                              <div style={{ marginBottom: row.compilationError ? 10 : 0 }}>
                                <div style={{ font: '600 11px/1 Satoshi', color: '#991B1B', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Generation error</div>
                                <div style={{ font: '400 12px/1.6 Satoshi', color: '#7F1D1D', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.lastGenerationError}</div>
                              </div>
                            )}
                            {row.compilationError && (
                              <div>
                                <div style={{ font: '600 11px/1 Satoshi', color: '#991B1B', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Compilation error</div>
                                <div style={{ font: '400 12px/1.6 Satoshi', color: '#7F1D1D', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.compilationError}</div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Archive / unarchive */}
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (showArchived) void unarchiveProject(row.id);
                              else void archiveProject(row.id);
                            }}
                            disabled={archiving[row.id]}
                            style={{
                              height: 30, padding: '0 12px', borderRadius: 7,
                              border: '1px solid #E4E4E0', background: '#fff',
                              font: '500 12px/1 Satoshi', color: '#75757C',
                              cursor: archiving[row.id] ? 'default' : 'pointer',
                              opacity: archiving[row.id] ? 0.5 : 1,
                            }}
                          >
                            {archiving[row.id] ? '…' : showArchived ? 'Unarchive' : 'Archive'}
                          </button>
                        </div>
                      </div>
                    )}
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
