'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { Film, Plus, Search, Upload, X, Tag, CheckCircle, Clock, AlertCircle, ChevronRight } from 'lucide-react';

interface BrollClip {
  id: number;
  title: string;
  storagePath: string;
  signedUrl: string | null;
  thumbnailSignedUrl: string | null;
  mimeType: string;
  fileSizeBytes: number | null;
  durationSeconds: number | null;
  aiTags: string | null;
  aiMood: string | null;
  aiSceneType: string | null;
  aiSummary: string | null;
  processingStatus: string;
  reviewStatus: string;
  userTags: string | null;
  category: string | null;
  createdAt: number;
}

type FilterKey = 'all' | 'unreviewed' | 'approved' | 'rejected';
const FILTER_LABELS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unreviewed', label: 'Unreviewed' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

function ProcessingBadge({ status }: { status: string }) {
  if (status === 'completed') return null;
  if (status === 'processing') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 999, background: '#FEF9C3', color: '#854D0E', font: '500 11px/1 Satoshi' }}>
      <Clock size={10} /> Processing
    </span>
  );
  if (status === 'failed') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 999, background: '#FEF2F2', color: '#DC2626', font: '500 11px/1 Satoshi' }}>
      <AlertCircle size={10} /> Failed
    </span>
  );
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 999, background: '#F3F4F6', color: '#6B7280', font: '500 11px/1 Satoshi' }}>
      <Clock size={10} /> Pending
    </span>
  );
}

function ReviewBadge({ status }: { status: string }) {
  if (status === 'approved') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 999, background: '#DCFCE7', color: '#166534', font: '500 11px/1 Satoshi' }}>
      <CheckCircle size={10} /> Approved
    </span>
  );
  if (status === 'rejected') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 999, background: '#FEF2F2', color: '#DC2626', font: '500 11px/1 Satoshi' }}>
      <X size={10} /> Rejected
    </span>
  );
  return null;
}

