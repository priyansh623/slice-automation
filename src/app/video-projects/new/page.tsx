'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import ImageUpload from '@/components/ImageUpload';
import ProjectHeader from '@/components/ProjectHeader';
import { workflowSteps } from '@/lib/steps';

interface UploadResult {
  storedPath: string;
  previewUrl: string;
  filename: string;
}

const SAMPLE_SCRIPT = `[Hook]
The easiest way to upgrade any look starts with one simple swap...

[Body]
Start with the fit. The right silhouette changes everything, not too tight, not too loose.
Add a neutral that works with everything in your wardrobe.
Then one accent piece that makes it feel intentional.

[CTA]
Link in bio for the full breakdown.`;

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export default function NewVideoProjectPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [baseImage, setBaseImage] = useState<UploadResult | null>(null);
  const [originalScript, setOriginalScript] = useState('');
  const [creatorDescription, setCreatorDescription] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!baseImage) {
      setError('Please upload a creator reference image.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/v1/video-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          baseImagePath: baseImage.storedPath,
          originalScript,
          skillVersion: 'v2',
          creatorDescription: creatorDescription.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Failed to create project');
        return;
      }
      const data = await res.json();
      router.push(`/video-projects/${data.id}`);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  const wordCount = countWords(originalScript);
  const ready = !saving && !!baseImage && !!name.trim() && wordCount >= 15;
  const missing = [!name.trim() && 'a name', wordCount < 15 && (wordCount === 0 ? 'a script' : 'a longer script (at least 15 words)'), !baseImage && 'a character image'].filter(Boolean) as string[];
  const hint = ready ? 'Next, the script is split into scenes.' : `Add ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}` : missing[0]} to continue.`;
  const label: React.CSSProperties = { font: '700 15px/1.3 Satoshi', color: '#111113' };
  const field: React.CSSProperties = { width: '100%', border: '1px solid #E4E4E0', borderRadius: 12, background: '#fff', outline: 'none', boxSizing: 'border-box', color: '#111113' };
  const focus = (e: React.FocusEvent<HTMLElement>) => (e.currentTarget.style.borderColor = '#6C47FF');
  const blur = (e: React.FocusEvent<HTMLElement>) => (e.currentTarget.style.borderColor = '#E4E4E0');

  return (
    <AppShell fullscreen>
      <ProjectHeader projectId="new" projectName={name.trim() || 'Untitled project'} steps={workflowSteps('Script')} />
      <form id="new-project-form" onSubmit={handleSubmit} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={{ maxWidth: 1320, height: '100%', minHeight: 560, margin: '0 auto', padding: '28px 36px 24px', boxSizing: 'border-box', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) max(220px, calc((100vh - 250px) * 9 / 16))', gap: 56, alignItems: 'stretch' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, minHeight: 0 }}>
              <div>
                <h1 style={{ margin: 0, font: '700 34px/1.1 Satoshi', letterSpacing: '-0.025em' }}>New video project</h1>
                <p style={{ margin: '6px 0 0', font: '400 16px/1.4 Satoshi', color: '#75757C' }}>Add the script and your character. Everything after this follows from here.</p>
              </div>

              {error && <div role="alert" style={{ padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#991B1B' }}>{error}</div>}

              <label style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span style={label}>Project name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Super Slicer: Card Launch" style={{ ...field, height: 52, padding: '0 18px', font: '500 16px/1 Satoshi' }} onFocus={focus} onBlur={blur} />
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label htmlFor="np-script" style={label}>Script</label>
                  <button type="button" onClick={() => setOriginalScript(SAMPLE_SCRIPT)} style={{ background: 'none', border: 'none', cursor: 'pointer', font: '500 15px/1 Satoshi', color: '#6C47FF', padding: 0 }}>Use sample script</button>
                </div>
                <textarea id="np-script" value={originalScript} onChange={(e) => setOriginalScript(e.target.value)} required placeholder="Paste the full voiceover script" style={{ ...field, flex: 1, minHeight: 120, padding: '16px 20px', font: '400 16px/1.6 Satoshi', resize: 'none' }} onFocus={focus} onBlur={blur} />
                <span style={{ font: '400 14px/1 Satoshi', color: '#75757C' }}>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span style={label}>Character description</span>
                <textarea value={creatorDescription} onChange={(e) => setCreatorDescription(e.target.value)} placeholder="Age, hair, clothing, anything that must stay consistent across scenes" style={{ ...field, height: 92, padding: '14px 20px', font: '400 16px/1.5 Satoshi', resize: 'none' }} onFocus={focus} onBlur={blur} />
              </label>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
              <span style={label}>Master character image <span style={{ font: '500 13px/1 Satoshi', color: '#75757C' }}>9:16</span></span>
              <div style={{ width: '100%', aspectRatio: '9 / 16' }}>
                <ImageUpload variant="tall" label="" value={baseImage} onChange={setBaseImage} />
              </div>
            </div>
          </div>
        </div>

        <div style={{ flexShrink: 0, background: '#fff', borderTop: '1px solid #ECECE8', padding: '14px 32px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 20 }}>
          <span style={{ font: '400 15px/1.3 Satoshi', color: '#75757C' }}>{hint}</span>
          <button type="submit" disabled={!ready} style={{ height: 48, padding: '0 26px', borderRadius: 12, background: ready ? '#6C47FF' : '#C9BBFF', color: '#fff', border: 'none', font: '600 16px/1 Satoshi', cursor: ready ? 'pointer' : 'not-allowed', transition: 'background 0.1s' }}>
            {saving ? 'Creating…' : 'Continue to Scene Breakdown'}
          </button>
        </div>
      </form>
    </AppShell>
  );
}
