'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';

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
  creatorDescription: string | null;
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
  const router = useRouter();
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
  const [infoMsg, setInfoMsg] = useState('');

  async function load() {
    const [res, tasksRes] = await Promise.all([
      fetch(`/api/v1/video-projects/${id}`),
      fetch(`/api/v1/video-projects/${id}/prompt-tasks`),
    ]);
    if (!res.ok) { setLoading(false); return; }
    const data = await res.json();
    setProject(data);
    setEditedScreens(data.screens ?? []);
    setApprovedScript(data.approvedScript ?? null);
    setLoading(false);
    setDirty(false);
    if (tasksRes.ok) {
      const tasksData = await tasksRes.json();
      const tasks: PromptTask[] = tasksData.tasks ?? [];
      setPromptTasks(tasks);
      const statusMap: Record<number, string> = {};
      for (const t of tasks) statusMap[t.id] = t.status;
      prevTaskStatusesRef.current = statusMap;
    }
  }

  const autoAnalyzedRef = useRef(false);
  const prevTaskStatusesRef = useRef<Record<number, string>>({});

  useEffect(() => { load(); }, [id]);

  // Auto-trigger analysis when project loads with no scenes yet
  useEffect(() => {
    if (loading || autoAnalyzedRef.current) return;
    if (editedScreens.length === 0 && project) {
      autoAnalyzedRef.current = true;
      setAnalyzing(true);
      setError('');
      fetch(`/api/v1/video-projects/${id}/analyze`, { method: 'POST' })
        .then(async (res) => {
          if (!res.ok) { setError('Analysis failed. Please try again.'); return; }
          const data = await res.json();
          if (Array.isArray(data.possibleTypos) && data.possibleTypos.length > 0) {
            setPossibleTypos(data.possibleTypos);
          }
          await load();
        })
        .catch(() => setError('Analysis failed. Please try again.'))
        .finally(() => setAnalyzing(false));
    }
  }, [loading, editedScreens.length, project, id]);

  // Poll while prompt tasks are in-flight or video gens are active.
  // When only tasks are active (no active gens) we use a lightweight path: poll tasks only and
  // fetch the full project only when a task transitions to completed/failed — this avoids the
  // heavy project fetch on every 4-second tick while prompts are being written.
  useEffect(() => {
    const hasActiveTasks = promptTasks.some((t) => t.status === 'pending' || t.status === 'processing');
    const hasActiveGens = project?.screens.some((s) => {
      const g = s.latestGen;
      return g && (g.status === 'queued' || g.status === 'pending' || g.status === 'processing');
    });
    if (!hasActiveTasks && !hasActiveGens) return;

    const timer = setTimeout(async () => {
      if (hasActiveGens) {
        // Full refresh: gen status lives on the project response.
        const [tasksRes, projectRes] = await Promise.all([
          fetch(`/api/v1/video-projects/${id}/prompt-tasks`),
          fetch(`/api/v1/video-projects/${id}`),
        ]);
        if (tasksRes.ok) {
          const data = await tasksRes.json();
          const newTasks: PromptTask[] = data.tasks ?? [];
          setPromptTasks(newTasks);
          const statusMap: Record<number, string> = {};
          for (const t of newTasks) statusMap[t.id] = t.status;
          prevTaskStatusesRef.current = statusMap;
        }
        if (projectRes.ok) {
          const data = await projectRes.json();
          setProject(data);
          setEditedScreens(data.screens ?? []);
        }
      } else {
        // Lightweight path: only task statuses matter, skip the heavy project fetch.
        const tasksRes = await fetch(`/api/v1/video-projects/${id}/prompt-tasks`);
        if (!tasksRes.ok) return;
        const data = await tasksRes.json();
        const newTasks: PromptTask[] = data.tasks ?? [];
        // Detect any task transitioning from active to terminal.
        const prev = prevTaskStatusesRef.current;
        const anyTransitioned = newTasks.some(
          (t) =>
            (t.status === 'completed' || t.status === 'failed') &&
            prev[t.id] !== undefined &&
            (prev[t.id] === 'pending' || prev[t.id] === 'processing'),
        );
        const statusMap: Record<number, string> = {};
        for (const t of newTasks) statusMap[t.id] = t.status;
        prevTaskStatusesRef.current = statusMap;
        setPromptTasks(newTasks);
        if (anyTransitioned) {
          const projectRes = await fetch(`/api/v1/video-projects/${id}`);
          if (projectRes.ok) {
            const projectData = await projectRes.json();
            setProject(projectData);
            setEditedScreens(projectData.screens ?? []);
          }
        }
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
    const body = await res.json().catch(() => ({}));
    if (body.tasksQueued === 0 && body.alreadyPending > 0) {
      setInfoMsg(`Prompts are already queued (${body.alreadyPending} task${body.alreadyPending !== 1 ? 's' : ''} pending). The worker will process them shortly.`);
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
  const screen1 = editedScreens.find((s) => s.screenNumber === 1);
  const screen1Approved = !!screen1?.approvedGenerationId;
  const generateAllEligible = editedScreens.filter((s) => {
    if (s.approvedGenerationId) return false;
    if (!s.hasPrompt) return false;
    const g = s.latestGen;
    if (g && (g.status === 'pending' || g.status === 'processing' || g.status === 'queued')) return false;
    return true;
  }).length;

  // Phase 3: Breakdown approved — redirect to scene 1
  if (project.breakdownApprovedAt) {
    router.replace(`/video-projects/${id}/screens/1`);
    return null;
  }

  // ─── Phase 1: No screens yet — auto-analyzing ─────────────────────────────
  if (editedScreens.length === 0) {
    return (
      <AppShell>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {error ? (
            <div style={{ maxWidth: 400, padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#991B1B', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span>{error}</span>
              <button onClick={() => setError('')} style={{ marginLeft: 12, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit', lineHeight: 1, padding: 0 }}>×</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', border: '3px solid #ECECE8', borderTopColor: '#6C47FF', animation: 'spin 0.75s linear infinite' }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ font: '500 14px/1 Satoshi', color: '#75757C' }}>Analysing your script…</div>
            </div>
          )}
        </div>
      </AppShell>
    );
  }

  // ─── Phase 2: Screens exist, not yet approved ─────────────────────────────
  const totalDuration = editedScreens.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);

  return (
    <AppShell>
      <ProjectHeader
        projectId={project.id}
        projectName={project.name}
        steps={[
          { label: 'Script', status: 'complete' },
          { label: 'Breakdown', status: 'active' },
          { label: 'Scenes', status: 'pending' },
          { label: 'Compile', status: 'pending' },
          { label: 'Review', status: 'pending' },
        ]}
        statusLabel="Breakdown review"
      />

      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 40px 48px' }}>

          {error && (
            <div style={{ marginBottom: 20, padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#991B1B', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span>{error}</span>
              <button onClick={() => setError('')} style={{ marginLeft: 12, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit', lineHeight: 1, padding: 0 }}>×</button>
            </div>
          )}

          {/* Typo review panel */}
          {possibleTypos.length > 0 && possibleTypos.some((_, i) => !typoDecisions[i]) && (
            <div style={{ marginBottom: 20, border: '1px solid #FCD34D', background: '#FFFBEB', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #FCD34D' }}>
                <div style={{ font: '600 14px/1.3 Satoshi', color: '#92400E' }}>Possible typos detected</div>
                <div style={{ font: '400 12px/1.5 Satoshi', color: '#78350F', marginTop: 2 }}>Review each suggestion.</div>
              </div>
              <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {possibleTypos.map((typo, i) => {
                  if (typoDecisions[i]) return null;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1px solid #E4E4E0', borderRadius: 8, padding: '10px 14px' }}>
                      <div style={{ flex: 1, font: '400 13px/1 Satoshi' }}>
                        <span style={{ color: '#75757C', marginRight: 6 }}>Context:</span>
                        <span style={{ fontFamily: 'monospace', fontSize: 12, background: '#F5F5F3', padding: '1px 6px', borderRadius: 4 }}>{typo.context}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <span style={{ font: '400 13px/1 Satoshi', textDecoration: 'line-through', color: '#75757C' }}>{typo.original}</span>
                        <span style={{ font: '400 12px/1 Satoshi', color: '#9A9AA0' }}>→</span>
                        <span style={{ font: '600 13px/1 Satoshi', color: '#6C47FF' }}>{typo.suggestion}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => rejectTypo(i)}>Keep</button>
                        <button className="btn btn-primary btn-sm" onClick={() => acceptTypo(i)}>Accept</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Character description read-only banner */}
          {project.creatorDescription && (
            <div style={{ marginBottom: 20, padding: '14px 18px', background: '#F7F5FF', border: '1px solid #DDD6FE', borderRadius: 12 }}>
              <div style={{ font: '600 12px/1 Satoshi', color: '#6C47FF', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Character description</div>
              <div style={{ font: '400 14px/1.6 Satoshi', color: '#3D3D45', whiteSpace: 'pre-wrap' }}>{project.creatorDescription}</div>
            </div>
          )}

          {/* Section header */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
            <div>
              <span style={{ font: '600 18px/1.2 Satoshi' }}>Scene breakdown</span>
              <span style={{ font: '400 14px/1 Satoshi', color: '#75757C', marginLeft: 10 }}>
                {editedScreens.length} scene{editedScreens.length !== 1 ? 's' : ''}
                {totalDuration > 0 && ` · ${totalDuration}s total`}
              </span>
            </div>
            {showReanalyzeConfirm ? (
              <div style={{ padding: '10px 14px', background: '#FFFBEB', border: '1px solid #FCD34D', borderRadius: 10, font: '400 13px/1.5 Satoshi', color: '#78350F', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <strong style={{ font: '600 13px/1 Satoshi' }}>Unsaved edits will be lost</strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-primary btn-sm" onClick={handleAnalyze} disabled={analyzing}>Re-analyse anyway</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowReanalyzeConfirm(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => dirty ? setShowReanalyzeConfirm(true) : handleAnalyze()}
                disabled={analyzing}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', border: '1px solid #E4E4E0', borderRadius: 8, background: '#fff', font: '500 13px/1 Satoshi', color: '#5E5E65', cursor: 'pointer' }}
              >
                <IconSparkle />
                {analyzing ? 'Re-analysing…' : 'Re-analyse'}
              </button>
            )}
          </div>

          {/* Scene list — redesigned */}
          <div style={{ border: '1px solid #ECECE8', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
            {editedScreens.map((s, idx) => (
              <div
                key={s.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 14,
                  padding: '14px 20px',
                  borderBottom: idx < editedScreens.length - 1 ? '1px solid #F3F3F1' : 'none',
                  background: '#fff',
                }}
              >
                {/* Number badge */}
                <div style={{
                  width: 26, height: 26, borderRadius: 8, background: '#F0F0EC',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  font: '600 12px/1 Satoshi', color: '#5E5E65', flexShrink: 0, marginTop: 7,
                }}>
                  {s.screenNumber}
                </div>

                {/* Dialogue */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <textarea
                    value={s.dialogue}
                    onChange={(e) => { updateDialogue(s.screenNumber, e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px'; }}
                    ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }}
                    placeholder="Enter dialogue for this scene…"
                    style={{
                      width: '100%', border: '1px solid transparent', borderRadius: 8,
                      padding: '6px 8px', font: '400 14px/1.6 Satoshi', background: 'transparent',
                      outline: 'none', resize: 'none', boxSizing: 'border-box', overflow: 'hidden',
                    }}
                    onFocus={(e) => { e.currentTarget.style.border = '1px solid #E4E4E0'; e.currentTarget.style.background = '#FAFAF8'; }}
                    onBlur={(e) => { e.currentTarget.style.border = '1px solid transparent'; e.currentTarget.style.background = 'transparent'; }}
                  />
                </div>

                {/* Duration buttons + reorder + remove — right side */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {SUPPORTED_DURATIONS.map((d) => (
                      <button
                        key={d}
                        onClick={() => updateDuration(s.screenNumber, d)}
                        style={{
                          width: 32, height: 28, borderRadius: 6,
                          border: `1px solid ${s.durationSeconds === d ? '#6C47FF' : '#E4E4E0'}`,
                          background: s.durationSeconds === d ? '#6C47FF' : '#fff',
                          color: s.durationSeconds === d ? '#fff' : '#5E5E65',
                          font: `${s.durationSeconds === d ? '600' : '400'} 11px/1 Satoshi`,
                          cursor: 'pointer',
                        }}
                      >{d}s</button>
                    ))}
                  </div>
                  <button onClick={() => removeScreen(s.screenNumber)} title="Remove scene" style={{ width: 28, height: 28, border: '1px solid #E4E4E0', borderRadius: 6, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9A9AA0' }}>
                    <IconTrash />
                  </button>
                </div>
              </div>
            ))}

            {/* Add scene row */}
            <div style={{ padding: '10px 20px', borderTop: editedScreens.length > 0 ? '1px solid #F3F3F1' : 'none', background: '#FAFAF8' }}>
              <button
                onClick={addScreen}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', border: '1px solid #E4E4E0', borderRadius: 7, background: '#fff', font: '500 13px/1 Satoshi', color: '#5E5E65', cursor: 'pointer' }}
              >
                <IconPlus />
                Add scene
              </button>
            </div>
          </div>

          {/* Bottom actions */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {dirty && (
                <button
                  onClick={handleSaveBreakdown}
                  disabled={saving}
                  style={{ height: 38, padding: '0 16px', border: '1px solid #E4E4E0', borderRadius: 9, background: '#fff', font: '500 14px/1 Satoshi', color: '#111113', cursor: 'pointer' }}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              )}
              <button
                onClick={() => dirty ? setShowReanalyzeConfirm(true) : handleAnalyze()}
                disabled={analyzing}
                style={{ height: 38, padding: '0 16px', border: '1px solid #E4E4E0', borderRadius: 9, background: '#fff', font: '500 14px/1 Satoshi', color: '#5E5E65', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <IconSparkle />
                Re-analyse
              </button>
            </div>
            <button
              onClick={handleApproveBreakdown}
              disabled={approving || editedScreens.length === 0}
              style={{
                height: 40, padding: '0 20px', borderRadius: 10,
                background: '#6C47FF', color: '#fff', border: 'none',
                font: '600 14px/1 Satoshi', cursor: 'pointer',
                opacity: (approving || editedScreens.length === 0) ? 0.6 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 8,
              }}
            >
              {approving ? 'Approving…' : 'Approve breakdown'}
              {!approving && <IconArrow />}
            </button>
          </div>

        </div>
      </div>
    </AppShell>
  );
}
