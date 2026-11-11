'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { ArrowLeft, Tag, CheckCircle, X, RefreshCw, Star, Trash2 } from 'lucide-react';

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
  aiSubjects: string | null;
  aiSummary: string | null;
  processingStatus: string;
  reviewStatus: string;
  userTags: string | null;
  category: string | null;
  notes: string | null;
  qualityRating: number | null;
  createdAt: number;
  updatedAt: number;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function BrollClipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [clip, setClip] = useState<BrollClip | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [userTagsInput, setUserTagsInput] = useState('');
  const [qualityRating, setQualityRating] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    fetch(`/api/v1/broll/${id}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<BrollClip>; })
      .then((data) => {
        setClip(data);
        setTitle(data.title);
        setCategory(data.category ?? '');
        setNotes(data.notes ?? '');
        setUserTagsInput(parseTags(data.userTags).join(', '));
        setQualityRating(data.qualityRating ?? 0);
        setLoading(false);
      })
      .catch(() => { setLoading(false); router.push('/broll'); });
  }, [id, router]);

  async function saveChanges() {
    if (!clip) return;
    setSaving(true);
    const userTags = userTagsInput.split(',').map((t) => t.trim()).filter(Boolean);
    const res = await fetch(`/api/v1/broll/${clip.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, category: category || null, notes: notes || null, userTags, qualityRating: qualityRating || null }),
    });
    if (res.ok) {
      const updated = await res.json() as BrollClip;
      setClip(updated);
    }
    setSaving(false);
  }

  async function setReview(status: 'approved' | 'rejected' | 'unreviewed') {
    if (!clip) return;
    const res = await fetch(`/api/v1/broll/${clip.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewStatus: status }),
    });
    if (res.ok) setClip(await res.json() as BrollClip);
  }

  async function retryProcessing() {
    if (!clip) return;
    const res = await fetch(`/api/v1/broll/${clip.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ processingStatus: 'pending' }),
    });
    if (res.ok) setClip(await res.json() as BrollClip);
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

  const aiTags = parseTags(clip.aiTags);
  const aiSubjects = parseTags(clip.aiSubjects);
  const userTags = parseTags(clip.userTags);

  return (
    <AppShell>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 40px 80px' }}>
          {/* Back */}
          <button onClick={() => router.push('/broll')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 24, border: 'none', background: 'transparent', color: '#75757C', font: '500 13px/1 Satoshi', cursor: 'pointer', padding: 0 }}>
            <ArrowLeft size={15} /> Back to library
          </button>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 32, alignItems: 'start' }}>
            {/* Left: video + AI metadata */}
            <div>
              {/* Video player */}
              <div style={{ background: '#111113', borderRadius: 12, overflow: 'hidden', marginBottom: 20, aspectRatio: '16/9' }}>
                {clip.signedUrl ? (
                  <video src={clip.signedUrl} controls style={{ width: '100%', height: '100%', display: 'block' }} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: '#5E5E65', font: '400 14px/1 Satoshi' }}>No preview available</div>
                )}
              </div>

              {/* AI Analysis */}
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '20px 20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div style={{ font: '600 15px/1 Satoshi' }}>AI Analysis</div>
                  {clip.processingStatus === 'failed' && (
                    <button onClick={retryProcessing} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 10px', borderRadius: 7, border: '1px solid #E4E4E0', background: '#fff', font: '500 12px/1 Satoshi', cursor: 'pointer', color: '#5E5E65' }}>
                      <RefreshCw size={12} /> Retry
                    </button>
                  )}
                </div>

                {clip.processingStatus === 'pending' || clip.processingStatus === 'processing' ? (
                  <div style={{ color: '#75757C', font: '400 14px/1.5 Satoshi' }}>
                    Analysis {clip.processingStatus === 'processing' ? 'in progress' : 'queued'}…
                  </div>
                ) : clip.processingStatus === 'failed' ? (
                  <div style={{ color: '#DC2626', font: '400 14px/1.5 Satoshi' }}>Analysis failed. Click Retry to try again.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {clip.aiSummary && (
                      <div>
                        <div style={{ font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Summary</div>
                        <div style={{ font: '400 14px/1.6 Satoshi', color: '#111113' }}>{clip.aiSummary}</div>
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      {clip.aiMood && (
                        <div>
                          <div style={{ font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Mood</div>
                          <div style={{ font: '500 14px/1 Satoshi', textTransform: 'capitalize' }}>{clip.aiMood}</div>
                        </div>
                      )}
                      {clip.aiSceneType && (
                        <div>
                          <div style={{ font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Scene type</div>
                          <div style={{ font: '500 14px/1 Satoshi', textTransform: 'capitalize' }}>{clip.aiSceneType}</div>
                        </div>
                      )}
                    </div>
                    {aiSubjects.length > 0 && (
                      <div>
                        <div style={{ font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Subjects</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {aiSubjects.map((s) => (
                            <span key={s} style={{ height: 24, padding: '0 10px', borderRadius: 999, background: '#F0F0EC', color: '#3A3A3F', font: '500 12px/24px Satoshi', textTransform: 'capitalize' }}>{s}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {aiTags.length > 0 && (
                      <div>
                        <div style={{ font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>AI tags</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {aiTags.map((t) => (
                            <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 10px', borderRadius: 999, background: '#F0EEFF', color: '#6C47FF', font: '500 12px/1 Satoshi' }}>
                              <Tag size={10} />{t}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right: metadata editor + review */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Review actions */}
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '16px 18px' }}>
                <div style={{ font: '600 14px/1 Satoshi', marginBottom: 12 }}>Review</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setReview(clip.reviewStatus === 'approved' ? 'unreviewed' : 'approved')}
                    style={{ flex: 1, height: 34, border: 'none', borderRadius: 8, background: clip.reviewStatus === 'approved' ? '#DCFCE7' : '#F3F4F6', color: clip.reviewStatus === 'approved' ? '#166534' : '#5E5E65', font: '600 13px/1 Satoshi', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  >
                    <CheckCircle size={14} /> Approve
                  </button>
                  <button
                    onClick={() => setReview(clip.reviewStatus === 'rejected' ? 'unreviewed' : 'rejected')}
                    style={{ flex: 1, height: 34, border: 'none', borderRadius: 8, background: clip.reviewStatus === 'rejected' ? '#FEF2F2' : '#F3F4F6', color: clip.reviewStatus === 'rejected' ? '#DC2626' : '#5E5E65', font: '600 13px/1 Satoshi', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  >
                    <X size={14} /> Reject
                  </button>
                </div>
              </div>

              {/* Quality rating */}
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '16px 18px' }}>
                <div style={{ font: '600 14px/1 Satoshi', marginBottom: 12 }}>Quality rating</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => setQualityRating(n === qualityRating ? 0 : n)}
                      style={{ width: 36, height: 36, border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Star size={20} fill={n <= qualityRating ? '#FBBF24' : 'none'} color={n <= qualityRating ? '#FBBF24' : '#D1D5DB'} />
                    </button>
                  ))}
                </div>
              </div>

              {/* Editable metadata */}
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '16px 18px' }}>
                <div style={{ font: '600 14px/1 Satoshi', marginBottom: 14 }}>Details</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 5 }}>Title</label>
                    <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', height: 34, border: '1px solid #E4E4E0', borderRadius: 7, padding: '0 10px', font: '400 13px/1 Satoshi', outline: 'none' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />
                  </div>
                  <div>
                    <label style={{ display: 'block', font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 5 }}>Category</label>
                    <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. product, lifestyle" style={{ width: '100%', height: 34, border: '1px solid #E4E4E0', borderRadius: 7, padding: '0 10px', font: '400 13px/1 Satoshi', outline: 'none' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />
                  </div>
                  <div>
                    <label style={{ display: 'block', font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 5 }}>Your tags <span style={{ fontWeight: 400 }}>(comma-separated)</span></label>
                    <input value={userTagsInput} onChange={(e) => setUserTagsInput(e.target.value)} placeholder="e.g. hero, cta, unboxing" style={{ width: '100%', height: 34, border: '1px solid #E4E4E0', borderRadius: 7, padding: '0 10px', font: '400 13px/1 Satoshi', outline: 'none' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />
                  </div>
                  <div>
                    <label style={{ display: 'block', font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 5 }}>Notes</label>
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Internal notes…" style={{ width: '100%', border: '1px solid #E4E4E0', borderRadius: 7, padding: '8px 10px', font: '400 13px/1.5 Satoshi', outline: 'none', resize: 'vertical' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />
                  </div>
                  <button onClick={saveChanges} disabled={saving} style={{ height: 36, border: 'none', borderRadius: 8, background: saving ? '#E4E4E0' : '#6C47FF', color: saving ? '#A3A3A9' : '#fff', font: '600 13px/1 Satoshi', cursor: saving ? 'not-allowed' : 'pointer' }}>
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </div>

              {/* File info */}
              <div style={{ background: '#F9F9F7', border: '1px solid #ECECE8', borderRadius: 14, padding: '14px 18px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { label: 'File size', value: formatBytes(clip.fileSizeBytes) },
                    { label: 'Added', value: formatDate(clip.createdAt) },
                    { label: 'User tags', value: userTags.join(', ') || '—' },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <span style={{ font: '400 12px/1.4 Satoshi', color: '#75757C' }}>{label}</span>
                      <span style={{ font: '500 12px/1.4 Satoshi', color: '#111113', textAlign: 'right' }}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Delete */}
              <button onClick={() => setConfirmDelete(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 36, border: '1px solid transparent', borderRadius: 9, background: 'transparent', color: '#C4C4CC', font: '500 13px/1 Satoshi', cursor: 'pointer' }} onMouseEnter={(e) => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.borderColor = '#FECACA'; e.currentTarget.style.color = '#DC2626'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = '#C4C4CC'; }}>
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
              This will permanently remove "{clip.title}" from your library. This cannot be undone.
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
