'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { ArrowLeft, Plus, Pencil, Trash2, ChevronDown, ChevronRight } from 'lucide-react';

interface CategoryNode {
  id: number;
  name: string;
  slug: string;
  description: string | null;
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

function CategoryRow({
  node,
  depth,
  onEdit,
  onDelete,
  onAddChild,
}: {
  node: CategoryNode;
  depth: number;
  onEdit: (node: CategoryNode) => void;
  onDelete: (node: CategoryNode) => void;
  onAddChild: (parent: CategoryNode) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: `9px 16px 9px ${16 + depth * 20}px`,
          borderBottom: '1px solid #F2F2EF', background: '#fff',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFAF8')}
        onMouseLeave={(e) => (e.currentTarget.style.background = '#fff')}
      >
        <button
          onClick={() => setExpanded((x) => !x)}
          style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', cursor: hasChildren ? 'pointer' : 'default', color: '#A3A3A9', flexShrink: 0 }}
        >
          {hasChildren ? (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span style={{ width: 13 }} />}
        </button>
        <div style={{ flex: 1, font: `${depth === 0 ? 600 : 400} 13px/1.3 Satoshi`, color: '#111113' }}>{node.name}</div>
        <div style={{ font: '400 11px/1 Satoshi', color: '#A3A3A9', marginRight: 8 }}>{node.slug}</div>
        {node.scope === 'brand' && node.brandScope && (
          <span style={{ height: 20, padding: '0 7px', borderRadius: 5, background: '#FFF3E0', color: '#E65100', font: '500 11px/20px Satoshi', marginRight: 4 }}>{node.brandScope}</span>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => onAddChild(node)}
            title="Add subcategory"
            style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #E4E4E0', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#75757C' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#F6F6F4')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '#fff')}
          >
            <Plus size={12} />
          </button>
          <button
            onClick={() => onEdit(node)}
            title="Edit"
            style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #E4E4E0', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#75757C' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#F6F6F4')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '#fff')}
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={() => onDelete(node)}
            title="Delete"
            style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #E4E4E0', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#C4C4CC' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.color = '#DC2626'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.color = '#C4C4CC'; }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {expanded && node.children.map((child) => (
        <CategoryRow key={child.id} node={child} depth={depth + 1} onEdit={onEdit} onDelete={onDelete} onAddChild={onAddChild} />
      ))}
    </>
  );
}

