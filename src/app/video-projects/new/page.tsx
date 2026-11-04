'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ImageUpload from '@/components/ImageUpload';

interface UploadResult {
  storedPath: string;
  previewUrl: string;
  filename: string;
}

const SAMPLE_SCRIPT = `[Hook]
The easiest way to upgrade any look starts with one simple swap...

[Body]
Start with the fit. The right silhouette changes everything — not too tight, not too loose.
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
        }),
      });
      if (!res.ok) {
        const data = await res.json();
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

  return (
    <AppShell>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '40px 40px 80px' }}>

          {/* Page header row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 36 }}>
            <div>
              <Link
                href="/video-projects"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '400 13px/1 Satoshi', color: '#75757C', textDecoration: 'none', marginBottom: 10 }}
              >
                <i className="icon-arrow-left" style={{ fontSize: 14 }} />
                Projects
              </Link>
              <h1 style={{ margin: 0, font: '700 28px/1.1 Satoshi', letterSpacing: '-0.03em' }}>New project</h1>
            </div>
            <button
              form="new-project-form"
              type="submit"
              disabled={saving || !baseImage || !name || !originalScript}
              style={{
                marginTop: 28,
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: 40, padding: '0 18px',
                borderRadius: 10, background: '#6C47FF', color: '#fff',
                border: 'none', font: '600 14px/1 Satoshi', cursor: 'pointer',
                opacity: (saving || !baseImage || !name || !originalScript) ? 0.5 : 1,
                transition: 'opacity 0.1s',
              }}
            >
              {saving ? 'Creating…' : 'Analyse script'}
              {!saving && <i className="icon-arrow-right" style={{ fontSize: 14 }} />}
            </button>
          </div>

          {error && (
            <div style={{ marginBottom: 20, padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, font: '400 13px/1.4 Satoshi', color: '#991B1B' }}>
              {error}
            </div>
          )}

          <form id="new-project-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

            {/* Row 1: Project name */}
            <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 32, padding: '24px 0', borderBottom: '1px solid #ECECE8' }}>
              <div>
                <div style={{ font: '600 15px/1.3 Satoshi', marginBottom: 4 }}>Project name</div>
                <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>Usually brand + concept.</div>
              </div>
              <div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="Lumen Serum: Morning Routine"
                  style={{
                    width: '100%', height: 40, border: '1px solid #E4E4E0', borderRadius: 10,
                    padding: '0 14px', font: '400 14px/1 Satoshi', background: '#fff',
                    outline: 'none', boxSizing: 'border-box',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                />
              </div>
            </div>

            {/* Row 2: Creator reference */}
            <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 32, padding: '24px 0', borderBottom: '1px solid #ECECE8' }}>
              <div>
                <div style={{ font: '600 15px/1.3 Satoshi', marginBottom: 4 }}>Creator reference</div>
                <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>
                  A photo of the creator. Keeps character and style consistent across scenes.
                </div>
              </div>
              <div>
                <ImageUpload
                  label=""
                  hint="Drop an image here, or browse. JPEG, PNG or WEBP up to 10 MB."
                  value={baseImage}
                  onChange={setBaseImage}
                />
              </div>
            </div>

            {/* Row 3: UGC Script */}
            <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 32, padding: '24px 0' }}>
              <div>
                <div style={{ font: '600 15px/1.3 Satoshi', marginBottom: 4 }}>UGC script</div>
                <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C' }}>
                  Paste the full script the creator will say. Claude splits it into scenes.
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <textarea
                  value={originalScript}
                  onChange={(e) => setOriginalScript(e.target.value)}
                  required
                  placeholder="Paste the full script the creator will say..."
                  style={{
                    width: '100%', minHeight: 220, border: '1px solid #E4E4E0', borderRadius: 10,
                    padding: '12px 14px', font: '400 14px/1.6 Satoshi', background: '#fff',
                    outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                  <span style={{ font: '400 12px/1 Satoshi', color: '#9A9AA0' }}>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
                  <button
                    type="button"
                    onClick={() => setOriginalScript(SAMPLE_SCRIPT)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', font: '400 12px/1 Satoshi', color: '#6C47FF', padding: 0 }}
                  >
                    Paste sample script
                  </button>
                </div>
              </div>
            </div>

          </form>
        </div>
      </div>
    </AppShell>
  );
}
