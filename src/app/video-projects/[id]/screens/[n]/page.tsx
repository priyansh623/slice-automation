'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';
import CharacterGeneration from '@/components/CharacterGeneration';
import { useProject } from '@/contexts/ProjectContext';
import CompileButton from '@/components/CompileButton';
import { AddSceneModal, DeleteSceneModal, readAddSceneDraft } from '@/components/SceneModals';
import { summarizeApproval } from '@/lib/scene-approval';

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
  const router = useRouter();
  const [showAddScene, setShowAddScene] = useState(false);
  const [sceneToDelete, setSceneToDelete] = useState<{ id: number; screenNumber: number; approvedGenerationId: number | null } | null>(null);

  const [promptHistory, setPromptHistory] = useState<PromptVersion[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [currentPrompt, setCurrentPrompt] = useState('');
  const [feedback, setFeedback] = useState('');
  const [writingPrompt, setWritingPrompt] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Undo for a just-deleted scene (shown for a short while) and the scenes that can still be restored.
  const [undo, setUndo] = useState<{ screenId: number; screenNumber: number } | null>(null);
  const [deletedScenes, setDeletedScenes] = useState<Array<{ id: number; dialogue: string; originalNumber: number | null; approved: boolean }>>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
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
    const data = await res.json() as { promptText: string; validation?: { issues: string[]; warnings: string[] }; approvalCleared?: boolean };
    setCurrentPrompt(data.promptText);
    if (data.validation) setValidation(data.validation);
    setFeedback('');
    if (data.approvalCleared) setNotice('The prompt changed, so this scene is no longer approved. Generate and approve a video for the new prompt.');
    await Promise.all([loadSceneData(), refreshProject()]);
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
    const saved = await res.json().catch(() => ({})) as { approvalCleared?: boolean };
    if (saved.approvalCleared) setNotice('The prompt changed, so this scene is no longer approved. Generate and approve a video for the new prompt.');
    await Promise.all([loadSceneData(), refreshProject()]);
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
    setNotice('');
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

  async function handleSceneAdded(newNumber: number) {
    setShowAddScene(false);
    await refreshProject();
    router.push(`/video-projects/${id}/screens/${newNumber}`);
  }

  // A refresh while a scene was being added: reopen the form with the saved text so the retry is one click.
  useEffect(() => { if (readAddSceneDraft(id)?.inFlightAt) setShowAddScene(true); }, [id]);

  // A scene whose prompt is still being written finishes (or is found interrupted) on the server: keep looking.
  const anyWriting = project?.screens.some((s) => s.creationState === 'generating') ?? false;
  useEffect(() => {
    if (!anyWriting) return;
    const timer = setInterval(() => { void refreshProject(); }, 4000);
    return () => clearInterval(timer);
  }, [anyWriting, refreshProject]);

  // Retry on a failed or interrupted scene: finishes that same scene from its saved text, never adds another.
  async function handleRetryCreation(screenId: number) {
    if (retryingId !== null) return;
    setRetryingId(screenId);
    setError('');
    try {
      const res = await fetch(`/api/v1/video-projects/${id}/screens/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screenId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setError(d.error ?? 'Retry did not finish. Your text is saved: press Retry again.');
      }
    } catch {
      setError('Could not reach the server. Your text is saved: press Retry again.');
    } finally {
      await Promise.all([refreshProject(), loadSceneData()]);
      setRetryingId(null);
    }
  }

  // The notice is about one scene: it goes away when you move to another.
  useEffect(() => { setNotice(''); }, [n]);

  const loadDeleted = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/video-projects/${id}/screens`);
      if (!res.ok) return;
      const d = await res.json() as { deleted?: typeof deletedScenes };
      setDeletedScenes(d.deleted ?? []);
    } catch { /* keep what is shown */ }
  }, [id]);
  useEffect(() => { void loadDeleted(); }, [loadDeleted]);

  // The Undo bar lasts a short while. It is kept in session storage because moving to another scene remounts this
  // page; the scene can still be restored later from "Deleted scenes".
  const UNDO_MS = 15000;
  const undoKey = `soma:undo-delete:${id}`;
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(undoKey);
      if (!raw) return;
      const u = JSON.parse(raw) as { screenId: number; screenNumber: number; at: number };
      if (Date.now() - u.at < UNDO_MS) setUndo({ screenId: u.screenId, screenNumber: u.screenNumber });
      else window.sessionStorage.removeItem(undoKey);
    } catch { /* storage unavailable: no undo bar, the Deleted scenes list still works */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoKey]);
  useEffect(() => {
    if (!undo) return;
    let left = UNDO_MS;
    try {
      const raw = window.sessionStorage.getItem(undoKey);
      if (raw) left = Math.max(0, UNDO_MS - (Date.now() - (JSON.parse(raw) as { at: number }).at));
    } catch { /* keep the full time */ }
    const timer = setTimeout(() => { setUndo(null); try { window.sessionStorage.removeItem(undoKey); } catch { /* */ } }, left);
    return () => clearTimeout(timer);
  }, [undo, undoKey]);

  async function handleSceneDeleted(deletedNumber: number) {
    const deleted = sceneToDelete;
    setSceneToDelete(null);
    const remainingBefore = project?.screens.length ?? 1;
    await Promise.all([refreshProject(), loadDeleted()]);
    if (deleted) {
      setUndo({ screenId: deleted.id, screenNumber: deletedNumber });
      try { window.sessionStorage.setItem(undoKey, JSON.stringify({ screenId: deleted.id, screenNumber: deletedNumber, at: Date.now() })); } catch { /* */ }
    }
    const remaining = remainingBefore - 1;
    const current = parseInt(n, 10);
    if (remaining <= 0) { router.push(`/video-projects/${id}/screens/1`); return; }
    // Numbers after the deleted scene moved down by one; keep looking at the same scene where it still exists.
    if (deletedNumber < current) router.push(`/video-projects/${id}/screens/${current - 1}`);
    else if (deletedNumber === current) router.push(`/video-projects/${id}/screens/${Math.min(current, remaining)}`);
  }

  async function handleRestore(screenId: number) {
    if (restoring) return;
    setRestoring(true);
    setError('');
    try {
      const res = await fetch(`/api/v1/video-projects/${id}/screens/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screenId }),
      });
      const d = await res.json().catch(() => ({})) as { error?: string; screenNumber?: number };
      if (!res.ok || !d.screenNumber) { setError(d.error ?? 'Could not restore the scene.'); return; }
      setUndo(null);
      try { window.sessionStorage.removeItem(undoKey); } catch { /* */ }
      await Promise.all([refreshProject(), loadDeleted()]);
      router.push(`/video-projects/${id}/screens/${d.screenNumber}`);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally { setRestoring(false); }
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
  const approval = summarizeApproval(project?.screens ?? []);
  const approvedCount = approval.approved;
  const totalScreens = approval.total;
  const allScenesApproved = approval.eligible;

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
      <ProjectHeader
        projectId={id}
        projectName={project.name}
        steps={projectSteps}
        actions={<><CharacterGeneration projectId={id} /><CompileButton projectId={id} screens={project.screens} onStale={() => void refreshProject()} /></>}
      />

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
            <button
              onClick={() => setShowAddScene(true)}
              style={{
                width: '100%', height: 34, marginTop: 8, border: '1px dashed #6C47FF', borderRadius: 8,
                background: '#F5F3FF', font: '600 13px/1 Satoshi', color: '#6C47FF', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              + Add scene
            </button>
          </div>

          {/* Scene list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {project.screens.map((s) => {
              const isActive = s.screenNumber === currentScreenNum;
              const approved = !!s.approvedGenerationId;
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'flex', alignItems: 'flex-start',
                    background: isActive ? '#F5F3FF' : 'transparent',
                    borderLeft: `2px solid ${isActive ? '#6C47FF' : 'transparent'}`,
                    transition: 'background 0.1s',
                  }}
                >
                <Link
                  href={`/video-projects/${id}/screens/${s.screenNumber}`}
                  style={{ textDecoration: 'none', flex: 1, minWidth: 0 }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '10px 4px 10px 16px',
                    cursor: 'pointer',
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
                        if (s.creationState) {
                          const cs = s.creationState;
                          const retrying = retryingId === s.id;
                          const colors = cs === 'failed' ? ['#FEE2E2', '#B91C1C'] : cs === 'interrupted' ? ['#FEF3C7', '#92400E'] : ['#EDE9FE', '#6D28D9'];
                          return (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 999, background: colors[0], color: colors[1], font: '500 10px/1.4 Satoshi', letterSpacing: '0.02em' }}>
                                {(cs === 'generating' || retrying) && <span style={{ width: 5, height: 5, borderRadius: '50%', background: colors[1], animation: 'pulse 1.2s ease-in-out infinite' }} />}
                                {retrying || cs === 'generating' ? 'Generating' : cs === 'interrupted' ? 'Generation interrupted' : 'Generation failed'}
                              </span>
                              {cs !== 'generating' && !retrying && (
                                <button
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); void handleRetryCreation(s.id); }}
                                  style={{ height: 20, padding: '0 8px', borderRadius: 6, border: '1px solid #D9D0FF', background: '#F5F3FF', color: '#6C47FF', font: '600 11px/1 Satoshi', cursor: 'pointer' }}
                                >Retry</button>
                              )}
                            </span>
                          );
                        }
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
                              Ready for review
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
                {(() => {
                  const busy = !!s.latestGen && ['queued', 'pending', 'processing'].includes(s.latestGen.status);
                  return (
                    <button
                      onClick={() => setSceneToDelete({ id: s.id, screenNumber: s.screenNumber, approvedGenerationId: s.approvedGenerationId })}
                      disabled={busy}
                      aria-label={`Delete Scene ${s.screenNumber}`}
                      title={busy ? 'This scene is generating a video. Wait for it to finish.' : `Delete Scene ${s.screenNumber}`}
                      style={{
                        flexShrink: 0, width: 30, height: 30, margin: '8px 10px 0 0', border: 'none', borderRadius: 7,
                        background: 'transparent', color: busy ? '#D4D4D8' : '#9A9AA0', cursor: busy ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                      onMouseEnter={(e) => { if (!busy) { e.currentTarget.style.background = '#FEE2E2'; e.currentTarget.style.color = '#DC2626'; } }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = busy ? '#D4D4D8' : '#9A9AA0'; }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                        <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                    </button>
                  );
                })()}
                </div>
              );
            })}
            {project.screens.length === 0 && (
              <div style={{ padding: '20px 16px', font: '400 13px/1.5 Satoshi', color: '#75757C' }}>No scenes yet. Use Add scene to create one.</div>
            )}
            {deletedScenes.length > 0 && (
              <div style={{ borderTop: '1px solid #ECECE8', marginTop: 8 }}>
                <button
                  onClick={() => setShowDeleted((v) => !v)} aria-expanded={showDeleted}
                  style={{ width: '100%', textAlign: 'left', padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer', font: '600 12px/1 Satoshi', color: '#75757C' }}
                >
                  {showDeleted ? '▾' : '▸'} Deleted scenes ({deletedScenes.length})
                </button>
                {showDeleted && deletedScenes.map((d) => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px 6px 20px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ font: '600 12px/1.3 Satoshi', color: '#5E5E65' }}>{d.originalNumber ? `Was Scene ${d.originalNumber}` : 'Deleted scene'}</div>
                      <div style={{ font: '400 11px/1.3 Satoshi', color: '#9A9AA0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.dialogue || 'No dialogue'}</div>
                    </div>
                    <button
                      onClick={() => void handleRestore(d.id)} disabled={restoring}
                      style={{ height: 26, padding: '0 10px', borderRadius: 7, border: '1px solid #D9D0FF', background: '#F5F3FF', color: '#6C47FF', font: '600 12px/1 Satoshi', cursor: restoring ? 'wait' : 'pointer' }}
                    >Restore</button>
                  </div>
                ))}
              </div>
            )}
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

            {notice && (
              <div role="status" style={{ marginBottom: 14, padding: '10px 14px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#92400E', display: 'flex', justifyContent: 'space-between' }}>
                <span>{notice}</span>
                <button onClick={() => setNotice('')} aria-label="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit', lineHeight: 1, padding: 0 }}>×</button>
              </div>
            )}

            {!screen && (
              <div style={{ textAlign: 'center', padding: '56px 0', font: '400 14px/1.5 Satoshi', color: '#75757C' }}>
                {project.screens.length === 0
                  ? 'This video has no scenes. Use Add scene to create one.'
                  : `Scene ${n} does not exist. Pick a scene from the list.`}
              </div>
            )}

            {/* Prompt tab */}
            {screen && activeTab === 'prompt' && (
              <>
                {promptHistory.length === 0 && screen.creationState ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
                    <div style={{ font: '600 15px/1.3 Satoshi' }}>
                      {screen.creationState === 'generating' || retryingId === screen.id ? 'Writing the prompt…' : screen.creationState === 'interrupted' ? 'Generation interrupted' : 'Generation failed'}
                    </div>
                    <div style={{ font: '400 13px/1.5 Satoshi', color: '#5E5E65' }}>
                      {screen.creationState === 'generating' || retryingId === screen.id
                        ? 'This scene was just added and its prompt is being written. This page updates by itself.'
                        : 'The prompt for this scene was not finished. The dialogue is saved: press Retry and nothing needs to be typed again. The scene cannot be approved or compiled until it has a prompt and a video.'}
                    </div>
                    {screen.creationBrief && (
                      <div style={{ border: '1px solid #ECECE8', borderRadius: 10, padding: '10px 12px', background: '#FAFAF8', font: '400 13px/1.5 Satoshi', color: '#3F3F46', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div><strong>Dialogue:</strong> {screen.creationBrief.dialogue}</div>
                      </div>
                    )}
                    <div>
                      <button
                        onClick={() => void handleRetryCreation(screen.id)}
                        disabled={screen.creationState === 'generating' || retryingId !== null}
                        style={{ height: 38, padding: '0 18px', borderRadius: 10, background: '#6C47FF', color: '#fff', border: 'none', font: '600 14px/1 Satoshi', cursor: 'pointer', opacity: (screen.creationState === 'generating' || retryingId !== null) ? 0.5 : 1 }}
                      >
                        {retryingId === screen.id ? 'Retrying…' : 'Retry'}
                      </button>
                    </div>
                  </div>
                ) : promptHistory.length === 0 ? (
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
            {screen && activeTab === 'requests' && (
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

          {/* Video area — fills the panel, no container background */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Video / state takes all available flex space */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {hasPending ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                  <div className="pulse-dots" style={{ justifyContent: 'center', marginBottom: 4 }}>
                    <div className="pulse-dot" style={{ background: '#6C47FF' }} />
                    <div className="pulse-dot" style={{ background: '#6C47FF' }} />
                    <div className="pulse-dot" style={{ background: '#6C47FF' }} />
                  </div>
                  <div style={{ font: '600 14px/1.3 Satoshi', color: '#111113' }}>Generating clip…</div>
                  <div style={{ font: '400 12px/1.4 Satoshi', color: '#9A9AA0' }}>Usually 1–3 minutes</div>
                </div>
              ) : displayGen?.generation.status === 'completed' && displayGen.generation.videoStoragePath ? (
                signedVideoUrls[displayGen.generation.id] ? (
                  <video
                    key={displayGen.generation.id}
                    src={signedVideoUrls[displayGen.generation.id]}
                    controls
                    style={{ height: '100%', width: 'auto', maxWidth: '100%', display: 'block' }}
                  />
                ) : (
                  <div style={{
                    width: 56, height: 56, borderRadius: '50%', background: '#F0F0EC',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6C47FF',
                  }}>
                    <IconPlay />
                  </div>
                )
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: '50%', background: '#F0F0EC',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9A9AA0',
                  }}>
                    <IconPlay />
                  </div>
                  <div style={{ font: '400 12px/1.4 Satoshi', color: '#9A9AA0', textAlign: 'center', maxWidth: 160 }}>
                    {promptHistory.length === 0 ? 'Write a prompt first' : 'Generate a video to see it here'}
                  </div>
                </div>
              )}
            </div>

            {/* Thumbnail strip */}
            {completedGens.length > 0 && (
              <div style={{ flexShrink: 0, display: 'flex', gap: 8, padding: '10px 20px', borderTop: '1px solid #ECECE8' }}>
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
                        width: 56, height: 76, borderRadius: 8, background: '#1A1A1E', flexShrink: 0,
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

      {undo && (
        <div role="status" style={{ position: 'fixed', left: 88, bottom: 24, zIndex: 900, display: 'flex', alignItems: 'center', gap: 14, background: '#111113', color: '#fff', padding: '12px 16px', borderRadius: 12, font: '500 13px/1.3 Satoshi', boxShadow: '0 8px 24px rgba(0,0,0,0.25)' }}>
          <span>Scene {undo.screenNumber} deleted.</span>
          <button onClick={() => void handleRestore(undo.screenId)} disabled={restoring} style={{ background: 'none', border: 'none', color: '#B9A9FF', font: '700 13px/1 Satoshi', cursor: 'pointer', padding: 0 }}>Undo</button>
          <button onClick={() => { setUndo(null); try { window.sessionStorage.removeItem(undoKey); } catch { /* */ } }} aria-label="Dismiss" style={{ background: 'none', border: 'none', color: '#9A9AA0', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
        </div>
      )}
      {showAddScene && (
        <AddSceneModal projectId={id} scenes={project.screens} onClose={() => setShowAddScene(false)} onAdded={handleSceneAdded} />
      )}
      {sceneToDelete && (
        <DeleteSceneModal projectId={id} scene={sceneToDelete} onClose={() => setSceneToDelete(null)} onDeleted={handleSceneDeleted} />
      )}
    </AppShell>
  );
}
