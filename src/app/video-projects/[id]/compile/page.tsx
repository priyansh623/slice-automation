'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';
import { Play, RotateCcw, ChevronRight } from 'lucide-react';

interface Screen {
  id: number;
  screenNumber: number;
  dialogue: string;
  approvedGenerationId: number | null;
  durationSeconds: number | null;
}

interface VideoProject {
  id: number;
  name: string;
  screens: Screen[];
}

interface Compilation {
  id: number;
  videoProjectId: number;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export default function CompilePage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<VideoProject | null>(null);
  const [compilations, setCompilations] = useState<Compilation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadData() {
    const [projRes, compsRes] = await Promise.all([
      fetch(`/api/v1/video-projects/${id}`),
      fetch(`/api/v1/video-projects/${id}/compilations`),
    ]);
    if (projRes.ok) setProject(await projRes.json());
    if (compsRes.ok) {
      const comps = await compsRes.json();
      setCompilations(Array.isArray(comps) ? comps : []);
    }
  }

  useEffect(() => { loadData(); }, [id]);

  const latestComp = compilations[0] ?? null;
  const isRunning = latestComp?.status === 'pending' || latestComp?.status === 'processing';
  const isDone = latestComp?.status === 'completed';
  const isFailed = latestComp?.status === 'failed';