export default function CategoryManagementPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [loading, setLoading] = useState(true);

  // Edit/create modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CategoryNode | null>(null);
  const [defaultParentId, setDefaultParentId] = useState<number | null>(null);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formScope, setFormScope] = useState<'soma' | 'brand'>('soma');
  const [formBrandScope, setFormBrandScope] = useState('');
  const [formParentId, setFormParentId] = useState<number | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<CategoryNode | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchCategories = useCallback(() => {
    fetch('/api/v1/broll/categories')
      .then((r) => r.json())
      .then((data: CategoryNode[]) => { setCategories(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  function openCreate(parent?: CategoryNode) {
    setEditTarget(null);
    setDefaultParentId(parent?.id ?? null);
    setFormName('');
    setFormSlug('');
    setFormScope('soma');
    setFormBrandScope('');
    setFormParentId(parent?.id ?? null);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(node: CategoryNode) {
    setEditTarget(node);
    setDefaultParentId(node.parentId);
    setFormName(node.name);
    setFormSlug(node.slug);
    setFormScope((node.scope as 'soma' | 'brand') ?? 'soma');
    setFormBrandScope(node.brandScope ?? '');
    setFormParentId(node.parentId);
    setFormError(null);
    setModalOpen(true);
  }

  async function handleSave() {
    if (!formName.trim()) { setFormError('Name is required'); return; }
    setFormSaving(true);
    setFormError(null);
    try {
      const slug = formSlug.trim() || formName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const body = {
        name: formName.trim(),
        slug,
        scope: formScope,
        brandScope: formScope === 'brand' ? formBrandScope.trim() || null : null,
        parentId: formParentId,
      };
      if (editTarget) {
        const res = await fetch(`/api/v1/broll/categories/${editTarget.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('Failed to update');
      } else {
        const res = await fetch('/api/v1/broll/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('Failed to create');
      }
      setModalOpen(false);
      fetchCategories();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Error');
    } finally {
      setFormSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    await fetch(`/api/v1/broll/categories/${deleteTarget.id}`, { method: 'DELETE' });
    setDeleting(false);
    setDeleteTarget(null);
    fetchCategories();
  }

  const flat = flattenCategories(categories);

  return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ height: 64, flexShrink: 0, borderBottom: '1px solid #ECECE8', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => router.push('/broll')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', color: '#75757C', font: '500 13px/1 Satoshi', cursor: 'pointer', padding: 0 }}>
              <ArrowLeft size={14} /> B-roll library
            </button>
            <span style={{ color: '#D6D6D1' }}>/</span>
            <span style={{ font: '600 14px/1 Satoshi', color: '#111113' }}>Manage categories</span>
          </div>
          <button
            onClick={() => openCreate()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 9, background: '#6C47FF', color: '#fff', border: 'none', font: '600 14px/1 Satoshi', cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#5A36E8')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '#6C47FF')}
          >
            <Plus size={14} /> New category
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 60px' }}>
          {loading ? (
            <div style={{ color: '#75757C', font: '400 14px/1 Satoshi' }}>Loading…</div>
          ) : categories.length === 0 ? (
            <div style={{ padding: '48px 20px', textAlign: 'center', color: '#75757C', font: '400 14px/1.5 Satoshi' }}>
              No categories yet. Click "New category" to create the first one.
            </div>
          ) : (
            <div style={{ background: '#fff', border: '1px solid #ECECE8', borderRadius: 14, overflow: 'hidden', maxWidth: 720 }}>
              {categories.map((node) => (
                <CategoryRow
                  key={node.id}
                  node={node}
                  depth={0}
                  onEdit={openEdit}
                  onDelete={setDeleteTarget}
                  onAddChild={openCreate}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create / Edit modal */}
      {modalOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '28px', width: '100%', maxWidth: 440, boxShadow: '0 16px 48px rgba(0,0,0,0.18)' }}>
            <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 20 }}>{editTarget ? 'Edit category' : 'New category'}</div>

            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Name <span style={{ color: '#DC2626' }}>*</span></label>
            <input value={formName} onChange={(e) => { setFormName(e.target.value); if (!editTarget) setFormSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }}
              placeholder="e.g. Shopping & Retail"
              style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 14, outline: 'none', boxSizing: 'border-box' }}
              onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} autoFocus />

            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Slug</label>
            <input value={formSlug} onChange={(e) => setFormSlug(e.target.value)}
              placeholder="auto-generated from name"
              style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 14, outline: 'none', boxSizing: 'border-box', fontFamily: 'monospace' }}
              onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />

            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Scope</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              {(['soma', 'brand'] as const).map((s) => (
                <button key={s} type="button" onClick={() => setFormScope(s)}
                  style={{ flex: 1, height: 36, borderRadius: 8, border: `1.5px solid ${formScope === s ? '#6C47FF' : '#E4E4E0'}`, background: formScope === s ? '#EFEBFF' : '#fff', color: formScope === s ? '#6C47FF' : '#5E5E65', font: `${formScope === s ? 600 : 400} 13px/1 Satoshi`, cursor: 'pointer', textTransform: 'capitalize' }}>
                  {s === 'soma' ? 'Soma-wide' : 'Brand-specific'}
                </button>
              ))}
            </div>

            {formScope === 'brand' && (
              <>
                <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Brand</label>
                <input value={formBrandScope} onChange={(e) => setFormBrandScope(e.target.value)}
                  placeholder="e.g. Acme"
                  style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 12px', font: '400 14px/1 Satoshi', marginBottom: 14, outline: 'none', boxSizing: 'border-box' }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')} />
              </>
            )}

            <label style={{ display: 'block', font: '500 13px/1 Satoshi', marginBottom: 6 }}>Parent category <span style={{ color: '#A3A3A9', fontWeight: 400 }}>(optional)</span></label>
            <select value={formParentId ?? ''} onChange={(e) => setFormParentId(e.target.value ? Number(e.target.value) : null)}
              style={{ width: '100%', height: 38, border: '1px solid #E4E4E0', borderRadius: 8, padding: '0 10px', font: '400 14px/1 Satoshi', marginBottom: 20, outline: 'none', background: '#fff', boxSizing: 'border-box' }}
              onFocus={(e) => (e.currentTarget.style.borderColor = '#6C47FF')} onBlur={(e) => (e.currentTarget.style.borderColor = '#E4E4E0')}>
              <option value="">None (top-level)</option>
              {flat.filter((c) => c.id !== editTarget?.id).map((c) => (
                <option key={c.id} value={c.id}>{c.parentId ? '  └ ' : ''}{c.name}</option>
              ))}
            </select>

            {formError && <div style={{ color: '#DC2626', font: '400 13px/1.5 Satoshi', marginBottom: 12 }}>{formError}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setModalOpen(false)} disabled={formSaving} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer', color: '#111113' }}>Cancel</button>
              <button onClick={handleSave} disabled={formSaving || !formName.trim()} style={{ height: 38, padding: '0 18px', borderRadius: 9, background: formSaving || !formName.trim() ? '#E4E4E0' : '#6C47FF', color: formSaving || !formName.trim() ? '#A3A3A9' : '#fff', border: 'none', font: '700 14px/1 Satoshi', cursor: formSaving || !formName.trim() ? 'not-allowed' : 'pointer' }}>
                {formSaving ? 'Saving…' : editTarget ? 'Save changes' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '28px 28px 24px', width: '100%', maxWidth: 380, boxShadow: '0 16px 48px rgba(0,0,0,0.18)' }}>
            <div style={{ font: '700 18px/1.3 Satoshi', marginBottom: 8 }}>Delete category?</div>
            <div style={{ font: '400 14px/1.55 Satoshi', color: '#5E5E65', marginBottom: 24 }}>
              This will permanently delete &ldquo;{deleteTarget.name}&rdquo;{deleteTarget.children.length > 0 ? ` and its ${deleteTarget.children.length} subcategor${deleteTarget.children.length === 1 ? 'y' : 'ies'}` : ''}. All clip assignments to this category will be removed.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTarget(null)} style={{ height: 38, padding: '0 16px', borderRadius: 9, background: '#fff', border: '1px solid #E4E4E0', font: '500 14px/1 Satoshi', cursor: 'pointer', color: '#111113' }}>Cancel</button>
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
