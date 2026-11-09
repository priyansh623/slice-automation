'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { FileText, Video, Layers, MessageCircle, Info, RefreshCw } from 'lucide-react';
import AppShell from '@/components/AppShell';

interface AdminSettings {
  scene1HookInstruction: string | null;
  compilationCrf: number;
  updatedAt: number;
}

type NavSection = 'hook' | 'video' | 'compilation' | 'feedback';

const NAV_ITEMS: { key: NavSection; label: string; Icon: React.ElementType }[] = [
  { key: 'hook', label: 'Hook instructions', Icon: FileText },
  { key: 'video', label: 'Video generation', Icon: Video },
  { key: 'compilation', label: 'Compilation', Icon: Layers },
  { key: 'feedback', label: 'Tester feedback', Icon: MessageCircle },
];

const CRF_MARKS = [
  { value: 0, label: 'Lossless' },
  { value: 18, label: 'Recommended' },
  { value: 23, label: 'FFmpeg default' },
  { value: 51, label: 'Smallest' },
];

function crfNote(crf: number): string {
  if (crf <= 2) return 'True lossless encoding';
  if (crf <= 15) return 'Near-lossless quality';
  if (crf <= 20) return 'Visually lossless, recommended';
  if (crf <= 25) return 'Good quality, FFmpeg default range';
  if (crf <= 35) return 'Acceptable quality';
  return 'Lower quality, smallest file';
}

function crfSizeMb(crf: number): string {
  // Rough estimate: 30s at 1080p
  const baseKbps = 8000 * Math.pow(0.88, crf);
  const mb = (baseKbps * 30) / 8 / 1000;
  return mb.toFixed(1);
}

