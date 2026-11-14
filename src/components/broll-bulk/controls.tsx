'use client';
import { useState } from 'react';
import type { BrandRole } from '@/lib/broll-bulk/analysis-schema';
import { canonicalBrand, canonicalTag, type Taxonomy } from '@/lib/broll-bulk/taxonomy';
import { Button, Chip, T, font, inputStyle } from './ui';

/** Controlled inputs: values come from the approved lists, so nothing that already exists is ever typed by hand. */

export function CategorySelect({ taxonomy, value, onChange, allowEmpty = true, emptyLabel = 'Needs review (no category)', style }: {
  taxonomy: Taxonomy; value: number | null; onChange: (id: number | null) => void; allowEmpty?: boolean; emptyLabel?: string; style?: React.CSSProperties;
}) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} style={{ ...inputStyle, ...style }}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {taxonomy.categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
    </select>
  );
}

export function AllowedSelect({ options, value, onChange, emptyLabel, style }: { options: string[]; value: string | null; onChange: (v: string | null) => void; emptyLabel: string; style?: React.CSSProperties }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} style={{ ...inputStyle, ...style }}>
      <option value="">{emptyLabel}</option>
      {options.map((o) => <option key={o} value={o}>{o.trim() === o ? o : `${o.trim()} `}</option>)}
    </select>
  );
}

const ROLE_LABEL: Record<BrandRole, string> = { hero: 'Hero', incidental: 'Incidental', unresolved: 'Unresolved' };

export function BrandPicker({ taxonomy, value, onAdd, onRemove, onRole, readOnly }: {
  taxonomy: Taxonomy; value: { name: string; role: BrandRole }[]; onAdd: (name: string, role: BrandRole) => void; onRemove: (name: string) => void;
  onRole?: (name: string, role: BrandRole) => void; readOnly?: boolean;
}) {
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<BrandRole>('incidental');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const have = new Set(value.map((b) => b.name.toLowerCase()));
  const options = taxonomy.brands.filter((b) => !have.has(b.toLowerCase()));
  const existing = canonicalBrand(draft, taxonomy.brands);
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: readOnly ? 0 : 8 }}>
        {value.length === 0 && <span style={{ font: font(400, 13), color: T.faint }}>No brand</span>}
        {value.map((b) => (
          <span key={b.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${T.border}`, borderRadius: 8, padding: '3px 8px', font: font(500, 13, 1.2), background: '#fff' }}>
            {b.name}
            {!taxonomy.brands.some((x) => x.toLowerCase() === b.name.toLowerCase()) && <Chip tone="warn" title="Not in the library yet: it will be added with this clip, following the existing convention">new</Chip>}
            {readOnly || !onRole
              ? <span style={{ color: T.muted, font: font(400, 12, 1) }}>{ROLE_LABEL[b.role]}</span>
              : <select value={b.role} onChange={(e) => onRole(b.name, e.target.value as BrandRole)} style={{ border: 'none', background: 'transparent', font: font(400, 12, 1), color: T.muted }}>
                  {(Object.keys(ROLE_LABEL) as BrandRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>}
            {!readOnly && <button onClick={() => onRemove(b.name)} aria-label={`Remove ${b.name}`} style={{ border: 'none', background: 'none', cursor: 'pointer', color: T.faint, padding: 0, font: font(500, 14, 1) }}>×</button>}
          </span>
        ))}
      </div>
      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {!creating ? (
            <>
              <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...inputStyle, width: 'auto', minWidth: 160, height: 32 }}>
                <option value="">Add a known brand…</option>
                {options.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <select value={role} onChange={(e) => setRole(e.target.value as BrandRole)} style={{ ...inputStyle, width: 'auto', height: 32 }}>
                {(Object.keys(ROLE_LABEL) as BrandRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <Button size="sm" disabled={!pick} onClick={() => { onAdd(pick, role); setPick(''); }}>Add</Button>
              <Button size="sm" kind="ghost" onClick={() => setCreating(true)}>New brand…</Button>
            </>
          ) : (
            <>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New brand name" style={{ ...inputStyle, width: 200, height: 32 }} />
              {existing && <Chip tone="accent" title="This brand already exists, so the existing record is reused">uses “{existing}”</Chip>}
              <Button size="sm" disabled={!draft.trim()} onClick={() => { onAdd(existing ?? draft.trim(), role); setDraft(''); setCreating(false); }}>Add</Button>
              <Button size="sm" kind="ghost" onClick={() => { setCreating(false); setDraft(''); }}>Cancel</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function TagPicker({ taxonomy, value, suggested, onAdd, onRemove, readOnly }: {
  taxonomy: Taxonomy; value: string[]; suggested?: string[]; onAdd: (tag: string) => void; onRemove: (tag: string) => void; readOnly?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const vocab = taxonomy.tags.map((t) => t.tag);
  const options = vocab.filter((t) => !value.includes(t)).slice(0, 300);
  const dropped = (suggested ?? []).filter((t) => !value.includes(t));
  const normalised = canonicalTag(draft, vocab);
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {value.length === 0 && <span style={{ font: font(400, 13), color: T.faint }}>No tags (at least one is required)</span>}
        {value.map((t) => (
          <Chip key={t} tone="accent" onClick={readOnly ? undefined : () => onRemove(t)} title={readOnly ? undefined : 'Click to remove'}>{t}{!readOnly && ' ×'}</Chip>
        ))}
      </div>
      {!readOnly && dropped.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ font: font(400, 12, 1), color: T.faint }}>Suggested, not selected:</span>
          {dropped.map((t) => <Chip key={t} onClick={() => onAdd(t)} title="Click to add">+ {t}</Chip>)}
        </div>
      )}
      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value="" onChange={(e) => { if (e.target.value) onAdd(e.target.value); }} style={{ ...inputStyle, width: 'auto', minWidth: 180, height: 32 }}>
            <option value="">Add from the tag list…</option>
            {options.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && normalised) { onAdd(normalised.tag); setDraft(''); } }} placeholder="New tag + Enter" style={{ ...inputStyle, width: 150, height: 32 }} />
          {normalised && draft.trim() && <Chip tone={normalised.known ? 'accent' : 'warn'} title={normalised.known ? 'An existing tag' : 'A new tag, saved lower case with single spaces'}>{normalised.known ? 'existing' : 'new'}: {normalised.tag}</Chip>}
        </div>
      )}
    </div>
  );
}
