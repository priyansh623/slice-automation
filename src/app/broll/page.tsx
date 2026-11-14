'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { applyLibraryFilters } from '@/lib/broll-filters';
import { searchClips } from '@/lib/broll-search';
import { Search, Upload, Download, ChevronDown, X, LibraryBig, SlidersHorizontal } from 'lucide-react';

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
  categoryIds: number[];
  brands?: { brandName: string | null; role: string }[];
  createdAt: number;
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

interface BrollFeedbackItem {
  id: number;
  clipId: number | null;
  text: string;
  nextAction: string;
  createdAt: number;
}

const NEXT_ACTIONS = ['Film it', 'Generate it', 'Fix the details', 'Replace the clip', 'Remove the clip'];

const FILTER_DEFS: [keyof BrollClip, string][] = [
  ['userTags', 'Tags'],
  ['subject', 'Subject'],
  ['activity', 'Activity'],
  ['setting', 'Setting'],
  ['brand', 'Brand'],
];

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

function formatDuration(s: number | null): string {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}:${sec.toString().padStart(2, '0')}` : `0:${sec.toString().padStart(2, '0')}`;
}

function flattenCategories(nodes: CategoryNode[]): CategoryNode[] {
  const result: CategoryNode[] = [];
  function walk(list: CategoryNode[]) {
    for (const n of list) { result.push(n); walk(n.children); }
  }
  walk(nodes);
  return result;
}

function getCategoryDescendantIds(node: CategoryNode): number[] {
  const ids: number[] = [node.id];
  function walk(list: CategoryNode[]) {
    for (const n of list) { ids.push(n.id); walk(n.children); }
  }
  walk(node.children);
  return ids;
}

function collectDistinctValues(clips: BrollClip[], field: keyof BrollClip): string[] {
  const set = new Set<string>();
  for (const c of clips) {
    const v = c[field];
    if (field === 'userTags') {
      parseTags(v as string | null).forEach((t) => set.add(t));
    } else if (typeof v === 'string' && v) {
      set.add(v);
    }
  }
  return Array.from(set).sort();
}

function FilterDropdown({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function h(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const active = !!value;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, height: 34, padding: '0 11px',
          border: `1px solid ${active ? '#6C47FF' : '#E4E4E0'}`, borderRadius: 8,
          background: active ? '#EFEBFF' : '#fff',
          color: active ? '#6C47FF' : '#5E5E65', font: '500 13px/1 Satoshi', cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        {label}{value ? `: ${value}` : ''}
        {active ? (
          <X size={12} onClick={(e) => { e.stopPropagation(); onChange(''); setOpen(false); }} style={{ cursor: 'pointer' }} />
        ) : (
          <ChevronDown size={12} />
        )}
      </button>
      {open && options.length > 0 && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 100, background: '#fff', border: '1px solid #E4E4E0', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', minWidth: 160, padding: '4px 0', maxHeight: 220, overflowY: 'auto' }}>
          {options.map((opt) => (
            <button key={opt} onClick={() => { onChange(opt); setOpen(false); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: opt === value ? '#F3F0FF' : 'transparent', color: opt === value ? '#6C47FF' : '#111113', font: '400 13px/1.4 Satoshi', cursor: 'pointer' }}
              onMouseEnter={(e) => { if (opt !== value) e.currentTarget.style.background = '#F6F6F4'; }}
              onMouseLeave={(e) => { if (opt !== value) e.currentTarget.style.background = 'transparent'; }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function normalizeBrand(b: string | null | undefined): string | null {
  const n = (b ?? '').trim().toLowerCase();
  return n || null;
}

function CategoryChip({ label, active, small, onClick }: { label: string; active: boolean; small?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        height: small ? 28 : 34, padding: small ? '0 10px' : '0 13px',
        border: `1px solid ${active ? '#6C47FF' : '#E4E4E0'}`, borderRadius: 8,
        background: active ? '#EFEBFF' : '#fff',
        color: active ? '#6C47FF' : '#3A3A3F', font: `${active ? 600 : 500} ${small ? 12 : 13}px/1 Satoshi`,
        cursor: 'pointer', whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#F6F6F4'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = '#fff'; }}
    >
      {label}
    </button>
  );
}

function CategoryMultiSelect({ categories, value, onChange }: { categories: CategoryNode[]; value: number[]; onChange: (v: number[]) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function h(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const flat = flattenCategories(categories);
  const q = search.toLowerCase();
  const displayList = q ? flat.filter((c) => c.name.toLowerCase().includes(q)) : flat;

  function toggle(id: number) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  const selectedNames = value.map((id) => flat.find((c) => c.id === id)?.name ?? id).join(', ');

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: 38, padding: '0 12px', border: '1px solid #E4E4E0', borderRadius: 8, background: '#fff', font: '400 14px/1 Satoshi', cursor: 'pointer', textAlign: 'left', color: value.length ? '#111113' : '#A3A3A9', marginBottom: 14 }}
        onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
        onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {value.length ? selectedNames : 'Select categories…'}
        </span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: '#75757C', marginLeft: 6 }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, background: '#fff', border: '1px solid #E4E4E0', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', maxHeight: 260, overflowY: 'auto', marginBottom: 14 }}>
          <div style={{ padding: '6px 8px', borderBottom: '1px solid #ECECE8' }}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search categories…"
              style={{ width: '100%', height: 28, border: '1px solid #E4E4E0', borderRadius: 6, padding: '0 8px', font: '400 12px/1 Satoshi', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
          {displayList.map((n) => {
            const checked = value.includes(n.id);
            const isRoot = n.parentId === null;
            return (
              <button key={n.id} type="button" onClick={() => toggle(n.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: `7px 12px 7px ${isRoot ? 12 : 24}px`, border: 'none', background: checked ? '#F3F0FF' : 'transparent', color: '#111113', font: `${isRoot ? 500 : 400} 13px/1.4 Satoshi`, cursor: 'pointer' }}
                onMouseEnter={(e) => { if (!checked) e.currentTarget.style.background = '#F6F6F4'; }}
                onMouseLeave={(e) => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ width: 16, height: 16, border: `2px solid ${checked ? '#6C47FF' : '#D6D6D1'}`, borderRadius: 4, background: checked ? '#6C47FF' : '#fff', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {checked && <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>}
                </span>
                {n.name}
              </button>
            );
          })}
        </div>
      )}
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: -10, marginBottom: 8 }}>
          {value.map((id) => {
            const cat = flat.find((c) => c.id === id);
            return cat ? (
              <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 8px', borderRadius: 7, background: '#EFEBFF', color: '#6C47FF', font: '500 12px/24px Satoshi' }}>
                {cat.name}
                <X size={10} style={{ cursor: 'pointer' }} onClick={() => toggle(id)} />
              </span>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

function ClipCard({ clip, onClick }: { clip: BrollClip; onClick: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hovering, setHovering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [liveTime, setLiveTime] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const tags = parseTags(clip.userTags).slice(0, 3);

  const startHover = useCallback(() => {
    setHovering(true);
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().catch(() => {});
  }, []);

  const stopHover = useCallback(() => {
    setHovering(false);
    setProgress(0);
    setLiveTime(null);
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    if (!hovering) return;
    const v = videoRef.current;
    if (!v) return;
    const tick = () => {
      if (v.duration > 0) {
        setProgress(v.currentTime / v.duration);
        setLiveTime(v.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [hovering]);

  async function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    if (!clip.signedUrl) return;
    const a = document.createElement('a');
    a.href = clip.signedUrl;
    a.download = `${clip.title}.mp4`;
    a.click();
  }

  return (
    <div
      onClick={onClick}
      onMouseEnter={startHover}
      onMouseLeave={stopHover}
      style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden', cursor: 'pointer', transition: 'box-shadow 0.15s', boxShadow: hovering ? '0 4px 20px rgba(0,0,0,0.1)' : 'none' }}
    >
      {/* 9:16 video area */}
      <div style={{ width: '100%', aspectRatio: '9/16', background: '#111113', position: 'relative', overflow: 'hidden' }}>
        {clip.signedUrl ? (
          <video
            ref={videoRef}
            src={clip.signedUrl}
            muted
            loop
            playsInline
            preload="metadata"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
            <LibraryBig size={28} color="#5E5E65" />
          </div>
        )}

        {/* Progress bar on hover */}
        {hovering && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(255,255,255,0.2)' }}>
            <div style={{ height: '100%', background: '#fff', width: `${progress * 100}%`, transition: 'none' }} />
          </div>
        )}

        {/* Live duration chip */}
        {hovering && liveTime !== null && (
          <div style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.6)', color: '#fff', font: '500 11px/1 Satoshi', padding: '3px 7px', borderRadius: 6 }}>
            {formatDuration(liveTime)}
          </div>
        )}

        {/* Duration badge when not hovering */}
        {!hovering && clip.durationSeconds && (
          <div style={{ position: 'absolute', bottom: 8, right: 8, background: 'rgba(0,0,0,0.5)', color: '#fff', font: '500 11px/1 Satoshi', padding: '3px 7px', borderRadius: 6 }}>
            {formatDuration(clip.durationSeconds)}
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '10px 12px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6, marginBottom: 7 }}>
          <div style={{ font: '600 13px/1.35 Satoshi', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{clip.title}</div>
          <button
            onClick={handleDownload}
            title="Download"
            style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, border: '1px solid #E4E4E0', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#75757C' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#F6F6F4'; e.currentTarget.style.borderColor = '#D6D6D1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#E4E4E0'; }}
          >
            <Download size={13} />
          </button>
        </div>
        {tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {tags.map((t) => (
              <span key={t} style={{ height: 24, padding: '0 9px', borderRadius: 7, background: '#EFEFEC', color: '#3A3A3F', font: '500 12px/24px Satoshi', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** PUTs a file straight to a presigned R2 URL with progress. Rejects on a network failure, an expired link or a refusal. */
function putToR2(url: string, headers: Record<string, string>, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 403 ? 'The upload link expired or was refused. Please try again.' : `Upload failed (${xhr.status}). Please try again.`)));
    xhr.onerror = () => reject(new Error('The upload was interrupted. Please check your connection and try again.'));
    xhr.onabort = () => reject(new Error('The upload was cancelled.'));
    xhr.send(file);
  });
}

export default function BrollLibraryPage() {
  const router = useRouter();
  const [tab, setTab] = useState<'library' | 'feedback'>('library');
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'feedback') setTab('feedback');
  }, []);
  const [clips, setClips] = useState<BrollClip[]>([]);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [feedback, setFeedback] = useState<BrollFeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [categoryFilters, setCategoryFilters] = useState<number[]>([]);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Upload modal state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pendingVideoFile, setPendingVideoFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadTags, setUploadTags] = useState('');
  const [uploadSubject, setUploadSubject] = useState('');
  const [uploadActivity, setUploadActivity] = useState('');
  const [uploadSetting, setUploadSetting] = useState('');
  const [uploadBrand, setUploadBrand] = useState('');
  const [uploadDescription, setUploadDescription] = useState('');
  const [uploadCategoryIds, setUploadCategoryIds] = useState<number[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Feedback form state
  const [fbClipId, setFbClipId] = useState<string>('');
  const [fbText, setFbText] = useState('');
  const [fbAction, setFbAction] = useState('');
  const [fbSubmitting, setFbSubmitting] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchClips = useCallback(() => {
    setLoadError(null);
    fetch('/api/v1/broll')
      .then(async (r) => {
        const data: unknown = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(data)) throw new Error((data as { error?: string } | null)?.error ?? `Could not load the library (${r.status})`);
        setClips(data as BrollClip[]);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Could not load the library'))
      .finally(() => setLoading(false));
  }, []);

  const fetchCategories = useCallback(() => {
    fetch('/api/v1/broll/categories')
      .then((r) => r.json())
      .then((data: CategoryNode[]) => setCategories(data))
      .catch(() => {});
  }, []);

  const fetchFeedback = useCallback(() => {
    fetch('/api/v1/broll/feedback')
      .then((r) => r.json())
      .then((data: BrollFeedbackItem[]) => setFeedback(data))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchClips(); fetchCategories(); fetchFeedback(); }, [fetchClips, fetchCategories, fetchFeedback]);

  function openVideoFile(file: File) {
    setPendingVideoFile(file);
    setUploadTitle(file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
    setUploadTags('');
    setUploadSubject('');
    setUploadActivity('');
    setUploadSetting('');
    setUploadBrand('');
    setUploadDescription('');
    setUploadCategoryIds([]);
    setUploadError(null);
    setShowUploadModal(true);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) openVideoFile(file);
  }

  async function handleUpload() {
    if (!pendingVideoFile || !uploadTitle.trim()) return;
    const tags = uploadTags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tags.length === 0) { setUploadError('At least one tag is required.'); return; }
    setUploading(true);
    setUploadProgress('Uploading video…');
    setUploadError(null);

    try {
      const clipFields = {
        title: uploadTitle.trim(),
        userTags: tags,
        subject: uploadSubject || null,
        activity: uploadActivity || null,
        setting: uploadSetting || null,
        brand: uploadBrand || null,
        description: uploadDescription || null,
      };
      let created: { id: number } | null = null;

      // 1. Preferred: the video goes straight from the browser to R2 (any size up to the server limit) and the server
      //    verifies it before creating the clip. If direct upload is not available, fall back to the server upload below.
      const initRes = await fetch('/api/v1/broll/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: pendingVideoFile.type, fileSize: pendingVideoFile.size, fileName: pendingVideoFile.name }),
      });
      if (initRes.ok) {
        const init = await initRes.json() as { storagePath: string; uploadUrl: string; headers: Record<string, string> };
        await putToR2(init.uploadUrl, init.headers, pendingVideoFile, (pct) => setUploadProgress(`Uploading video… ${pct}%`));
        setUploadProgress('Checking and saving clip…');
        const doneRes = await fetch('/api/v1/broll/upload/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storagePath: init.storagePath, ...clipFields }),
        });
        if (!doneRes.ok) {
          const err = await doneRes.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error ?? 'Failed to save the uploaded clip');
        }
        created = await doneRes.json() as { id: number };
      } else {
        const initErr = await initRes.json().catch(() => ({})) as { error?: string; code?: string };
        if (initErr.code !== 'direct_upload_unavailable') throw new Error(initErr.error ?? 'Upload failed');

        // Fallback: the video passes through the server (limited to about 4 MB by the hosting platform).
        const form = new FormData();
        form.append('video', pendingVideoFile);
        const uploadRes = await fetch('/api/v1/broll/upload', { method: 'POST', body: form });
        if (!uploadRes.ok) {
          const err = await uploadRes.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error ?? 'Upload failed');
        }
        const upload = await uploadRes.json() as { storagePath: string; signedUrl: string | null; mimeType: string; fileSizeBytes: number; durationSeconds: number | null };

        setUploadProgress('Saving clip…');
        const createRes = await fetch('/api/v1/broll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...clipFields,
            storagePath: upload.storagePath,
            signedUrl: upload.signedUrl,
            mimeType: upload.mimeType,
            fileSizeBytes: upload.fileSizeBytes,
            durationSeconds: upload.durationSeconds,
          }),
        });
        if (!createRes.ok) throw new Error('Failed to create clip record');
        created = await createRes.json() as { id: number };
      }

      if (uploadCategoryIds.length > 0 && created) {
        await fetch(`/api/v1/broll/${created.id}/categories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ categoryIds: uploadCategoryIds }),
        });
      }

      setShowUploadModal(false);
      setPendingVideoFile(null);
      fetchClips();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  async function handleFeedbackSubmit() {
    if (!fbText.trim() || !fbAction) return;
    setFbSubmitting(true);
    try {
      await fetch('/api/v1/broll/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipId: fbClipId && fbClipId !== '__missing__' ? Number(fbClipId) : null,
          text: fbText.trim(),
          nextAction: fbAction,
        }),
      });
      setFbText('');
      setFbAction('');
      setFbClipId('');
      fetchFeedback();
    } finally {
      setFbSubmitting(false);
    }
  }

  const flatCategories = useMemo(() => flattenCategories(categories), [categories]);
  const categoryById = useMemo(() => new Map(flatCategories.map((c) => [c.id, c])), [flatCategories]);
  const selectedCategoryIds = new Set(categoryFilters);

  // Brand-specific categories appear alongside Soma-wide ones, narrowed to one brand when the Brand filter is set
  const brandFilter = normalizeBrand(filters.brand);
  const primaryCategories = categories.filter(
    (c) => c.scope !== 'brand' || !brandFilter || normalizeBrand(c.brandScope) === brandFilter,
  );

  function hasSelectedDescendant(node: CategoryNode): boolean {
    return getCategoryDescendantIds(node).some((id) => id !== node.id && selectedCategoryIds.has(id));
  }

  function toggleCategory(node: CategoryNode) {
    if (selectedCategoryIds.has(node.id)) {
      const drop = new Set(getCategoryDescendantIds(node));
      setCategoryFilters((prev) => prev.filter((id) => !drop.has(id)));
    } else {
      setCategoryFilters((prev) => [...prev, node.id]);
    }
  }

  function clearSubcategories(node: CategoryNode) {
    const drop = new Set(getCategoryDescendantIds(node).filter((id) => id !== node.id));
    setCategoryFilters((prev) => prev.filter((id) => !drop.has(id)));
  }

  // Each selected category that has children gets a row for navigating into them
  const openCategories: CategoryNode[] = [];
  (function walk(nodes: CategoryNode[]) {
    for (const n of nodes) {
      if (selectedCategoryIds.has(n.id) && n.children.length > 0) {
        openCategories.push(n);
        walk(n.children);
      }
    }
  })(primaryCategories);

  // A selected category matches itself and its descendants, unless narrowed by a selected subcategory.
  // Separate selections combine with OR.
  const activeCategoryIds: Set<number> | null = (() => {
    if (categoryFilters.length === 0) return null;
    const ids = new Set<number>();
    for (const filterId of categoryFilters) {
      const node = categoryById.get(filterId);
      if (!node || hasSelectedDescendant(node)) continue;
      getCategoryDescendantIds(node).forEach((id) => ids.add(id));
    }
    return ids;
  })();

  // Filters narrow the library first and stay strict. Search then ranks inside what they leave: direct matches
  // first, related matches after (only for broad queries). It cannot bring a filtered-out clip back.
  const filteredPool = applyLibraryFilters(clips, filters, activeCategoryIds);
  const searchResult = searchClips(search.trim(), filteredPool, flatCategories);
  const filtered = searchResult.hits.map((h) => h.clip);
  const firstRelatedIndex = searchResult.hits.findIndex((h) => h.tier === 'related');

  const activeMoreFilterCount = Object.values(filters).filter(Boolean).length;
  const hasActiveFilters = activeMoreFilterCount > 0 || categoryFilters.length > 0;

  function setMetadataFilter(field: string, value: string) {
    setFilters((prev) => ({ ...prev, [field]: value }));
    const brand = field === 'brand' ? normalizeBrand(value) : null;
    if (brand) {
      setCategoryFilters((prev) => prev.filter((id) => {
        const node = categoryById.get(id);
        return !node || node.scope !== 'brand' || normalizeBrand(node.brandScope) === brand;
      }));
    }
  }

  return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Section header */}
        <div style={{ height: 64, flexShrink: 0, borderBottom: '1px solid #ECECE8', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px' }}>
          <div style={{ display: 'flex', gap: 2, padding: '3px', borderRadius: 10, background: '#EFEFEC' }}>
            {(['library', 'feedback'] as const).map((t) => {
              const labels = { library: 'Library', feedback: 'Feedback & gaps' };
              const active = tab === t;
              return (
                <button key={t} onClick={() => setTab(t)} style={{ height: 30, padding: '0 14px', border: 'none', borderRadius: 7, background: active ? '#fff' : 'transparent', color: active ? '#111113' : '#75757C', font: `${active ? 600 : 500} 13px/1 Satoshi`, cursor: 'pointer', boxShadow: active ? '0 1px 4px rgba(0,0,0,0.08)' : 'none', transition: 'all 0.12s' }}>
                  {labels[t]}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => router.push('/broll/categories')}
              style={{ height: 38, padding: '0 14px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', color: '#5E5E65', font: '500 13px/1 Satoshi', cursor: 'pointer', flexShrink: 0 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#F6F6F4')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#fff')}
            >
              Manage categories
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 9, background: dragOver ? '#5A36E8' : '#6C47FF', color: '#fff', border: 'none', font: '600 14px/1 Satoshi', cursor: 'pointer', flexShrink: 0 }}
              onMouseEnter={(e) => { if (!dragOver) e.currentTarget.style.background = '#5A36E8'; }}
              onMouseLeave={(e) => { if (!dragOver) e.currentTarget.style.background = '#6C47FF'; }}
            >
              <Upload size={15} />
              Upload B-roll
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) openVideoFile(f); e.target.value = ''; }} />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 60px' }}>
          {tab === 'library' ? (
            <>
              {/* Search + more filters */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 380 }}>
                  <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#A3A3A9', pointerEvents: 'none' }} />
                  <input
                    value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search clips, tags or categories…"
                    style={{ width: '100%', height: 34, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 10px 0 32px', font: '400 13px/1 Satoshi', background: '#fff', outline: 'none', boxSizing: 'border-box' }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                  />
                </div>
                <button
                  onClick={() => setShowMoreFilters((o) => !o)}
                  aria-expanded={showMoreFilters}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 11px',
                    border: `1px solid ${activeMoreFilterCount > 0 ? '#6C47FF' : '#E4E4E0'}`, borderRadius: 8,
                    background: activeMoreFilterCount > 0 ? '#EFEBFF' : '#fff',
                    color: activeMoreFilterCount > 0 ? '#6C47FF' : '#5E5E65', font: '500 13px/1 Satoshi', cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  <SlidersHorizontal size={13} />
                  More filters{activeMoreFilterCount > 0 ? ` (${activeMoreFilterCount})` : ''}
                  <ChevronDown size={12} style={{ transform: showMoreFilters ? 'rotate(180deg)' : 'none', transition: 'transform 0.12s' }} />
                </button>
                {hasActiveFilters && (
                  <button onClick={() => { setFilters({}); setCategoryFilters([]); }} style={{ height: 34, padding: '0 10px', border: 'none', background: 'transparent', color: '#75757C', font: '400 13px/1 Satoshi', cursor: 'pointer', textDecoration: 'underline' }}>
                    Clear all
                  </button>
                )}
              </div>

              {showMoreFilters && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                  {FILTER_DEFS.map(([field, label]) => (
                    <FilterDropdown
                      key={field}
                      label={label}
                      options={collectDistinctValues(clips, field)}
                      value={filters[field] ?? ''}
                      onChange={(v) => setMetadataFilter(field, v)}
                    />
                  ))}
                </div>
              )}

              {/* Browse categories */}
              {primaryCategories.length > 0 && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ font: '600 12px/1 Satoshi', color: '#75757C', marginBottom: 9 }}>Browse categories</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <CategoryChip label="All clips" active={categoryFilters.length === 0} onClick={() => setCategoryFilters([])} />
                    {primaryCategories.map((c) => (
                      <CategoryChip
                        key={c.id}
                        label={c.scope === 'brand' && c.brandScope ? `${c.name} · ${c.brandScope}` : c.name}
                        active={selectedCategoryIds.has(c.id)}
                        onClick={() => toggleCategory(c)}
                      />
                    ))}
                  </div>
                  {openCategories.map((parent) => (
                    <div key={parent.id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid #ECECE8' }}>
                      <span style={{ font: '500 12px/1 Satoshi', color: '#75757C', marginRight: 4 }}>{parent.name}</span>
                      <CategoryChip small label="All" active={!hasSelectedDescendant(parent)} onClick={() => clearSubcategories(parent)} />
                      {parent.children.map((child) => (
                        <CategoryChip
                          key={child.id}
                          small
                          label={child.name}
                          active={selectedCategoryIds.has(child.id)}
                          onClick={() => toggleCategory(child)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {loading ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))', gap: '24px 16px' }}>
                  {[1, 2, 3, 4, 5, 6].map((i) => (
                    <div key={i} style={{ background: '#E9E9E5', borderRadius: 14, aspectRatio: '9/16', animation: 'pulse 1.4s ease-in-out infinite' }} />
                  ))}
                </div>
              ) : loadError ? (
                <div style={{ padding: '48px 20px', textAlign: 'center', color: '#75757C', font: '400 14px/1.5 Satoshi' }}>
                  <div style={{ marginBottom: 12 }}>{loadError}</div>
                  <button onClick={() => { setLoading(true); fetchClips(); }} style={{ height: 36, padding: '0 16px', borderRadius: 9, border: '1px solid #E4E4E0', background: '#fff', font: '500 13px/1 Satoshi', cursor: 'pointer', color: '#111113' }}>Try again</button>
                </div>
              ) : clips.length === 0 ? (
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ background: dragOver ? '#F5F3FF' : '#fff', border: `2px dashed ${dragOver ? '#6C47FF' : '#D6D6D1'}`, borderRadius: 16, padding: '72px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s' }}
                >
                  <div style={{ width: 52, height: 52, borderRadius: 14, background: '#EFEFEC', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
                    <LibraryBig size={22} color="#75757C" />
                  </div>
                  <h2 style={{ margin: 0, font: '700 18px/1.3 Satoshi' }}>No clips yet</h2>
                  <p style={{ margin: '8px 0 24px', maxWidth: 380, color: '#75757C', font: '400 14px/1.55 Satoshi' }}>
                    Drop a 9:16 video here or click Upload B-roll to get started.
                  </p>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 9, background: '#6C47FF', color: '#fff', font: '600 14px/1 Satoshi' }}>
                    <Upload size={14} /> Upload B-roll
                  </span>
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: '48px 20px', textAlign: 'center', color: '#75757C', font: '400 14px/1.5 Satoshi' }}>
                  No clips match your search or filters.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))', gap: '24px 16px' }}>
                  {filtered.map((clip, i) => (
                    <div key={clip.id} style={{ display: 'contents' }}>
                      {i === firstRelatedIndex && (
                        <div style={{ gridColumn: '1 / -1', font: '500 12px/1 Satoshi', color: '#75757C', paddingTop: 4 }}>
                          Related footage — not an exact match for your search
                        </div>
                      )}
                      <ClipCard clip={clip} onClick={() => router.push(`/broll/${clip.id}`)} />
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            /* Feedback & gaps tab */
            <div style={{ maxWidth: 640 }}>
              <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, padding: '22px 24px 24px', marginBottom: 28 }}>
                <div style={{ font: '600 15px/1 Satoshi', marginBottom: 16 }}>Submit feedback</div>

                {/* Which clip */}
                <label style={{ display: 'block', font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 6 }}>Which clip?</label>
                <select
                  value={fbClipId}
                  onChange={(e) => setFbClipId(e.target.value)}
                  style={{ width: '100%', height: 36, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 10px', font: '400 13px/1 Satoshi', background: '#fff', marginBottom: 14, outline: 'none', color: '#111113' }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                >
                  <option value="">Select a clip (optional)</option>
                  <option value="__missing__">A missing clip</option>
                  {clips.map((c) => <option key={c.id} value={String(c.id)}>{c.title}</option>)}
                </select>

                {/* Feedback text */}
                <label style={{ display: 'block', font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 6 }}>Feedback</label>
                <textarea
                  value={fbText}
                  onChange={(e) => setFbText(e.target.value)}
                  rows={3}
                  placeholder="Describe what's needed or what could be improved…"
                  style={{ width: '100%', border: '1px solid #E4E4E0', borderRadius: 8, padding: '8px 10px', font: '400 13px/1.5 Satoshi', marginBottom: 14, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}
                />

                {/* Next action chips */}
                <label style={{ display: 'block', font: '500 12px/1 Satoshi', color: '#75757C', marginBottom: 8 }}>Next action</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
                  {NEXT_ACTIONS.map((a) => {
                    const sel = fbAction === a;
                    return (
                      <button key={a} onClick={() => setFbAction(sel ? '' : a)} style={{ height: 32, padding: '0 13px', border: `1.5px solid ${sel ? '#6C47FF' : '#E4E4E0'}`, borderRadius: 8, background: sel ? '#EFEBFF' : '#fff', color: sel ? '#6C47FF' : '#5E5E65', font: `${sel ? 600 : 400} 13px/1 Satoshi`, cursor: 'pointer' }}>
                        {a}
                      </button>
                    );
                  })}
                </div>

                <button
                  onClick={handleFeedbackSubmit}
                  disabled={fbSubmitting || !fbText.trim() || !fbAction}
                  style={{ height: 38, padding: '0 20px', borderRadius: 9, border: 'none', background: fbSubmitting || !fbText.trim() || !fbAction ? '#E4E4E0' : '#6C47FF', color: fbSubmitting || !fbText.trim() || !fbAction ? '#A3A3A9' : '#fff', font: '600 14px/1 Satoshi', cursor: fbSubmitting || !fbText.trim() || !fbAction ? 'not-allowed' : 'pointer' }}
                >
                  {fbSubmitting ? 'Submitting…' : 'Submit feedback'}
                </button>
              </div>

              {/* Recent feedback */}
              {feedback.length > 0 && (
                <div>
                  <div style={{ font: '600 14px/1 Satoshi', marginBottom: 12, color: '#5E5E65' }}>Recent feedback</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {feedback.map((fb) => {
                      const clip = clips.find((c) => c.id === fb.clipId);
                      return (
                        <div key={fb.id} style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 12, padding: '14px 16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <span style={{ height: 24, padding: '0 9px', borderRadius: 7, background: '#EFEFEC', color: '#3A3A3F', font: '500 11px/24px Satoshi', flexShrink: 0 }}>{fb.nextAction}</span>
                            {clip && <span style={{ font: '500 12px/1 Satoshi', color: '#6C47FF' }}>{clip.title}</span>}
                            {!fb.clipId && <span style={{ font: '400 12px/1 Satoshi', color: '#A3A3A9' }}>Missing clip</span>}
                          </div>
                          <div style={{ font: '400 13px/1.5 Satoshi', color: '#3A3A3F' }}>{fb.text}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Upload modal */}
      {showUploadModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={(e) => { if (e.target === e.currentTarget) setShowUploadModal(false); }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '28px 28px 24px', width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 16px 48px rgba(0,0,0,0.18)' }}>
            <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 4 }}>Upload B-roll</div>
            <div style={{ font: '400 13px/1.5 Satoshi', color: '#75757C', marginBottom: 20 }}>{pendingVideoFile?.name}</div>

            {/* Clip name */}
            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Clip name <span style={{ color: '#DC2626' }}>*</span></label>
            <input value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} placeholder="e.g. Product shot – hands on desk" style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 14, outline: 'none', boxSizing: 'border-box' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} autoFocus />

            {/* Tags */}
            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Tags <span style={{ color: '#DC2626' }}>*</span> <span style={{ color: '#A3A3A9', fontWeight: 400 }}>(comma-separated)</span></label>
            <input value={uploadTags} onChange={(e) => setUploadTags(e.target.value)} placeholder="e.g. hero, product, unboxing" style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 14, outline: 'none', boxSizing: 'border-box' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />

            {/* Subject */}
            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Subject <span style={{ color: '#A3A3A9', fontWeight: 400 }}>(optional)</span></label>
            <input value={uploadSubject} onChange={(e) => setUploadSubject(e.target.value)} placeholder={collectDistinctValues(clips, 'subject')[0] ?? 'e.g. Founder'} list="broll-subjects" style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 14, outline: 'none', boxSizing: 'border-box' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />
            <datalist id="broll-subjects">{collectDistinctValues(clips, 'subject').map((v) => <option key={v} value={v} />)}</datalist>

            {/* Activity */}
            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Activity <span style={{ color: '#A3A3A9', fontWeight: 400 }}>(optional)</span></label>
            <input value={uploadActivity} onChange={(e) => setUploadActivity(e.target.value)} placeholder={collectDistinctValues(clips, 'activity')[0] ?? 'e.g. Working at desk'} list="broll-activities" style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 14, outline: 'none', boxSizing: 'border-box' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />
            <datalist id="broll-activities">{collectDistinctValues(clips, 'activity').map((v) => <option key={v} value={v} />)}</datalist>

            {/* Setting */}
            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Setting <span style={{ color: '#A3A3A9', fontWeight: 400 }}>(optional)</span></label>
            <input value={uploadSetting} onChange={(e) => setUploadSetting(e.target.value)} placeholder={collectDistinctValues(clips, 'setting')[0] ?? 'e.g. Office'} list="broll-settings" style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 14, outline: 'none', boxSizing: 'border-box' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />
            <datalist id="broll-settings">{collectDistinctValues(clips, 'setting').map((v) => <option key={v} value={v} />)}</datalist>

            {/* Brand */}
            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Brand <span style={{ color: '#A3A3A9', fontWeight: 400 }}>(optional)</span></label>
            <input value={uploadBrand} onChange={(e) => setUploadBrand(e.target.value)} placeholder={collectDistinctValues(clips, 'brand')[0] ?? 'e.g. Soma'} list="broll-brands" style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 14, outline: 'none', boxSizing: 'border-box' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />
            <datalist id="broll-brands">{collectDistinctValues(clips, 'brand').map((v) => <option key={v} value={v} />)}</datalist>

            {/* Categories */}
            {categories.length > 0 && (
              <>
                <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Categories <span style={{ color: '#A3A3A9', fontWeight: 400 }}>(optional)</span></label>
                <CategoryMultiSelect categories={categories} value={uploadCategoryIds} onChange={setUploadCategoryIds} />
              </>
            )}

            {/* Description */}
            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Description <span style={{ color: '#A3A3A9', fontWeight: 400 }}>(optional — for search)</span></label>
            <textarea value={uploadDescription} onChange={(e) => setUploadDescription(e.target.value)} rows={2} placeholder="Brief description to help with search…" style={{ width: '100%', border: '1px solid #E4E4E0', borderRadius: 8, padding: '8px 12px', font: '400 14px/1.5 Satoshi', marginBottom: 20, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />

            {uploadError && <div style={{ color: '#DC2626', font: '400 13px/1.5 Satoshi', marginBottom: 12 }}>{uploadError}</div>}
            {uploadProgress && <div style={{ color: '#6C47FF', font: '400 13px/1.5 Satoshi', marginBottom: 12 }}>{uploadProgress}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowUploadModal(false); setPendingVideoFile(null); }} disabled={uploading} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer', color: '#111113' }}>Cancel</button>
              <button onClick={handleUpload} disabled={uploading || !uploadTitle.trim()} style={{ height: 38, padding: '0 18px', borderRadius: 9, background: uploading || !uploadTitle.trim() ? '#E4E4E0' : '#6C47FF', color: uploading || !uploadTitle.trim() ? '#A3A3A9' : '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: uploading || !uploadTitle.trim() ? 'not-allowed' : 'pointer' }}>
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