export default function AdminSettingsPage() {
  const [activeSection, setActiveSection] = useState<NavSection>('hook');
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [hookInstruction, setHookInstruction] = useState('');
  const [compilationCrf, setCompilationCrf] = useState(18);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [credits, setCredits] = useState<number | null | undefined>(undefined); // undefined = loading, null = unknown
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);

  const fetchCredits = useCallback(async () => {
    setCreditsLoading(true);
    setCreditsError(null);
    try {
      const res = await fetch('/api/v1/admin/credits');
      const data = await res.json() as { remainingCredits?: number | null; error?: string; raw?: unknown };
      if (!res.ok || data.error) {
        setCredits(null);
        setCreditsError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setCredits(data.remainingCredits ?? null);
      if (data.remainingCredits === null || data.remainingCredits === undefined) {
        const acct = (data as Record<string, unknown>).firstAccount as Record<string, unknown> | undefined;
        const keys = acct ? Object.keys(acct).join(', ') : 'none';
        const vals = acct ? JSON.stringify(acct) : '{}';
        setCreditsError(`Keys: ${keys} | Full: ${vals}`);
      }
    } catch (e) {
      setCredits(null);
      setCreditsError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreditsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch('/api/v1/admin/settings')
      .then((r) => {
        if (!r.ok) throw new Error('Not authorized');
        return r.json();
      })
      .then((data: AdminSettings) => {
        setSettings(data);
        setHookInstruction(data.scene1HookInstruction ?? '');
        setCompilationCrf(data.compilationCrf ?? 18);
      })
      .catch(() => {});
    void fetchCredits();
  }, [fetchCredits]);

  async function handleSave() {
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
    setTestResult(null);
    try {
      const res = await fetch('/api/v1/admin/connection-test');
      if (!res.ok) {
        setTestResult({ ok: false, detail: res.status === 403 ? 'Not authorised' : `HTTP ${res.status}` });
        return;
      }
      const data = await res.json();
      const overall = Object.values(data.results as Record<string, { ok: boolean; detail: string }>).every((r) => r.ok);
      setTestResult({ ok: overall, detail: overall ? 'All services connected' : 'One or more services failed' });
    } catch {
      setTestResult({ ok: false, detail: 'Request failed' });
    } finally {
      setTesting(false);
    }
  }

  const lastEdited = settings?.updatedAt
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(settings.updatedAt))
    : null;

  return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left nav */}
        <nav style={{
          width: 220,
          flexShrink: 0,
          borderRight: '1px solid #ECECE8',
          padding: '28px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          overflowY: 'auto',
        }}>
          <div style={{ font: '600 11px/1 Satoshi', letterSpacing: '0.07em', color: '#9A9AA0', textTransform: 'uppercase', padding: '0 8px', marginBottom: 8 }}>
            Administration
          </div>
          {NAV_ITEMS.map((item) => {
            const isActive = activeSection === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setActiveSection(item.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  height: 36, padding: '0 10px', borderRadius: 8, border: 'none',
                  background: isActive ? '#F0F0EC' : 'transparent',
                  font: `${isActive ? '600' : '400'} 13px/1 Satoshi`,
                  color: isActive ? '#111113' : '#5E5E65',
                  cursor: 'pointer', textAlign: 'left', width: '100%',
                }}
              >
                <item.Icon size={15} style={{ flexShrink: 0 }} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Main content */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ maxWidth: 680, padding: '36px 40px 80px' }}>

            {/* ── Hook Instructions ── */}
            {activeSection === 'hook' && (
              <div>
                <h1 style={{ margin: '0 0 6px', font: '700 22px/1.2 Satoshi', letterSpacing: '-0.02em' }}>Hook instructions</h1>
                <p style={{ margin: '0 0 28px', font: '400 14px/1.6 Satoshi', color: '#5E5E65' }}>
                  Guidelines Claude follows when writing the opening scene&apos;s prompt. Changes apply to <strong>new projects only</strong>, existing projects keep the snapshot taken when they were created.
                </p>

                <textarea
                  value={hookInstruction}
                  onChange={(e) => setHookInstruction(e.target.value)}
                  rows={12}
                  placeholder="e.g. Open with a confident mid-shot. The creator addresses the camera directly with high energy and a slight lean-in. Start with the hook statement before cutting to product."
                  style={{
                    width: '100%', border: '1px solid #E4E4E0', borderRadius: 12,
                    padding: '14px 16px', font: '400 14px/1.6 Satoshi', background: '#fff',
                    outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                    color: '#111113',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                />

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
                  <div style={{ font: '400 12px/1 Satoshi', color: '#9A9AA0' }}>
                    {lastEdited && `Last saved on ${lastEdited}`}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {saveMsg && (
                      <span style={{ font: '400 13px/1 Satoshi', color: saveMsg.startsWith('Error') ? '#dc2626' : '#16a34a' }}>
                        {saveMsg}
                      </span>
                    )}
                    <button
                      onClick={handleSave}
                      disabled={saving || settings === null}
                      style={{
                        height: 38, padding: '0 18px', borderRadius: 9,
                        background: '#6C47FF', color: '#fff', border: 'none',
                        font: '600 14px/1 Satoshi', cursor: 'pointer',
                        opacity: (saving || settings === null) ? 0.6 : 1,
                      }}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Video Generation ── */}
            {activeSection === 'video' && (
              <div>
                <h1 style={{ margin: '0 0 6px', font: '700 22px/1.2 Satoshi', letterSpacing: '-0.02em' }}>Video generation</h1>
                <p style={{ margin: '0 0 28px', font: '400 14px/1.6 Satoshi', color: '#5E5E65' }}>
                  Controls how videos are generated for each scene.
                </p>

                {/* Provider card */}
                <div style={{ border: '1px solid #ECECE8', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
                  <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ font: '600 14px/1 Satoshi', marginBottom: 4 }}>Video provider</div>
                      <div style={{ font: '400 12px/1 Satoshi', color: '#75757C' }}>Google Veo via useapi.net</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 12px/1 Satoshi', color: '#15803D' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                        Connected
                      </span>
                      <button
                        onClick={runConnectionTest}
                        disabled={testing}
                        style={{
                          height: 32, padding: '0 14px', border: '1px solid #E4E4E0', borderRadius: 8,
                          background: '#fff', font: '500 13px/1 Satoshi', cursor: 'pointer',
                        }}
                      >
                        {testing ? 'Testing…' : 'Test connection'}
                      </button>
                    </div>
                  </div>
                  {testResult && (
                    <div style={{
                      padding: '10px 20px',
                      background: testResult.ok ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
                      borderTop: `1px solid ${testResult.ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                      font: '400 12px/1.4 Satoshi',
                      color: testResult.ok ? '#16a34a' : '#dc2626',
                    }}>
                      {testResult.detail}
                    </div>
                  )}
                </div>

                {/* Credits card */}
                <div style={{ border: '1px solid #ECECE8', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
                  <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ font: '600 14px/1 Satoshi', marginBottom: 4 }}>Google Flow credits</div>
                      <div style={{ font: '400 12px/1 Satoshi', color: '#75757C' }}>Remaining balance on your useapi.net account</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                      {creditsLoading ? (
                        <span style={{ font: '400 13px/1 Satoshi', color: '#9A9AA0' }}>Loading…</span>
                      ) : credits !== null && credits !== undefined ? (
                        <span style={{ font: '700 22px/1 Satoshi', color: '#111113' }}>
                          {credits.toLocaleString()}
                          <span style={{ font: '400 12px/1 Satoshi', color: '#75757C', marginLeft: 4 }}>credits</span>
                        </span>
                      ) : creditsError ? (
                        <span style={{ font: '400 11px/1.4 Satoshi', color: '#DC2626', maxWidth: 400, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                          {creditsError}
                        </span>
                      ) : (
                        <span style={{ font: '400 13px/1 Satoshi', color: '#9A9AA0' }}>Unavailable</span>
                      )}
                      <button
                        onClick={() => void fetchCredits()}
                        disabled={creditsLoading}
                        title="Refresh"
                        style={{
                          width: 32, height: 32, border: '1px solid #E4E4E0', borderRadius: 8,
                          background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          opacity: creditsLoading ? 0.4 : 1,
                        }}
                      >
                        <RefreshCw size={14} color="#5E5E65" style={{ animation: creditsLoading ? 'spin 0.75s linear infinite' : 'none' }} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Settings rows */}
                {[
                  { label: 'Quality', desc: 'Clip quality vs. generation cost', value: 'Standard · ≈ 1 credit / sec', editable: false },
                  { label: 'Output format', desc: 'Resolution and orientation', value: '9:16 · 1080 × 1920 · with speech audio', editable: false },
                  { label: 'Parallel generations', desc: 'How many clips run at the same time', value: '3 at a time', editable: false },
                  { label: 'Request timeout', desc: 'Per-generation timeout before marking failed', value: '120 seconds', editable: false },
                ].map((row) => (
                  <div
                    key={row.label}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid #F3F3F1', gap: 20 }}
                  >
                    <div>
                      <div style={{ font: '500 14px/1.3 Satoshi' }}>{row.label}</div>
                      <div style={{ font: '400 12px/1.4 Satoshi', color: '#75757C', marginTop: 2 }}>{row.desc}</div>
                    </div>
                    <div style={{ font: '400 14px/1 Satoshi', color: '#5E5E65', flexShrink: 0 }}>{row.value}</div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Compilation ── */}
            {activeSection === 'compilation' && (
              <div>
                <h1 style={{ margin: '0 0 6px', font: '700 22px/1.2 Satoshi', letterSpacing: '-0.02em' }}>Compilation</h1>
                <p style={{ margin: '0 0 28px', font: '400 14px/1.6 Satoshi', color: '#5E5E65' }}>
                  Settings for the final video compilation step.
                </p>

                {/* CRF card */}
                <div style={{ border: '1px solid #ECECE8', borderRadius: 12, padding: '20px 24px', marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
                    <div>
                      <div style={{ font: '600 14px/1.3 Satoshi', marginBottom: 4 }}>FFmpeg CRF</div>
                      <div style={{ font: '400 12px/1.5 Satoshi', color: '#75757C', maxWidth: 380 }}>
                        Constant Rate Factor controls output quality. Lower values mean higher quality and larger file sizes.
                      </div>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={51}
                      value={compilationCrf}
                      onChange={(e) => setCompilationCrf(parseInt(e.target.value, 10))}
                      style={{
                        width: 72, height: 42, border: '1px solid #E4E4E0', borderRadius: 9,
                        padding: '0 12px', font: '600 20px/1 Satoshi', textAlign: 'center',
                        outline: 'none', background: '#fff', flexShrink: 0,
                      }}
                    />
                  </div>

                  {/* Slider */}
                  <div style={{ marginBottom: 12 }}>
                    <input
                      type="range"
                      min={0}
                      max={51}
                      value={compilationCrf}
                      onChange={(e) => setCompilationCrf(parseInt(e.target.value, 10))}
                      style={{ width: '100%', accentColor: '#6C47FF', cursor: 'pointer' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                      {CRF_MARKS.map((m) => (
                        <div key={m.value} style={{ display: 'flex', flexDirection: 'column', alignItems: m.value === 0 ? 'flex-start' : m.value === 51 ? 'flex-end' : 'center' }}>
                          <div style={{ font: '600 11px/1 Satoshi', color: compilationCrf === m.value ? '#6C47FF' : '#9A9AA0' }}>{m.value}</div>
                          <div style={{ font: '400 10px/1.3 Satoshi', color: '#9A9AA0', marginTop: 2 }}>{m.label}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: '#F9F9F7', borderRadius: 8 }}>
                    <span style={{ font: '400 13px/1 Satoshi', color: '#5E5E65' }}>{crfNote(compilationCrf)}</span>
                    <span style={{ font: '400 12px/1 Satoshi', color: '#75757C' }}>≈ {crfSizeMb(compilationCrf)} MB for a 30 s video</span>
                  </div>
                </div>

                {/* Audio info row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 0', borderBottom: '1px solid #F3F3F1' }}>
                  <Info size={15} color="#9A9AA0" style={{ flexShrink: 0 }} />
                  <span style={{ font: '400 13px/1.5 Satoshi', color: '#5E5E65' }}>
                    Audio is always preserved. Speech is normalised and encoded as AAC 192 kbps.
                  </span>
                </div>

                {/* Worker status row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ font: '500 14px/1 Satoshi' }}>Compilation worker</span>
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 12px/1 Satoshi', color: '#15803D' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                    Online
                  </span>
                </div>

                {/* Save */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
                  {saveMsg && (
                    <span style={{ font: '400 13px/1 Satoshi', color: saveMsg.startsWith('Error') ? '#dc2626' : '#16a34a' }}>
                      {saveMsg}
                    </span>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={saving || settings === null}
                    style={{
                      height: 38, padding: '0 18px', borderRadius: 9,
                      background: '#6C47FF', color: '#fff', border: 'none',
                      font: '600 14px/1 Satoshi', cursor: 'pointer',
                      opacity: (saving || settings === null) ? 0.6 : 1,
                    }}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            )}

            {/* ── Tester Feedback ── */}
            {activeSection === 'feedback' && (
              <div>
                <h1 style={{ margin: '0 0 6px', font: '700 22px/1.2 Satoshi', letterSpacing: '-0.02em' }}>Tester feedback</h1>
                <p style={{ margin: '0 0 28px', font: '400 14px/1.6 Satoshi', color: '#5E5E65' }}>
                  Feedback submitted by testers during video review.
                </p>
                <div style={{ padding: '48px 0', textAlign: 'center' }}>
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: '#F0F0EC', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                    <MessageCircle size={20} color="#9A9AA0" />
                  </div>
                  <div style={{ font: '500 14px/1.3 Satoshi', marginBottom: 6 }}>No feedback yet</div>
                  <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>Feedback submitted from the review screen will appear here.</div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </AppShell>
  );
}
