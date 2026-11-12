'use client';

import { useEffect, useRef, useState, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { ArrowLeft, Download, Trash2, X, Play, Pause, Minus, Plus, Repeat, Scissors, Flag, Upload } from 'lucide-react';

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

interface CategoryNode {
  id: number;
  name: string;
  slug: string;
  scope: string;
  brandScope: string | null;
  parentId: number | null;
  sortOrder: number;
  children: CategoryNode[];
}

function flattenCategories(nodes: CategoryNode[]): CategoryNode[] {
  const result: CategoryNode[] = [];
  function walk(list: CategoryNode[]) { for (const n of list) { result.push(n); walk(n.children); } }
  walk(nodes);
  return result;
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
  duration, inPoint, outPoint, currentTime, onInChange, onOutChange, onSeek,
}: {
  duration: number; inPoint: number; outPoint: number; currentTime: number;
  onInChange: (v: number) => void; onOutChange: (v: number) => void; onSeek: (v: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const toTime = (x: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * duration;
  };

  const startDrag = (handle: 'in' | 'out') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const onMove = (ev: MouseEvent) => {
      const t = toTime(ev.clientX);
      if (handle === 'in') onInChange(Math.max(0, Math.min(t, outPoint - 0.1)));
      else onOutChange(Math.min(duration, Math.max(t, inPoint + 0.1)));
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const inPct = (inPoint / duration) * 100;
  const outPct = (outPoint / duration) * 100;
  const playPct = Math.min((currentTime / duration) * 100, 100);
  const handle = (side: 'in' | 'out'): React.CSSProperties => ({
    position: 'absolute', top: 0, bottom: 0, width: 14, borderRadius: 5, background: '#6C47FF', cursor: 'ew-resize',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    ...(side === 'in' ? { left: `${inPct}%`, marginLeft: -7 } : { left: `${outPct}%`, marginLeft: -7 }),
  });

  return (
    <div ref={trackRef} onClick={(e) => onSeek(toTime(e.clientX))} style={{ position: 'relative', height: 56, borderRadius: 8, background: '#E4E4E0', cursor: 'pointer', userSelect: 'none' }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${inPct}%`, width: `${outPct - inPct}%`, background: '#DCD3FF', borderTop: '2px solid #6C47FF', borderBottom: '2px solid #6C47FF', boxSizing: 'border-box', pointerEvents: 'none' }} />
      <div onMouseDown={startDrag('in')} title="Drag to set the start" style={handle('in')}><span style={{ width: 2, height: 18, borderRadius: 1, background: '#fff' }} /></div>
      <div onMouseDown={startDrag('out')} title="Drag to set the end" style={handle('out')}><span style={{ width: 2, height: 18, borderRadius: 1, background: '#fff' }} /></div>
      <div style={{ position: 'absolute', top: -4, bottom: -4, left: `${playPct}%`, width: 2, background: '#111113', pointerEvents: 'none' }} />
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
  const [playing, setPlaying] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [trimming, setTrimming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Only administrators edit, classify or delete clips; everyone else previews, trims and downloads.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch('/api/v1/admin/me').then((r) => (r.ok ? r.json() : { isAdmin: false })).then((d) => setIsAdmin(Boolean(d.isAdmin))).catch(() => setIsAdmin(false));
  }, []);

  // Category state
  const [allCategories, setAllCategories] = useState<CategoryNode[]>([]);
  const [clipCategoryIds, setClipCategoryIds] = useState<number[]>([]);
  const [catSearchOpen, setCatSearchOpen] = useState(false);
  const [catSearch, setCatSearch] = useState('');
  const catRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function h(e: MouseEvent) { if (catRef.current && !catRef.current.contains(e.target as Node)) setCatSearchOpen(false); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

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
    fetch('/api/v1/broll/categories')
      .then((r) => r.json()).then((data: CategoryNode[]) => setAllCategories(data)).catch(() => {});
    fetch(`/api/v1/broll/${id}/categories`)
      .then((r) => r.json()).then((ids: number[]) => setClipCategoryIds(ids)).catch(() => {});
  }, [id, router]);

  async function toggleCategory(catId: number) {
    const has = clipCategoryIds.includes(catId);
    if (has) {
      await fetch(`/api/v1/broll/${id}/categories`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryIds: [catId] }),
      });
      setClipCategoryIds((prev) => prev.filter((x) => x !== catId));
    } else {
      await fetch(`/api/v1/broll/${id}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryIds: [catId] }),
      });
      setClipCategoryIds((prev) => [...prev, catId]);
    }
  }

  const duration = clip?.durationSeconds || videoDuration || 0;

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
  const trimChanged = duration > 0 && (inPoint > 0.05 || outPoint < duration - 0.05);
  const toggleLoop = () => {
    setLooping((l) => {
      if (!l) {
        const v = videoRef.current;
        if (v) { v.currentTime = inPoint; v.play().catch(() => {}); }
      }
      return !l;
    });
  };
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  const stepper = (handle: 'in' | 'out') => {
    const val = handle === 'in' ? inPoint : outPoint;
    const btn: React.CSSProperties = { width: 30, height: '100%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#111113' };
    const mark: React.CSSProperties = { height: 36, padding: '0 10px', borderRadius: 9, border: '1px solid #E4E4E0', background: '#fff', font: '500 12.5px/1 Satoshi', cursor: 'pointer', whiteSpace: 'nowrap', color: '#111113' };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ font: '500 12px/1 Satoshi', color: '#75757C' }}>{handle === 'in' ? 'Start' : 'End'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', height: 36, border: '1px solid #E4E4E0', borderRadius: 9, background: '#fff' }}>
            <button onClick={() => nudge(handle, -0.1)} aria-label={`Move ${handle === 'in' ? 'start' : 'end'} back 0.1 seconds`} style={btn}><Minus size={13} /></button>
            <span style={{ minWidth: 48, textAlign: 'center', font: '700 13px/1 Satoshi', fontVariantNumeric: 'tabular-nums' }}>{formatTime(val)}</span>
            <button onClick={() => nudge(handle, 0.1)} aria-label={`Move ${handle === 'in' ? 'start' : 'end'} forward 0.1 seconds`} style={btn}><Plus size={13} /></button>
          </div>
          <button onClick={handle === 'in' ? markIn : markOut} title={handle === 'in' ? 'Set start to the playhead' : 'Set end to the playhead'} style={mark}>{handle === 'in' ? 'Mark in' : 'Mark out'}</button>
        </div>
      </div>
    );
  };
  const adminCategoryControls = isAdmin;

  return (
    <AppShell>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Section header, same as the library */}
        <div style={{ height: 64, flexShrink: 0, borderBottom: '1px solid #ECECE8', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px', position: 'sticky', top: 0, zIndex: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 28, height: '100%' }}>
            <span style={{ font: '700 17px/1 Satoshi', letterSpacing: '-0.01em' }}>B-roll Library</span>
            {[['Library', '/broll', true], ['Feedback & gaps', '/broll?tab=feedback', false]].map(([label, href, active]) => (
              <button key={label as string} onClick={() => router.push(href as string)} style={{ height: '100%', padding: 0, border: 'none', borderBottom: `2px solid ${active ? '#6C47FF' : 'transparent'}`, background: 'transparent', color: active ? '#111113' : '#75757C', font: '500 15px/1 Satoshi', cursor: 'pointer' }}>
                {label as string}
              </button>
            ))}
          </div>
          {isAdmin && (
            <button onClick={() => router.push('/broll')} title="Upload from the library" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '600 14px/1 Satoshi', cursor: 'pointer' }}>
              <Upload size={15} /> Upload B-roll
            </button>
          )}
        </div>

        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 28px 48px' }}>
          <button onClick={() => router.push('/broll')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 10px 0 8px', borderRadius: 8, border: '1px solid #E4E4E0', background: '#fff', font: '500 13px/1 Satoshi', cursor: 'pointer', marginBottom: 18, color: '#111113' }}>
            <ArrowLeft size={14} /> Library
          </button>

          <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* 9:16 player */}
            <div style={{ position: 'relative', height: 'min(calc(100vh - 190px), 760px)', minHeight: 480, aspectRatio: '9 / 16', flex: 'none', borderRadius: 14, overflow: 'hidden', background: '#2B2B2E' }}>
              {clip.signedUrl ? (
                <video
                  ref={videoRef}
                  src={clip.signedUrl}
                  playsInline
                  onClick={togglePlay}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration;
                    if (!clip.durationSeconds && Number.isFinite(d)) { setVideoDuration(d); setOutPoint(d); }
                  }}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block', cursor: 'pointer' }}
                />
              ) : (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#A3A3A9', font: '400 14px/1 Satoshi' }}>No preview</div>
              )}
              {clip.signedUrl && (
                <button onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 64, height: 64, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.94)', color: '#111113', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: playing ? 0 : 1, transition: 'opacity .15s' }}>
                  {playing ? <Pause size={26} /> : <Play size={26} style={{ marginLeft: 3 }} />}
                </button>
              )}
              <span style={{ position: 'absolute', left: 12, bottom: 12, height: 24, padding: '0 8px', borderRadius: 6, background: 'rgba(17,17,19,.6)', color: '#fff', display: 'flex', alignItems: 'center', font: '500 12px/1 Satoshi', fontVariantNumeric: 'tabular-nums' }}>
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            {/* Details and trim */}
            <div style={{ flex: 1, minWidth: 340, maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h1 style={{ margin: 0, font: '700 26px/1.2 Satoshi', letterSpacing: '-0.02em' }}>{clip.title}</h1>
                {tags.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                    {tags.map((t) => (
                      <span key={t} style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 9px', borderRadius: 7, background: '#EFEFEC', color: '#3A3A3F', font: '500 12px/1 Satoshi' }}>{t}</span>
                    ))}
                  </div>
                )}
                {(clip.subject || clip.activity || clip.setting || clip.brand) && (
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {[['Subject', clip.subject], ['Activity', clip.activity], ['Setting', clip.setting], ['Brand', clip.brand]].filter(([, v]) => v).map(([label, value]) => (
                      <div key={label} style={{ display: 'flex', gap: 8 }}>
                        <span style={{ font: '400 12px/1.4 Satoshi', color: '#A3A3A9', minWidth: 56 }}>{label}</span>
                        <span style={{ font: '500 12px/1.4 Satoshi', color: '#111113' }}>{value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {duration > 0 && (
                <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: 18 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                    <span style={{ font: '700 14px/1 Satoshi' }}>Trim</span>
                    <span style={{ font: '500 13px/1 Satoshi', color: '#75757C' }}>{selectionSec.toFixed(1)}s selected</span>
                  </div>
                  <TrimTrack
                    duration={duration}
                    inPoint={inPoint}
                    outPoint={outPoint}
                    currentTime={currentTime}
                    onInChange={setIn}
                    onOutChange={setOut}
                    onSeek={(t) => { if (videoRef.current) videoRef.current.currentTime = t; setCurrentTime(t); }}
                  />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
                    {stepper('in')}
                    {stepper('out')}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
                    <button onClick={toggleLoop} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', borderRadius: 10, border: `1px solid ${looping ? '#6C47FF' : '#E4E4E0'}`, background: looping ? '#EFEBFF' : '#fff', color: looping ? '#6C47FF' : '#111113', font: '500 13px/1 Satoshi', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      <Repeat size={14} /> {looping ? 'Stop preview' : 'Preview selection'}
                    </button>
                    {trimChanged && (
                      <button onClick={reset} style={{ height: 36, padding: '0 8px', border: 'none', background: 'transparent', font: '500 13px/1 Satoshi', color: '#5E5E65', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}>Reset</button>
                    )}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button onClick={downloadFull} disabled={downloading || !clip.signedUrl} style={{ background: '#fff', border: '1px solid #E4E4E0', color: '#111113', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42, padding: '0 16px', borderRadius: 10, font: '500 14px/1 Satoshi', cursor: 'pointer', whiteSpace: 'nowrap', flex: 1 }}>
                  <Download size={15} /> Download full clip
                </button>
                <button onClick={downloadTrimmed} disabled={trimming || !trimChanged} style={{ background: '#6C47FF', color: '#fff', border: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42, padding: '0 16px', borderRadius: 10, font: '700 14px/1 Satoshi', whiteSpace: 'nowrap', flex: 1, opacity: trimChanged ? 1 : 0.5, cursor: trimming ? 'wait' : trimChanged ? 'pointer' : 'not-allowed' }}>
                  <Scissors size={15} /> {trimming ? 'Processing…' : 'Download trimmed clip'}
                </button>
              </div>

              <button onClick={() => router.push('/broll?tab=feedback')} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', padding: 0, font: '500 13px/1 Satoshi', color: '#5E5E65', cursor: 'pointer' }}>
                <Flag size={13} /> Give feedback on this clip
              </button>

              {/* Categories: everyone sees them, only administrators change them */}
              {(clipCategoryIds.length > 0 || adminCategoryControls) && allCategories.length > 0 && (
                <div style={{ borderTop: '1px solid #ECECE8', paddingTop: 16 }}>
                  <div style={{ font: '700 13px/1 Satoshi', marginBottom: 10 }}>Categories</div>
                  {clipCategoryIds.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: adminCategoryControls ? 10 : 0 }}>
                      {clipCategoryIds.map((cid) => {
                        const cat = flattenCategories(allCategories).find((c) => c.id === cid);
                        return cat ? (
                          <span key={cid} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px', borderRadius: 7, background: '#EFEBFF', color: '#6C47FF', font: '500 12px/24px Satoshi' }}>
                            {cat.name}
                            {adminCategoryControls && <X size={10} style={{ cursor: 'pointer' }} onClick={() => toggleCategory(cid)} />}
                          </span>
                        ) : null;
                      })}
                    </div>
                  )}
                  {adminCategoryControls && (
                    <div ref={catRef} style={{ position: 'relative' }}>
                      <button onClick={() => setCatSearchOpen((o) => !o)} style={{ height: 30, padding: '0 12px', border: '1px dashed #D6D6D1', borderRadius: 8, background: '#fff', font: '400 12px/1 Satoshi', color: '#75757C', cursor: 'pointer' }}>
                        + Add category
                      </button>
                      {catSearchOpen && (
                        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 100, background: '#fff', border: '1px solid #E4E4E0', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', minWidth: 220, maxHeight: 260, overflowY: 'auto', padding: '6px 0' }}>
                          <div style={{ padding: '0 8px 6px', borderBottom: '1px solid #ECECE8', marginBottom: 2 }}>
                            <input autoFocus value={catSearch} onChange={(e) => setCatSearch(e.target.value)} placeholder="Search categories…" style={{ width: '100%', height: 28, border: '1px solid #E4E4E0', borderRadius: 6, padding: '0 8px', font: '400 12px/1 Satoshi', outline: 'none', boxSizing: 'border-box' }} />
                          </div>
                          {flattenCategories(allCategories)
                            .filter((c) => !catSearch || c.name.toLowerCase().includes(catSearch.toLowerCase()))
                            .map((c) => {
                              const checked = clipCategoryIds.includes(c.id);
                              const isRoot = c.parentId === null;
                              return (
                                <button key={c.id} onClick={() => toggleCategory(c.id)}
                                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: `7px 12px 7px ${isRoot ? 12 : 24}px`, border: 'none', background: checked ? '#F3F0FF' : 'transparent', color: '#111113', font: `${isRoot ? 500 : 400} 13px/1.4 Satoshi`, cursor: 'pointer' }}
                                >
                                  <span style={{ width: 14, height: 14, border: `2px solid ${checked ? '#6C47FF' : '#D6D6D1'}`, borderRadius: 3, background: checked ? '#6C47FF' : '#fff', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    {checked && <span style={{ color: '#fff', fontSize: 9, lineHeight: 1 }}>✓</span>}
                                  </span>
                                  {c.name}
                                </button>
                              );
                            })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {isAdmin && (
                <button onClick={() => setConfirmDelete(true)} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: 0, border: 'none', background: 'transparent', color: '#A3A3A9', font: '500 13px/1 Satoshi', cursor: 'pointer' }}>
                  <Trash2 size={14} /> Delete clip
                </button>
              )}
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
