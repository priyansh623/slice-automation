'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import ProjectHeader from '@/components/ProjectHeader';
import { Play, Pause, RotateCcw, Download } from 'lucide-react';

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

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
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
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
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
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setProject(d); })
      .catch(() => {});
    loadCompilation();
  }, [id, cid]);

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
  const tone = tones[(project?.id ?? 0) % tones.length];

  const numScenes = project?.screens.length ?? 0;
  const activeSegment = duration > 0 && numScenes > 0
    ? Math.min(Math.floor((currentTime / duration) * numScenes), numScenes - 1)
    : 0;

  const currentScene = project?.screens[activeSegment] ?? null;

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setIsPlaying(true); }
    else { v.pause(); setIsPlaying(false); }
  }

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

  const isProcessing = compilation?.status === 'pending' || compilation?.status === 'processing';
  const isFailed = compilation?.status === 'failed';
  const isCompleted = compilation?.status === 'completed';

  const projectSteps = [
    { label: 'Script', status: 'complete' as const },
    { label: 'Breakdown', status: 'complete' as const },
    { label: 'Scenes', status: 'complete' as const },
    { label: 'Compile', status: 'complete' as const },
    { label: 'Review', status: 'active' as const },
  ];

  return (
    <AppShell>
      <ProjectHeader projectId={id} projectName={project.name} steps={projectSteps} />

      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{
          minHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
          padding: '24px 32px',
        }}>
          {error && (
            <div className="alert alert-error" style={{ width: '100%', maxWidth: 360 }}>{error}</div>
          )}

          {/* Video player */}
          <div style={{
            position: 'relative',
            height: 'min(62vh, 640px)',
            aspectRatio: '9/16',
            borderRadius: 14,
            overflow: 'hidden',
            backgroundColor: tone,
            flexShrink: 0,
          }}>
            {/* Scene badge */}
            {isCompleted && currentScene && (
              <div style={{
                position: 'absolute',
                top: 12,
                right: 12,
                zIndex: 10,
                background: 'rgba(0,0,0,0.55)',
                backdropFilter: 'blur(6px)',
                borderRadius: 8,
                padding: '5px 10px',
                font: '500 12px/1.3 Satoshi',
                color: '#fff',
                pointerEvents: 'none',
              }}>
                Scene {currentScene.screenNumber}
                {currentScene.approvedGenerationId ? ` · Gen ${currentScene.approvedGenerationId}` : ''}
              </div>
            )}

            {isProcessing ? (
              <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid rgba(0,0,0,0.12)', borderTop: '3px solid rgba(0,0,0,0.5)', animation: 'spin 1s linear infinite' }} />
                <div style={{ font: '500 13px/1 Satoshi', color: 'rgba(0,0,0,0.6)' }}>Compiling your video…</div>
              </div>
            ) : isFailed ? (
              <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <div style={{ font: '400 14px/1.4 Satoshi', color: 'rgba(0,0,0,0.5)', textAlign: 'center' }}>Compilation failed</div>
              </div>
            ) : signedUrl ? (
              <video
                ref={videoRef}
                src={signedUrl}
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onDurationChange={(e) => setDuration(e.currentTarget.duration)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
              />
            ) : (
              <div style={{ width: '100%', height: '100%' }} />
            )}
          </div>

          {/* Segment strip */}
          {numScenes > 0 && (
            <div style={{
              display: 'flex',
              gap: 2,
              height: 28,
              width: 'min(calc(62vh * 9/16), 360px)',
              flexShrink: 0,
            }}>
              {project.screens.map((s, i) => {
                const isActive = i === activeSegment && isCompleted;
                return (
                  <div key={s.id} style={{
                    flex: 1,
                    borderRadius: 4,
                    background: isActive ? '#6C47FF' : '#D6D6D1',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    font: '500 11px/1 Satoshi',
                    color: isActive ? '#fff' : '#5E5E65',
                    cursor: 'default',
                    transition: 'background 0.2s',
                  }}>
                    {i + 1}
                  </div>
                );
              })}
            </div>
          )}

          {/* Control row */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: 'min(calc(62vh * 9/16), 360px)',
            flexShrink: 0,
          }}>
            {/* Play/pause button */}
            <button
              onClick={togglePlay}
              disabled={!signedUrl}
              style={{
                width: 38,
                height: 38,
                flexShrink: 0,
                borderRadius: '50%',
                background: signedUrl ? '#6C47FF' : '#E4E4E0',
                color: signedUrl ? '#fff' : '#A3A3A9',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: signedUrl ? 'pointer' : 'not-allowed',
              }}
            >
              {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>

            {/* Time */}
            <span style={{ font: '500 13px/1 Satoshi', color: '#5E5E65', whiteSpace: 'nowrap' }}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <div style={{ flex: 1 }} />

            {/* Fix this scene */}
            {isFailed ? (
              <Link href={`/video-projects/${id}/compile`} style={{ textDecoration: 'none' }}>
                <button style={{
                  height: 36, padding: '0 14px', borderRadius: 9,
                  background: 'transparent', border: '1px solid #D0D0CC',
                  font: '500 13px/1 Satoshi', cursor: 'pointer', color: '#111113',
                }}>
                  <RotateCcw size={13} style={{ marginRight: 6 }} />
                  Try again
                </button>
              </Link>
            ) : (
              <Link href={`/video-projects/${id}/screens/1`} style={{ textDecoration: 'none' }}>
                <button style={{
                  height: 36, padding: '0 14px', borderRadius: 9,
                  background: 'transparent', border: '1px solid #D0D0CC',
                  font: '500 13px/1 Satoshi', cursor: 'pointer', color: '#111113',
                }}>
                  Fix this scene
                </button>
              </Link>
            )}

            {/* Download */}
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
                  setDownloadError('Download failed. Please try again.');
                } finally {
                  setDownloading(false);
                }
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 36,
                padding: '0 14px',
                borderRadius: 9,
                background: downloading || !isCompleted ? '#E4E4E0' : '#6C47FF',
                color: downloading || !isCompleted ? '#A3A3A9' : '#fff',
                border: 'none',
                font: '700 13px/1 Satoshi',
                cursor: downloading || !isCompleted ? 'not-allowed' : 'pointer',
              }}
            >
              <Download size={14} />
              {downloading ? 'Downloading…' : 'Download'}
            </button>
          </div>

          {downloadError && (
            <div className="alert alert-error" style={{ width: '100%', maxWidth: 360, fontSize: 13 }}>{downloadError}</div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
