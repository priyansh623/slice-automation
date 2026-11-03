'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';

interface VideoProject {
  id: number;
  name: string;
  screens: Array<{ id: number; screenNumber: number; approvedGenerationId: number | null }>;
}

interface Compilation {
  id: number;
  videoProjectId: number;
  status: string;
  createdAt: number;
  outputStoragePath?: string | null;
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const cid = searchParams.get('cid');

  const [project, setProject] = useState<VideoProject | null>(null);
  const [compilation, setCompilation] = useState<Compilation | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchSignedUrl(compilationId: string) {
    const res = await fetch(`/api/v1/video-projects/${id}/compilations/${compilationId}/video`);
    if (!res.ok) return;
    const { signedUrl: url } = await res.json() as { signedUrl: string };
    setSignedUrl(url);
  }

  async function loadCompilation() {
    if (!cid) return;
    const res = await fetch(`/api/v1/video-projects/${id}/compilations`);
    if (!res.ok) return;
    const compilations: Compilation[] = await res.json();
    const found = compilations.find((c) => c.id === parseInt(cid, 10));
    if (!found) { setError('Compilation not found'); return; }
    setCompilation(found);
    if (found.status === 'completed') {
      await fetchSignedUrl(cid);
    }
  }

  useEffect(() => {
    fetch(`/api/v1/video-projects/${id}`)
      .then((r) => r.json())
      .then(setProject);
    loadCompilation();
  }, [id, cid]);

  // Poll while pending/processing
  useEffect(() => {
    if (!compilation) return;
    if (compilation.status === 'pending' || compilation.status === 'processing') {
      pollRef.current = setInterval(async () => {
        await loadCompilation();
      }, 5000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [compilation?.status]);

  if (!project || !cid) {
    return (
      <AppShell>
        <div className="page-body">
          <div className="skeleton" style={{ height: 28, width: '40%', marginBottom: 16 }} />
          <div className="skeleton" style={{ height: 400 }} />
        </div>
      </AppShell>
    );
  }

  const allApproved = project.screens.length > 0 && project.screens.every((s) => !!s.approvedGenerationId);
  const projectSteps = [
    { label: 'Breakdown', status: 'complete' as const },
    { label: 'Scenes', status: 'complete' as const },
    { label: 'Compile', status: 'active' as const },
  ];

  return (
    <AppShell>
      <ProjectHeader projectId={id} projectName={project.name} steps={projectSteps} />

      <div className="page-body" style={{ maxWidth: 900 }}>
        <div style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--text-primary)', marginBottom: 4 }}>
              Full video review
            </h2>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
              Review your compiled video. Compilation #{cid}.
            </p>
          </div>
          <Link href={`/video-projects/${id}/compile`}>
            <button className="btn btn-secondary btn-sm">← Back to compile</button>
          </Link>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>
        )}

        <div className="card">
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {compilation?.status === 'pending' || compilation?.status === 'processing' ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '40px 0' }}>
                <div className="pulse-dots">
                  <div className="pulse-dot" />
                  <div className="pulse-dot" />
                  <div className="pulse-dot" />
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                  Compiling your video…
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 360 }}>
                  This usually takes a few minutes. The page will update automatically when it's ready.
                </p>
              </div>
            ) : compilation?.status === 'failed' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="alert alert-error">Compilation failed. Please try again.</div>
                <Link href={`/video-projects/${id}/compile`}>
                  <button style={{ padding: '10px 20px', background: '#111113', color: '#fff', border: 'none', borderRadius: 'var(--radius-btn)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                    Try again
                  </button>
                </Link>
              </div>
            ) : compilation?.status === 'completed' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {signedUrl ? (
                  <div className="video-result" style={{ borderRadius: 12 }}>
                    <video src={signedUrl} controls style={{ width: '100%', display: 'block', maxHeight: 560 }} />
                  </div>
                ) : (
                  <div className="skeleton" style={{ height: 320, borderRadius: 12 }} />
                )}
                <div style={{ display: 'flex', gap: 10 }}>
                  {signedUrl && (
                    <a href={signedUrl} download>
                      <button style={{ padding: '10px 20px', background: '#111113', color: '#fff', border: 'none', borderRadius: 'var(--radius-btn)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                        Download video
                      </button>
                    </a>
                  )}
                  <Link href={`/video-projects/${id}/compile`}>
                    <button className="btn btn-secondary">Compile another version</button>
                  </Link>
                </div>
              </div>
            ) : (
              <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
                Loading compilation…
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