export default function BrollLibraryPage() {
  const router = useRouter();
  const [clips, setClips] = useState<BrollClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);
  const [pendingVideoFile, setPendingVideoFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pendingThumbFile, setPendingThumbFile] = useState<File | null>(null);

  const fetchClips = useCallback(() => {
    fetch('/api/v1/broll')
      .then((r) => r.json())
      .then((data: BrollClip[]) => { setClips(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchClips(); }, [fetchClips]);

  // Auto-refresh while any clip is pending/processing
  useEffect(() => {
    const hasInFlight = clips.some((c) => c.processingStatus === 'pending' || c.processingStatus === 'processing');
    if (!hasInFlight) return;
    const timer = setInterval(fetchClips, 8000);
    return () => clearInterval(timer);
  }, [clips, fetchClips]);

  const filtered = clips.filter((c) => {
    const matchSearch = !search || c.title.toLowerCase().includes(search.toLowerCase()) ||
      parseTags(c.aiTags).some((t) => t.toLowerCase().includes(search.toLowerCase())) ||
      (c.aiMood ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (c.aiSceneType ?? '').toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === 'all' || c.reviewStatus === filter;
    return matchSearch && matchFilter;
  });

  const countFor = (key: FilterKey) => key === 'all' ? clips.length : clips.filter((c) => c.reviewStatus === key).length;

  function openVideoFile(file: File) {
    setPendingVideoFile(file);
    setUploadTitle(file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
    setShowUploadModal(true);
  }

  async function handleUpload() {
    if (!pendingVideoFile || !uploadTitle.trim()) return;
    setUploading(true);
    setUploadProgress('Uploading video…');

    try {
      const form = new FormData();
      form.append('video', pendingVideoFile);
      if (pendingThumbFile) form.append('thumbnail', pendingThumbFile);

      const uploadRes = await fetch('/api/v1/broll/upload', { method: 'POST', body: form });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? 'Upload failed');
      }
      const upload = await uploadRes.json() as {
        storagePath: string; signedUrl: string | null;
        thumbnailStoragePath: string | null; thumbnailSignedUrl: string | null;
        mimeType: string; fileSizeBytes: number;
      };

      setUploadProgress('Creating clip record…');
      const createRes = await fetch('/api/v1/broll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: uploadTitle.trim(),
          storagePath: upload.storagePath,
          thumbnailStoragePath: upload.thumbnailStoragePath,
          signedUrl: upload.signedUrl,
          thumbnailSignedUrl: upload.thumbnailSignedUrl,
          mimeType: upload.mimeType,
          fileSizeBytes: upload.fileSizeBytes,
        }),
      });
      if (!createRes.ok) throw new Error('Failed to create clip record');

      setShowUploadModal(false);
      setPendingVideoFile(null);
      setPendingThumbFile(null);
      setUploadTitle('');
      fetchClips();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) openVideoFile(file);
  }

  return (
    <AppShell>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 1160, margin: '0 auto', padding: '44px 40px 80px' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
            <div>
              <h1 style={{ margin: 0, font: '700 30px/1.1 Satoshi', letterSpacing: '-0.025em' }}>B-roll Library</h1>
              <p style={{ margin: '8px 0 0', color: '#75757C', font: '400 15px/1.4 Satoshi' }}>
                Upload and manage your B-roll clips. AI analysis runs automatically.
              </p>
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 16px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '500 14px/1 Satoshi', cursor: 'pointer', flexShrink: 0 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#5A36E8')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#6C47FF')}
            >
              <Plus size={16} />
              Upload clip
            </button>
            <input ref={fileInputRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) openVideoFile(f); e.target.value = ''; }} />
          </div>

          {loading ? (
            <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden' }}>
              {[1, 2, 3].map((i) => (
                <div key={i} style={{ display: 'flex', gap: 16, padding: 16, borderBottom: i < 3 ? '1px solid #F3F3F1' : 'none', animation: 'pulse 1.4s ease-in-out infinite' }}>
                  <div style={{ width: 120, height: 72, borderRadius: 8, background: '#EFEFEC', flexShrink: 0 }} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center' }}>
                    <div style={{ height: 14, width: '50%', borderRadius: 4, background: '#EFEFEC' }} />
                    <div style={{ height: 10, width: '30%', borderRadius: 4, background: '#F3F3F1' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : clips.length === 0 ? (
            /* Drop zone / empty state */
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                background: dragOver ? '#F5F3FF' : '#fff',
                border: `2px dashed ${dragOver ? '#6C47FF' : '#DDDDD8'}`,
                borderRadius: 16,
                padding: '72px 40px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
                cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              <div style={{ width: 52, height: 52, borderRadius: 14, background: '#F0F0EC', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
                <Film size={24} color="#75757C" />
              </div>
              <h2 style={{ margin: 0, font: '700 20px/1.3 Satoshi' }}>No clips yet</h2>
              <p style={{ margin: '8px 0 28px', maxWidth: 440, color: '#75757C', font: '400 14px/1.55 Satoshi' }}>
                Drop a video file here or click to browse. AI will auto-tag mood, scene type, and subjects.
              </p>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 16px', borderRadius: 9, background: '#6C47FF', color: '#fff', font: '500 14px/1 Satoshi' }}>
                <Upload size={15} /> Choose file
              </span>
            </div>
          ) : (
            <>
              {/* Search + filter */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <div style={{ position: 'relative', width: 300 }}>
                  <Search size={15} style={{ position: 'absolute', left: 12, top: 10, color: '#A3A3A9' }} />
                  <input
                    value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search clips, tags, mood…"
                    style={{ width: '100%', height: 36, border: '1px solid #E4E4E0', borderRadius: 9, padding: '0 12px 0 34px', font: '400 14px/1 Satoshi', background: '#fff', outline: 'none' }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                  />
                </div>
                <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 10, background: '#EFEFEC' }}>
                  {FILTER_LABELS.map((f) => {
                    const active = filter === f.key;
                    return (
                      <button key={f.key} onClick={() => setFilter(f.key)} style={{ height: 30, padding: '0 12px', border: 'none', borderRadius: 7, background: active ? '#6C47FF' : 'transparent', color: active ? '#FFFFFF' : '#5E5E65', font: '500 13px/1 Satoshi', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {f.label}
                        <span style={{ color: active ? '#CFC2FF' : '#A3A3A9' }}>{countFor(f.key)}</span>
                      </button>
                    );
                  })}
                </div>
                {/* Drop zone button */}
                <button
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ height: 36, padding: '0 14px', border: `1.5px dashed ${dragOver ? '#6C47FF' : '#DDDDD8'}`, borderRadius: 9, background: dragOver ? '#F5F3FF' : 'transparent', color: dragOver ? '#6C47FF' : '#75757C', font: '500 13px/1 Satoshi', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}
                >
                  <Upload size={14} /> Drop or upload
                </button>
              </div>

              {/* Grid */}
              {filtered.length === 0 ? (
                <div style={{ padding: '48px 20px', textAlign: 'center', color: '#75757C', font: '400 14px/1.5 Satoshi', background: '#fff', border: '1px solid #ECECE8', borderRadius: 14 }}>
                  No clips match your search or filter.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
                  {filtered.map((clip) => {
                    const tags = parseTags(clip.aiTags).slice(0, 3);
                    return (
                      <div
                        key={clip.id}
                        onClick={() => router.push(`/broll/${clip.id}`)}
                        style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden', cursor: 'pointer', transition: 'box-shadow 0.15s' }}
                        onMouseEnter={(e) => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)')}
                        onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'none')}
                      >
                        {/* Thumbnail */}
                        <div style={{ width: '100%', aspectRatio: '16/9', background: '#F0F0EC', position: 'relative', overflow: 'hidden' }}>
                          {clip.thumbnailSignedUrl ? (
                            <img src={clip.thumbnailSignedUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          ) : clip.signedUrl ? (
                            <video src={clip.signedUrl} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} muted preload="metadata" />
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
                              <Film size={32} color="#C4C4CC" />
                            </div>
                          )}
                          {/* Processing badge overlay */}
                          {clip.processingStatus !== 'completed' && (
                            <div style={{ position: 'absolute', top: 8, left: 8 }}>
                              <ProcessingBadge status={clip.processingStatus} />
                            </div>
                          )}
                          {/* Review badge overlay */}
                          {clip.reviewStatus !== 'unreviewed' && (
                            <div style={{ position: 'absolute', top: 8, right: 8 }}>
                              <ReviewBadge status={clip.reviewStatus} />
                            </div>
                          )}
                        </div>

                        {/* Info */}
                        <div style={{ padding: '12px 14px 14px' }}>
                          <div style={{ font: '600 14px/1.3 Satoshi', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 6 }}>{clip.title}</div>
                          {clip.aiMood && (
                            <div style={{ font: '400 12px/1.4 Satoshi', color: '#75757C', marginBottom: 8 }}>
                              {clip.aiSceneType && <span style={{ textTransform: 'capitalize' }}>{clip.aiSceneType} · </span>}
                              <span style={{ textTransform: 'capitalize' }}>{clip.aiMood}</span>
                            </div>
                          )}
                          {tags.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                              {tags.map((t) => (
                                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, height: 20, padding: '0 7px', borderRadius: 999, background: '#F0EEFF', color: '#6C47FF', font: '500 11px/1 Satoshi' }}>
                                  <Tag size={9} />{t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Upload modal */}
      {showUploadModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '28px 28px 24px', width: '100%', maxWidth: 440, boxShadow: '0 16px 48px rgba(0,0,0,0.18)' }}>
            <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 4 }}>Upload clip</div>
            <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C', marginBottom: 20 }}>
              {pendingVideoFile?.name}
            </div>

            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Title</label>
            <input
              value={uploadTitle}
              onChange={(e) => setUploadTitle(e.target.value)}
              placeholder="e.g. Product shot – hands on desk"
              style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 16, outline: 'none' }}
              onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
              onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
              onKeyDown={(e) => { if (e.key === 'Enter' && !uploading) handleUpload(); }}
              autoFocus
            />

            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Thumbnail <span style={{ color: '#A3A3A9', fontWeight: 400 }}>(optional)</span></label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              {pendingThumbFile ? (
                <span style={{ font: '400 13px/1 Satoshi', color: '#5E5E65', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pendingThumbFile.name}</span>
              ) : (
                <span style={{ font: '400 13px/1 Satoshi', color: '#A3A3A9', flex: 1 }}>No thumbnail selected</span>
              )}
              <button onClick={() => thumbInputRef.current?.click()} style={{ height: 32, padding: '0 12px', border: '1px solid #E4E4E0', borderRadius: 7, background: '#fff', font: '500 12px/1 Satoshi', cursor: 'pointer' }}>Browse</button>
              <input ref={thumbInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) setPendingThumbFile(f); e.target.value = ''; }} />
            </div>

            {uploadProgress && (
              <div style={{ font: '400 13px/1.5 Satoshi', color: '#6C47FF', marginBottom: 16 }}>{uploadProgress}</div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowUploadModal(false); setPendingVideoFile(null); setPendingThumbFile(null); }} disabled={uploading} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer', color: '#111113' }}>Cancel</button>
              <button onClick={handleUpload} disabled={uploading || !uploadTitle.trim()} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: uploading || !uploadTitle.trim() ? '#E4E4E0' : '#6C47FF', color: uploading || !uploadTitle.trim() ? '#A3A3A9' : '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: uploading || !uploadTitle.trim() ? 'not-allowed' : 'pointer' }}>
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
