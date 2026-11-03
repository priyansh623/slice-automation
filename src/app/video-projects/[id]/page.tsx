'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';

interface GenSummary {
  id: number;
  status: string;
  videoStoragePath: string | null;
  updatedAt: number;
}

interface Screen {
  id: number;
  screenNumber: number;
  dialogue: string;
  position: number;
  approvedGenerationId: number | null;
  durationSeconds: number | null;
  durationNote: string | null;
  // Enriched by project API
  hasPrompt: boolean;
  latestGen: GenSummary | null;
  latestCompletedGen: { id: number; videoStoragePath: string } | null;
}

interface PromptTask {
  id: number;
  videoScreenId: number | null;
  taskType: 'extract_brief' | 'generate_prompt';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  errorMessage: string | null;
}

const SUPPORTED_DURATIONS = [4, 6, 8, 10];

interface CreativeBrief {
  creatorDescription?: string;
  voiceIdentity?: string;
  characterAppearance?: string;
  performanceStyle?: string;
  gestureIntensity?: 'low' | 'medium' | 'high';
  camera?: string;
  setting?: string;
}

interface VideoProject {
  id: number;
  name: string;
  originalScript: string;
  approvedScript: string | null;
  breakdownApprovedAt: number | null;
  creativeBrief: string | null;
  baseImagePreviewUrl?: string;
  screens: Screen[];
}

interface TypoCandidate {
  original: string;
  suggestion: string;
  context: string;
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

function IconArrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M5 12h14M12 5l7 7-7 7"/>
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
    </svg>
  );
}

type SceneStatus =
  | { kind: 'approved' }
  | { kind: 'generating-video' }
  | { kind: 'queued-video' }
  | { kind: 'generating-prompt' }
  | { kind: 'queued-prompt' }
  | { kind: 'failed-video'; hasPrior: boolean }
  | { kind: 'failed-prompt' }
  | { kind: 'generated' }
  | { kind: 'prompt-ready' }
  | { kind: 'up-next' }
  | { kind: 'not-started' };

function sceneStatus(s: Screen, promptTask: PromptTask | undefined, isNext: boolean): SceneStatus {
  const g = s.latestGen;
  // Active work takes priority
  if (promptTask?.status === 'processing') return { kind: 'generating-prompt' };
  if (g?.status === 'pending' || g?.status === 'processing') return { kind: 'generating-video' };
  if (g?.status === 'queued') return { kind: 'queued-video' };
  if (promptTask?.status === 'pending') return { kind: 'queued-prompt' };
  // Failures
  if (promptTask?.status === 'failed') return { kind: 'failed-prompt' };
  if (g?.status === 'failed') return { kind: 'failed-video', hasPrior: !!s.latestCompletedGen };
  // Terminal states
  if (s.approvedGenerationId) return { kind: 'approved' };
  if (g?.status === 'completed' && g.videoStoragePath) return { kind: 'generated' };
  if (s.hasPrompt) return { kind: 'prompt-ready' };
  if (isNext) return { kind: 'up-next' };
  return { kind: 'not-started' };
}

