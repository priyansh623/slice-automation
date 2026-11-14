'use client';
import { useEffect, useMemo, useState } from 'react';
import type { BulkItem, EditableMetadata } from '@/lib/broll-bulk/batch';
import { blockers, hasExactDuplicate } from '@/lib/broll-bulk/batch';
import type { Taxonomy } from '@/lib/broll-bulk/taxonomy';
import { AllowedSelect, BrandPicker, CategorySelect, TagPicker } from './controls';
import { Button, Chip, Field, PRIVACY_LABEL, T, font, inputStyle } from './ui';

const confTone = (c: string | undefined) => (c === 'high' ? 'ok' : c === 'medium' ? 'warn' : 'danger') as 'ok' | 'warn' | 'danger';

export function categoryLabel(t: Taxonomy, id: number | null): string {
  return id === null ? 'Needs review' : t.categories.find((c) => c.id === id)?.path ?? 'Unknown category';
}

/** Chips that tell the reviewer, at a glance, what needs attention. Shared by the grid and the detail view. */
export function WarningChips({ item }: { item: BulkItem }) {
  const s = item.suggestion;
  const dupLibrary = item.duplicates.find((d) => d.kind === 'library_exact');
  const dupBatch = item.duplicates.find((d) => d.kind === 'batch_exact');
  const sameSize = item.duplicates.find((d) => d.kind === 'library_same_size');
  return (
    <>
      {item.issues.filter((i) => i.severity === 'error').map((i) => <Chip key={i.code} tone="danger" title={i.message}>Invalid</Chip>)}
      {item.issues.filter((i) => i.severity === 'warning').map((i) => <Chip key={i.code} tone="warn" title={i.message}>{i.code === 'long_video' ? 'Long' : 'Check'}</Chip>)}
      {dupLibrary && <Chip tone="warn" title={`Identical to library clip “${dupLibrary.title}”`}>Duplicate of #{dupLibrary.clipId}</Chip>}
      {dupBatch && <Chip tone="warn" title="Identical to another video in this batch">Duplicate in batch</Chip>}
      {sameSize && !dupLibrary && <Chip tone="warn" title={`Same size as library clip “${sameSize.title}” (its checksum was never recorded, so this may be a coincidence)`}>Same size as #{sameSize.clipId}</Chip>}
      {s && s.privacy.length > 0 && <Chip tone="danger" title={s.privacy.map((p) => PRIVACY_LABEL[p.type]).join(', ')}>⚠ Privacy {s.privacy.length}</Chip>}
      {s && s.confidence === 'low' && <Chip tone="danger" title="The AI was not confident about this clip">Low confidence</Chip>}
      {item.edit && item.edit.categoryId === null && item.analysis === 'analysed' && <Chip tone="warn" title="No category: the clip stays hidden from the library until it has one">No category</Chip>}
    </>
  );
}

export function StatusChip({ item }: { item: BulkItem }) {
  if (item.upload === 'uploaded') return <Chip tone="ok">Uploaded</Chip>;
  if (item.upload === 'failed') return <Chip tone="danger" title={item.uploadError ?? ''}>Upload failed</Chip>;
  if (item.upload === 'uploading') return <Chip tone="accent">Uploading {Math.round(item.uploadProgress * 100)}%</Chip>;
  if (item.upload === 'verifying') return <Chip tone="accent">Verifying…</Chip>;
  if (item.upload === 'queued') return <Chip>Queued</Chip>;
  switch (item.analysis) {
    case 'pending': return <Chip>Waiting</Chip>;
    case 'preparing': return <Chip tone="accent">Reading video…</Chip>;
    case 'analysing': return <Chip tone="accent">Analysing…</Chip>;
    case 'analysed': return <Chip tone="ok">Analysed</Chip>;
    case 'failed': return <Chip tone="danger" title={item.analysisError ?? ''}>Analysis failed</Chip>;
    case 'invalid': return <Chip tone="danger">Can’t be uploaded</Chip>;
  }
}

// ── Grid ─────────────────────────────────────────────────────────────────────────────────────────────────

export function ReviewGrid({ items, taxonomy, locked, onOpen, onToggleSelect, onToggleInclude, onRemove, onRetryAnalysis }: {
  items: BulkItem[]; taxonomy: Taxonomy; locked: boolean;
  onOpen: (id: string) => void; onToggleSelect: (id: string) => void; onToggleInclude: (id: string) => void; onRemove: (id: string) => void; onRetryAnalysis: (id: string) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 16 }}>
      {items.map((it) => {
        const e = it.edit;
        const problems = blockers(it);
        const dim = it.analysis === 'invalid' || (!it.included && it.analysis === 'analysed');
        return (
          <div key={it.id} style={{ background: '#fff', border: `1px solid ${it.selected ? T.accent : T.border}`, borderRadius: 12, overflow: 'hidden', opacity: dim ? 0.72 : 1, boxShadow: it.selected ? `0 0 0 2px ${T.accentSoft}` : 'none', display: 'flex', flexDirection: 'column' }}>
            <div onClick={() => e && onOpen(it.id)} style={{ position: 'relative', aspectRatio: '9 / 12', background: '#1c1c1f', cursor: e ? 'pointer' : 'default' }}>
              {it.thumbnail ? <img src={it.thumbnail} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
              {it.analysis === 'analysed' && !locked && (
                <input type="checkbox" checked={it.selected} onChange={() => onToggleSelect(it.id)} onClick={(ev) => ev.stopPropagation()} aria-label="Select for bulk edit" style={{ position: 'absolute', top: 8, left: 8, width: 18, height: 18, cursor: 'pointer' }} />
              )}
              <div style={{ position: 'absolute', top: 8, right: 8 }}><StatusChip item={it} /></div>
              {it.durationSeconds ? <span style={{ position: 'absolute', bottom: 8, right: 8, background: 'rgba(0,0,0,0.65)', color: '#fff', borderRadius: 6, padding: '2px 6px', font: font(500, 11, 1) }}>{Math.round(it.durationSeconds)}s</span> : null}
            </div>
            <div style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <div title={it.fileName} style={{ font: font(600, 13, 1.3), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e?.title || it.fileName}</div>
              {e ? (
                <>
                  <div style={{ font: font(500, 12, 1.3), color: e.categoryId === null ? T.warn : T.text }}>{categoryLabel(taxonomy, e.categoryId)}</div>
                  <div style={{ font: font(400, 12, 1.4), color: T.muted }}>{[e.activity?.trim(), e.setting].filter(Boolean).join(' · ') || 'No activity or setting'}</div>
                  <div style={{ font: font(400, 12, 1.4), color: T.muted }}>{e.brands.length ? e.brands.map((b) => b.name).join(', ') : 'No brand'}</div>
                </>
              ) : (
                <div style={{ font: font(400, 12, 1.4), color: T.muted }}>
                  {it.issues.find((i) => i.severity === 'error')?.message ?? it.analysisError ?? 'Waiting for analysis'}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                <WarningChips item={it} />
                {it.restored && <Chip tone="accent" title="Analysis and edits restored from your earlier visit">Restored</Chip>}
                {it.reviewed && it.analysis === 'analysed' && it.upload === 'none' && <Chip tone="ok" title="You opened or edited this clip">Reviewed</Chip>}
              </div>
              {it.restored && it.upload === 'uploaded' && <div style={{ font: font(400, 12, 1.4), color: T.ok }}>Already uploaded as clip #{it.clipId}; it will not be uploaded again.</div>}
              <div style={{ marginTop: 'auto', display: 'flex', gap: 6, alignItems: 'center', paddingTop: 4 }}>
                {it.analysis === 'failed' && !locked && <Button size="sm" onClick={() => onRetryAnalysis(it.id)}>Retry analysis</Button>}
                {it.analysis === 'analysed' && it.upload !== 'uploaded' && !locked && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: font(500, 12, 1), color: problems.length ? T.faint : T.text, cursor: problems.length ? 'not-allowed' : 'pointer' }} title={problems.join(' ')}>
                    <input type="checkbox" checked={it.included && problems.length === 0} disabled={problems.length > 0} onChange={() => onToggleInclude(it.id)} />
                    Upload{hasExactDuplicate(it) && !it.included ? ' anyway' : ''}
                  </label>
                )}
                {it.upload !== 'uploaded' && it.upload !== 'uploading' && it.upload !== 'verifying' && (
                  <Button size="sm" kind="ghost" style={{ marginLeft: 'auto' }} onClick={() => onRemove(it.id)} title="Remove from the batch">Remove</Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────────────────────────────────

export function ReviewDetail({ item, file, taxonomy, readOnly, index, count, onChange, onPrev, onNext, onClose, onRetryAnalysis }: {
  item: BulkItem; file: File | undefined; taxonomy: Taxonomy; readOnly: boolean; index: number; count: number;
  onChange: (patch: Partial<EditableMetadata>) => void; onPrev: () => void; onNext: () => void; onClose: () => void; onRetryAnalysis: () => void;
}) {
  const e = item.edit;
  const s = item.suggestion;
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const [showAi, setShowAi] = useState(false);
  if (!e || !s) return null;
  // A field stops being "unresolved" as soon as the reviewer has chosen a value for it.
  const filled: Record<string, boolean> = { category: e.categoryId !== null, activity: e.activity !== null, setting: e.setting !== null };
  const unresolved = s.unresolved.filter((f) => !filled[f]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.45)', display: 'flex', justifyContent: 'flex-end' }} onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div style={{ width: 'min(920px, 100%)', background: T.surface, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: `1px solid ${T.border}`, background: '#fff' }}>
          <div style={{ font: font(700, 16, 1.3), flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.fileName}</div>
          <span style={{ font: font(400, 13, 1), color: T.muted }}>{index + 1} of {count}</span>
          <Button size="sm" onClick={onPrev} disabled={index === 0}>← Prev</Button>
          <Button size="sm" onClick={onNext} disabled={index >= count - 1}>Next →</Button>
          <Button size="sm" kind="primary" onClick={onClose}>Done</Button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 24, alignItems: 'start' }}>
          <div style={{ position: 'sticky', top: 0 }}>
            <div style={{ background: '#000', borderRadius: 12, overflow: 'hidden', aspectRatio: '9 / 16' }}>
              {url && <video src={url} controls playsInline muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}><StatusChip item={item} /><WarningChips item={item} /></div>
            <div style={{ font: font(400, 12, 1.5), color: T.muted, marginTop: 8 }}>
              {item.width}×{item.height} · {Math.round(item.durationSeconds ?? 0)} s · {(item.size / 1048576).toFixed(1)} MB
            </div>
          </div>
          <div>
            {s.privacy.length > 0 && (
              <div style={{ background: T.dangerSoft, border: `1px solid ${T.dangerBorder}`, borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
                <div style={{ font: font(700, 13, 1.3), color: T.danger, marginBottom: 4 }}>Privacy warnings</div>
                {s.privacy.map((p, i) => <div key={i} style={{ font: font(400, 13, 1.45), color: '#7F1D1D' }}><strong>{PRIVACY_LABEL[p.type]}</strong>: {p.detail}</div>)}
                <div style={{ font: font(400, 12, 1.4), color: '#991B1B', marginTop: 6 }}>Nothing is blurred or removed. These warnings never block an upload; you decide.</div>
              </div>
            )}
            {(unresolved.length > 0 || (s.rejectedValues.activity && !filled.activity) || (s.rejectedValues.setting && !filled.setting)) && (
              <div style={{ background: T.warnSoft, border: `1px solid ${T.warnBorder}`, borderRadius: 10, padding: '10px 12px', marginBottom: 14, font: font(400, 13, 1.45), color: '#78350F' }}>
                <strong>Needs your decision:</strong> {unresolved.join(', ') || 'see below'}.
                {s.rejectedValues.activity && !filled.activity && <div>The AI suggested the activity “{s.rejectedValues.activity}”, which is not an approved value, so it was not used.</div>}
                {s.rejectedValues.setting && !filled.setting && <div>The AI suggested the setting “{s.rejectedValues.setting}”, which is not an approved value, so it was not used.</div>}
              </div>
            )}
            <Field label="Clip name"><input value={e.title} disabled={readOnly} onChange={(ev) => onChange({ title: ev.target.value })} style={inputStyle} /></Field>
            <Field label="Category" hint={<Chip tone={confTone(s.categoryConfidence)}>{s.categoryConfidence} confidence</Chip>}>
              <CategorySelect taxonomy={taxonomy} value={e.categoryId} onChange={(id) => onChange({ categoryId: id })} style={readOnly ? { pointerEvents: 'none', opacity: 0.7 } : undefined} />
              {s.categoryReason && <div style={{ font: font(400, 12, 1.5), color: T.muted, marginTop: 4 }}>{s.categoryReason}</div>}
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Activity"><AllowedSelect options={taxonomy.activities} value={e.activity} onChange={(v) => onChange({ activity: v })} emptyLabel="Not set" style={readOnly ? { pointerEvents: 'none', opacity: 0.7 } : undefined} /></Field>
              <Field label="Setting"><AllowedSelect options={taxonomy.settings} value={e.setting} onChange={(v) => onChange({ setting: v })} emptyLabel="Not set" style={readOnly ? { pointerEvents: 'none', opacity: 0.7 } : undefined} /></Field>
            </div>
            <Field label="Brand and associations">
              <BrandPicker taxonomy={taxonomy} value={e.brands} readOnly={readOnly}
                onAdd={(name, role) => onChange({ brands: e.brands.some((b) => b.name.toLowerCase() === name.toLowerCase()) ? e.brands : [...e.brands, { name, role }] })}
                onRemove={(name) => onChange({ brands: e.brands.filter((b) => b.name !== name) })}
                onRole={(name, role) => onChange({ brands: e.brands.map((b) => (b.name === name ? { ...b, role } : b)) })} />
              {s.brands.length > 0 && <div style={{ font: font(400, 12, 1.5), color: T.muted, marginTop: 6 }}>{s.brands.map((b) => `${b.name}: ${b.evidence || 'seen in the frames'}`).join(' · ')}</div>}
            </Field>
            <Field label="Tags">
              <TagPicker taxonomy={taxonomy} value={e.tags} suggested={s.tags.map((t) => t.tag)} readOnly={readOnly}
                onAdd={(tag) => onChange({ tags: e.tags.includes(tag) ? e.tags : [...e.tags, tag] })} onRemove={(tag) => onChange({ tags: e.tags.filter((t) => t !== tag) })} />
            </Field>
            <Field label="Subject" hint="(optional)"><input value={e.subject} disabled={readOnly} onChange={(ev) => onChange({ subject: ev.target.value })} style={inputStyle} /></Field>
            <Field label="Description" hint="(short and factual; edit freely)">
              <textarea value={e.description} disabled={readOnly} onChange={(ev) => onChange({ description: ev.target.value })} rows={3} style={{ ...inputStyle, height: 'auto', padding: '8px 10px', lineHeight: 1.5, resize: 'vertical' }} />
            </Field>
            <button onClick={() => setShowAi((v) => !v)} style={{ border: 'none', background: 'none', color: T.accent, font: font(500, 13, 1), cursor: 'pointer', padding: 0 }}>{showAi ? 'Hide' : 'Show'} what the AI saw</button>
            {showAi && (
              <div style={{ marginTop: 8, background: '#fff', border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', font: font(400, 13, 1.5), color: '#3F3F46' }}>
                <div><strong>Summary:</strong> {s.summary || '—'}</div>
                {s.subjects.length > 0 && <div><strong>Subjects:</strong> {s.subjects.join(', ')}</div>}
                {s.objects.length > 0 && <div><strong>Objects:</strong> {s.objects.join(', ')}</div>}
                {s.descriptors.length > 0 && <div><strong>Descriptors:</strong> {s.descriptors.join(', ')}</div>}
                {s.visibleText.length > 0 && <div><strong>Text it could read:</strong> {s.visibleText.map((x) => `“${x}”`).join(' ')}</div>}
                <div><strong>Overall confidence:</strong> <Chip tone={confTone(s.confidence)}>{s.confidence}</Chip></div>
              </div>
            )}
            {item.analysis === 'failed' && <div style={{ marginTop: 10 }}><Button onClick={onRetryAnalysis}>Retry analysis</Button></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
