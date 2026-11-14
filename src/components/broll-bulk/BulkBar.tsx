'use client';
import { useState } from 'react';
import type { BrandRole } from '@/lib/broll-bulk/analysis-schema';
import type { BulkOp, ProposalGroup } from '@/lib/broll-bulk/batch';
import type { Taxonomy } from '@/lib/broll-bulk/taxonomy';
import { canonicalTag } from '@/lib/broll-bulk/taxonomy';
import { AllowedSelect, CategorySelect } from './controls';
import { Button, Chip, ModalShell, T, font, inputStyle } from './ui';

/** Bulk editing for the selected clips. Each control changes only its own field; nothing else is overwritten. */
export function BulkBar({ count, taxonomy, tagsInSelection, onOp, onRemoveSelected, onSetIncluded, onClear }: {
  count: number; taxonomy: Taxonomy; tagsInSelection: string[]; onOp: (op: BulkOp) => void; onRemoveSelected: () => void; onSetIncluded: (included: boolean) => void; onClear: () => void;
}) {
  const [cat, setCat] = useState<number | null>(null);
  const [act, setAct] = useState<string | null>(null);
  const [set, setSet] = useState<string | null>(null);
  const [brand, setBrand] = useState(''); const [role, setRole] = useState<BrandRole>('incidental');
  const [tag, setTag] = useState(''); const [tagDraft, setTagDraft] = useState(''); const [rmTag, setRmTag] = useState('');
  const vocab = taxonomy.tags.map((t) => t.tag);
  const draft = canonicalTag(tagDraft, vocab);
  const row: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' };
  return (
    <div style={{ background: '#fff', border: `1px solid ${T.accent}`, borderRadius: 12, padding: '12px 14px', marginBottom: 16, boxShadow: `0 0 0 3px ${T.accentSoft}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ font: font(700, 14, 1) }}>{count} selected</div>
        <span style={{ font: font(400, 12, 1.3), color: T.muted }}>Each action changes only that one field on the selected clips.</span>
        <Button size="sm" kind="ghost" style={{ marginLeft: 'auto' }} onClick={onClear}>Clear selection</Button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 18px' }}>
        <div style={row}><CategorySelect taxonomy={taxonomy} value={cat} onChange={setCat} emptyLabel="Set category…" style={{ width: 200, height: 32 }} /><Button size="sm" disabled={cat === null} onClick={() => { onOp({ kind: 'category', categoryId: cat }); setCat(null); }}>Apply</Button></div>
        <div style={row}><AllowedSelect options={taxonomy.activities} value={act} onChange={setAct} emptyLabel="Set activity…" style={{ width: 170, height: 32 }} /><Button size="sm" disabled={act === null} onClick={() => { onOp({ kind: 'activity', activity: act }); setAct(null); }}>Apply</Button></div>
        <div style={row}><AllowedSelect options={taxonomy.settings} value={set} onChange={setSet} emptyLabel="Set setting…" style={{ width: 170, height: 32 }} /><Button size="sm" disabled={set === null} onClick={() => { onOp({ kind: 'setting', setting: set }); setSet(null); }}>Apply</Button></div>
        <div style={row}>
          <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ ...inputStyle, width: 160, height: 32 }}><option value="">Add brand…</option>{taxonomy.brands.map((b) => <option key={b} value={b}>{b}</option>)}</select>
          <select value={role} onChange={(e) => setRole(e.target.value as BrandRole)} style={{ ...inputStyle, width: 110, height: 32 }}><option value="hero">Hero</option><option value="incidental">Incidental</option><option value="unresolved">Unresolved</option></select>
          <Button size="sm" disabled={!brand} onClick={() => { onOp({ kind: 'addBrand', name: brand, role }); setBrand(''); }}>Add</Button>
        </div>
        <div style={row}>
          <select value={tag} onChange={(e) => setTag(e.target.value)} style={{ ...inputStyle, width: 160, height: 32 }}><option value="">Add tag…</option>{vocab.slice(0, 300).map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <Button size="sm" disabled={!tag} onClick={() => { onOp({ kind: 'addTags', tags: [tag] }); setTag(''); }}>Add</Button>
          <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft) { onOp({ kind: 'addTags', tags: [draft.tag] }); setTagDraft(''); } }} placeholder="New tag + Enter" style={{ ...inputStyle, width: 130, height: 32 }} />
          {draft && tagDraft.trim() && <Chip tone={draft.known ? 'accent' : 'warn'}>{draft.known ? 'existing' : 'new'}</Chip>}
        </div>
        <div style={row}>
          <select value={rmTag} onChange={(e) => setRmTag(e.target.value)} style={{ ...inputStyle, width: 160, height: 32 }}><option value="">Remove tag…</option>{tagsInSelection.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <Button size="sm" disabled={!rmTag} onClick={() => { onOp({ kind: 'removeTags', tags: [rmTag] }); setRmTag(''); }}>Remove</Button>
        </div>
        <div style={row}>
          <Button size="sm" onClick={() => onSetIncluded(true)}>Include in upload</Button>
          <Button size="sm" onClick={() => onSetIncluded(false)}>Exclude from upload</Button>
          <Button size="sm" kind="danger" onClick={onRemoveSelected}>Remove from batch</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * New-category proposals. Creating a category is its own explicit action, separate from approving the batch: nothing is
 * created until someone clicks "Create category" and confirms here.
 */
export function ProposalPanel({ groups, taxonomy, decisions, busyKey, error, onCreate, onReject }: {
  groups: ProposalGroup[]; taxonomy: Taxonomy; decisions: Record<string, 'rejected'>; busyKey: string | null; error: string | null;
  onCreate: (g: ProposalGroup) => void; onReject: (g: ProposalGroup) => void;
}) {
  const [confirming, setConfirming] = useState<ProposalGroup | null>(null);
  const open = groups.filter((g) => decisions[g.key] !== 'rejected');
  const rejected = groups.filter((g) => decisions[g.key] === 'rejected');
  if (groups.length === 0) return null;
  const parentName = (id: number | null) => (id === null ? 'top level' : taxonomy.categories.find((c) => c.id === id)?.path ?? 'unknown');
  return (
    <div style={{ background: T.warnSoft, border: `1px solid ${T.warnBorder}`, borderRadius: 12, padding: '12px 14px', marginBottom: 16 }}>
      <div style={{ font: font(700, 14, 1.3), color: '#78350F' }}>New category proposals</div>
      <div style={{ font: font(400, 12.5, 1.5), color: '#92400E', marginBottom: 8 }}>
        The AI found no existing category for these clips and proposed new ones. Nothing is created until you approve it here, and approving the upload batch never creates a category.
      </div>
      {open.map((g) => (
        <div key={g.key} style={{ background: '#fff', border: `1px solid ${T.warnBorder}`, borderRadius: 10, padding: '10px 12px', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ font: font(700, 14, 1.3) }}>“{g.name}”</div>
            <Chip>under {parentName(g.parentId)}</Chip>
            <Chip tone="accent">{g.itemIds.length} clip{g.itemIds.length === 1 ? '' : 's'}</Chip>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <Button size="sm" kind="primary" disabled={busyKey !== null} onClick={() => setConfirming(g)}>{busyKey === g.key ? 'Creating…' : 'Create category…'}</Button>
              <Button size="sm" disabled={busyKey !== null} onClick={() => onReject(g)}>Reject</Button>
            </div>
          </div>
          {g.reasons.map((r, i) => <div key={i} style={{ font: font(400, 12.5, 1.5), color: T.muted, marginTop: 4 }}>{r}</div>)}
        </div>
      ))}
      {rejected.length > 0 && <div style={{ font: font(400, 12.5, 1.4), color: T.muted }}>Rejected: {rejected.map((g) => `“${g.name}”`).join(', ')}. Those clips stay uncategorised until you choose a category yourself.</div>}
      {error && <div style={{ color: T.danger, font: font(400, 13, 1.4), marginTop: 6 }}>{error}</div>}
      {confirming && (
        <ModalShell title="Create this category?" onClose={() => setConfirming(null)}>
          <div style={{ font: font(400, 14, 1.55), marginBottom: 14 }}>
            This adds <strong>“{confirming.name}”</strong> ({parentName(confirming.parentId)}) to the shared B-roll categories that everyone uses, and assigns it to {confirming.itemIds.length} clip{confirming.itemIds.length === 1 ? '' : 's'} in this batch. It does not upload anything.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={() => setConfirming(null)}>Cancel</Button>
            <Button kind="primary" onClick={() => { const g = confirming; setConfirming(null); onCreate(g); }}>Create category</Button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
