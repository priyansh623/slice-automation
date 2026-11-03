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

export default function NewVideoProjectPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [baseImage, setBaseImage] = useState<UploadResult | null>(null);
  const [originalScript, setOriginalScript] = useState('');
  const [skillVersion, setSkillVersion] = useState('v2');
  const [creatorDescription, setCreatorDescription] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!baseImage) {
      setError('Please upload a character reference image.');
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
          skillVersion,
          ...(creatorDescription.trim() ? { creatorDescription: creatorDescription.trim() } : {}),
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

  return (
    <AppShell>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-breadcrumb">
            <Link href="/video-projects" style={{ color: 'var(--text-muted)' }}>Projects</Link>
            <span style={{ color: 'var(--text-muted)' }}>›</span>
            <span style={{ color: 'var(--text-primary)' }}>New Project</span>
          </div>
        </div>
      </div>

      <div className="page-body" style={{ maxWidth: 860 }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--text-primary)', marginBottom: 4 }}>New Project</h2>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            Upload a reference image and paste your UGC script. Claude will break it into scenes.
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card">
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div className="form-group">
                <label className="form-label">Project name</label>
                <input
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="e.g. Menswear UGC – Week 12"
                  style={{ maxWidth: 420 }}
                />
              </div>

              {/* 2-column: image left, script right */}
              <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 20 }}>
                <div>
                  <ImageUpload
                    label="Reference image"
                    hint="Keeps the character consistent across all scenes."
                    value={baseImage}
                    onChange={setBaseImage}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Script</label>
                  <textarea
                    className="form-textarea"
                    value={originalScript}
                    onChange={(e) => setOriginalScript(e.target.value)}
                    required
                    placeholder={`[Hook]\nThe easiest way to upgrade a man's look...\n\n[Body]\nStart with the pants. The right colour...`}
                    style={{ minHeight: 280, resize: 'vertical' }}
                  />
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    Claude will split this into scenes using the UGC skill.
                  </p>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div className="form-group">
                  <label className="form-label">Creator description <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span></label>
                  <textarea
                    className="form-textarea"
                    value={creatorDescription}
                    onChange={(e) => setCreatorDescription(e.target.value)}
                    rows={3}
                    placeholder="Personality, voice, accent, energy, appearance…"
                  />
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    Seeds the creative brief. More detail is extracted after Screen 1 is approved.
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label">UGC skill version</label>
                  <select
                    className="form-select"
                    value={skillVersion}
                    onChange={(e) => setSkillVersion(e.target.value)}
                    style={{ maxWidth: 160 }}
                  >
                    <option value="v2">v2 (recommended)</option>
                    <option value="v1">v1 (legacy)</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Link href="/video-projects">
              <button type="button" className="btn btn-secondary">Cancel</button>
            </Link>
            <button type="submit" className="btn btn-primary" disabled={saving || !baseImage}>
              {saving ? 'Creating…' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
