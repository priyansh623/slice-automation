'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import FeedbackModal from '@/components/FeedbackModal';
import ProjectHeader from '@/components/ProjectHeader';

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

interface Screen {
  id: number;
  screenNumber: number;
  dialogue: string;
  position: number;
  approvedGenerationId: number | null;
  durationSeconds: number | null;
}

const SUPPORTED_DURATIONS = [4, 6, 8, 10];

interface VideoProject {
  id: number;
  name: string;
  baseImagePreviewUrl?: string;
  screens: Screen[];
}

function IconSparkle() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function IconVideo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <polygon points="23 7 16 12 23 17 23 7"/>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
    </svg>
  );
}

export default function ScreenPage() {
  const { id, n } = useParams<{ id: string; n: string }>();

  const [project, setProject] = useState<VideoProject | null>(null);
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
  const [showHistory, setShowHistory] = useState(false);
  const [validation, setValidation] = useState<{ issues: string[]; warnings: string[] } | null>(null);
  const [projectScopePending, setProjectScopePending] = useState(false);
  const [signedVideoUrls, setSignedVideoUrls] = useState<Record<number, string>>({});
  const [feedbackGenId, setFeedbackGenId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'prompt' | 'requests'>('prompt');
  const [generatingAll, setGeneratingAll] = useState(false);
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

  async function loadAll() {
    const [projRes, histRes, genRes] = await Promise.all([
      fetch(`/api/v1/video-projects/${id}`),
      fetch(`/api/v1/video-projects/${id}/screens/${n}/prompt-history`),
      fetch(`/api/v1/video-projects/${id}/screens/${n}/generations`),
    ]);
    if (!projRes.ok || !histRes.ok || !genRes.ok) return;
    const proj: VideoProject = await projRes.json();
    const hist: PromptVersion[] = await histRes.json();
    const gens: Generation[] = await genRes.json();
    setProject(proj);
    setPromptHistory(hist);
    setGenerations(gens);
    if (hist.length > 0 && !activePromptVersionId) {
      setCurrentPrompt(hist[0].promptText);
      setActivePromptVersionId(hist[0].id);
    } else if (hist.length > 0) {
      // refresh current prompt if a new version was written
      setCurrentPrompt(hist[0].promptText);
      setActivePromptVersionId(hist[0].id);
    }
  }

  // Auto-poll when any generation is pending or processing
  useEffect(() => {
    loadAll();
  }, [id, n]);

  useEffect(() => {
    const hasPending = generations.some(
      (g) => g.generation.status === 'pending' || g.generation.status === 'processing' || g.generation.status === 'queued',
    );
    if (hasPending) {
      pollRef.current = setInterval(async () => {
        const [genRes, histRes] = await Promise.all([
          fetch(`/api/v1/video-projects/${id}/screens/${n}/generations`),
          fetch(`/api/v1/video-projects/${id}/screens/${n}/prompt-history`),
        ]);
        if (!genRes.ok || !histRes.ok) return;
        const gens: Generation[] = await genRes.json();
        const hist: PromptVersion[] = await histRes.json();
        setGenerations(gens);
        setPromptHistory(hist);
        const stillPending = gens.some(
          (g) => g.generation.status === 'pending' || g.generation.status === 'processing' || g.generation.status === 'queued',
        );
        if (!stillPending && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          // Reload project to pick up approvedGenerationId changes
          const projRes = await fetch(`/api/v1/video-projects/${id}`);
          if (projRes.ok) { const proj = await projRes.json(); setProject(proj); }
        }
      }, 5000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [generations.map((g) => `${g.generation.id}:${g.generation.status}`).join(',')]);

  // Trigger signed URL fetch when the display generation changes — not from render body.
  useEffect(() => {
    const latestCompleted = generations.find((g) => g.generation.status === 'completed');
    const displayGeneration = latestCompleted ?? generations[0];
    const genId = displayGeneration?.generation?.id;
    if (genId != null && !signedVideoUrls[genId]) {
      void fetchSignedUrl(genId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generations]);

  async function handleUnapprove() {
    setApproving(true);
    setError('');
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/unapprove`, { method: 'POST' });
    if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setError(d.error ?? 'Failed to unapprove'); setApproving(false); return; }
    await loadAll();
    setApproving(false);
  }

  async function handleWritePrompt() {
    // If feedback looks project-wide, show confirmation before sending
    if (feedback.trim() && isProjectScopeFeedback(feedback) && !projectScopePending) {
      setProjectScopePending(true);
      return;
    }
    setProjectScopePending(false);
    setWritingPrompt(true);
    setError('');
    const body: Record<string, unknown> = {};
    if (feedback.trim()) body.nlFeedback = feedback;
    // Pass the generation being reviewed so feedback is saved against it immediately
    if (feedback.trim() && latestGen) body.reviewingGenerationId = latestGen.generation.id;
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setError(d.error ?? 'Failed'); setWritingPrompt(false); return; }
    const data = await res.json();
    setCurrentPrompt(data.promptText);
    if (data.validation) setValidation(data.validation);
    setFeedback('');
    await loadAll();
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
    await loadAll();
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
      try {
        const d = await res.json();
        if (typeof d.error === 'string' && d.error) message = d.error;
      } catch {
        // response body was empty or not JSON — use the fallback message
      }
      setError(message);
      setSubmitting(false);
      return;
    }
    await loadAll();
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
      try {
        const d = await res.json();
        if (typeof d.error === 'string' && d.error) message = d.error;
      } catch { /* empty body */ }
      setError(message);
      setSubmitting(false);
      return;
    }
    await loadAll();
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
    await loadAll();
    setApproving(false);
  }

  // ─── Derived state ────────────────────────────────────────────────────────
  const latestVersion = promptHistory[0];
  const hasUnsavedPromptEdits = latestVersion != null && currentPrompt !== latestVersion.promptText;
  const isSaveDisabled = !currentPrompt.trim() || savingPrompt || currentPrompt === latestVersion?.promptText;
  const screen = project?.screens.find((s) => s.screenNumber === parseInt(n, 10));
  const prevScreen = project?.screens.find((s) => s.screenNumber === parseInt(n, 10) - 1);
  const nextScreen = project?.screens.find((s) => s.screenNumber === parseInt(n, 10) + 1);
  const isApproved = !!(screen?.approvedGenerationId);
  const approvedGen = isApproved ? generations.find((g) => g.generation.id === screen?.approvedGenerationId) : null;
  const latestGen = generations[0];
  const hasPending = generations.some(
    (g) => g.generation.status === 'pending' || g.generation.status === 'processing' || g.generation.status === 'queued',
  );
  const hasReadyVideo = generations.some((g) => g.generation.status === 'completed');
  const approvedCount = project?.screens.filter((s) => !!s.approvedGenerationId).length ?? 0;

  const currentScreenNum = parseInt(n, 10);

  async function handleGenerateAllScenes() {
    if (!activePromptVersionId) return;
    setGeneratingAll(true);
    try {
      await fetch(`/api/v1/video-projects/${id}/screens/${n}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptVersionId: activePromptVersionId }),
      });
      await loadAll();
    } catch { /* ignore */ } finally {
      setGeneratingAll(false);
    }
  }

  if (!project) {
    return (
      <AppShell fullscreen>
        <div className="page-header">
          <div className="skeleton" style={{ height: 20, width: 200 }} />
        </div>
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ width: 252, borderRight: '1px solid var(--border)', flexShrink: 0 }} />
          <div style={{ flex: 1, padding: '24px 32px' }}>
            <div className="skeleton" style={{ height: 28, width: '50%', marginBottom: 16 }} />
            <div className="skeleton" style={{ height: 320 }} />
          </div>
        </div>
      </AppShell>
    );
  }

  const allScenesApproved = project.screens.length > 0 && project.screens.every((s) => !!s.approvedGenerationId);
  const projectSteps = [
    { label: 'Script', status: 'complete' as const },
    { label: 'Breakdown', status: 'complete' as const },
    { label: 'Scenes', status: allScenesApproved ? ('complete' as const) : ('active' as const) },
    { label: 'Compile', status: allScenesApproved ? ('active' as const) : ('pending' as const) },
    { label: 'Review', status: 'pending' as const },
  ];

  // The latest completed generation for the right panel
  const latestCompletedGen = generations.find((g) => g.generation.status === 'completed');
  const displayGen = latestCompletedGen ?? latestGen;

  return (
    <AppShell fullscreen>
      <ProjectHeader projectId={id} projectName={project.name} steps={projectSteps} />

      <div className="workspace-shell">

        {/* ── Scene nav ─────────────────────────────────────────────────── */}
        <nav className="scene-nav">
          {/* Nav header with count + generate-all */}
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #ECECE8' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ font: '600 11px/1 Satoshi', letterSpacing: '0.07em', textTransform: 'uppercase', color: '#9A9AA0' }}>Scenes</span>
              <span style={{ font: '500 11px/1 Satoshi', color: '#75757C' }}>{approvedCount} / {project.screens.length}</span>
            </div>
            <button
              onClick={handleGenerateAllScenes}
              disabled={generatingAll || !activePromptVersionId || hasPending}
              style={{
                width: '100%', height: 32, borderRadius: 8, border: '1px solid #E4E4E0',
                background: '#fff', font: '500 12px/1 Satoshi', color: '#5E5E65',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                opacity: (generatingAll || !activePromptVersionId || hasPending) ? 0.5 : 1,
              }}
            >
              <IconVideo />
              {generatingAll ? 'Queuing…' : 'Generate all scenes'}
            </button>
          </div>

          {/* Scene items */}
          {project.screens.map((s) => {
            const isActive = s.screenNumber === currentScreenNum;
            return (
              <Link
                key={s.id}
                href={`/video-projects/${id}/screens/${s.screenNumber}`}
                className={`scene-nav-item${isActive ? ' scene-nav-item--active' : ''}`}
              >
                <div className="scene-nav-item-top">
                  <span className="scene-nav-item-number">Scene {s.screenNumber}</span>
                  {s.approvedGenerationId ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 500, color: '#15803D' }}>
                      <IconCheck /> Done
                    </span>
                  ) : null}
                </div>
                {s.dialogue ? (
                  <div className="scene-nav-item-dialogue">{s.dialogue}</div>
                ) : null}
              </Link>
            );
          })}
        </nav>

        {/* ── Middle panel ───────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #ECECE8' }}>

          {/* Middle header */}
          <div style={{ padding: '16px 24px 0', borderBottom: '1px solid #ECECE8', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ font: '700 18px/1.2 Satoshi', letterSpacing: '-0.02em' }}>Scene {n}</div>
                {screen?.dialogue && (
                  <div style={{ font: '400 13px/1.4 Satoshi', color: '#75757C', marginTop: 2, maxWidth: 360 }}>
                    {screen.dialogue.slice(0, 80)}{screen.dialogue.length > 80 ? '…' : ''}
                  </div>
                )}
              </div>
              {/* Scene 1 calibration badge */}
              {currentScreenNum === 1 && !isApproved && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 999, background: '#F0F0EC', font: '500 11px/1 Satoshi', color: '#5E5E65', flexShrink: 0 }}>
                  Calibration scene
                </span>
              )}
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 0 }}>
              {(['prompt', 'requests'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    height: 36, padding: '0 16px', border: 'none', background: 'none',
                    font: `${activeTab === tab ? '600' : '400'} 13px/1 Satoshi`,
                    color: activeTab === tab ? '#111113' : '#75757C',
                    borderBottom: `2px solid ${activeTab === tab ? '#6C47FF' : 'transparent'}`,
                    cursor: 'pointer', textTransform: 'capitalize',
                  }}
                >
                  {tab === 'prompt' ? 'Prompt' : 'Requests'}
                  {tab === 'requests' && promptHistory.length > 1 && (
                    <span style={{ marginLeft: 5, background: '#F0F0EC', borderRadius: 10, padding: '1px 6px', font: '500 10px/1 Satoshi', color: '#75757C' }}>
                      {promptHistory.length - 1}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Middle body — scrollable */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>

            {error && (
              <div style={{ marginBottom: 16, padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#991B1B', display: 'flex', justifyContent: 'space-between' }}>
                <span>{error}</span>
                <button onClick={() => setError('')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit', lineHeight: 1, padding: 0 }}>×</button>
              </div>
            )}

            {/* Prompt tab */}
            {activeTab === 'prompt' && (
              <>
                {promptHistory.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '48px 0' }}>
                    <div style={{ width: 48, height: 48, borderRadius: 12, background: '#F0F0EC', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                      <IconSparkle />
                    </div>
                    <div style={{ font: '600 15px/1.3 Satoshi', marginBottom: 6 }}>Write the video prompt</div>
                    <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C', maxWidth: 300, marginBottom: 20 }}>
                      Claude will write a detailed prompt for this scene using the dialogue above. Nothing is sent to the video API yet.
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ font: '600 13px/1 Satoshi' }}>Prompt</span>
                        {latestVersion && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px', borderRadius: 10, background: '#EDE9FF', font: '500 11px/1 Satoshi', color: '#6C47FF' }}>
                            v{latestVersion.version}
                          </span>
                        )}
                        {hasUnsavedPromptEdits && (
                          <span style={{ font: '400 12px/1 Satoshi', color: '#92400E' }}>Unsaved changes</span>
                        )}
                      </div>
                      <button
                        onClick={handleSaveManualEdit}
                        disabled={isSaveDisabled}
                        style={{ height: 28, padding: '0 12px', border: '1px solid #E4E4E0', borderRadius: 7, background: '#fff', font: '500 12px/1 Satoshi', color: '#5E5E65', cursor: isSaveDisabled ? 'default' : 'pointer', opacity: isSaveDisabled ? 0.5 : 1 }}
                      >
                        {savingPrompt ? 'Saving…' : 'Save edit'}
                      </button>
                    </div>

                    <textarea
                      value={currentPrompt}
                      onChange={(e) => setCurrentPrompt(e.target.value)}
                      rows={12}
                      style={{
                        width: '100%', border: '1px solid #E4E4E0', borderRadius: 10,
                        padding: '12px 14px', font: '400 13px/1.6 Satoshi', background: '#fff',
                        outline: 'none', resize: 'vertical', boxSizing: 'border-box',
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
                  promptHistory.slice(1).map((v, idx) => (
                    <div
                      key={v.id}
                      style={{ padding: '10px 14px', border: '1px solid #ECECE8', borderRadius: 10, cursor: 'pointer', background: activePromptVersionId === v.id ? '#F5F3FF' : '#fff' }}
                      onClick={() => { setCurrentPrompt(v.promptText); setActivePromptVersionId(v.id); setActiveTab('prompt'); }}
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

          {/* Middle footer — Request a change + Generate video */}
          {promptHistory.length > 0 && (
            <div style={{ padding: '16px 24px', borderTop: '1px solid #ECECE8', background: '#fff', flexShrink: 0 }}>
              {projectScopePending && (
                <div style={{ marginBottom: 10, padding: '10px 14px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, font: '400 13px/1.4 Satoshi', color: '#78350F' }}>
                  <div style={{ font: '600 13px/1 Satoshi', marginBottom: 6 }}>Apply project-wide?</div>
                  <div style={{ marginBottom: 8 }}>This looks like a project-wide change. It will update the creative brief and may affect all scenes.</div>
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
                  style={{
                    flex: 1, height: 38, border: '1px solid #E4E4E0', borderRadius: 9,
                    padding: '0 14px', font: '400 14px/1 Satoshi', background: '#fff', outline: 'none',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                />
                <button
                  onClick={handleWritePrompt}
                  disabled={writingPrompt}
                  style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#111113', color: '#fff', border: 'none', font: '600 14px/1 Satoshi', cursor: 'pointer', opacity: writingPrompt ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
                >
                  <IconSparkle />
                  {writingPrompt ? 'Revising…' : 'Revise'}
                </button>
              </div>
              <button
                onClick={handleGenerateVideo}
                disabled={submitting || !activePromptVersionId || hasUnsavedPromptEdits || hasPending}
                style={{
                  width: '100%', height: 42, borderRadius: 10,
                  background: '#6C47FF', color: '#fff', border: 'none',
                  font: '600 15px/1 Satoshi', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  opacity: (submitting || !activePromptVersionId || hasUnsavedPromptEdits || hasPending) ? 0.5 : 1,
                }}
              >
                <IconVideo />
                {submitting ? 'Generating…' : hasPending ? 'Generation in progress…' : 'Generate video'}
              </button>
              {hasUnsavedPromptEdits && (
                <div style={{ font: '400 11px/1 Satoshi', color: '#75757C', marginTop: 6, textAlign: 'center' }}>Save your prompt edits first</div>
              )}
            </div>
          )}
        </div>

        {/* ── Right video panel ──────────────────────────────────────────── */}
        <div style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#1A1A1E', overflow: 'hidden' }}>

          {/* Video area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, gap: 16 }}>
            {hasPending ? (
              <div style={{ textAlign: 'center' }}>
                <div className="pulse-dots" style={{ justifyContent: 'center', marginBottom: 12 }}>
                  <div className="pulse-dot" style={{ background: '#6C47FF' }} />
                  <div className="pulse-dot" style={{ background: '#6C47FF' }} />
                  <div className="pulse-dot" style={{ background: '#6C47FF' }} />
                </div>
                <div style={{ font: '600 14px/1.3 Satoshi', color: '#E8E8F0' }}>Generating clip…</div>
                <div style={{ font: '400 12px/1.4 Satoshi', color: '#75757C', marginTop: 6 }}>Usually 1-3 minutes</div>
              </div>
            ) : displayGen?.generation.status === 'completed' && displayGen.generation.videoStoragePath ? (
              <div style={{ width: '100%' }}>
                {signedVideoUrls[displayGen.generation.id] ? (
                  <video
                    src={signedVideoUrls[displayGen.generation.id]}
                    controls
                    style={{ width: '100%', borderRadius: 10, background: '#000', display: 'block' }}
                  />
                ) : (
                  <div style={{ width: '100%', paddingBottom: '177.78%', background: '#2A2A30', borderRadius: 10, position: 'relative' }}>
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ font: '400 12px/1 Satoshi', color: '#75757C' }}>Loading…</div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ width: '100%', paddingBottom: '177.78%', background: '#2A2A30', borderRadius: 10, position: 'relative' }}>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }}>
                  <IconVideo />
                  <div style={{ font: '400 12px/1.4 Satoshi', color: '#75757C', textAlign: 'center', maxWidth: 180 }}>
                    {promptHistory.length === 0 ? 'Write a prompt first' : 'Generate a video to see it here'}
                  </div>
                </div>
              </div>
            )}

            {/* Thumbnail strip for earlier clips */}
            {generations.filter((g) => g.generation.status === 'completed' && g.generation.videoStoragePath).length > 1 && (
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', width: '100%' }}>
                {generations.filter((g) => g.generation.status === 'completed' && g.generation.videoStoragePath).map(({ generation: g }) => (
                  <div
                    key={g.id}
                    onClick={() => { void fetchSignedUrl(g.id); }}
                    style={{
                      width: 52, height: 80, borderRadius: 6, background: '#2A2A30', flexShrink: 0, cursor: 'pointer',
                      border: `2px solid ${g.id === displayGen?.generation.id ? '#6C47FF' : 'transparent'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <IconVideo />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right panel footer — approve / unapprove / next */}
          <div style={{ padding: '16px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
            {isApproved ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                  <span style={{ font: '500 13px/1 Satoshi', color: '#E8E8F0' }}>Scene {n} approved</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={handleUnapprove}
                    disabled={approving}
                    style={{ flex: 1, height: 36, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, background: 'transparent', font: '500 13px/1 Satoshi', color: '#A3A3A9', cursor: 'pointer' }}
                  >
                    {approving ? 'Updating…' : 'Unapprove'}
                  </button>
                  {nextScreen && (
                    <Link href={`/video-projects/${id}/screens/${nextScreen.screenNumber}`} style={{ flex: 1 }}>
                      <button style={{ width: '100%', height: 36, borderRadius: 8, background: '#6C47FF', color: '#fff', border: 'none', font: '600 13px/1 Satoshi', cursor: 'pointer' }}>
                        Scene {nextScreen.screenNumber} →
                      </button>
                    </Link>
                  )}
                </div>
              </div>
            ) : displayGen?.generation.status === 'completed' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button
                  onClick={() => handleApprove(displayGen.generation.id)}
                  disabled={approving}
                  style={{ width: '100%', height: 40, borderRadius: 10, background: '#22c55e', color: '#fff', border: 'none', font: '600 14px/1 Satoshi', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: approving ? 0.6 : 1 }}
                >
                  <IconCheck />
                  {approving ? 'Approving…' : 'Approve clip'}
                </button>
                <button
                  onClick={handleGenerateVideo}
                  disabled={submitting || hasUnsavedPromptEdits || hasPending}
                  style={{ width: '100%', height: 36, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, background: 'transparent', font: '500 13px/1 Satoshi', color: '#A3A3A9', cursor: 'pointer', opacity: (submitting || hasUnsavedPromptEdits || hasPending) ? 0.5 : 1 }}
                >
                  {submitting ? 'Generating…' : 'Generate another'}
                </button>
                {generations.some((g) => g.generation.status === 'failed') && (
                  <div style={{ font: '400 11px/1.3 Satoshi', color: '#EF4444', textAlign: 'center' }}>
                    {generations.filter((g) => g.generation.status === 'failed').length} generation{generations.filter((g) => g.generation.status === 'failed').length > 1 ? 's' : ''} failed
                  </div>
                )}
              </div>
            ) : (
              <div style={{ font: '400 12px/1.5 Satoshi', color: '#75757C', textAlign: 'center' }}>
                {promptHistory.length === 0 ? 'Write a prompt to get started' : 'Generate a video clip to approve it'}
              </div>
            )}
          </div>
        </div>

      </div>

      {feedbackGenId != null && (
        <FeedbackModal
          videoGenerationId={feedbackGenId}
          videoProjectId={project?.id}
          onClose={() => setFeedbackGenId(null)}
        />
      )}
    </AppShell>
  );
}
