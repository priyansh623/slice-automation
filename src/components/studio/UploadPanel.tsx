'use client';

import { useCallback, useRef, useState } from 'react';
import { newGroupId, runPool, uploadImage, type StudioAsset } from '@/lib/studio/client';

interface Item { id: number; file: File; status: 'queued' | 'uploading' | 'done' | 'duplicate' | 'failed'; error?: string }

const CONCURRENCY = 3;
const ACCEPT = 'image/jpeg,image/png,image/webp';

interface Props { packId: number; disabled?: boolean; onUploaded: (asset: StudioAsset, duplicate: boolean) => void }

/** Select or drop many images. Each is uploaded straight to R2 and verified on its own: one failure never stops the others. */
export default function UploadPanel({ packId, disabled, onUploaded }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const group = useRef(newGroupId());

  const patch = useCallback((id: number, p: Partial<Item>) => setItems((cur) => cur.map((i) => (i.id === id ? { ...i, ...p } : i))), []);

  const process = useCallback(async (batch: Item[]) => {
    await runPool(batch, CONCURRENCY, async (it) => {
      patch(it.id, { status: 'uploading', error: undefined });
      try {
        const r = await uploadImage(packId, it.file, group.current);
        patch(it.id, { status: r.duplicate ? 'duplicate' : 'done' });
        onUploaded(r.asset, r.duplicate);
      } catch (e) {
        patch(it.id, { status: 'failed', error: (e as Error).message });
      }
    });
  }, [packId, onUploaded, patch]);

  function add(files: FileList | File[]) {
    const accepted = [...files].filter((f) => ACCEPT.split(',').includes(f.type));
    const rejected = [...files].length - accepted.length;
    const batch: Item[] = accepted.map((file) => ({ id: ++seq.current, file, status: 'queued' }));
    const skipped: Item[] = rejected > 0 ? [{ id: ++seq.current, file: new File([], `${rejected} file(s) skipped`), status: 'failed', error: 'Only JPEG, PNG and WEBP images can be added.' }] : [];
    group.current = newGroupId();
    setItems((cur) => [...cur, ...skipped, ...batch]);
    void process(batch);
  }

  const failed = items.filter((i) => i.status === 'failed' && i.file.size > 0);
  const active = items.filter((i) => i.status === 'queued' || i.status === 'uploading').length;

  return (
    <div style={{ marginBottom: 14 }}>
      <div
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled) add(e.dataTransfer.files); }}
        style={{ border: `1.5px dashed ${dragging ? '#6C47FF' : '#D4D4CE'}`, background: dragging ? '#F5F3FF' : '#FAFAF8', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14, opacity: disabled ? 0.5 : 1 }}
      >
        <button className="btn btn-primary" disabled={disabled} onClick={() => input.current?.click()} style={{ height: 36 }}>Add images</button>
        <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
        <div style={{ font: '400 13px/1.4 Satoshi', color: '#5E5E65' }}>
          Select or drop JPEG, PNG or WEBP images (up to 25 MB each). Originals are stored unchanged in R2 and analysed in the background.
        </div>
      </div>

      {items.length > 0 && (
        <div style={{ marginTop: 10, border: '1px solid #ECECE8', borderRadius: 10, background: '#fff', maxHeight: 180, overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid #F4F4F0', font: '600 12px Satoshi', color: '#5E5E65' }}>
            <span>{active > 0 ? `Uploading… ${active} left` : 'Upload finished'}</span>
            <span style={{ display: 'flex', gap: 10 }}>
              {failed.length > 0 && <button onClick={() => { const retry = failed.map((f) => ({ ...f, status: 'queued' as const })); setItems((cur) => cur.map((i) => (retry.find((r) => r.id === i.id) ?? i))); void process(retry); }} style={{ border: 'none', background: 'none', color: '#6C47FF', font: '600 12px Satoshi', cursor: 'pointer' }}>Retry {failed.length} failed</button>}
              {active === 0 && <button onClick={() => setItems([])} style={{ border: 'none', background: 'none', color: '#75757C', font: '500 12px Satoshi', cursor: 'pointer' }}>Clear</button>}
            </span>
          </div>
          {items.map((i) => (
            <div key={i.id} style={{ display: 'flex', gap: 10, padding: '6px 12px', font: '400 12px/1.4 Satoshi', alignItems: 'baseline' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.file.name}</span>
              <span style={{ color: i.status === 'failed' ? '#B91C1C' : i.status === 'done' ? '#16A34A' : '#75757C', maxWidth: 360, textAlign: 'right' }}>
                {i.status === 'queued' && 'Waiting'}{i.status === 'uploading' && 'Uploading…'}{i.status === 'done' && 'Added'}{i.status === 'duplicate' && 'Already in this pack'}{i.status === 'failed' && (i.error ?? 'Failed')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
