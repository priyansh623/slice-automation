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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function isProjectScopeFeedback(text: string): boolean {
    return /across all scenes|throughout|in every scene|all scenes|his voice throughout|her voice throughout|the whole project|project.wide|consistently|every scene/i.test(text);
  }

  const fetchSignedUrl = useCallback(async (generationId: number) => {
    if (signedVideoUrls[generationId]) return;
    try {
      const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/video?generationId=${generationId}`);
      if (!res.ok) return;
      const { signedUrl } = await res.json() as { signedUrl: string };
      setSignedVideoUrls((prev) => ({ ...prev, [generationId]: signedUrl }));
    } catch { /* will retry on next render */ }
  }, [id, n, signedVideoUrls]);

  async function loadAll() {
    const [projRes, histRes, genRes] = await Promise.all([
      fetch(`/api/v1/video-projects/${id}`),
      fetch(`/api/v1/video-projects/${id}/screens/${n}/prompt-history`),
      fetch(`/api/v1/video-projects/${id}/screens/${n}/generations`),
    ]);
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
          const proj = await projRes.json();
          setProject(proj);
        }
      }, 5000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [generations.map((g) => `${g.generation.id}:${g.generation.status}`).join(',')]);

  async function handleUnapprove() {
    setApproving(true);
    setError('');
    const res = await fetch(`/api/v1/video-projects/${id}/screens/${n}/unapprove`, { method: 'POST' });
    if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Failed to unapprove'); setApproving(false); return; }
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
    if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Failed'); setWritingPrompt(false); return; }
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
    if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Failed'); setApproving(false); return; }
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

  const currentScreenNum = parseInt(n, 10);

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

  return (
    <AppShell fullscreen>
      {/* ── Project header with step indicator ───────────────────────────── */}
      <ProjectHeader projectId={id} projectName={project.name} steps={projectSteps} />

      {/* ── Full-height workspace ───────────────────────────────────────────── */}
      <div className="workspace-shell">

        {/* ── Scene list navigator ───────────────────────────────────────── */}
        <nav className="scene-nav">
          <div className="scene-nav-header">Scenes</div>
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

        {/* ── Main work area ─────────────────────────────────────────────── */}
        <div className="workspace-main">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Scene {n}</h1>
            {screen?.dialogue && (
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>· {screen.dialogue.slice(0, 60)}{screen.dialogue.length > 60 ? '…' : ''}</span>
            )}
          </div>

        {error && (
          <div className="alert alert-error" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <span>{error}</span>
            <button onClick={() => setError('')} style={{ marginLeft: 12, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit', lineHeight: 1, padding: 0 }} title="Dismiss">×</button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* ── Phase 1: No prompt yet ──── */}
            {promptHistory.length === 0 && (
              <>
                <div className="stage-banner stage-banner-purple">
                  <div className="stage-banner-icon"><IconSparkle /></div>
                  <div>
                    <div className="stage-banner-title">Step 3: Write the video prompt</div>
                    <div className="stage-banner-desc">
                      Claude will write a detailed video prompt for this scene using the skill and the dialogue above. You can review and edit it before generating anything.
                    </div>
                  </div>
                </div>
                <div className="action-well">
                  <div className="action-well-title">Ready to write the prompt</div>
                  <div className="action-well-desc">
                    Click <strong>Write prompt</strong> and Claude will create a prompt for this scene. Nothing is sent to the video API yet. You review and generate separately.
                  </div>
                  <button className="btn btn-primary" onClick={handleWritePrompt} disabled={writingPrompt} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <IconSparkle />
                    {writingPrompt ? 'Writing prompt…' : 'Write prompt'}
                  </button>
                </div>
              </>
            )}

            {/* ── Phase 2+: Has a prompt ─── */}
            {promptHistory.length > 0 && (
              <>
                {/* Approved banner - full width */}
                {isApproved && (
                  <div className="stage-banner stage-banner-green">
                    <div className="stage-banner-icon"><IconCheck /></div>
                    <div style={{ flex: 1 }}>
                      <div className="stage-banner-title">Scene {n} is approved</div>
                      <div className="stage-banner-desc">
                        {nextScreen
                          ? `This clip is approved. Move on to Scene ${nextScreen.screenNumber} to continue.`
                          : 'This is the last scene and it\'s approved. Your video project is complete.'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button className="btn btn-secondary btn-sm" onClick={handleUnapprove} disabled={approving} title="Revoke approval — keeps all generated clips and history">
                        {approving ? 'Updating…' : 'Unapprove'}
                      </button>
                      {nextScreen && (
                        <Link href={`/video-projects/${id}/screens/${nextScreen.screenNumber}`}>
                          <button className="btn btn-primary btn-sm" style={{ whiteSpace: 'nowrap' }}>Scene {nextScreen.screenNumber} →</button>
                        </Link>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Side-by-side: prompt panel + video panel ─── */}
                <div className="screen-panels">

                  {/* Prompt panel */}
                  <div className="card">
                    <div className="card-header">
                      <div>
                        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          Prompt
                          {latestVersion && <span className="badge badge-purple">v{latestVersion.version}</span>}
                        </div>
                        <div className="card-subtitle">
                          {latestVersion && currentPrompt !== latestVersion.promptText
                            ? <span style={{ color: 'var(--warning-text, #92400e)', fontWeight: 500 }}>Unsaved changes — save before generating</span>
                            : 'Exactly what will be sent to Google Flow'}
                        </div>
                      </div>
                      <button className="btn btn-secondary btn-sm" onClick={handleSaveManualEdit} disabled={isSaveDisabled} title={currentPrompt === latestVersion?.promptText ? 'No changes to save' : undefined}>
                        {savingPrompt ? 'Saving…' : 'Save edit'}
                      </button>
                    </div>
                    <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <textarea className="form-textarea" value={currentPrompt} onChange={(e) => setCurrentPrompt(e.target.value)} rows={9} />

                      {validation && (validation.issues.length > 0 || validation.warnings.length > 0) && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {validation.issues.map((issue, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, padding: '8px 10px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6, fontSize: 13, color: '#991B1B' }}>
                              <span style={{ flexShrink: 0 }}>!</span><span>{issue}</span>
                            </div>
                          ))}
                          {validation.warnings.map((warn, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, padding: '8px 10px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, fontSize: 13, color: '#92400E' }}>
                              <span style={{ flexShrink: 0 }}>~</span><span>{warn}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="Request a change…"
                          value={feedback}
                          onChange={(e) => { setFeedback(e.target.value); setProjectScopePending(false); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !writingPrompt) handleWritePrompt(); }}
                          style={{ flex: 1, marginBottom: 0 }}
                        />
                        <button
                          onClick={handleWritePrompt}
                          disabled={writingPrompt}
                          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#111113', color: '#fff', border: 'none', borderRadius: 'var(--radius-btn)', fontSize: 13, fontWeight: 500, cursor: writingPrompt ? 'not-allowed' : 'pointer', opacity: writingPrompt ? 0.6 : 1, whiteSpace: 'nowrap' }}
                        >
                          <IconSparkle />
                          {writingPrompt ? 'Revising…' : 'Revise'}
                        </button>
                      </div>

                      {projectScopePending && (
                        <div style={{ padding: '12px 14px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <p style={{ margin: 0, fontSize: 13, color: '#78350F', fontWeight: 500 }}>
                            This looks like a project-wide change. Applying it will update the creative brief and may affect prompts for all scenes.
                          </p>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-primary btn-sm" onClick={handleWritePrompt} disabled={writingPrompt}>Apply project-wide</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => setProjectScopePending(false)}>Cancel</button>
                          </div>
                        </div>
                      )}

                      {promptHistory.length > 1 && (
                        <div>
                          <button className="collapsible-trigger" onClick={() => setShowHistory((v) => !v)}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12" style={{ transform: showHistory ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                              <polyline points="9 18 15 12 9 6"/>
                            </svg>
                            {promptHistory.length} prompt versions
                          </button>
                          {showHistory && (
                            <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                              {promptHistory.map((v, idx) => (
                                <div
                                  key={v.id}
                                  style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: idx > 0 ? '1px solid var(--border)' : 'none', padding: '9px 14px', background: activePromptVersionId === v.id ? 'var(--brand-light)' : 'transparent', cursor: 'pointer' }}
                                  onClick={() => { setCurrentPrompt(v.promptText); setActivePromptVersionId(v.id); }}
                                >
                                  <span className="badge badge-purple">v{v.version}</span>
                                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{v.source === 'claude' ? 'Written by Claude' : 'Manual edit'}</span>
                                  {v.nlFeedback && (
                                    <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>· {v.nlFeedback}</span>
                                  )}
                                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{new Date(v.createdAt).toLocaleString()}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Video panel */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                    {/* Generating spinner */}
                    {hasPending && (
                      <div className="card">
                        <div className="card-body">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                            <div className="pulse-dots">
                              <div className="pulse-dot" />
                              <div className="pulse-dot" />
                              <div className="pulse-dot" />
                            </div>
                            <span style={{ fontSize: 14, fontWeight: 600 }}>Generating your video clip…</span>
                          </div>
                          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                            This usually takes 1–3 minutes. The page will update automatically when it's ready.
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Video ready / approved */}
                    {!hasPending && hasReadyVideo && generations.map(({ generation: g, promptVersion: pv }, idx) => {
                      if (g.status !== 'completed' || !g.videoStoragePath) return null;
                      const thisIsApproved = g.id === screen?.approvedGenerationId;
                      if (!signedVideoUrls[g.id]) { void fetchSignedUrl(g.id); }
                      return (
                        <div key={g.id} className="card">
                          <div className="card-header">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <IconVideo />
                                {idx + 1 < generations.filter((g2) => g2.generation.status === 'completed').length ? 'Earlier clip' : 'Latest clip'}
                              </div>
                              <span className="badge badge-purple">Prompt v{pv.version}</span>
                              {(g.durationSeconds ?? screen?.durationSeconds) && (
                                <span className="badge" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                                  {g.durationSeconds ?? screen?.durationSeconds}s
                                </span>
                              )}
                              {thisIsApproved && <span className="badge badge-green"><span className="dot dot-green" />Approved</span>}
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(g.createdAt).toLocaleString()}</span>
                          </div>
                          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <div className="video-result">
                              {signedVideoUrls[g.id] ? (
                                <video src={signedVideoUrls[g.id]} controls />
                              ) : (
                                <div className="skeleton" style={{ height: 200, borderRadius: 8 }} />
                              )}
                            </div>
                            {!isApproved && (
                              <div className="action-well">
                                <div className="action-well-title">Approve this clip?</div>
                                <div className="action-well-desc">
                                  {parseInt(n, 10) === 1
                                    ? 'Approving locks in Scene 1 and lets you move on to the remaining scenes.'
                                    : 'Approving this clip marks Scene ' + n + ' as done.'}
                                </div>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                  <button onClick={() => handleApprove(g.id)} disabled={approving} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#111113', color: '#fff', border: 'none', borderRadius: 'var(--radius-btn)', fontSize: 14, fontWeight: 500, cursor: approving ? 'not-allowed' : 'pointer', opacity: approving ? 0.6 : 1 }}>
                                    <IconCheck />
                                    {approving ? 'Approving…' : 'Approve this clip'}
                                  </button>
                                  <button className="btn btn-secondary" onClick={handleGenerateVideo} disabled={submitting || hasUnsavedPromptEdits}>
                                    {submitting ? 'Generating…' : 'Generate another'}
                                  </button>
                                  {hasUnsavedPromptEdits && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Save prompt first</span>}
                                  {SUPPORTED_DURATIONS.filter((d) => d !== (g.durationSeconds ?? screen?.durationSeconds)).map((d) => (
                                    <button key={d} className="btn btn-secondary" onClick={() => handleGenerateWithDuration(d)} disabled={submitting || hasUnsavedPromptEdits} title={hasUnsavedPromptEdits ? 'Save your prompt edits first' : `Regenerate at ${d}s`}>
                                      {submitting ? 'Generating…' : `${d}s`}
                                    </button>
                                  ))}
                                  <button className="btn btn-secondary" onClick={() => setFeedbackGenId(g.id)}>Rate this clip</button>
                                </div>
                              </div>
                            )}
                            {thisIsApproved && (
                              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                                <button className="btn btn-secondary btn-sm" onClick={() => setFeedbackGenId(g.id)}>Rate this clip</button>
                                {nextScreen && (
                                  <Link href={`/video-projects/${id}/screens/${nextScreen.screenNumber}`}>
                                    <button className="btn btn-primary btn-sm">Continue to Scene {nextScreen.screenNumber} →</button>
                                  </Link>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {/* Generate action (when no gens or all failed) */}
                    {!hasPending && !hasReadyVideo && (
                      <div className="action-well">
                        <div className="action-well-title">
                          {generations.length === 0 ? 'Generate the video clip' : 'Try again'}
                        </div>
                        <div className="action-well-desc">
                          {generations.length === 0
                            ? 'The prompt is ready. Click below to send it to the video generator. Usually takes 1–3 minutes.'
                            : 'The previous generation failed. Click below to try again.'}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <button className="btn btn-primary" onClick={handleGenerateVideo} disabled={submitting || !activePromptVersionId || hasUnsavedPromptEdits} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <IconVideo />
                            {submitting ? 'Submitting…' : 'Generate video clip'}
                          </button>
                          {hasUnsavedPromptEdits && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Save your prompt edits first</span>}
                        </div>
                      </div>
                    )}

                    {/* Failed generations */}
                    {generations.some((g) => g.generation.status === 'failed') && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {generations.filter((g) => g.generation.status === 'failed').map(({ generation: g }) => (
                          <div key={g.id} className="alert alert-error" style={{ fontSize: 13 }}>
                            A generation attempt failed at {new Date(g.createdAt).toLocaleTimeString()}.
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
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
