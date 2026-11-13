'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';
import { Play, RotateCcw, ChevronRight } from 'lucide-react';
import { compilationView, describeActiveCompilation } from '@/lib/compilation-versions';

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
  errorMessage?: string | null;
  createdAt: number;
  updatedAt: number;
  version: number | null;
  isCurrent?: boolean;
  sceneCount?: number;
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
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

  // The list is shown newest first; the view picks the current version, a running job and the latest failure from it.
  const view = compilationView(compilations);
  const currentComp = view.current;
  const isRunning = view.active !== null;
  const isDone = currentComp !== null && !isRunning;
  const failedComp = view.lastFailed;
  const hasVersions = view.versions.length > 0;

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
      if (res.status === 409) loadData(); // another compilation is already running: show it
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

  const activeText = view.active ? describeActiveCompilation(view.active.status, view.nextVersion, currentComp?.version ?? null) : null;

  const pageTitle = isRunning
    ? (activeText?.headline ?? `Compiling version ${view.nextVersion}`)
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
            {currentComp && (
              <Link href={`/video-projects/${id}/review?cid=${currentComp.id}`} style={{ textDecoration: 'none' }}>
                <button style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '500 14px/1 Satoshi', cursor: 'pointer' }}>
                  <Play size={14} />
                  {isRunning ? `Review version ${currentComp.version}` : 'Review video'}
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

          {/* Waiting or running: a queued job is only waiting for the worker, so it gets no moving progress bar */}
          {isRunning && activeText && (
            <div style={{ marginTop: 24, padding: '16px 20px', background: '#fff', border: '1px solid #ECECE8', borderRadius: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ font: '500 13px/1 Satoshi', color: '#111113' }}>
                  {activeText.queued ? `Queued · version ${view.nextVersion}` : `Processing · version ${view.nextVersion}`}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: '#EFEFEC', overflow: 'hidden' }}>
                {activeText.queued ? (
                  <div style={{ height: '100%', width: '100%', background: 'repeating-linear-gradient(90deg, #D6D6D1 0 8px, #EFEFEC 8px 16px)' }} />
                ) : (
                  <div style={{
                    height: '100%',
                    width: '60%',
                    background: '#6C47FF',
                    borderRadius: 3,
                    animation: 'indeterminate 1.5s ease-in-out infinite',
                  }} />
                )}
              </div>
              <div style={{ marginTop: 10, font: '400 13px/1.45 Satoshi', color: '#75757C' }}>
                {activeText.detail}
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

          {/* Compile button: whenever every scene is approved and nothing is running. After a first compilation it makes the next version. */}
          {allApproved && !isRunning && !failedComp && (
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
                  background: hasVersions ? '#fff' : '#6C47FF',
                  color: hasVersions ? '#111113' : '#fff',
                  border: hasVersions ? '1px solid #D0D0CC' : 'none',
                  font: '700 14px/1 Satoshi',
                  cursor: 'pointer',
                }}
              >
                {hasVersions ? <RotateCcw size={14} /> : null}
                {hasVersions ? `Compile new version (v${view.nextVersion})` : 'Compile all scenes'}
              </button>
              {hasVersions && (
                <div style={{ marginTop: 8, font: '400 13px/1.4 Satoshi', color: '#75757C' }}>
                  Changed a scene? Use Change above, then compile again. Earlier versions are kept.
                </div>
              )}
            </div>
          )}

          {/* Failed state: the earlier version, if any, is unaffected */}
          {failedComp && !isRunning && (
            <div style={{ marginTop: 16 }}>
              <div style={{ font: '400 14px/1.5 Satoshi', color: '#DC2626', marginBottom: 12 }}>
                {hasVersions
                  ? `Version ${view.nextVersion} could not be made, so Version ${currentComp!.version} is still your current video.`
                  : 'Compilation failed. Please try again.'}
              </div>
              {allApproved && (
                <button
                  onClick={() => setShowModal(true)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: 'pointer' }}
                >
                  <RotateCcw size={14} />
                  Try again
                </button>
              )}
            </div>
          )}

          {/* Version history: every successful compilation is kept and can be played and downloaded */}
          {hasVersions && (
            <div style={{ marginTop: 32 }}>
              <div style={{ font: '500 12px/1 Satoshi', color: '#9A9AA0', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
                Versions
              </div>
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
                {view.versions.map((c, i) => (
                  <Link key={c.id} href={`/video-projects/${id}/review?cid=${c.id}`} style={{ textDecoration: 'none', display: 'block' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 16px',
                      borderBottom: i < view.versions.length - 1 ? '1px solid #F3F3F1' : 'none',
                      cursor: 'pointer',
                    }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFAF8')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ font: '700 13px/1 Satoshi' }}>Version {c.version}</span>
                      {c.isCurrent && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 999, font: '500 12px/1 Satoshi', background: '#EFEBFF', color: '#6C47FF' }}>
                          Current
                        </span>
                      )}
                      <span style={{ font: '400 12px/1 Satoshi', color: '#75757C' }}>
                        {c.sceneCount ? `${c.sceneCount} scenes` : ''}
                      </span>
                      <span style={{ marginLeft: 'auto', font: '400 12px/1 Satoshi', color: '#9A9AA0' }}>
                        {formatWhen(c.createdAt)}
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
            <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 8 }}>
              {hasVersions ? `Compile Version ${view.nextVersion}?` : 'Compile the full video?'}
            </div>
            <div style={{ font: '400 14px/1.55 Satoshi', color: '#5E5E65', marginBottom: 24 }}>
              This will stitch your {approvedCount} approved scene{approvedCount !== 1 ? 's' : ''} into a single video. This may take a few minutes.
              {hasVersions ? ` Version ${currentComp!.version} is kept and stays available.` : ''}
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
