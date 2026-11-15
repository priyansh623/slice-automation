'use client';

import { useEffect, useRef, useState } from 'react';

export interface SceneRef {
  id: number;
  screenNumber: number;
  approvedGenerationId: number | null;
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
};
const card: React.CSSProperties = {
  background: '#fff', borderRadius: 16, padding: '26px 28px 22px', width: '100%', maxHeight: '90vh', overflowY: 'auto',
  boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
};
const label: React.CSSProperties = { display: 'block', font: '600 13px/1.3 Satoshi', color: '#111113', marginBottom: 4 };
const hint: React.CSSProperties = { font: '400 12px/1.45 Satoshi', color: '#75757C', marginBottom: 6 };
const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', border: '1px solid #E4E4E0', borderRadius: 10, padding: '10px 12px',
  font: '400 13px/1.5 Satoshi', background: '#fff', color: '#111113', outline: 'none', resize: 'vertical',
};
const secondary: React.CSSProperties = {
  height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0',
  font: '500 14px/1 Satoshi', cursor: 'pointer', color: '#111113',
};

function ErrorBox({ message }: { message: string }) {
  return <div role="alert" style={{ marginTop: 12, padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#991B1B' }}>{message}</div>;
}

// ── Add scene ────────────────────────────────────────────────────────────────

interface AddProps {
  projectId: number | string;
  /** The scenes in order. */
  scenes: readonly SceneRef[];
  onClose: () => void;
  /** Called with the new scene's number once it exists and its prompt is written. */
  onAdded: (screenNumber: number) => void;
}

// What the person typed is kept in this browser until the scene exists, so a failure, a timeout or a refresh never means
// typing it again. `requestId` names this one "Add scene" attempt: the server uses it so a retry never adds a second scene.
interface Draft { requestId: string; description: string; dialogue: string; visual: string; after: string; inFlightAt: number | null }
const draftKey = (projectId: number | string) => `soma:add-scene-draft:${projectId}`;
const newRequestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

export function readAddSceneDraft(projectId: number | string): Draft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(projectId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return d && typeof d.requestId === 'string' && typeof d.description === 'string' ? d : null;
  } catch { return null; }
}
function writeDraft(projectId: number | string, d: Draft | null) {
  try {
    if (d) window.localStorage.setItem(draftKey(projectId), JSON.stringify(d));
    else window.localStorage.removeItem(draftKey(projectId));
  } catch { /* storage unavailable: the form still works, it just cannot survive a refresh */ }
}

export function AddSceneModal({ projectId, scenes, onClose, onAdded }: AddProps) {
  const restored = useRef<Draft | null>(typeof window !== 'undefined' ? readAddSceneDraft(projectId) : null);
  const [description, setDescription] = useState(restored.current?.description ?? '');
  const [dialogue, setDialogue] = useState(restored.current?.dialogue ?? '');
  const [visual, setVisual] = useState(restored.current?.visual ?? '');
  // 'end' or the id of the scene to insert after
  const [after, setAfter] = useState<string>(restored.current?.after && (restored.current.after === 'end' || scenes.some((s) => String(s.id) === restored.current!.after)) ? restored.current.after : 'end');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(restored.current?.inFlightAt ? 'Your earlier request was interrupted. Your text is saved: press Retry to finish adding the scene (it will not be added twice).' : '');
  const [failed, setFailed] = useState(Boolean(restored.current?.inFlightAt));
  const [touched, setTouched] = useState(false);
  const requestId = useRef(restored.current?.requestId ?? newRequestId());
  const inFlight = useRef(false);
  // Leaving the page aborts the request in the browser; that is not a failure, and the "request was out" marker must survive it.
  const leaving = useRef(false);
  useEffect(() => {
    const onLeave = () => { leaving.current = true; };
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);
    return () => { window.removeEventListener('pagehide', onLeave); window.removeEventListener('beforeunload', onLeave); };
  }, []);

  // Keep the draft up to date while typing.
  useEffect(() => {
    if (!description && !dialogue && !visual) { writeDraft(projectId, null); return; }
    writeDraft(projectId, { requestId: requestId.current, description, dialogue, visual, after, inFlightAt: inFlight.current ? Date.now() : null });
  }, [projectId, description, dialogue, visual, after]);
  const first = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !inFlight.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const missingDescription = description.trim().length === 0;

  async function submit() {
    setTouched(true);
    if (missingDescription || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    setFailed(false);
    // Remember that a request is out, so a refresh while it runs can offer a safe retry.
    writeDraft(projectId, { requestId: requestId.current, description, dialogue, visual, after, inFlightAt: Date.now() });
    try {
      const res = await fetch(`/api/v1/video-projects/${projectId}/screens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          dialogue,
          visualInstructions: visual,
          afterScreenId: after === 'end' ? null : Number(after),
          requestId: requestId.current,
        }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; code?: string; screen?: { screenNumber: number } };
      if (res.status === 502 && data.code === 'prompt_failed' && data.screen) {
        // The scene was kept, marked "Generation failed", with everything typed saved on the server: go to it to retry.
        writeDraft(projectId, null);
        onAdded(data.screen.screenNumber);
        return;
      }
      if (!res.ok || !data.screen) {
        // Gateway timeouts and network drops have no JSON body. Either way the text stays in the form and Retry is safe.
        setError(data.error ?? (res.status === 504 || res.status === 502 || res.status === 408
          ? 'Writing the prompt took too long. Your text is saved: press Retry.'
          : 'Could not add the scene. Your text is saved: press Retry.'));
        setFailed(true);
        writeDraft(projectId, { requestId: requestId.current, description, dialogue, visual, after, inFlightAt: null });
        return;
      }
      writeDraft(projectId, null);
      onAdded(data.screen.screenNumber);
    } catch {
      if (leaving.current) return; // the page is going away: keep the draft as it was written when the request left
      setError('Could not reach the server. Your text is saved: press Retry.');
      setFailed(true);
      writeDraft(projectId, { requestId: requestId.current, description, dialogue, visual, after, inFlightAt: null });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Add scene" style={overlay} onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}>
      <div style={{ ...card, maxWidth: 520 }}>
        <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 4 }}>Add a scene</div>
        <div style={{ font: '400 13px/1.5 Satoshi', color: '#5E5E65', marginBottom: 18 }}>
          Describe the scene and we&apos;ll write its prompt from your project&apos;s script, character and creative direction. You can edit the prompt and must approve the video before it is used.
        </div>

        <label htmlFor="scene-description" style={label}>What happens in this scene? <span style={{ color: '#DC2626' }}>*</span></label>
        <textarea
          id="scene-description" ref={first} rows={4} value={description} disabled={submitting}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. He holds up the card and shows the camera how it looks."
          aria-invalid={touched && missingDescription}
          style={{ ...field, borderColor: touched && missingDescription ? '#DC2626' : '#E4E4E0' }}
        />
        {touched && missingDescription && <div style={{ font: '400 12px/1.4 Satoshi', color: '#DC2626', marginTop: 4 }}>Describe what happens in this scene.</div>}

        <div style={{ height: 14 }} />
        <label htmlFor="scene-dialogue" style={label}>Dialogue <span style={{ font: '400 12px/1 Satoshi', color: '#9A9AA0' }}>(optional)</span></label>
        <div style={hint}>The exact words spoken. Leave empty for a scene with no speech: nothing will be written for you.</div>
        <textarea id="scene-dialogue" rows={2} value={dialogue} disabled={submitting} onChange={(e) => setDialogue(e.target.value)} style={field} />

        <div style={{ height: 14 }} />
        <label htmlFor="scene-visual" style={label}>Visual instructions <span style={{ font: '400 12px/1 Satoshi', color: '#9A9AA0' }}>(optional)</span></label>
        <div style={hint}>Framing, setting, props, lighting or mood you want to see.</div>
        <textarea id="scene-visual" rows={2} value={visual} disabled={submitting} onChange={(e) => setVisual(e.target.value)} style={field} />

        <div style={{ height: 14 }} />
        <label htmlFor="scene-position" style={label}>Position</label>
        <select
          id="scene-position" value={after} disabled={submitting} onChange={(e) => setAfter(e.target.value)}
          style={{ ...field, resize: 'none', height: 40, padding: '0 10px' }}
        >
          <option value="end">At the end{scenes.length > 0 ? ` (after Scene ${scenes[scenes.length - 1].screenNumber})` : ''}</option>
          {scenes.slice(0, -1).map((s) => (
            <option key={s.id} value={String(s.id)}>After Scene {s.screenNumber}</option>
          ))}
        </select>

        {error && <ErrorBox message={error} />}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={() => { if (!failed) writeDraft(projectId, null); onClose(); }} disabled={submitting} style={{ ...secondary, opacity: submitting ? 0.5 : 1 }}>{failed ? 'Close (keep draft)' : 'Cancel'}</button>
          <button
            onClick={submit} disabled={submitting}
            style={{ height: 38, padding: '0 18px', borderRadius: 9, background: submitting ? '#B9A9FF' : '#6C47FF', color: '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: submitting ? 'wait' : 'pointer' }}
          >
            {submitting ? 'Writing the prompt…' : failed ? 'Retry' : 'Add scene'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete scene ─────────────────────────────────────────────────────────────

interface DeleteProps {
  projectId: number | string;
  scene: SceneRef;
  onClose: () => void;
  onDeleted: (deletedNumber: number) => void;
}

export function DeleteSceneModal({ projectId, scene, onClose, onDeleted }: DeleteProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !inFlight.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/v1/video-projects/${projectId}/screens/${scene.screenNumber}?screenId=${scene.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setError(data.error ?? 'Could not delete the scene. Please try again.'); return; }
      onDeleted(scene.screenNumber);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={`Delete Scene ${scene.screenNumber}`} style={overlay} onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}>
      <div style={{ ...card, maxWidth: 420 }}>
        <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 8 }}>Delete Scene {scene.screenNumber}?</div>
        <div style={{ font: '400 14px/1.55 Satoshi', color: '#5E5E65' }}>
          Scene {scene.screenNumber} will be removed from the video and the scenes after it will be renumbered.
          {scene.approvedGenerationId ? ' It is approved, so the next compiled video will no longer include it.' : ''}
          {' '}Its prompts and generated videos are not deleted from storage.
        </div>
        {error && <ErrorBox message={error} />}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 22 }}>
          <button onClick={onClose} disabled={submitting} style={{ ...secondary, opacity: submitting ? 0.5 : 1 }}>Cancel</button>
          <button
            onClick={confirm} disabled={submitting}
            style={{ height: 38, padding: '0 16px', borderRadius: 9, background: submitting ? '#F3B4B4' : '#DC2626', color: '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: submitting ? 'wait' : 'pointer' }}
          >
            {submitting ? 'Deleting…' : `Delete Scene ${scene.screenNumber}`}
          </button>
        </div>
      </div>
    </div>
  );
}
