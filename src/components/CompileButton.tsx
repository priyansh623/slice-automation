'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { compilationView, MAX_COMPILATION_CLIPS, MIN_COMPILATION_CLIPS } from '@/lib/compilation-versions';
import { summarizeApproval, type ApprovalScreenLike } from '@/lib/scene-approval';

interface CompileScreen extends ApprovalScreenLike {
  id: number;
}

interface Props {
  projectId: number | string;
  screens: readonly CompileScreen[];
  /** Called after a compilation was started, so the caller can refresh anything it shows. */
  onStarted?: () => void;
  /** Called when the server says the scenes changed since this page loaded, so the caller can reload them. */
  onStale?: () => void;
}

interface CompilationRow { id: number; status: string; version: number | null; createdAt: number }

// The compile action for the Scenes screen header. It uses the same approval rule as the Compile page
// (summarizeApproval: every scene has an approved video) and starts the same compilation, so progress, success and
// failure are shown on the Compile page exactly as before. While a compilation is waiting or running the button does
// not start another one; it takes you to the progress instead.
export default function CompileButton({ projectId, screens, onStarted, onStale }: Props) {
  const router = useRouter();
  const [compilations, setCompilations] = useState<CompilationRow[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false); // blocks a second request before React has re-rendered the disabled state

  const loadCompilations = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/video-projects/${projectId}/compilations`);
      if (!res.ok) return;
      const data = await res.json();
      setCompilations(Array.isArray(data) ? data : []);
    } catch { /* keep what is shown */ }
  }, [projectId]);

  useEffect(() => { void loadCompilations(); }, [loadCompilations]);

  const view = compilationView(compilations);
  const running = view.active !== null;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void loadCompilations(); }, 5000);
    return () => clearInterval(timer);
  }, [running, loadCompilations]);

  const summary = summarizeApproval(screens);
  let blockedReason = summary.reason;
  if (!blockedReason && summary.total < MIN_COMPILATION_CLIPS) blockedReason = `A video needs at least ${MIN_COMPILATION_CLIPS} scenes.`;
  if (!blockedReason && summary.total > MAX_COMPILATION_CLIPS) blockedReason = `A video can have at most ${MAX_COMPILATION_CLIPS} scenes.`;
  const eligible = blockedReason === null;

  async function start() {
    if (inFlight.current || running || !eligible) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      const scenes = screens
        .filter((s) => s.screenNumber > 0 && s.approvedGenerationId)
        .map((s) => ({ videoScreenId: s.id, videoGenerationId: s.approvedGenerationId! }));
      const res = await fetch(`/api/v1/video-projects/${projectId}/compilations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenes, knownSceneIds: screens.filter((s) => s.screenNumber > 0).map((s) => s.id) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string; code?: string };
        setError(d.error ?? 'Failed to start compilation');
        setConfirming(false);
        if (res.status === 409) { void loadCompilations(); if (d.code === 'scenes_changed') onStale?.(); }
        return;
      }
      setConfirming(false);
      onStarted?.();
      router.push(`/video-projects/${projectId}/compile`);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 8, height: 36, padding: '0 16px', borderRadius: 9,
    font: '600 13px/1 Satoshi', whiteSpace: 'nowrap',
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {!running && !eligible && (
          <span id="compile-reason" style={{ font: '400 12px/1.3 Satoshi', color: '#75757C', textAlign: 'right' }}>{blockedReason}</span>
        )}
        {running ? (
          <button
            onClick={() => router.push(`/video-projects/${projectId}/compile`)}
            aria-busy="true"
            title="A compilation is in progress. View its progress."
            style={{ ...base, background: '#EFEBFF', color: '#6C47FF', border: '1px solid #D9D0FF', cursor: 'pointer' }}
          >
            <span style={{ width: 12, height: 12, border: '2px solid #6C47FF', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
            Compiling… View
          </button>
        ) : (
          <button
            onClick={() => { setError(''); setConfirming(true); }}
            disabled={!eligible}
            aria-describedby={eligible ? undefined : 'compile-reason'}
            title={eligible ? 'Join all approved scenes into one video' : (blockedReason ?? undefined)}
            style={{
              ...base,
              background: eligible ? '#6C47FF' : '#EFEFEC',
              color: eligible ? '#fff' : '#A3A3A9',
              border: 'none',
              cursor: eligible ? 'pointer' : 'not-allowed',
            }}
          >
            {view.lastFailed ? 'Retry compile' : view.versions.length > 0 ? `Compile v${view.nextVersion}` : 'Compile'}
          </button>
        )}
      </div>

      {confirming && (
        <div
          role="dialog" aria-modal="true" aria-label="Compile the video"
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={(e) => { if (e.target === e.currentTarget && !submitting) setConfirming(false); }}
        >
          <div style={{ background: '#fff', borderRadius: 16, padding: '28px 28px 24px', width: '100%', maxWidth: 400, boxShadow: '0 16px 48px rgba(0,0,0,0.18)' }}>
            <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 8 }}>
              {view.versions.length > 0 ? `Compile Version ${view.nextVersion}?` : 'Compile the full video?'}
            </div>
            <div style={{ font: '400 14px/1.55 Satoshi', color: '#5E5E65', marginBottom: error ? 12 : 24 }}>
              This will stitch your {summary.total} approved scene{summary.total !== 1 ? 's' : ''} into a single video. This may take a few minutes.
              {view.current ? ` Version ${view.current.version} is kept and stays available.` : ''}
            </div>
            {error && (
              <div style={{ marginBottom: 16, padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#991B1B' }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirming(false)}
                disabled={submitting}
                style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer', color: '#111113' }}
              >
                Cancel
              </button>
              <button
                onClick={start}
                disabled={submitting || running || !eligible}
                style={{ height: 38, padding: '0 16px', borderRadius: 9, background: submitting ? '#E4E4E0' : '#6C47FF', color: submitting ? '#A3A3A9' : '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: submitting ? 'not-allowed' : 'pointer' }}
              >
                {submitting ? 'Starting…' : 'Start compiling'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
