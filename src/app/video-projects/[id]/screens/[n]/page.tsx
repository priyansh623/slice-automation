'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';
import { useProject } from '@/contexts/ProjectContext';

const SUPPORTED_DURATIONS = [4, 6, 8, 10];

interface PromptVersion {
  id: number;
  version: number;
  promptText: string;
  source: string;
  nlFeedback: string | null;
  createdAt: number;
}

interface Generation {
  generation: {
    id: number;
    status: string;
    jobId: string | null;
    videoStoragePath: string | null;
    durationSeconds: number | null;
    createdAt: number;
  };
  promptVersion: PromptVersion;
}

// ─── Icons ──────────────────────────────────────────────────────────────────

function IconSparkle() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
    </svg>
  );
}

function IconCheck({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/>
      <polyline points="2 17 12 22 22 17"/>
      <polyline points="2 12 12 17 22 12"/>
    </svg>
  );
}

function IconSend() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <line x1="5" y1="12" x2="19" y2="12"/>
      <polyline points="12 5 19 12 12 19"/>
    </svg>
  );
}

export default function ScreenPage() {
  const { id, n } = useParams<{ id: string; n: string }>();
  const { project, refreshProject } = useProject();

  const [promptHistory, setPromptHistory] = useState<PromptVersion[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [currentPrompt, setCurrentPrompt] = useState('');
  const [feedback, setFeedback] = useState('');
  const [writingPrompt, setWritingPrompt] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState('');
  const [activePromptVersionId, setActivePromptVersionId] = useState<number | null>(null);
  const [validation, setValidation] = useState<{ issues: string[]; warnings: string[] } | null>(null);
  const [projectScopePending, setProjectScopePending] = useState(false);
  const [signedVideoUrls, setSignedVideoUrls] = useState<Record<number, string>>({});
  const [activeTab, setActiveTab] = useState<'prompt' | 'requests'>('prompt');
  const [displayGenId, setDisplayGenId] = useState<number | null>(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingFetchesRef = useRef<Set<number>>(new Set());

  function isProjectScopeFeedback(text: string): boolean {
    return /across all scenes|throughout|in every scene|all scenes|his voice throughout|her voice throughout|the whole project|project.wide|consistently|every scene/i.test(text);
  }

  const fetchSignedUrl = useCallback(async (generationId: number) => {
    if (pendingFetchesRef.current.has(generationId)) return;
    pendingFetchesRef.current.add(generationId);
    try {
      const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/video?generationId=${generationId}`);
      if (!res.ok) return;
      const { signedUrl } = await res.json() as { signedUrl: string };
      setSignedVideoUrls((prev) => ({ ...prev, [generationId]: signedUrl }));
    } catch { /* */ } finally {
      pendingFetchesRef.current.delete(generationId);
    }
  }, [id, n]);

  const loadSceneData = useCallback(async () => {
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/scene-data`);
    if (!res.ok) return;
    const { promptHistory: hist, generations: gens } = await res.json() as {
      promptHistory: PromptVersion[];
      generations: Generation[];
    };
    setPromptHistory(hist);
    setGenerations(gens);
    if (hist.length > 0) {
      setCurrentPrompt(hist[0].promptText);
      setActivePromptVersionId(hist[0].id);
    }
  }, [id, n]);

  useEffect(() => {
    setPromptHistory([]);
    setGenerations([]);
    setCurrentPrompt('');
    setActivePromptVersionId(null);
    setDisplayGenId(null);
    setError('');
    setFeedback('');
    setActiveTab('prompt');
    void loadSceneData();
  }, [id, n, loadSceneData]);

  // Poll while pending generations exist
  useEffect(() => {
    const hasPending = generations.some(
      (g) => g.generation.status === 'pending' || g.generation.status === 'processing' || g.generation.status === 'queued',
    );
    if (hasPending) {
      pollRef.current = setInterval(async () => {
        const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/scene-data`);
        if (!res.ok) return;
        const { promptHistory: hist, generations: gens } = await res.json() as {
          promptHistory: PromptVersion[];
          generations: Generation[];
        };
        setGenerations(gens);
        setPromptHistory(hist);
        const stillPending = gens.some(
          (g) => g.generation.status === 'pending' || g.generation.status === 'processing' || g.generation.status === 'queued',
        );
        if (!stillPending && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          void refreshProject();
        }
      }, 5000);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [generations.map((g) => `${g.generation.id}:${g.generation.status}`).join(',')]);

  // Auto-fetch signed URL for display generation
  useEffect(() => {
    const latestCompleted = generations.find((g) => g.generation.status === 'completed');
    const id2 = displayGenId ?? latestCompleted?.generation.id;
    if (id2 != null && !signedVideoUrls[id2]) void fetchSignedUrl(id2);
  }, [generations, displayGenId]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  async function handleWritePrompt() {
    if (feedback.trim() && isProjectScopeFeedback(feedback) && !projectScopePending) {
      setProjectScopePending(true);
      return;
    }
    setProjectScopePending(false);
    setWritingPrompt(true);
    setError('');
    const latestGen = generations[0];
    const body: Record<string, unknown> = {};
    if (feedback.trim()) body.nlFeedback = feedback;
    if (feedback.trim() && latestGen) body.reviewingGenerationId = latestGen.generation.id;
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setError(d.error ?? 'Failed'); setWritingPrompt(false); return; }
    const data = await res.json() as { promptText: string; validation?: { issues: string[]; warnings: string[] } };
    setCurrentPrompt(data.promptText);
    if (data.validation) setValidation(data.validation);
    setFeedback('');
    await loadSceneData();
    setWritingPrompt(false);
  }

  async function handleSaveManualEdit() {
    if (!currentPrompt.trim()) return;
    setSavingPrompt(true);
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText: currentPrompt }),
    });
    if (!res.ok) { setError('Save failed'); setSavingPrompt(false); return; }
    await loadSceneData();
    setSavingPrompt(false);
  }

  async function handleGenerateVideo() {
    if (!activePromptVersionId) { setError('No prompt available'); return; }
    setSubmitting(true);
    setError('');
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptVersionId: activePromptVersionId }),
    });
    if (!res.ok) {
      let message = 'Video generation failed. Please try again.';
      try { const d = await res.json(); if (typeof d.error === 'string' && d.error) message = d.error; } catch { /* */ }
      setError(message); setSubmitting(false); return;
    }
    await loadSceneData();
    setSubmitting(false);
  }

  async function handleGenerateWithDuration(duration: number) {
    if (!activePromptVersionId) { setError('No prompt available'); return; }
    setSubmitting(true);
    setError('');
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptVersionId: activePromptVersionId, durationOverride: duration }),
    });
    if (!res.ok) {
      let message = 'Video generation failed. Please try again.';
      try { const d = await res.json(); if (typeof d.error === 'string' && d.error) message = d.error; } catch { /* */ }
      setError(message); setSubmitting(false); return;
    }
    await loadSceneData();
    setSubmitting(false);
  }

  async function handleApprove(generationId: number) {
    setApproving(true);
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generationId }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setError(d.error ?? 'Failed'); setApproving(false); return; }
    await Promise.all([loadSceneData(), refreshProject()]);
    setApproving(false);
  }

  async function handleUnapprove() {
    setApproving(true);
    setError('');
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/unapprove`, { method: 'POST' });
    if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setError(d.error ?? 'Failed to unapprove'); setApproving(false); return; }
    await Promise.all([loadSceneData(), refreshProject()]);
    setApproving(false);
  }

  async function handleGenerateAll() {
    setGeneratingAll(true);
    try {
      await fetch(`/api/v1/video-projects/${id}/generate-all`, { method: 'POST' });
      await loadSceneData();
    } catch { /* */ } finally { setGeneratingAll(false); }
  }

  // ─── Derived state ────────────────────────────────────────────────────────

  const currentScreenNum = parseInt(n, 10);
  const screen = project?.screens.find((s) => s.screenNumber === currentScreenNum);
  const prevScreen = project?.screens.find((s) => s.screenNumber === currentScreenNum - 1);
  const nextScreen = project?.screens.find((s) => s.screenNumber === currentScreenNum + 1);
  const isApproved = !!(screen?.approvedGenerationId);
  const latestVersion = promptHistory[0];
  const hasUnsavedPromptEdits = latestVersion != null && currentPrompt !== latestVersion.promptText;
  const isSaveDisabled = !currentPrompt.trim() || savingPrompt || currentPrompt === latestVersion?.promptText;
  const hasPending = generations.some(
    (g) => g.generation.status === 'pending' || g.generation.status === 'processing' || g.generation.status === 'queued',
  );
  const completedGens = generations.filter((g) => g.generation.status === 'completed' && g.generation.videoStoragePath);
  const resolvedDisplayGenId = displayGenId ?? completedGens[0]?.generation.id ?? null;
  const displayGen = generations.find((g) => g.generation.id === resolvedDisplayGenId) ?? generations[0] ?? null;
  const approvedCount = project?.screens.filter((s) => !!s.approvedGenerationId).length ?? 0;
  const totalScreens = project?.screens.length ?? 0;
  const allScenesApproved = totalScreens > 0 && approvedCount === totalScreens;

  // For "Generation N" label: reverse-index by createdAt so oldest = Gen 1
  const genIndex = (genId: number) => {
    const sorted = [...generations].sort((a, b) => a.generation.createdAt - b.generation.createdAt);
    const idx = sorted.findIndex((g) => g.generation.id === genId);
    return idx === -1 ? 1 : idx + 1;
  };

  const projectSteps = [
    { label: 'Script', status: 'complete' as const },
    { label: 'Breakdown', status: 'complete' as const },
    { label: 'Scenes', status: allScenesApproved ? ('complete' as const) : ('active' as const) },
    { label: 'Compile', status: allScenesApproved ? ('active' as const) : ('pending' as const) },
    { label: 'Review', status: 'pending' as const },
  ];


  if (!project) {
    return (
      <AppShell fullscreen>
        <div style={{ height: 64, background: '#fff', borderBottom: '1px solid #ECECE8' }} />
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ width: 240, borderRight: '1px solid #ECECE8', background: '#FAFAF9' }} />
          <div style={{ flex: 1, padding: '32px 28px' }}>
            <div className="skeleton" style={{ height: 24, width: '40%', marginBottom: 16 }} />
            <div className="skeleton" style={{ height: 300 }} />
          </div>
          <div style={{ width: 420, background: '#fff', borderLeft: '1px solid #ECECE8' }} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell fullscreen>
      <ProjectHeader projectId={id} projectName={project.name} steps={projectSteps} />

      <div className="workspace-shell">

        {/* ── Left sidebar ───────────────────────────────────────────────── */}
        <nav className="scene-nav">
          {/* Header */}
          <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #ECECE8' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ font: '600 13px/1 Satoshi', color: '#111113' }}>Scenes</span>
              <span style={{ font: '500 12px/1 Satoshi', color: '#75757C' }}>{approvedCount} of {totalScreens} approved</span>
            </div>
            {/* Progress bar */}
            <div style={{ height: 4, background: '#ECECE8', borderRadius: 999, marginBottom: 10, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${totalScreens > 0 ? (approvedCount / totalScreens) * 100 : 0}%`, background: '#6C47FF', borderRadius: 999, transition: 'width 0.3s' }} />
            </div>
            {/* Generate all */}
            <button
              onClick={handleGenerateAll}
              disabled={generatingAll || hasPending}
              style={{
                width: '100%', height: 32, border: '1px solid #E4E4E0', borderRadius: 8,
                background: '#fff', font: '500 12px/1 Satoshi', color: '#5E5E65',
                cursor: (generatingAll || hasPending) ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                opacity: (generatingAll || hasPending) ? 0.5 : 1,
              }}
            >
              <IconLayers />
              {generatingAll ? 'Queuing…' : 'Generate all scenes'}
            </button>
          </div>

          {/* Scene list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {project.screens.map((s) => {
              const isActive = s.screenNumber === currentScreenNum;
              const approved = !!s.approvedGenerationId;
              return (
                <Link
                  key={s.id}
                  href={`/video-projects/${id}/screens/${s.screenNumber}`}
                  style={{ textDecoration: 'none' }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '10px 16px',
                    background: isActive ? '#F5F3FF' : 'transparent',
                    borderLeft: `2px solid ${isActive ? '#6C47FF' : 'transparent'}`,
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}>
                    {/* Circle indicator */}
                    <div style={{
                      width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                      background: approved ? '#6C47FF' : '#ECECE8',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: approved ? '#fff' : '#75757C',
                      font: '600 11px/1 Satoshi',
                    }}>
                      {approved ? <IconCheck size={11} /> : s.screenNumber}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ font: `${isActive ? '600' : '500'} 13px/1.3 Satoshi`, color: '#111113', marginBottom: 4 }}>
                        Scene {s.screenNumber}
                      </div>
                      {(() => {
                        const gen = s.latestGen;
                        const isGenerating = gen && ['queued', 'pending', 'processing'].includes(gen.status);
                        const isGenerated = gen && gen.status === 'completed';
                        const isMakingPrompt = s.promptTaskStatus === 'pending' || s.promptTaskStatus === 'processing';
                        if (approved) {
                          return (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 999, background: '#DCFCE7', color: '#16A34A', font: '500 10px/1.4 Satoshi', letterSpacing: '0.02em' }}>
                              Approved
                            </span>
                          );
                        }
                        if (isGenerating) {
                          return (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 999, background: '#FEF9C3', color: '#A16207', font: '500 10px/1.4 Satoshi', letterSpacing: '0.02em' }}>
                              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#CA8A04', animation: 'pulse 1.2s ease-in-out infinite' }} />
                              Generating
                            </span>
                          );
                        }
                        if (isGenerated) {
                          return (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 999, background: '#DBEAFE', color: '#1D4ED8', font: '500 10px/1.4 Satoshi', letterSpacing: '0.02em' }}>
                              Generated
                            </span>
                          );
                        }
                        if (isMakingPrompt) {
                          return (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 999, background: '#EDE9FE', color: '#6D28D9', font: '500 10px/1.4 Satoshi', letterSpacing: '0.02em' }}>
                              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#7C3AED', animation: 'pulse 1.2s ease-in-out infinite' }} />
                              Making prompt
                            </span>
                          );
                        }
                        if (s.hasPrompt) {
                          return (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 999, background: '#F3F4F6', color: '#6B7280', font: '500 10px/1.4 Satoshi', letterSpacing: '0.02em' }}>
                              Ready
                            </span>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </nav>

        {/* ── Middle panel ───────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #ECECE8' }}>

          {/* Middle header */}
          <div style={{ padding: '14px 24px 0', borderBottom: '1px solid #ECECE8', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              {/* Scene title */}
              <span style={{ font: '700 18px/1 Satoshi', letterSpacing: '-0.02em', color: '#111113', marginRight: 2 }}>
                Scene {n}
              </span>

              {/* Direction pill */}
              <button style={{
                height: 26, padding: '0 10px', border: '1px solid #E4E4E0', borderRadius: 999,
                background: '#fff', font: '500 12px/1 Satoshi', color: '#5E5E65',
                display: 'flex', alignItems: 'center', gap: 4, cursor: 'default',
              }}>
                Direction <IconChevronDown />
              </button>

              {/* Version pills */}
              <div style={{ display: 'flex', gap: 4, marginLeft: 2 }}>
                {promptHistory.slice(0, 4).map((v) => {
                  const isActivePill = activePromptVersionId === v.id;
                  return (
                    <button
                      key={v.id}
                      onClick={() => { setCurrentPrompt(v.promptText); setActivePromptVersionId(v.id); setActiveTab('prompt'); }}
                      style={{
                        height: 24, padding: '0 10px', borderRadius: 999, border: 'none',
                        background: isActivePill ? '#6C47FF' : '#F0F0EC',
                        color: isActivePill ? '#fff' : '#5E5E65',
                        font: '500 12px/1 Satoshi', cursor: 'pointer',
                      }}
                    >
                      v{v.version}
                    </button>
                  );
                })}
              </div>

              {/* Prev / next arrows */}
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                {prevScreen ? (
                  <Link href={`/video-projects/${id}/screens/${prevScreen.screenNumber}`}>
                    <button style={{ width: 28, height: 28, border: '1px solid #E4E4E0', borderRadius: 7, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5E5E65' }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                  </Link>
                ) : (
                  <button disabled style={{ width: 28, height: 28, border: '1px solid #E4E4E0', borderRadius: 7, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#C4C4C9', cursor: 'default' }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
                  </button>
                )}
                {nextScreen ? (
                  <Link href={`/video-projects/${id}/screens/${nextScreen.screenNumber}`}>
                    <button style={{ width: 28, height: 28, border: '1px solid #E4E4E0', borderRadius: 7, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5E5E65' }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                  </Link>
                ) : (
                  <button disabled style={{ width: 28, height: 28, border: '1px solid #E4E4E0', borderRadius: 7, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#C4C4C9', cursor: 'default' }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
                  </button>
                )}
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex' }}>
              {(['prompt', 'requests'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    height: 36, padding: '0 4px', marginRight: 16, border: 'none', background: 'none',
                    font: `${activeTab === tab ? '600' : '400'} 13px/1 Satoshi`,
                    color: activeTab === tab ? '#111113' : '#75757C',
                    borderBottom: `2px solid ${activeTab === tab ? '#6C47FF' : 'transparent'}`,
                    cursor: 'pointer',
                  }}
                >
                  {tab === 'prompt' ? 'Prompt' : (
                    <span>
                      Requests{promptHistory.length > 1 && (
                        <span style={{ marginLeft: 5, background: '#F0F0EC', borderRadius: 10, padding: '1px 6px', font: '500 10px/1 Satoshi', color: '#75757C' }}>
                          {promptHistory.length - 1}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Middle body */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
            {error && (
              <div style={{ marginBottom: 14, padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#991B1B', display: 'flex', justifyContent: 'space-between' }}>
                <span>{error}</span>
                <button onClick={() => setError('')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit', lineHeight: 1, padding: 0 }}>×</button>
              </div>
            )}

            {/* Prompt tab */}
            {activeTab === 'prompt' && (
              <>
                {promptHistory.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '48px 0' }}>
                    <div style={{ width: 48, height: 48, borderRadius: 12, background: '#F0F0EC', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16, color: '#6C47FF' }}>
                      <IconSparkle />
                    </div>
                    <div style={{ font: '600 15px/1.3 Satoshi', marginBottom: 6 }}>Write the video prompt</div>
                    <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C', maxWidth: 300, marginBottom: 20 }}>
                      Claude will write a detailed prompt for this scene. Nothing is sent to the video API yet.
                    </div>
                    <button
                      onClick={handleWritePrompt}
                      disabled={writingPrompt}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 18px', borderRadius: 10, background: '#6C47FF', color: '#fff', border: 'none', font: '600 14px/1 Satoshi', cursor: 'pointer', opacity: writingPrompt ? 0.6 : 1 }}
                    >
                      <IconSparkle />
                      {writingPrompt ? 'Writing prompt…' : 'Write prompt'}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {hasUnsavedPromptEdits && (
                          <span style={{ font: '400 12px/1 Satoshi', color: '#92400E' }}>Unsaved changes</span>
                        )}
                      </div>
                      <button
                        onClick={handleSaveManualEdit}
                        disabled={isSaveDisabled}
                        style={{ height: 26, padding: '0 10px', border: '1px solid #E4E4E0', borderRadius: 7, background: '#fff', font: '500 12px/1 Satoshi', color: '#5E5E65', cursor: isSaveDisabled ? 'default' : 'pointer', opacity: isSaveDisabled ? 0.4 : 1 }}
                      >
                        {savingPrompt ? 'Saving…' : 'Save edit'}
                      </button>
                    </div>

                    <textarea
                      value={currentPrompt}
                      onChange={(e) => setCurrentPrompt(e.target.value)}
                      style={{
                        width: '100%', flex: 1, minHeight: 320,
                        border: '1px solid #E4E4E0', borderRadius: 10,
                        padding: '14px 16px', font: '400 13px/1.65 Satoshi',
                        background: '#fff', outline: 'none', resize: 'vertical',
                        boxSizing: 'border-box', color: '#111113',
                      }}
                      onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                      onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                    />

                    {validation && (validation.issues.length > 0 || validation.warnings.length > 0) && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {validation.issues.map((issue, i) => (
                          <div key={i} style={{ padding: '8px 10px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6, font: '400 13px/1.4 Satoshi', color: '#991B1B' }}>{issue}</div>
                        ))}
                        {validation.warnings.map((warn, i) => (
                          <div key={i} style={{ padding: '8px 10px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, font: '400 13px/1.4 Satoshi', color: '#92400E' }}>{warn}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Requests tab */}
            {activeTab === 'requests' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {promptHistory.length <= 1 ? (
                  <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C', textAlign: 'center', padding: '32px 0' }}>No revision requests yet.</div>
                ) : (
                  promptHistory.slice(1).map((v) => (
                    <div
                      key={v.id}
                      onClick={() => { setCurrentPrompt(v.promptText); setActivePromptVersionId(v.id); setActiveTab('prompt'); }}
                      style={{ padding: '10px 14px', border: '1px solid #ECECE8', borderRadius: 10, cursor: 'pointer', background: activePromptVersionId === v.id ? '#F5F3FF' : '#fff' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', height: 18, padding: '0 6px', borderRadius: 10, background: '#EDE9FF', font: '500 10px/1 Satoshi', color: '#6C47FF' }}>v{v.version}</span>
                        <span style={{ font: '400 12px/1 Satoshi', color: '#75757C' }}>{v.source === 'claude' ? 'Claude revision' : 'Manual edit'}</span>
                        <span style={{ marginLeft: 'auto', font: '400 11px/1 Satoshi', color: '#9A9AA0' }}>{new Date(v.createdAt).toLocaleString()}</span>
                      </div>
                      {v.nlFeedback && (
                        <div style={{ font: '400 13px/1.4 Satoshi', color: '#5E5E65', marginTop: 6 }}>{v.nlFeedback}</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Middle footer */}
          {promptHistory.length > 0 && (
            <div style={{ padding: '14px 24px', borderTop: '1px solid #ECECE8', background: '#fff', flexShrink: 0 }}>
              {projectScopePending && (
                <div style={{ marginBottom: 10, padding: '10px 14px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, font: '400 13px/1.4 Satoshi', color: '#78350F' }}>
                  <div style={{ font: '600 13px/1 Satoshi', marginBottom: 6 }}>Apply project-wide?</div>
                  <div style={{ marginBottom: 8 }}>This looks like a project-wide change and may affect all scenes.</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-primary btn-sm" onClick={handleWritePrompt} disabled={writingPrompt}>Apply project-wide</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setProjectScopePending(false)}>Cancel</button>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input
                  type="text"
                  placeholder="Request a change…"
                  value={feedback}
                  onChange={(e) => { setFeedback(e.target.value); setProjectScopePending(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !writingPrompt) handleWritePrompt(); }}
                  style={{ flex: 1, height: 40, border: '1px solid #E4E4E0', borderRadius: 10, padding: '0 14px', font: '400 13px/1 Satoshi', background: '#fff', outline: 'none' }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                />
                <button
                  onClick={handleWritePrompt}
                  disabled={writingPrompt}
                  style={{ width: 40, height: 40, borderRadius: 10, background: '#111113', color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: writingPrompt ? 0.6 : 1 }}
                >
                  {writingPrompt ? (
                    <span style={{ width: 14, height: 14, border: '2px solid #fff', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.6s linear infinite' }} />
                  ) : <IconSend />}
                </button>
              </div>
              {/* Duration selector */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ font: '500 12px/1 Satoshi', color: '#75757C', flexShrink: 0 }}>Duration</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {SUPPORTED_DURATIONS.map((d) => {
                    const isSelected = selectedDuration === d;
                    return (
                      <button
                        key={d}
                        onClick={() => setSelectedDuration(isSelected ? null : d)}
                        style={{
                          height: 28, padding: '0 10px', borderRadius: 999,
                          border: `1px solid ${isSelected ? '#6C47FF' : '#E4E4E0'}`,
                          background: isSelected ? '#6C47FF' : '#fff',
                          color: isSelected ? '#fff' : '#5E5E65',
                          font: '500 12px/1 Satoshi', cursor: 'pointer',
                        }}
                      >
                        {d}s
                      </button>
                    );
                  })}
                </div>
              </div>
              <button
                onClick={() => selectedDuration ? handleGenerateWithDuration(selectedDuration) : handleGenerateVideo()}
                disabled={submitting || !activePromptVersionId || hasUnsavedPromptEdits || hasPending}
                style={{
                  width: '100%', height: 44, borderRadius: 12,
                  background: '#6C47FF', color: '#fff', border: 'none',
                  font: '600 14px/1 Satoshi', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  opacity: (submitting || !activePromptVersionId || hasUnsavedPromptEdits || hasPending) ? 0.5 : 1,
                }}
              >
                <IconPlay />
                {submitting ? 'Generating…' : hasPending ? 'Generating…' : selectedDuration ? `Generate at ${selectedDuration}s` : 'Generate another video'}
              </button>
              {hasUnsavedPromptEdits && (
                <div style={{ font: '400 11px/1 Satoshi', color: '#75757C', marginTop: 6, textAlign: 'center' }}>Save your prompt edits first</div>
              )}
            </div>
          )}
        </div>

        {/* ── Right panel ────────────────────────────────────────────────── */}
        <div style={{ width: 420, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff', borderLeft: '1px solid #ECECE8' }}>

          {/* Right header */}
          {displayGen && (
            <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid #ECECE8', flexShrink: 0 }}>
              <span style={{ font: '600 14px/1 Satoshi', color: '#111113' }}>
                Generation {genIndex(displayGen.generation.id)}
              </span>
              <span style={{ font: '400 13px/1 Satoshi', color: '#9A9AA0', marginLeft: 8 }}>
                Prompt v{displayGen.promptVersion.version} ·
              </span>
            </div>
          )}

          {/* Video area */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '20px', gap: 14, overflowY: 'auto', background: '#FAFAF9' }}>
            {hasPending ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#1A1A1E', borderRadius: 14, minHeight: 360 }}>
                <div className="pulse-dots" style={{ justifyContent: 'center', marginBottom: 12 }}>
                  <div className="pulse-dot" style={{ background: '#6C47FF' }} />
                  <div className="pulse-dot" style={{ background: '#6C47FF' }} />
                  <div className="pulse-dot" style={{ background: '#6C47FF' }} />
                </div>
                <div style={{ font: '600 14px/1.3 Satoshi', color: '#E8E8F0' }}>Generating clip…</div>
                <div style={{ font: '400 12px/1.4 Satoshi', color: '#75757C', marginTop: 6 }}>Usually 1–3 minutes</div>
              </div>
            ) : displayGen?.generation.status === 'completed' && displayGen.generation.videoStoragePath ? (
              <div style={{ background: '#1A1A1E', borderRadius: 14 }}>
                {signedVideoUrls[displayGen.generation.id] ? (
                  <video
                    key={displayGen.generation.id}
                    src={signedVideoUrls[displayGen.generation.id]}
                    controls
                    style={{ width: '100%', borderRadius: 10, background: '#000', display: 'block' }}
                  />
                ) : (
                  <div style={{ paddingBottom: '177.78%', position: 'relative' }}>
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{
                        width: 56, height: 56, borderRadius: '50%', background: 'rgba(255,255,255,0.15)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                      }}>
                        <IconPlay />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ paddingBottom: '177.78%', background: '#1A1A1E', borderRadius: 14, position: 'relative' }}>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: '50%', background: 'rgba(255,255,255,0.1)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)',
                  }}>
                    <IconPlay />
                  </div>
                  <div style={{ font: '400 12px/1.4 Satoshi', color: '#75757C', textAlign: 'center', maxWidth: 160 }}>
                    {promptHistory.length === 0 ? 'Write a prompt first' : 'Generate a video to see it here'}
                  </div>
                </div>
              </div>
            )}

            {/* Thumbnail strip */}
            {completedGens.length > 0 && (
              <div style={{ display: 'flex', gap: 8 }}>
                {completedGens.map(({ generation: g }) => {
                  const isSelected = g.id === resolvedDisplayGenId;
                  const num = genIndex(g.id);
                  return (
                    <div
                      key={g.id}
                      onClick={() => { setDisplayGenId(g.id); void fetchSignedUrl(g.id); }}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'pointer' }}
                    >
                      <div style={{
                        width: 60, height: 80, borderRadius: 8, background: '#1A1A1E', flexShrink: 0,
                        border: `2px solid ${isSelected ? '#6C47FF' : 'transparent'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden',
                      }}>
                        <div style={{ color: 'rgba(255,255,255,0.3)' }}><IconPlay /></div>
                        {isSelected && (
                          <div style={{
                            position: 'absolute', top: 4, right: 4, width: 16, height: 16,
                            borderRadius: '50%', background: '#6C47FF',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                          }}>
                            <IconCheck size={9} />
                          </div>
                        )}
                      </div>
                      <span style={{ font: '500 10px/1 Satoshi', color: '#9A9AA0' }}>Gen {num}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right footer */}
          <div style={{ padding: '14px 20px', borderTop: '1px solid #ECECE8', background: '#fff', flexShrink: 0, display: 'flex', gap: 8 }}>
            {isApproved ? (
              <>
                <button
                  onClick={handleUnapprove}
                  disabled={approving}
                  style={{
                    flex: 1, height: 40, border: '1.5px solid #6C47FF', borderRadius: 10,
                    background: '#fff', color: '#6C47FF', font: '600 13px/1 Satoshi',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    opacity: approving ? 0.6 : 1,
                  }}
                >
                  <IconCheck size={13} />
                  {approving ? 'Removing…' : 'Approved'}
                </button>
                <button
                  onClick={handleUnapprove}
                  disabled={approving}
                  style={{ height: 40, padding: '0 16px', border: '1px solid #E4E4E0', borderRadius: 10, background: '#fff', color: '#5E5E65', font: '500 13px/1 Satoshi', cursor: 'pointer', opacity: approving ? 0.5 : 1 }}
                >
                  Remove
                </button>
                {nextScreen && (
                  <Link href={`/video-projects/${id}/screens/${nextScreen.screenNumber}`}>
                    <button style={{ width: 40, height: 40, border: 'none', borderRadius: 10, background: '#111113', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                      <IconArrowRight />
                    </button>
                  </Link>
                )}
                {!nextScreen && allScenesApproved && (
                  <Link href={`/video-projects/${id}/compile`}>
                    <button style={{ height: 40, padding: '0 14px', border: 'none', borderRadius: 10, background: '#111113', color: '#fff', font: '600 13px/1 Satoshi', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      Compile →
                    </button>
                  </Link>
                )}
              </>
            ) : displayGen?.generation.status === 'completed' ? (
              <>
                <button
                  onClick={() => handleApprove(displayGen.generation.id)}
                  disabled={approving}
                  style={{
                    flex: 1, height: 40, border: 'none', borderRadius: 10,
                    background: '#6C47FF', color: '#fff', font: '600 13px/1 Satoshi',
                    cursor: 'pointer', opacity: approving ? 0.6 : 1,
                  }}
                >
                  {approving ? 'Approving…' : 'Approve'}
                </button>
                {nextScreen && (
                  <Link href={`/video-projects/${id}/screens/${nextScreen.screenNumber}`}>
                    <button style={{ width: 40, height: 40, border: '1px solid #E4E4E0', borderRadius: 10, background: '#fff', color: '#5E5E65', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                      <IconArrowRight />
                    </button>
                  </Link>
                )}
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: 40 }}>
                <span style={{ font: '400 13px/1 Satoshi', color: '#9A9AA0' }}>
                  {promptHistory.length === 0 ? 'Write a prompt first' : 'Generate a video to approve'}
                </span>
              </div>
            )}
          </div>
        </div>

      </div>
    </AppShell>
  );
}
