'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';

interface AdminSettings {
  scene1HookInstruction: string | null;
  compilationCrf: number;
  updatedAt: number;
}

interface ConnectionResult {
  ok: boolean;
  detail: string;
}

interface ConnectionTestResult {
  ok: boolean;
  results: Record<string, ConnectionResult>;
}

const LABELS: Record<string, string> = {
  database: 'PostgreSQL (pooler)',
  supabaseAuth: 'Supabase Auth',
  storage: 'Supabase Storage',
  anthropic: 'Anthropic API',
  useapi: 'useapi.net',
};

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [hookInstruction, setHookInstruction] = useState('');
  const [compilationCrf, setCompilationCrf] = useState(23);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  const [connResults, setConnResults] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetch('/api/v1/admin/settings')
      .then((r) => {
        if (!r.ok) throw new Error('Not authorized');
        return r.json();
      })
      .then((data: AdminSettings) => {
        setSettings(data);
        setHookInstruction(data.scene1HookInstruction ?? '');
        setCompilationCrf(data.compilationCrf ?? 23);
      })
      .catch(() => {});
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch('/api/v1/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene1HookInstruction: hookInstruction.trim() || null,
          compilationCrf,
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data: AdminSettings = await res.json();
      setSettings(data);
      setSaveMsg('Saved.');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch {
      setSaveMsg('Error saving settings.');
    } finally {
      setSaving(false);
    }
  }

  async function runConnectionTest() {
    setTesting(true);
    setConnResults(null);
    try {
      const res = await fetch('/api/v1/admin/connection-test');
      if (!res.ok) {
        const detail = res.status === 403
          ? 'Not authorized — add your Supabase user UUID to ADMIN_USER_IDS in Vercel env vars'
          : `HTTP ${res.status}`;
        setConnResults({ ok: false, results: { error: { ok: false, detail } } });
        return;
      }
      const data: ConnectionTestResult = await res.json();
      setConnResults(data);
    } catch {
      setConnResults({ ok: false, results: { error: { ok: false, detail: 'Request failed' } } });
    } finally {
      setTesting(false);
    }
  }

  return (
    <AppShell>
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Admin Settings</h1>
        </div>
      </div>

      <div className="page-body" style={{ maxWidth: 720 }}>

        {/* Connection Health */}
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Connection Health</div>
              <div className="card-subtitle">Verify all external services are reachable from this deployment.</div>
            </div>
            <button
              className="btn btn-secondary"
              onClick={runConnectionTest}
              disabled={testing}
            >
              {testing ? 'Testing…' : 'Run tests'}
            </button>
          </div>

          {connResults && (
            <div className="card-body" style={{ paddingTop: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.entries(connResults.results).map(([key, result]) => (
                  <div
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '10px 12px',
                      borderRadius: 8,
                      background: result.ok ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
                      border: `1px solid ${result.ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                    }}
                  >
                    <span style={{
                      fontSize: 16,
                      flexShrink: 0,
                      marginTop: 1,
                    }}>
                      {result.ok ? '✓' : '✗'}
                    </span>
                    <div>
                      <div style={{
                        fontWeight: 600,
                        fontSize: 13,
                        color: result.ok ? '#16a34a' : '#dc2626',
                      }}>
                        {LABELS[key] ?? key}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {result.detail}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Scene 1 hook instruction */}
        <form onSubmit={handleSave}>
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-header">
              <div>
                <div className="card-title">Scene 1 Hook Instruction</div>
                <div className="card-subtitle">
                  Default creative direction injected into every new Scene 1 prompt as a low-priority seed.
                  Feedback from the creator always takes priority.
                </div>
              </div>
            </div>
            <div className="card-body">
              <div className="form-group">
                <textarea
                  className="form-textarea"
                  value={hookInstruction}
                  onChange={(e) => setHookInstruction(e.target.value)}
                  rows={8}
                  placeholder="e.g. Open with a confident mid-shot. The creator addresses the camera directly with high energy and a slight lean-in. Start with the hook statement before cutting to product."
                />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Stored as <code>scene1_hook_snapshot</code> on each project at creation time.
                  Editing this after a project is created does not affect existing projects.
                </p>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-header">
              <div>
                <div className="card-title">FFmpeg Compilation Quality</div>
                <div className="card-subtitle">CRF value for the final compiled video (lower = higher quality, larger file).</div>
              </div>
            </div>
            <div className="card-body">
              <div className="form-group" style={{ maxWidth: 200 }}>
                <label className="form-label">CRF (0–51, default 23)</label>
                <input
                  className="form-input"
                  type="number"
                  min={0}
                  max={51}
                  value={compilationCrf}
                  onChange={(e) => setCompilationCrf(parseInt(e.target.value, 10))}
                />
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'flex-end' }}>
            {saveMsg && (
              <span style={{
                fontSize: 13,
                color: saveMsg.startsWith('Error') ? '#dc2626' : '#16a34a',
              }}>
                {saveMsg}
              </span>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || settings === null}
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>

      </div>
    </AppShell>
  );
}
