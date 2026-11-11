'use client';

import { useEffect, useRef, useState, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { ArrowLeft, Download, Trash2, RotateCcw } from 'lucide-react';

interface BrollClip {
  id: number;
  title: string;
  storagePath: string;
  signedUrl: string | null;
  mimeType: string;
  fileSizeBytes: number | null;
  durationSeconds: number | null;
  userTags: string | null;
  subject: string | null;
  activity: string | null;
  setting: string | null;
  brand: string | null;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${m}:${sec.padStart(4, '0')}`;
}

function TrimTrack({
  duration,
  inPoint,
  outPoint,
  currentTime,
  onInChange,
  onOutChange,
}: {
  duration: number;
  inPoint: number;
  outPoint: number;
  currentTime: number;
  onInChange: (v: number) => void;
  onOutChange: (v: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'in' | 'out' | null>(null);

  const toFrac = (x: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  };

  const handleMouseDown = (handle: 'in' | 'out') => (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = handle;
    const onMove = (ev: MouseEvent) => {
      const frac = toFrac(ev.clientX);
      const t = frac * duration;
      if (handle === 'in') onInChange(Math.min(t, outPoint - 0.1));
      else onOutChange(Math.max(t, inPoint + 0.1));
    };
    const onUp = () => {
      dragging.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const inPct = (inPoint / duration) * 100;
  const outPct = (outPoint / duration) * 100;
  const playPct = (currentTime / duration) * 100;

  return (
    <div ref={trackRef} style={{ position: 'relative', height: 36, userSelect: 'none', cursor: 'default' }}>
      {/* Full track */}
      <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 6, transform: 'translateY(-50%)', background: '#E9E9E5', borderRadius: 3 }} />
      {/* Selected range */}
      <div style={{ position: 'absolute', top: '50%', left: `${inPct}%`, width: `${outPct - inPct}%`, height: 6, transform: 'translateY(-50%)', background: '#6C47FF', borderRadius: 3 }} />
      {/* Playhead */}
      <div style={{ position: 'absolute', top: '50%', left: `${Math.min(playPct, 100)}%`, width: 2, height: 20, transform: 'translate(-50%, -50%)', background: '#fff', borderRadius: 1, pointerEvents: 'none', zIndex: 2 }} />
      {/* In handle */}
      <div
        onMouseDown={handleMouseDown('in')}
        style={{ position: 'absolute', top: '50%', left: `${inPct}%`, transform: 'translate(-50%, -50%)', width: 14, height: 28, background: '#6C47FF', borderRadius: 4, cursor: 'ew-resize', zIndex: 3, border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }}
      />
      {/* Out handle */}
      <div
        onMouseDown={handleMouseDown('out')}
        style={{ position: 'absolute', top: '50%', left: `${outPct}%`, transform: 'translate(-50%, -50%)', width: 14, height: 28, background: '#6C47FF', borderRadius: 4, cursor: 'ew-resize', zIndex: 3, border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }}
      />
    </div>
  );
}

export default function BrollClipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [clip, setClip] = useState<BrollClip | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(0);
  const [looping, setLooping] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [trimming, setTrimming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    fetch(`/api/v1/broll/${id}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<BrollClip>; })
      .then((data) => {
        setClip(data);
        const dur = data.durationSeconds ?? 0;
        setInPoint(0);
        setOutPoint(dur);
        setLoading(false);
      })
      .catch(() => { setLoading(false); router.push('/broll'); });
  }, [id, router]);

  const duration = clip?.durationSeconds ?? 0;

  // Sync video currentTime
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const handler = () => setCurrentTime(v.currentTime);
    v.addEventListener('timeupdate', handler);
    return () => v.removeEventListener('timeupdate', handler);
  }, [clip]);

  // Looping: when video exceeds outPoint, jump back to inPoint
  useEffect(() => {
    if (!looping) return;
    const v = videoRef.current;
    if (!v) return;
    const handler = () => {
      if (v.currentTime >= outPoint) {
        v.currentTime = inPoint;
        v.play().catch(() => {});
      }
    };
    v.addEventListener('timeupdate', handler);
    return () => v.removeEventListener('timeupdate', handler);
  }, [looping, inPoint, outPoint]);

  const setIn = useCallback((t: number) => {
    setInPoint(t);
    if (videoRef.current) videoRef.current.currentTime = t;
  }, []);

  const setOut = useCallback((t: number) => {
    setOutPoint(t);
    if (videoRef.current) videoRef.current.currentTime = t;
  }, []);

  const nudge = (handle: 'in' | 'out', delta: number) => {
    if (handle === 'in') {
      const v = Math.max(0, Math.min(inPoint + delta, outPoint - 0.1));
      setIn(v);
    } else {
      const v = Math.max(inPoint + 0.1, Math.min(outPoint + delta, duration));
      setOut(v);
    }
  };

  const markIn = () => setIn(currentTime);
  const markOut = () => setOut(currentTime);
  const reset = () => { setInPoint(0); setOutPoint(duration); setLooping(false); };

  async function downloadFull() {
    if (!clip?.signedUrl) return;
    setDownloading(true);
    const a = document.createElement('a');
    a.href = clip.signedUrl;
    a.download = `${clip.title}.mp4`;
    a.click();
    setDownloading(false);
  }

  async function downloadTrimmed() {
    if (!clip) return;
    setTrimming(true);
    try {
      const res = await fetch(`/api/v1/broll/${clip.id}/trim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inPoint, outPoint }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        alert(err.error ?? 'Trim failed');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${clip.title}_trimmed.mp4`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setTrimming(false);
    }
  }

  async function handleDelete() {
    if (!clip) return;
    setDeleting(true);
    const res = await fetch(`/api/v1/broll/${clip.id}`, { method: 'DELETE' });
    setDeleting(false);
    setConfirmDelete(false);
    if (res.ok) router.push('/broll');
  }

  if (loading) return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#75757C', font: '400 14px/1 Satoshi' }}>Loading…</div>
    </AppShell>
  );

  if (!clip) return null;

  const tags = parseTags(clip.userTags);
  const selectionSec = Math.max(0, outPoint - inPoint);
  const trimChanged = inPoint > 0 || outPoint < duration;

  return (
    <AppShell>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 820, margin: '0 auto', padding: '28px 32px 80px' }}>
          {/* Back */}
          <button onClick={() => router.push('/broll')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 24, border: 'none', background: 'transparent', color: '#75757C', font: '500 13px/1 Satoshi', cursor: 'pointer', padding: 0 }}>
            <ArrowLeft size={14} /> Back to library
          </button>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 28, alignItems: 'start' }}>
            {/* Left: 9:16 player + trim card */}
            <div>
              {/* 9:16 player */}
              <div style={{ background: '#111113', borderRadius: 12, overflow: 'hidden', marginBottom: 16, aspectRatio: '9/16', maxWidth: 320 }}>
                {clip.signedUrl ? (
                  <video
                    ref={videoRef}
                    src={clip.signedUrl}
                    controls
                    style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                  />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: '#5E5E65', font: '400 14px/1 Satoshi' }}>No preview</div>
                )}
              </div>

              {/* Trim card */}
              {duration > 0 && (
                <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '18px 20px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                    <div style={{ font: '600 14px/1 Satoshi' }}>Trim clip</div>
                    {trimChanged && (
                      <button onClick={reset} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', color: '#75757C', font: '400 13px/1 Satoshi', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                        <RotateCcw size={11} /> Reset
                      </button>
                    )}
                  </div>

                  {/* Track */}
                  <TrimTrack
                    duration={duration}
                    inPoint={inPoint}
                    outPoint={outPoint}
                    currentTime={currentTime}
                    onInChange={setIn}
                    onOutChange={setOut}
                  />

                  {/* In/Out timecodes + nudge */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                    {(['in', 'out'] as const).map((handle) => {
                      const val = handle === 'in' ? inPoint : outPoint;
                      return (
                        <div key={handle} style={{ background: '#F6F6F4', borderRadius: 9, padding: '10px 12px' }}>
                          <div style={{ font: '500 11px/1 Satoshi', color: '#75757C', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>{handle === 'in' ? 'In' : 'Out'}</div>
                          <div style={{ font: '600 15px/1 Satoshi', fontVariantNumeric: 'tabular-nums', marginBottom: 8 }}>{formatTime(val)}</div>
                          <div style={{ display: 'flex', gap: 5 }}>
                            {[-0.1, +0.1].map((d) => (
                              <button key={d} onClick={() => nudge(handle, d)} style={{ height: 24, flex: 1, border: '1px solid #E4E4E0', borderRadius: 6, background: '#fff', font: '500 11px/1 Satoshi', cursor: 'pointer', color: '#5E5E65' }}>
                                {d > 0 ? '+0.1s' : '−0.1s'}
                              </button>
                            ))}
                          </div>
                          <button onClick={handle === 'in' ? markIn : markOut} style={{ marginTop: 6, width: '100%', height: 24, border: '1px solid #DCD3FF', borderRadius: 6, background: '#F3F0FF', font: '500 11px/1 Satoshi', color: '#6C47FF', cursor: 'pointer' }}>
                            Mark {handle === 'in' ? 'in' : 'out'}
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Selection info + loop toggle */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                    <div style={{ font: '400 12px/1 Satoshi', color: '#75757C' }}>
                      Selection: <strong style={{ color: '#111113' }}>{formatTime(selectionSec)}</strong>
                    </div>
                    <button
                      onClick={() => {
                        setLooping((l) => {
                          if (!l) {
                            const v = videoRef.current;
                            if (v) { v.currentTime = inPoint; v.play().catch(() => {}); }
                          }
                          return !l;
                        });
                      }}
                      style={{ height: 28, padding: '0 12px', borderRadius: 7, border: `1.5px solid ${looping ? '#6C47FF' : '#E4E4E0'}`, background: looping ? '#EFEBFF' : '#fff', color: looping ? '#6C47FF' : '#5E5E65', font: `${looping ? 600 : 400} 12px/1 Satoshi`, cursor: 'pointer' }}
                    >
                      {looping ? '⏹ Stop loop' : '↻ Preview selection'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Right panel */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Title + tags */}
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '16px 18px' }}>
                <div style={{ font: '700 16px/1.3 Satoshi', marginBottom: 8 }}>{clip.title}</div>
                {tags.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {tags.map((t) => (
                      <span key={t} style={{ height: 24, padding: '0 9px', borderRadius: 7, background: '#EFEFEC', color: '#3A3A3F', font: '500 12px/24px Satoshi' }}>{t}</span>
                    ))}
                  </div>
                )}
                {(clip.subject || clip.activity || clip.setting || clip.brand) && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {[['Subject', clip.subject], ['Activity', clip.activity], ['Setting', clip.setting], ['Brand', clip.brand]].filter(([, v]) => v).map(([label, value]) => (
                      <div key={label} style={{ display: 'flex', gap: 8 }}>
                        <span style={{ font: '400 12px/1.4 Satoshi', color: '#A3A3A9', minWidth: 56 }}>{label}</span>
                        <span style={{ font: '500 12px/1.4 Satoshi', color: '#111113' }}>{value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Downloads */}
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ font: '600 14px/1 Satoshi', marginBottom: 2 }}>Download</div>
                <button
                  onClick={downloadFull}
                  disabled={downloading || !clip.signedUrl}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 14px', border: '1px solid #E4E4E0', borderRadius: 9, background: '#fff', font: '500 13px/1 Satoshi', cursor: downloading ? 'wait' : 'pointer', color: '#111113', transition: 'background 0.12s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#F6F6F4'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                >
                  <Download size={14} />
                  {downloading ? 'Downloading…' : 'Download full clip'}
                  {clip.durationSeconds && <span style={{ marginLeft: 'auto', color: '#A3A3A9', font: '400 12px/1 Satoshi' }}>{formatTime(clip.durationSeconds)}</span>}
                </button>
                {duration > 0 && (
                  <button
                    onClick={downloadTrimmed}
                    disabled={trimming}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 14px', border: `1px solid ${trimChanged ? '#DCD3FF' : '#E4E4E0'}`, borderRadius: 9, background: trimChanged ? '#F3F0FF' : '#fff', font: '500 13px/1 Satoshi', cursor: trimming ? 'wait' : 'pointer', color: trimChanged ? '#6C47FF' : '#75757C', transition: 'background 0.12s' }}
                  >
                    <Download size={14} />
                    {trimming ? 'Processing…' : 'Download trimmed clip'}
                    <span style={{ marginLeft: 'auto', color: trimChanged ? '#9C8DFF' : '#A3A3A9', font: '400 12px/1 Satoshi' }}>{formatTime(selectionSec)}</span>
                  </button>
                )}
              </div>

              {/* Delete */}
              <button
                onClick={() => setConfirmDelete(true)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 36, border: '1px solid transparent', borderRadius: 9, background: 'transparent', color: '#C4C4CC', font: '500 13px/1 Satoshi', cursor: 'pointer' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.borderColor = '#FECACA'; e.currentTarget.style.color = '#DC2626'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = '#C4C4CC'; }}
              >
                <Trash2 size={14} /> Delete clip
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete modal */}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '28px 28px 24px', width: '100%', maxWidth: 380, boxShadow: '0 16px 48px rgba(0,0,0,0.18)' }}>
            <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 8 }}>Delete clip?</div>
            <div style={{ font: '400 14px/1.55 Satoshi', color: '#5E5E65', marginBottom: 24 }}>
              This will permanently remove &ldquo;{clip.title}&rdquo; from your library. This cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(false)} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer', color: '#111113' }}>Cancel</button>
              <button onClick={handleDelete} disabled={deleting} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: deleting ? '#E4E4E0' : '#DC2626', color: deleting ? '#A3A3A9' : '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: deleting ? 'not-allowed' : 'pointer' }}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