export default function VideoProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<VideoProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedScreens, setEditedScreens] = useState<Screen[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [possibleTypos, setPossibleTypos] = useState<TypoCandidate[]>([]);
  const [typoDecisions, setTypoDecisions] = useState<Record<number, 'accepted' | 'rejected'>>({});
  const [approvedScript, setApprovedScript] = useState<string | null>(null);
  const [promptTasks, setPromptTasks] = useState<PromptTask[]>([]);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generatingAllPrompts, setGeneratingAllPrompts] = useState(false);
  const [showGenerateAllConfirm, setShowGenerateAllConfirm] = useState(false);
  const [showReanalyzeConfirm, setShowReanalyzeConfirm] = useState(false);

  async function load() {
    const res = await fetch(`/api/v1/video-projects/${id}`);
    const data = await res.json();
    setProject(data);
    setEditedScreens(data.screens ?? []);
    setApprovedScript(data.approvedScript ?? null);
    setLoading(false);
    setDirty(false);
    // Also load prompt task statuses
    const tasksRes = await fetch(`/api/v1/video-projects/${id}/prompt-tasks`);
    if (tasksRes.ok) {
      const tasksData = await tasksRes.json();
      setPromptTasks(tasksData.tasks ?? []);
    }
  }

  useEffect(() => { load(); }, [id]);

  // Poll while prompt tasks are in-flight or video gens are active
  useEffect(() => {
    const hasActiveTasks = promptTasks.some((t) => t.status === 'pending' || t.status === 'processing');
    const hasActiveGens = project?.screens.some((s) => {
      const g = s.latestGen;
      return g && (g.status === 'queued' || g.status === 'pending' || g.status === 'processing');
    });
    if (!hasActiveTasks && !hasActiveGens) return;
    const timer = setTimeout(async () => {
      const [tasksRes, projectRes] = await Promise.all([
        fetch(`/api/v1/video-projects/${id}/prompt-tasks`),
        fetch(`/api/v1/video-projects/${id}`),
      ]);
      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setPromptTasks(data.tasks ?? []);
      }
      if (projectRes.ok) {
        const data = await projectRes.json();
        setProject(data);
        setEditedScreens(data.screens ?? []);
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, [promptTasks, project, id]);

  async function handleAnalyze() {
    // Loss aversion: warn before discarding unsaved manual edits
    if (dirty && !showReanalyzeConfirm) {
      setShowReanalyzeConfirm(true);
      return;
    }
    setShowReanalyzeConfirm(false);
    setAnalyzing(true);
    setError('');
    setPossibleTypos([]);
    setTypoDecisions({});
    const res = await fetch(`/api/v1/video-projects/${id}/analyze`, { method: 'POST' });
    if (!res.ok) { setError('Analysis failed. Please try again.'); setAnalyzing(false); return; }
    const data = await res.json();
    if (Array.isArray(data.possibleTypos) && data.possibleTypos.length > 0) {
      setPossibleTypos(data.possibleTypos);
    }
    await load();
    setAnalyzing(false);
  }

  function acceptTypo(index: number) {
    const typo = possibleTypos[index];
    if (!typo) return;
    const pattern = new RegExp(typo.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    setEditedScreens((prev) =>
      prev.map((s) => ({
        ...s,
        dialogue: s.dialogue.replace(pattern, typo.suggestion),
      })),
    );
    setApprovedScript((prev) => {
      const base = prev ?? project?.originalScript ?? '';
      return base.replace(pattern, typo.suggestion);
    });
    setTypoDecisions((prev) => ({ ...prev, [index]: 'accepted' }));
    setDirty(true);
  }

  function rejectTypo(index: number) {
    setTypoDecisions((prev) => ({ ...prev, [index]: 'rejected' }));
  }

  async function handleSaveBreakdown() {
    setSaving(true);
    const body: { screens: Array<{ screenNumber: number; dialogue: string; position?: number; durationSeconds?: number | null; durationNote?: string | null }>; approvedScript?: string } = {
      screens: editedScreens.map((s) => ({
        screenNumber: s.screenNumber,
        dialogue: s.dialogue,
        position: s.position,
        durationSeconds: s.durationSeconds,
        durationNote: s.durationNote,
      })),
    };
    if (approvedScript !== null && approvedScript !== project?.originalScript) {
      body.approvedScript = approvedScript;
    }
    const res = await fetch(`/api/v1/video-projects/${id}/breakdown`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { setError('Save failed'); setSaving(false); return; }
    await load();
    setSaving(false);
  }

  async function handleGenerateAllPrompts() {
    setGeneratingAllPrompts(true);
    setError('');
    const res = await fetch(`/api/v1/video-projects/${id}/generate-all-prompts`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Failed to queue prompt generation');
      setGeneratingAllPrompts(false);
      return;
    }
    await load();
    setGeneratingAllPrompts(false);
  }

  async function handleGenerateAll() {
    if (!showGenerateAllConfirm) {
      setShowGenerateAllConfirm(true);
      return;
    }
    setShowGenerateAllConfirm(false);
    setGeneratingAll(true);
    setError('');
    const res = await fetch(`/api/v1/video-projects/${id}/generate-all`, { method: 'POST' });
    if (!res.ok) { setError('Failed to queue generations'); setGeneratingAll(false); return; }
    await load();
    setGeneratingAll(false);
  }

  async function handleApproveBreakdown() {
    if (dirty) await handleSaveBreakdown();
    setApproving(true);
    const res = await fetch(`/api/v1/video-projects/${id}/approve-breakdown`, { method: 'POST' });
    if (!res.ok) { setError('Approval failed'); setApproving(false); return; }
    await load();
    setApproving(false);
  }

  function updateDialogue(screenNumber: number, dialogue: string) {
    setEditedScreens((prev) =>
      prev.map((s) => (s.screenNumber === screenNumber ? { ...s, dialogue } : s)),
    );
    setDirty(true);
  }

  function updateDuration(screenNumber: number, durationSeconds: number | null) {
    setEditedScreens((prev) =>
      prev.map((s) => (s.screenNumber === screenNumber ? { ...s, durationSeconds } : s)),
    );
    setDirty(true);
  }

  function addScreen() {
    const maxNum = editedScreens.reduce((m, s) => Math.max(m, s.screenNumber), 0);
    const newScreen: Screen = {
      id: -(Date.now()),
      screenNumber: maxNum + 1,
      dialogue: '',
      position: editedScreens.length,
      approvedGenerationId: null,
      durationSeconds: null,
      durationNote: null,
      hasPrompt: false,
      latestGen: null,
      latestCompletedGen: null,
    };
    setEditedScreens((prev) => [...prev, newScreen]);
    setDirty(true);
  }

  function removeScreen(screenNumber: number) {
    setEditedScreens((prev) => {
      const filtered = prev.filter((s) => s.screenNumber !== screenNumber);
      return filtered.map((s, i) => ({ ...s, screenNumber: i + 1, position: i }));
    });
    setDirty(true);
  }

  function moveScreen(idx: number, dir: -1 | 1) {
    const next = idx + dir;
    if (next < 0 || next >= editedScreens.length) return;
    setEditedScreens((prev) => {
      const arr = [...prev];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return arr.map((s, i) => ({ ...s, screenNumber: i + 1, position: i }));
    });
    setDirty(true);
  }

  if (loading) {
    return (
      <AppShell>
        <div className="page-body" style={{ maxWidth: 800 }}>
          <div className="skeleton" style={{ height: 28, width: '40%', marginBottom: 16 }} />
          <div className="skeleton" style={{ height: 120, marginBottom: 16 }} />
          <div className="skeleton" style={{ height: 120 }} />
        </div>
      </AppShell>
    );
  }

  if (!project) {
    return (
      <AppShell>
        <div className="page-body">
          <div className="alert alert-error">Project not found.</div>
        </div>
      </AppShell>
    );
  }

  const approvedCount = editedScreens.filter((s) => s.approvedGenerationId).length;
  const nextIncompleteScreen = editedScreens.find((s) => !s.approvedGenerationId);
  const generateAllEligible = editedScreens.filter((s) => {
    if (s.approvedGenerationId) return false;
    if (!s.hasPrompt) return false;
    const g = s.latestGen;
    if (g && (g.status === 'pending' || g.status === 'processing' || g.status === 'queued')) return false;
    return true;
  }).length;

  // Phase 3: Breakdown approved - show screen progress grid
  if (project.breakdownApprovedAt) {
    const total = editedScreens.length;
    const pct = total > 0 ? Math.round((approvedCount / total) * 100) : 0;

    return (
      <AppShell>
        <div className="page-header">
          <div className="page-header-left">
            <div className="page-breadcrumb">
              <Link href="/video-projects" style={{ color: 'var(--text-muted)' }}>Video Projects</Link>
              <span>›</span>
              <span style={{ color: 'var(--text-primary)' }}>{project.name}</span>
            </div>
            <h1 className="page-title">{project.name}</h1>
          </div>
        </div>

        <div className="page-body" style={{ maxWidth: 900 }}>
          {error && (
            <div className="alert alert-error" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span>{error}</span>
              <button onClick={() => setError('')} style={{ marginLeft: 12, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit', lineHeight: 1, padding: 0 }} title="Dismiss">×</button>
            </div>
          )}

          {/* Progress summary */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>
                    {approvedCount === total ? 'All scenes complete' : `${approvedCount} of ${total} scenes approved`}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {approvedCount === total
                      ? 'Your video is ready to export.'
                      : `${total - approvedCount} scene${total - approvedCount !== 1 ? 's' : ''} still need a video clip.`}
                  </div>
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand)' }}>{pct}%</div>
              </div>
              <div className="progress-bar-wrap">
                <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>

          {/* Creative brief */}
          {project.creativeBrief && (() => {
            let brief: CreativeBrief = {};
            try { brief = JSON.parse(project.creativeBrief); } catch { /* ignore */ }
            const hasExtracted = brief.voiceIdentity || brief.characterAppearance || brief.performanceStyle;
            if (!hasExtracted) return null;
            return (
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div className="card-title">Creative Brief</div>
                    <div className="card-subtitle">Extracted from Screen 1 approval. Used for all subsequent scenes.</div>
                  </div>
                  <a href={`/api/v1/video-projects/${id}/brief`} style={{ fontSize: 12, color: 'var(--brand)', textDecoration: 'none' }}>Edit via API</a>
                </div>
                <div className="card-body">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px' }}>
                    {brief.voiceIdentity && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>Voice</div>
                        <div style={{ fontSize: 13 }}>{brief.voiceIdentity}</div>
                      </div>
                    )}
                    {brief.characterAppearance && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>Character</div>
                        <div style={{ fontSize: 13 }}>{brief.characterAppearance}</div>
                      </div>
                    )}
                    {brief.performanceStyle && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>Performance</div>
                        <div style={{ fontSize: 13 }}>{brief.performanceStyle}</div>
                      </div>
                    )}
                    {brief.gestureIntensity && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>Gestures</div>
                        <div style={{ fontSize: 13, textTransform: 'capitalize' }}>{brief.gestureIntensity}</div>
                      </div>
                    )}
                    {brief.camera && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>Camera</div>
                        <div style={{ fontSize: 13 }}>{brief.camera}</div>
                      </div>
                    )}
                    {brief.setting && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>Setting</div>
                        <div style={{ fontSize: 13 }}>{brief.setting}</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Next action */}
          {nextIncompleteScreen && (
            <div className="stage-banner stage-banner-purple" style={{ marginBottom: 20 }}>
              <div className="stage-banner-icon">
                <IconArrow />
              </div>
              <div style={{ flex: 1 }}>
                <div className="stage-banner-title">Continue with Scene {nextIncompleteScreen.screenNumber}</div>
                <div className="stage-banner-desc">
                  Generate a video clip for the next scene. Review the prompt, generate a video, and approve it to move forward.
                </div>
              </div>
              <Link href={`/video-projects/${id}/screens/${nextIncompleteScreen.screenNumber}`}>
                <button className="btn btn-primary btn-sm" style={{ whiteSpace: 'nowrap' }}>
                  Go to Scene {nextIncompleteScreen.screenNumber} →
                </button>
              </Link>
            </div>
          )}

          {approvedCount === total && total > 0 && (
            <div className="stage-banner stage-banner-green" style={{ marginBottom: 20 }}>
              <div className="stage-banner-icon">
                <IconCheck />
              </div>
              <div style={{ flex: 1 }}>
                <div className="stage-banner-title">All scenes are approved</div>
                <div className="stage-banner-desc">Every scene has an approved video clip. Review them below.</div>
              </div>
            </div>
          )}

          {/* Scene grid */}
          <div className="card">
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="card-title">All Scenes</div>
              {editedScreens.some((s) => !s.approvedGenerationId) && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                  {showGenerateAllConfirm && (
                    <div style={{ padding: '12px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 280 }}>
                      <strong>Queue {generateAllEligible} video generation{generateAllEligible !== 1 ? 's' : ''}?</strong>
                      <span style={{ color: 'var(--text-secondary)' }}>This consumes API credits. Already-approved and actively-generating scenes will be skipped.</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-primary btn-sm" onClick={handleGenerateAll} disabled={generatingAll || generateAllEligible === 0}>
                          {generatingAll ? 'Queuing…' : `Queue ${generateAllEligible} generation${generateAllEligible !== 1 ? 's' : ''}`}
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setShowGenerateAllConfirm(false)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={handleGenerateAllPrompts}
                      disabled={generatingAllPrompts}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      <IconSparkle />
                      {generatingAllPrompts ? 'Queuing…' : 'Generate All Prompts'}
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleGenerateAll}
                      disabled={generatingAll || generateAllEligible === 0}
                      title={generateAllEligible === 0 ? 'No scenes have a prompt ready yet' : undefined}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      <IconSparkle />
                      {generatingAll ? 'Queuing…' : `Generate All Videos${generateAllEligible > 0 ? ` (${generateAllEligible})` : ''}`}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <div style={{ padding: '16px 20px' }}>
                <div className="scene-grid">
                  {editedScreens.map((s) => {
                    const isNext = s.id === nextIncompleteScreen?.id;
                    const promptTask = promptTasks.find((t) => t.videoScreenId === s.id && t.taskType === 'generate_prompt');
                    const status = sceneStatus(s, promptTask, isNext);
                    return (
                      <Link
                        key={s.screenNumber}
                        href={`/video-projects/${id}/screens/${s.screenNumber}`}
                        className={`scene-card${isNext ? ' scene-card-next' : ''}`}
                      >
                        <div className="scene-card-num" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          Scene {s.screenNumber}
                          {s.durationSeconds && (
                            <span style={{ fontSize: 10, background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', color: 'var(--text-muted)' }}>
                              {s.durationSeconds}s
                            </span>
                          )}
                        </div>
                        <div className="scene-card-dialogue">{s.dialogue || <span style={{ color: 'var(--text-muted)' }}>No dialogue</span>}</div>
                        <div className="scene-card-status">
                          {status.kind === 'approved'           && <span className="badge badge-green"><span className="dot dot-green" />Approved</span>}
                          {status.kind === 'generating-video'   && <span className="badge badge-purple">Generating video…</span>}
                          {status.kind === 'queued-video'       && <span className="badge badge-gray">Video queued</span>}
                          {status.kind === 'generating-prompt'  && <span className="badge badge-purple">Generating prompt…</span>}
                          {status.kind === 'queued-prompt'      && <span className="badge badge-gray">Prompt queued</span>}
                          {status.kind === 'failed-video'       && !status.hasPrior && <span className="badge badge-red">Video failed</span>}
                          {status.kind === 'failed-video'       && status.hasPrior  && <span className="badge badge-red">Latest attempt failed</span>}
                          {status.kind === 'failed-prompt'      && <span className="badge badge-red">Prompt failed</span>}
                          {status.kind === 'generated'          && <span className="badge badge-teal">Generated</span>}
                          {status.kind === 'prompt-ready'       && <span className="badge badge-blue">Prompt ready</span>}
                          {status.kind === 'up-next'            && <span className="badge badge-purple">Up next</span>}
                          {status.kind === 'not-started'        && <span className="badge badge-gray">Not started</span>}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

        </div>
      </AppShell>
    );
  }

  // ─── Phase 1: No screens yet ─────────────────────────────────────────────
  if (editedScreens.length === 0) {
    return (
      <AppShell>
        <div className="page-header">
          <div className="page-header-left">
            <div className="page-breadcrumb">
              <Link href="/video-projects" style={{ color: 'var(--text-muted)' }}>Video Projects</Link>
              <span>›</span>
              <span style={{ color: 'var(--text-primary)' }}>{project.name}</span>
            </div>
            <h1 className="page-title">{project.name}</h1>
          </div>
        </div>

        <div className="page-body" style={{ maxWidth: 720 }}>
          {error && (
            <div className="alert alert-error" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span>{error}</span>
              <button onClick={() => setError('')} style={{ marginLeft: 12, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit', lineHeight: 1, padding: 0 }} title="Dismiss">×</button>
            </div>
          )}

          {/* Step banner */}
          <div className="stage-banner stage-banner-purple">
            <div className="stage-banner-icon">
              <IconSparkle />
            </div>
            <div>
              <div className="stage-banner-title">Step 1 of 3: Break down the script</div>
              <div className="stage-banner-desc">
                Claude will read your script and split it into individual scenes, one for each line of dialogue. You can edit the scenes before moving on.
              </div>
            </div>
          </div>

          {/* Script preview */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div>
                <div className="card-title">Your Script</div>
                <div className="card-subtitle">This is the script Claude will analyse</div>
              </div>
            </div>
            <div className="card-body">
              <pre style={{
                margin: 0, fontSize: 13, color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap', lineHeight: 1.7,
                background: 'var(--bg-page)', padding: '12px 14px',
                borderRadius: 8, border: '1px solid var(--border)',
                maxHeight: 260, overflowY: 'auto',
              }}>{project.originalScript}</pre>
            </div>
          </div>

          {/* Primary action */}
          <div className="action-well">
            <div className="action-well-title">Ready to analyse</div>
            <div className="action-well-desc">
              When you click <strong>Analyse script</strong>, Claude will split your script into scenes. This takes a few seconds. You'll be able to review and edit the scenes before anything is generated.
            </div>
            <div>
              <button
                className="btn btn-primary"
                onClick={handleAnalyze}
                disabled={analyzing}
                style={{ gap: 8, display: 'inline-flex', alignItems: 'center' }}
              >
                <IconSparkle />
                {analyzing ? 'Analysing script…' : 'Analyse script'}
              </button>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  // ─── Phase 2: Screens exist, not yet approved ─────────────────────────────
  return (
    <AppShell>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-breadcrumb">
            <Link href="/video-projects" style={{ color: 'var(--text-muted)' }}>Video Projects</Link>
            <span>›</span>
            <span style={{ color: 'var(--text-primary)' }}>{project.name}</span>
          </div>
          <h1 className="page-title">{project.name}</h1>
        </div>
      </div>

      <div className="page-body" style={{ maxWidth: 720 }}>
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <span>{error}</span>
            <button onClick={() => setError('')} style={{ marginLeft: 12, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit', lineHeight: 1, padding: 0 }} title="Dismiss">×</button>
          </div>
        )}

        {/* Step banner */}
        <div className="stage-banner stage-banner-purple">
          <div className="stage-banner-icon">
            <IconCheck />
          </div>
          <div>
            <div className="stage-banner-title">Step 2 of 3: Review your scenes</div>
            <div className="stage-banner-desc">
              Claude found <strong>{editedScreens.length} scene{editedScreens.length !== 1 ? 's' : ''}</strong>. Review and edit the dialogue for each scene. You can add, remove, or reorder scenes. When you're happy, approve them to start generating videos.
            </div>
          </div>
        </div>

        {/* Typo review panel */}
        {possibleTypos.length > 0 && possibleTypos.some((_, i) => !typoDecisions[i]) && (
          <div className="card" style={{ marginBottom: 20, border: '1px solid var(--warning, #f59e0b)', background: 'var(--warning-bg, #fffbeb)' }}>
            <div className="card-header">
              <div>
                <div className="card-title" style={{ color: 'var(--warning-text, #92400e)' }}>Possible typos detected</div>
                <div className="card-subtitle">Review each suggestion. Accept to apply the correction, or reject to keep the original.</div>
              </div>
            </div>
            <div className="card-body" style={{ padding: '0 20px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 16 }}>
                {possibleTypos.map((typo, i) => {
                  const decision = typoDecisions[i];
                  if (decision) return null;
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      background: 'var(--bg-surface, white)', border: '1px solid var(--border)',
                      borderRadius: 8, padding: '10px 14px',
                    }}>
                      <div style={{ flex: 1, fontSize: 13 }}>
                        <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>Context:</span>
                        <span style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--bg-page)', padding: '1px 6px', borderRadius: 4 }}>{typo.context}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <span style={{ fontSize: 13, textDecoration: 'line-through', color: 'var(--text-muted)' }}>{typo.original}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>→</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand)' }}>{typo.suggestion}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => rejectTypo(i)}>Keep original</button>
                        <button className="btn btn-primary btn-sm" onClick={() => acceptTypo(i)}>Accept fix</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Scene list */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <div className="card-title">Scenes</div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              {showReanalyzeConfirm && (
                <div style={{ padding: '10px 14px', background: 'var(--warning-bg, #fffbeb)', border: '1px solid var(--warning, #f59e0b)', borderRadius: 8, fontSize: 13, color: '#78350F', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 260 }}>
                  <strong>Unsaved edits will be lost</strong>
                  <span>Re-analysing rewrites the scene breakdown from scratch. Your manual changes won't be preserved.</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-primary btn-sm" onClick={handleAnalyze} disabled={analyzing}>Re-analyse anyway</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setShowReanalyzeConfirm(false)}>Keep my edits</button>
                  </div>
                </div>
              )}
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleAnalyze}
                disabled={analyzing}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <IconSparkle />
                {analyzing ? 'Re-analysing…' : 'Re-analyse'}
              </button>
            </div>
          </div>
          <div className="card-body" style={{ padding: '0 20px' }}>
            <div className="scene-list">
              {editedScreens.map((s, idx) => (
                <div key={s.id} className="scene-list-row">
                  {/* Reorder */}
                  <div className="scene-reorder-btns">
                    <button
                      className="scene-reorder-btn"
                      onClick={() => moveScreen(idx, -1)}
                      disabled={idx === 0}
                      title="Move up"
                    >↑</button>
                    <button
                      className="scene-reorder-btn"
                      onClick={() => moveScreen(idx, 1)}
                      disabled={idx === editedScreens.length - 1}
                      title="Move down"
                    >↓</button>
                  </div>

                  {/* Number badge */}
                  <div className="screen-number-badge" style={{ flexShrink: 0, marginTop: 4 }}>{s.screenNumber}</div>

                  {/* Dialogue + duration + remove */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Textarea row with trash */}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <textarea
                        className="form-textarea"
                        value={s.dialogue}
                        onChange={(e) => updateDialogue(s.screenNumber, e.target.value)}
                        rows={2}
                        placeholder="Enter dialogue for this scene…"
                        style={{ marginBottom: 0, resize: 'vertical', flex: 1 }}
                      />
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => removeScreen(s.screenNumber)}
                        title="Remove scene"
                        style={{ flexShrink: 0, marginTop: 2, color: 'var(--text-muted)' }}
                      >
                        <IconTrash />
                      </button>
                    </div>
                    {/* Duration row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>Duration:</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {SUPPORTED_DURATIONS.map((d) => (
                          <button
                            key={d}
                            onClick={() => updateDuration(s.screenNumber, d)}
                            style={{
                              fontSize: 11, padding: '2px 7px', borderRadius: 4, border: '1px solid var(--border)',
                              background: s.durationSeconds === d ? 'var(--brand)' : 'var(--bg-surface)',
                              color: s.durationSeconds === d ? 'white' : 'var(--text-secondary)',
                              cursor: 'pointer', fontWeight: s.durationSeconds === d ? 600 : 400,
                            }}
                          >{d}s</button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Add scene */}
            <div style={{ padding: '12px 0' }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={addScreen}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <IconPlus />
                Add scene
              </button>
            </div>
          </div>
        </div>

        {/* Approve action */}
        <div className="action-well">
          <div className="action-well-title">Approve these scenes</div>
          <div className="action-well-desc">
            When you approve, the scene list is locked in and you will move on to generating a video clip for each scene, one at a time, starting with Scene 1. You can still view the script later.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {dirty && (
              <button
                className="btn btn-secondary"
                onClick={handleSaveBreakdown}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={handleApproveBreakdown}
              disabled={approving || editedScreens.length === 0}
            >
              {approving ? 'Approving…' : `Approve ${editedScreens.length} scene${editedScreens.length !== 1 ? 's' : ''} →`}
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