  useEffect(() => {
    if (!isRunning) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/v1/video-projects/${id}/compilations`);
      if (res.ok) {
        const comps = await res.json();
        setCompilations(Array.isArray(comps) ? comps : []);
      }
    }, 5000);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [isRunning, id]);

  async function handleCompile() {
    if (!project) return;
    const approvedScenes = project.screens.filter((s) => s.approvedGenerationId);
    if (approvedScenes.length === 0) {
      setError('No approved scenes to compile.');
      setShowModal(false);
      return;
    }
    setSubmitting(true);
    setError('');
    const res = await fetch(`/api/v1/video-projects/${id}/compilations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenes: approvedScenes.map((s) => ({
          videoScreenId: s.id,
          videoGenerationId: s.approvedGenerationId!,
        })),
      }),
    });
    setShowModal(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string };
      setError(d.error ?? 'Failed to start compilation');
      setSubmitting(false);
      return;
    }
    const newComp: Compilation = await res.json();
    setCompilations((prev) => [newComp, ...prev]);
    setSubmitting(false);
  }

  if (!project) {
    return (
      <AppShell>
        <div className="page-body">
          <div className="skeleton" style={{ height: 28, width: '40%', marginBottom: 16 }} />
        </div>
      </AppShell>
    );
  }

  const approvedCount = project.screens.filter((s) => s.approvedGenerationId).length;
  const totalCount = project.screens.length;
  const allApproved = approvedCount === totalCount && totalCount > 0;

  const pageTitle = isRunning
    ? 'Compiling your video'
    : isDone
    ? 'Video ready'
    : !allApproved
    ? 'Approve every scene to compile'
    : 'Compile video';

  const unapprovedScenes = project.screens.filter((s) => !s.approvedGenerationId);

  const projectSteps = [
    { label: 'Script', status: 'complete' as const },
    { label: 'Breakdown', status: 'complete' as const },
    { label: 'Scenes', status: allApproved ? ('complete' as const) : ('active' as const) },
    { label: 'Compile', status: 'active' as const },
    { label: 'Review', status: 'pending' as const },
  ];

  const tones = ['#E8E3D8', '#D8E3E8', '#E3D8E8', '#D8E8E3', '#E8DDD8', '#E3E8D8'];

  return (
    <AppShell>
      <ProjectHeader projectId={id} projectName={project.name} steps={projectSteps} />

      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 32px 80px' }}>
          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 44 }}>
            <h1 style={{ margin: 0, font: '700 26px/1.2 Satoshi', letterSpacing: '-0.02em' }}>
              {pageTitle}
            </h1>
            {isDone && latestComp && (
              <Link href={`/video-projects/${id}/review?cid=${latestComp.id}`} style={{ textDecoration: 'none' }}>
                <button style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '500 14px/1 Satoshi', cursor: 'pointer' }}>
                  <Play size={14} />
                  Review video
                </button>
              </Link>
            )}
          </div>

          {!allApproved && unapprovedScenes.length > 0 && (
            <div style={{ marginTop: 12, font: '400 14px/1.5 Satoshi', color: '#5E5E65' }}>
              Waiting on Scene {unapprovedScenes.map(s => s.screenNumber).join(', ')}.
            </div>
          )}

          {error && (
            <div className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>
          )}

          {/* Running state: progress bar */}
          {isRunning && (
            <div style={{ marginTop: 24, padding: '16px 20px', background: '#fff', border: '1px solid #ECECE8', borderRadius: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ font: '500 13px/1 Satoshi', color: '#111113' }}>
                  {latestComp?.status === 'processing' ? 'Processing…' : 'Queued…'}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: '#EFEFEC', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: '60%',
                  background: '#6C47FF',
                  borderRadius: 3,
                  animation: 'indeterminate 1.5s ease-in-out infinite',
                }} />
              </div>
              <style>{`
                @keyframes indeterminate {
                  0% { transform: translateX(-100%); width: 50%; }
                  50% { transform: translateX(100%); width: 70%; }
                  100% { transform: translateX(200%); width: 50%; }
                }
              `}</style>
            </div>
          )}

          {/* Scene list */}
          <div style={{ marginTop: 32, borderTop: '1px solid #ECECE8' }}>
            {project.screens.map((s, i) => {
              const approved = !!s.approvedGenerationId;
              const thumbBg = approved ? 'oklch(0.240 0 0)' : '#E9E9E5';
              const subtitle = approved
                ? `Gen ${s.approvedGenerationId}${s.durationSeconds ? ` · ${s.durationSeconds}s` : ''}`
                : 'Pending approval';

              return (
                <div key={s.id} style={{
                  display: 'grid',
                  gridTemplateColumns: '26px minmax(0,1fr) auto',
                  gap: 16,
                  alignItems: 'center',
                  padding: '12px 0',
                  borderBottom: '1px solid #F0F0EE',
                }}>
                  <span style={{
                    width: 26,
                    height: 42,
                    borderRadius: 5,
                    background: thumbBg,
                    display: 'block',
                    flexShrink: 0,
                  }} />
                  <div>
                    <div style={{ font: '700 14px/1.3 Satoshi' }}>Scene {s.screenNumber}</div>
                    <div style={{ font: '400 13px/1.4 Satoshi', color: '#75757C', marginTop: 2 }}>
                      {subtitle}
                    </div>
                  </div>
                  <Link href={`/video-projects/${id}/screens/${s.screenNumber}`} style={{ textDecoration: 'none' }}>
                    <button style={{ height: 30, padding: '0 12px', borderRadius: 8, background: '#fff', border: '1px solid #E4E4E0', font: '500 13px/1 Satoshi', cursor: 'pointer' }}>
                      {approved ? 'Change' : 'Approve'}
                    </button>
                  </Link>
                </div>
              );
            })}
          </div>

          {/* Compile button (only when all approved and no active compilation) */}
          {allApproved && !isRunning && !isDone && (
            <div style={{ marginTop: 28 }}>
              <button
                onClick={() => setShowModal(true)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 40,
                  padding: '0 18px',
                  borderRadius: 9,
                  background: '#6C47FF',
                  color: '#fff',
                  border: 'none',
                  font: '700 14px/1 Satoshi',
                  cursor: 'pointer',
                }}
              >
                Compile all scenes
              </button>
            </div>
          )}

          {/* Failed state */}
          {isFailed && (
            <div style={{ marginTop: 16 }}>
              <div style={{ font: '400 14px/1.5 Satoshi', color: '#DC2626', marginBottom: 12 }}>
                Compilation failed. Please try again.
              </div>
              <button
                onClick={() => setShowModal(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: 'pointer' }}
              >
                <RotateCcw size={14} />
                Try again
              </button>
            </div>
          )}

          {/* Previous compilations */}
          {compilations.length > 0 && (
            <div style={{ marginTop: 32 }}>
              <div style={{ font: '500 12px/1 Satoshi', color: '#9A9AA0', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
                Previous compilations
              </div>
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
                {compilations.map((c, i) => (
                  <Link key={c.id} href={`/video-projects/${id}/review?cid=${c.id}`} style={{ textDecoration: 'none', display: 'block' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 16px',
                      borderBottom: i < compilations.length - 1 ? '1px solid #F3F3F1' : 'none',
                      cursor: 'pointer',
                    }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFAF8')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ font: '500 13px/1 Satoshi' }}>Compilation #{c.id}</span>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 22,
                        padding: '0 8px',
                        borderRadius: 999,
                        font: '500 12px/1 Satoshi',
                        background: c.status === 'completed' ? '#EFEBFF' : c.status === 'failed' ? '#FEF2F2' : '#F0F0EC',
                        color: c.status === 'completed' ? '#6C47FF' : c.status === 'failed' ? '#DC2626' : '#111113',
                      }}>
                        {c.status}
                      </span>
                      <span style={{ marginLeft: 'auto', font: '400 12px/1 Satoshi', color: '#9A9AA0' }}>
                        {new Date(c.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                      <ChevronRight size={15} color="#A3A3A9" />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Compile confirm modal */}
      {showModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24,
        }}
          onClick={(e) => e.target === e.currentTarget && setShowModal(false)}
        >
          <div style={{
            background: '#fff',
            borderRadius: 16,
            padding: '28px 28px 24px',
            width: '100%',
            maxWidth: 400,
            boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
          }}>
            <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 8 }}>Compile the full video?</div>
            <div style={{ font: '400 14px/1.55 Satoshi', color: '#5E5E65', marginBottom: 24 }}>
              This will stitch your {approvedCount} approved scene{approvedCount !== 1 ? 's' : ''} into a single video. This may take a few minutes.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowModal(false)}
                style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer', color: '#111113' }}
              >
                Cancel
              </button>
              <button
                onClick={handleCompile}
                disabled={submitting}
                style={{
                  height: 38, padding: '0 16px', borderRadius: 9,
                  background: submitting ? '#E4E4E0' : '#6C47FF',
                  color: submitting ? '#A3A3A9' : '#fff',
                  border: 'none', font: '700 14px/1 Satoshi',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                }}
              >
                {submitting ? 'Starting…' : 'Start compiling'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
