'use client';

import { useCallback, useRef, useState } from 'react';

interface UploadResult {
  storedPath: string;
  previewUrl: string;
  filename: string;
}

interface Props {
  value: UploadResult | null;
  onChange: (result: UploadResult | null) => void;
  label?: string;
  hint?: string;
}

export default function ImageUpload({ value, onChange, label, hint }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  async function uploadFile(file: File) {
    setError('');
    setUploading(true);
    // Show local preview immediately so the user sees the image right away
    const objectUrl = URL.createObjectURL(file);
    setLocalPreview(objectUrl);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/v1/uploads', { method: 'POST', body: form });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? `Upload failed (${res.status})`);
        URL.revokeObjectURL(objectUrl);
        setLocalPreview(null);
        return;
      }
      const data = (await res.json()) as UploadResult;
      URL.revokeObjectURL(objectUrl);
      setLocalPreview(null);
      onChange(data);
    } catch (err: unknown) {
      setError(String(err));
      URL.revokeObjectURL(objectUrl);
      setLocalPreview(null);
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    // Reset input so the same file can be re-selected after removal
    e.target.value = '';
  }

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        uploadFile(file);
      } else {
        setError('Please drop an image file (JPEG, PNG, WEBP).');
      }
    },
    [],
  );

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave() {
    setDragging(false);
  }

  function handleRemove() {
    onChange(null);
    setError('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {label && <span className="form-label">{label}</span>}

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {(value || localPreview) ? (
        /* ── Preview state ── */
        <div style={{
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'var(--bg-page)',
        }}>
          <div style={{ position: 'relative' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={localPreview ?? value!.previewUrl}
              alt="Reference image preview"
              style={{
                width: '100%',
                maxHeight: 220,
                objectFit: 'cover',
                display: 'block',
              }}
            />
            <div style={{
              position: 'absolute',
              top: 8,
              right: 8,
              display: 'flex',
              gap: 6,
            }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
                style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)' }}
              >
                Replace
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleRemove}
                style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)' }}
              >
                Remove
              </button>
            </div>
          </div>
          <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
            {uploading ? 'Uploading…' : value?.filename}
          </div>
        </div>
      ) : (
        /* ── Drop zone ── */
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          disabled={uploading}
          style={{
            width: '100%',
            border: `2px dashed ${dragging ? 'var(--brand)' : 'var(--border-input)'}`,
            borderRadius: 10,
            background: dragging ? 'var(--brand-light)' : 'var(--bg-page)',
            padding: '32px 24px',
            cursor: uploading ? 'wait' : 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            transition: 'border-color 0.15s, background 0.15s',
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke={dragging ? 'var(--brand)' : 'var(--text-muted)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
            <rect x="3" y="3" width="18" height="18" rx="3"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <span style={{ fontSize: 14, fontWeight: 500, color: uploading ? 'var(--text-muted)' : 'var(--text-primary)' }}>
            {uploading ? 'Uploading…' : 'Click to upload or drag & drop'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            JPEG, PNG or WEBP
          </span>
        </button>
      )}

      {error && (
        <div className="alert alert-error" style={{ padding: '8px 12px', fontSize: 12 }}>
          {error}
        </div>
      )}

      {hint && !error && <span className="form-hint">{hint}</span>}
    </div>
  );
}
