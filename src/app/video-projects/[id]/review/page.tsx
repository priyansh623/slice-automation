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
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
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

  const tones = ['#E8E3D8', '#D8E3E8', '#E3D8E8', '#D8E8E3', '#E8DDD8', '#E3E8D8'];

  if (!project || !cid) {
    return (
      <AppShell>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 32px 80px' }}>
            <div className="skeleton" style={{ height: 28, width: '40%', marginBottom: 16 }} />
            <div className="skeleton" style={{ height: 400, borderRadius: 14 }} />
          </div>
        </div>
      </AppShell>
    );
  }

  const projectSteps = [
    { label: 'Breakdown', status: 'complete' as const },
    { label: 'Scenes', status: 'complete' as const },
    { label: 'Compile', status: 'active' as const },
  ];

  const isProcessing = compilation?.status === 'pending' || compilation?.status === 'processing';
  const isFailed = compilation?.status === 'failed';
  const isCompleted = compilation?.status === 'completed';

  return (
    <AppShell>
      <ProjectHeader projectId={id} projectName={project.name} steps={projectSteps} />

      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 20px 80px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {error && (
            <div className="alert alert-error">{error}</div>
          )}

          {/* Video player */}
          <div style={{
            position: 'relative',
            background: '#000',
            borderRadius: 14,
            overflow: 'hidden',
            height: 'min(62vh, 640px)',
            aspectRatio: '9/16',
            margin: '0 auto',
          }}>
            {isProcessing ? (
              <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid rgba(255,255,255,0.2)', borderTop: '3px solid #fff', animation: 'spin 1s linear infinite' }} />
                <div style={{ font: '500 13px/1 Satoshi', color: 'rgba(255,255,255,0.7)' }}>Compiling your video…</div>
              </div>
            ) : isFailed ? (
              <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <div style={{ font: '400 14px/1.4 Satoshi', color: 'rgba(255,255,255,0.6)', textAlign: 'center' }}>Compilation failed</div>
              </div>
            ) : signedUrl ? (
              <video
                src={signedUrl}
                controls
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
              />
            ) : (
              <div style={{ width: '100%', height: '100%', background: '#1A1A1C' }} />
            )}
          </div>

          {/* Scene strip */}
          {project.screens.length > 0 && (
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
              {project.screens.map((s, i) => (
                <Link key={s.id} href={`/video-projects/${id}/screens/${s.screenNumber}`} style={{ textDecoration: 'none', flexShrink: 0 }}>
                  <div style={{
                    width: 44,
                    height: 66,
                    borderRadius: 8,
                    background: tones[i % tones.length],
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    font: '700 11px/1 Satoshi',
                    color: 'rgba(0,0,0,0.5)',
                    border: '1.5px solid transparent',
                    cursor: 'pointer',
                  }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'transparent')}
                  >
                    {i + 1}
                  </div>
                </Link>
              ))}
            </div>
          )}

          {downloadError && (
            <div className="alert alert-error" style={{ fontSize: 13 }}>{downloadError}</div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            {isFailed ? (
              <Link href={`/video-projects/${id}/compile`} style={{ textDecoration: 'none' }}>
                <button style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, padding: '0 18px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '700 13px/1 Satoshi', cursor: 'pointer' }}>
                  <i className="icon-rotate-ccw" style={{ fontSize: 14 }} />
                  Try again
                </button>
              </Link>
            ) : (
              <>
                <Link href={`/video-projects/${id}/screens/1`} style={{ textDecoration: 'none', flex: 1 }}>
                  <button style={{ width: '100%', height: 40, borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 13px/1 Satoshi', cursor: 'pointer', color: '#111113' }}>
                    Fix this scene
                  </button>
                </Link>
                <button
                  disabled={downloading || !isCompleted}
                  onClick={async () => {
                    setDownloading(true);
                    setDownloadError('');
                    try {
                      const res = await fetch(`/api/v1/video-projects/${id}/compilations/${cid}/download`);
                      if (!res.ok) throw new Error(`Server returned ${res.status}`);
                      const blob = await res.blob();
                      const objectUrl = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = objectUrl;
                      a.download = `compilation-${cid}.mp4`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                    } catch {
                      setDownloadError('Download failed — please try again.');
                    } finally {
                      setDownloading(false);
                    }
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 40,
                    padding: '0 18px',
                    borderRadius: 9,
                    background: downloading || !isCompleted ? '#E4E4E0' : '#6C47FF',
                    color: downloading || !isCompleted ? '#A3A3A9' : '#fff',
                    border: 'none',
                    font: '700 13px/1 Satoshi',
                    cursor: downloading || !isCompleted ? 'not-allowed' : 'pointer',
                  }}
                >
                  <i className="icon-download" style={{ fontSize: 14 }} />
                  {downloading ? 'Downloading…' : 'Download'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
