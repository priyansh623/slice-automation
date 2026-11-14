'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sanitiseAnalysis, type Suggestion } from '@/lib/broll-bulk/analysis-schema';
import {
  applyBulkEdit, groupProposals, hasExactDuplicate, initialEdit, isUploadable, markBatchDuplicates, newItem, runPool, summarise, uploadApproved,
  type BulkItem, type BulkOp, type EditableMetadata, type ProposalGroup,
} from '@/lib/broll-bulk/batch';
import { BULK_MAX_FILES, resolveContentType, validateFileBasics, validateVideoFacts, hasBlockingIssue } from '@/lib/broll-bulk/rules';
import { sha256OfBlob } from '@/lib/broll-bulk/sha256-stream';
import { emptyTaxonomy, withPaths, type Taxonomy } from '@/lib/broll-bulk/taxonomy';
import { applyEntry, findEntry, hasUnfinishedWork, mergeForSave, missingEntries, snapshotItems, summariseSession, type Session } from '@/lib/broll-bulk/session';
import { BulkBar, ProposalPanel } from './BulkBar';
import { api, cacheSuggestion, cachedSuggestion, clearSession, inspectVideo, loadSession, putToR2, saveSession } from './client';
import { RecoveryBanner } from './Recovery';
import { ReviewDetail, ReviewGrid, StatusChip } from './Review';
import { Button, Chip, ModalShell, ProgressBar, T, font } from './ui';

const ANALYSE_CONCURRENCY = 3;
const UPLOAD_CONCURRENCY = 3;
const ACCEPT = 'video/*,.mp4,.mov,.webm,.avi';

let counter = 0;
const nextId = () => `b${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Bulk B-roll upload: pick many videos, let the AI analyse the whole batch, review and correct the suggestions, approve,
 * then upload through the existing direct-to-R2 flow. Analysis and upload are separate: nothing is uploaded and no clip
 * is created until the user approves the batch.
 */
export default function BulkUpload({ initialFiles, onClose, onUploaded, onManual }: { initialFiles: File[]; onClose: () => void; onUploaded: () => void; onManual: () => void }) {
  const [items, setItems] = useState<BulkItem[]>([]);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>(emptyTaxonomy());
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadStarted, setUploadStarted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, 'rejected'>>({});
  const [busyProposal, setBusyProposal] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  // Work saved by an earlier visit (see lib/broll-bulk/session.ts). Recovery only restores edits: it never uploads or approves.
  const [saved, setSaved] = useState<Session | null>(null);
  const [savedExpired, setSavedExpired] = useState(false);
  const savedRef = useRef<Session | null>(null);

  const itemsRef = useRef<BulkItem[]>([]);
  const taxonomyRef = useRef<Taxonomy>(emptyTaxonomy());
  const filesRef = useRef(new Map<string, File>());
  const framesRef = useRef(new Map<string, string[]>());
  const removedRef = useRef(new Set<string>());
  const inputRef = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const commit = useCallback((next: BulkItem[]) => { itemsRef.current = next; setItems(next); }, []);
  const patch = useCallback((id: string, p: Partial<BulkItem>) => { commit(itemsRef.current.map((it) => (it.id === id ? { ...it, ...p } : it))); }, [commit]);
  const get = (id: string) => itemsRef.current.find((i) => i.id === id);

  // ── Taxonomy ──────────────────────────────────────────────────────────────────────────────────────────
  const loadTaxonomy = useCallback(async () => {
    try { const t = await api.taxonomy(); taxonomyRef.current = t; setTaxonomy(t); setTaxonomyError(null); return t; }
    catch (e) { setTaxonomyError((e as Error).message); return null; }
  }, []);

  // ── Analysis pipeline ─────────────────────────────────────────────────────────────────────────────────
  const clientSanitise = (s: Suggestion): Suggestion => ({ ...sanitiseAnalysis({
    title: s.title, subject: s.subject, summary: s.summary, description: s.description, subjects: s.subjects, objects: s.objects, descriptors: s.descriptors,
    visible_text: s.visibleText, category_id: s.categoryId, category_confidence: s.categoryConfidence, category_reason: s.categoryReason,
    proposed_category: s.proposedCategory ? { name: s.proposedCategory.name, parent_id: s.proposedCategory.parentId, reason: s.proposedCategory.reason } : null,
    activity: s.activity, setting: s.setting, brands: s.brands, tags: s.tags.map((t) => t.tag), privacy: s.privacy, unresolved: s.unresolved, overall_confidence: s.confidence,
  }, taxonomyRef.current), hasVisibleText: s.hasVisibleText });

  const analyse = useCallback(async (id: string) => {
    const it = get(id); const frames = framesRef.current.get(id);
    if (!it || !frames) return;
    patch(id, { analysis: 'analysing', analysisError: null });
    try {
      const cached = it.sha256 ? cachedSuggestion(it.sha256) : null;
      const suggestion = cached ? clientSanitise(cached) : await api.analyse(frames, { durationSeconds: it.durationSeconds ?? 0, width: it.width ?? 0, height: it.height ?? 0 });
      if (!cached && it.sha256) cacheSuggestion(it.sha256, suggestion);
      if (removedRef.current.has(id)) return;
      const latest = get(id)!;
      patch(id, { analysis: 'analysed', suggestion, edit: initialEdit(suggestion, latest.fileName), included: !hasExactDuplicate(latest) });
    } catch (e) {
      if (!removedRef.current.has(id)) patch(id, { analysis: 'failed', analysisError: (e as Error).message });
    }
  }, [patch]);

  const prepare = useCallback(async (id: string) => {
    const file = filesRef.current.get(id);
    if (!file || removedRef.current.has(id)) return;
    patch(id, { analysis: 'preparing' });
    const basics = validateFileBasics(file);
    if (hasBlockingIssue(basics)) { patch(id, { analysis: 'invalid', issues: basics }); return; }
    let info;
    try { info = await inspectVideo(file); }
    catch (e) { patch(id, { analysis: 'invalid', issues: [...basics, { code: 'unreadable', severity: 'error', message: (e as Error).message }] }); return; }
    const issues = [...basics, ...validateVideoFacts(info)];
    patch(id, { thumbnail: info.thumbnail, width: info.width, height: info.height, durationSeconds: info.durationSeconds, issues });
    if (hasBlockingIssue(issues)) { patch(id, { analysis: 'invalid' }); return; }
    framesRef.current.set(id, info.frames);
    let sha: string | null = null;
    try { sha = await sha256OfBlob(file); } catch { sha = null; }
    if (removedRef.current.has(id)) return;
    commit(markBatchDuplicates(itemsRef.current.map((x) => (x.id === id ? { ...x, sha256: sha } : x))));
    try {
      const [res] = await api.duplicates([{ sha256: sha, size: file.size }]);
      const lib = res.matches.map((m) => ({ kind: m.kind, clipId: m.clipId, title: m.title }));
      patch(id, { duplicates: [...(get(id)?.duplicates ?? []).filter((d) => d.kind === 'batch_exact'), ...lib] });
    } catch { /* the duplicate check is advisory: a failure must not block the batch */ }
    const entry = findEntry(savedRef.current, sha);
    if (entry) {
      // Restored from an earlier visit: the saved analysis and edits come back, nothing is uploaded and nothing is approved.
      const current = get(id);
      if (current && !removedRef.current.has(id)) commit(itemsRef.current.map((x) => (x.id === id ? applyEntry({ ...current, thumbnail: x.thumbnail }, entry, taxonomyRef.current) : x)));
      return;
    }
    await analyse(id);
  }, [analyse, commit, patch]);

  const addFiles = useCallback((files: File[]) => {
    const videos = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|avi)$/i.test(f.name));
    const skipped = files.length - videos.length;
    const room = BULK_MAX_FILES - itemsRef.current.length;
    const take = videos.slice(0, Math.max(0, room));
    const messages: string[] = [];
    if (skipped > 0) messages.push(`${skipped} file${skipped === 1 ? ' was' : 's were'} skipped because they are not videos.`);
    if (videos.length > take.length) messages.push(`A batch holds up to ${BULK_MAX_FILES} videos; ${videos.length - take.length} were not added.`);
    setNotice(messages.join(' ') || null);
    if (take.length === 0) return;
    const created = take.map((f) => { const id = nextId(); filesRef.current.set(id, f); return newItem(id, f, resolveContentType(f)); });
    commit([...itemsRef.current, ...created]);
    void runPool(created.map((c) => () => prepare(c.id)), ANALYSE_CONCURRENCY);
  }, [commit, prepare]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const { session, expired } = loadSession();
    savedRef.current = session; setSaved(session); setSavedExpired(expired);
    void loadTaxonomy().then(() => { if (initialFiles.length) addFiles(initialFiles); });
  }, [addFiles, initialFiles, loadTaxonomy]);

  // Leaving the page mid-analysis or mid-upload would lose the batch: ask first.
  const summary = useMemo(() => summarise(items), [items]);
  const busy = (items.length > 0 && !summary.analysisDone) || summary.uploadingNow > 0;
  useEffect(() => {
    if (!busy) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [busy]);

  // Keep a redacted snapshot so a refresh does not lose the review. Never overwrites saved work with an empty batch.
  useEffect(() => {
    if (items.length === 0) return;
    const timer = setTimeout(() => {
      const merged = mergeForSave(snapshotItems(itemsRef.current), savedRef.current);
      if (hasUnfinishedWork(merged)) { saveSession(merged); savedRef.current = merged; setSaved(merged); }
      else if (merged.entries.length > 0 && itemsRef.current.length > 0 && itemsRef.current.every((i) => i.upload === 'uploaded' || i.analysis === 'invalid')) { clearSession(); savedRef.current = null; setSaved(null); }
      else { saveSession(merged); savedRef.current = merged; }
    }, 400);
    return () => clearTimeout(timer);
  }, [items]);
  const discardSaved = () => { clearSession(); savedRef.current = null; setSaved(null); setSavedExpired(false); };
  const missing = useMemo(() => missingEntries(saved, items), [saved, items]);

  // ── Editing ───────────────────────────────────────────────────────────────────────────────────────────
  const edit = (id: string, p: Partial<EditableMetadata>) => { const it = get(id); if (it?.edit) patch(id, { edit: { ...it.edit, ...p }, reviewed: true }); };
  const selectedIds = useMemo(() => new Set(items.filter((i) => i.selected).map((i) => i.id)), [items]);
  const bulk = (op: BulkOp) => { const ids = new Set(itemsRef.current.filter((i) => i.selected).map((i) => i.id)); commit(applyBulkEdit(itemsRef.current, ids, op, taxonomyRef.current).map((i) => (ids.has(i.id) ? { ...i, reviewed: true } : i))); };
  const remove = (ids: string[]) => {
    for (const id of ids) { removedRef.current.add(id); filesRef.current.delete(id); framesRef.current.delete(id); }
    commit(markBatchDuplicates(itemsRef.current.filter((i) => !ids.includes(i.id))));
    if (detailId && ids.includes(detailId)) setDetailId(null);
  };
  const setIncluded = (ids: Set<string>, included: boolean) => commit(itemsRef.current.map((i) => (ids.has(i.id) && i.analysis === 'analysed' ? { ...i, included } : i)));
  const tagsInSelection = useMemo(() => [...new Set(items.filter((i) => i.selected && i.edit).flatMap((i) => i.edit!.tags))].sort(), [items]);

  // ── Category proposals (explicit and separate from approving the batch) ───────────────────────────────
  const proposals = useMemo(() => groupProposals(items), [items]);
  const createProposal = async (g: ProposalGroup) => {
    setBusyProposal(g.key); setProposalError(null);
    try {
      const created = await api.createCategory(g.name, g.parentId);
      const next: Taxonomy = { ...taxonomyRef.current, categories: withPaths([...taxonomyRef.current.categories.map((c) => ({ ...c, sortOrder: 0 })), { id: created.id, name: created.name, parentId: created.parentId, scope: created.scope, brandScope: created.brandScope }]) };
      taxonomyRef.current = next; setTaxonomy(next);
      commit(itemsRef.current.map((i) => (g.itemIds.includes(i.id) && i.edit ? { ...i, edit: { ...i.edit, categoryId: created.id } } : i)));
    } catch (e) { setProposalError((e as Error).message); }
    finally { setBusyProposal(null); }
  };

  // ── Upload (only after approval) ──────────────────────────────────────────────────────────────────────
  const uploadOne = useCallback(async (id: string) => {
    const file = filesRef.current.get(id);
    const it = get(id);
    if (!file || !it || !it.edit) return;
    const result = await uploadApproved(
      it, it.contentType ?? resolveContentType(file) ?? 'video/mp4', file.name,
      { init: api.init, put: (url, headers, onProgress) => putToR2(url, headers, file, onProgress), complete: api.complete },
      (p) => patch(id, p),
    );
    patch(id, result);
  }, [patch]);

  const startUpload = async (onlyFailed = false) => {
    setConfirmOpen(false); setUploadStarted(true);
    const ids = itemsRef.current.filter((i) => (onlyFailed ? i.upload === 'failed' : isUploadable(i))).map((i) => i.id);
    commit(itemsRef.current.map((i) => (ids.includes(i.id) ? { ...i, upload: 'queued', uploadError: null } : i)));
    await runPool(ids.map((id) => () => uploadOne(id)), UPLOAD_CONCURRENCY);
    if (itemsRef.current.some((i) => i.upload === 'uploaded')) onUploaded();
  };

  const retryAnalysis = (id: string) => { if (framesRef.current.has(id)) void analyse(id); else { patch(id, { analysis: 'pending', analysisError: null }); void prepare(id); } };

  // ── Derived view state ────────────────────────────────────────────────────────────────────────────────
  const analysing = items.length > 0 && !summary.analysisDone;
  const uploading = uploadStarted && (summary.uploadingNow > 0 || items.some((i) => i.upload === 'queued'));
  const finished = uploadStarted && !uploading;
  const overall = items.length ? (summary.analysed + summary.failedAnalysis + summary.invalid) / items.length : 0;
  const toUpload = items.filter((i) => i.upload !== 'none' && i.upload !== undefined);
  const uploadFraction = toUpload.length ? toUpload.reduce((n, i) => n + (i.upload === 'uploaded' ? 1 : i.upload === 'verifying' ? 0.98 : i.upload === 'uploading' ? i.uploadProgress * 0.95 : 0), 0) / toUpload.length : 0;
  const detailItems = items.filter((i) => i.edit);
  const detailIndex = detailItems.findIndex((i) => i.id === detailId);
  const detail = detailIndex >= 0 ? detailItems[detailIndex] : null;
  const locked = (it: BulkItem) => it.upload === 'queued' || it.upload === 'uploading' || it.upload === 'verifying' || it.upload === 'uploaded';
  const approvable = items.filter(isUploadable);
  const withPrivacy = approvable.filter((i) => (i.suggestion?.privacy.length ?? 0) > 0).length;
  const uncategorised = approvable.filter((i) => i.edit?.categoryId === null).length;

  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); if (!uploadStarted) addFiles([...e.dataTransfer.files]); },
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: T.surface, display: 'flex', flexDirection: 'column' }} {...dropProps}>
      <input ref={inputRef} type="file" accept={ACCEPT} multiple style={{ display: 'none' }} onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', background: '#fff', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ font: font(700, 18, 1.2) }}>Bulk upload B-roll</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[['1 Select', items.length > 0], ['2 Analyse', items.length > 0 && !analysing], ['3 Review', items.length > 0 && !analysing && !uploadStarted], ['4 Upload', finished]].map(([label, done]) => (
            <Chip key={label as string} tone={done ? 'ok' : 'neutral'}>{label as string}</Chip>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {!uploadStarted && <Button onClick={onManual} title="Use the one-video form instead">Upload one manually</Button>}
          <Button onClick={() => { if (busy && !window.confirm('Leave now? Analysis or uploads in progress will be lost.')) return; onClose(); }}>{finished ? 'Close' : 'Cancel'}</Button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24, position: 'relative' }}>
        {taxonomyError && <div style={{ background: T.dangerSoft, border: `1px solid ${T.dangerBorder}`, borderRadius: 10, padding: '10px 12px', color: T.danger, font: font(400, 13, 1.4), marginBottom: 14 }}>
          Could not load the categories and options ({taxonomyError}). <button onClick={() => void loadTaxonomy()} style={{ border: 'none', background: 'none', color: T.accent, cursor: 'pointer', font: font(600, 13, 1) }}>Try again</button>
        </div>}
        {notice && <div style={{ background: T.warnSoft, border: `1px solid ${T.warnBorder}`, borderRadius: 10, padding: '8px 12px', color: T.warn, font: font(400, 13, 1.4), marginBottom: 14 }}>{notice}</div>}

        <RecoveryBanner saved={saved} missing={missing} expired={savedExpired} hasItems={items.length > 0} onSelect={() => inputRef.current?.click()} onDiscard={discardSaved} />

        {items.length === 0 ? (
          <div onClick={() => inputRef.current?.click()} style={{ maxWidth: 720, margin: '60px auto 0', background: dragOver ? T.accentSoft : '#fff', border: `2px dashed ${dragOver ? T.accent : T.borderStrong}`, borderRadius: 16, padding: '64px 40px', textAlign: 'center', cursor: 'pointer' }}>
            <div style={{ font: font(700, 20, 1.3) }}>Drop videos here, or click to choose</div>
            <div style={{ font: font(400, 14, 1.6), color: T.muted, margin: '10px auto 20px', maxWidth: 460 }}>
              Pick as many 9:16 videos as you like (up to {BULK_MAX_FILES}). The AI looks at each one and suggests the category, activity, setting, brand and tags. Nothing is uploaded until you review and approve the batch.
            </div>
            <Button kind="primary">Choose videos</Button>
          </div>
        ) : (
          <>
            {/* Progress */}
            <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 12, padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <div style={{ font: font(700, 14, 1.2) }}>
                  {uploadStarted ? (finished ? 'Upload finished' : 'Uploading approved clips…') : analysing ? `Analysing ${summary.analysed + summary.failedAnalysis + summary.invalid} of ${items.length}…` : `Analysis complete: ${items.length} video${items.length === 1 ? '' : 's'}`}
                </div>
                {summary.analysed > 0 && <Chip tone="ok">{summary.analysed} analysed</Chip>}
                {summary.failedAnalysis > 0 && <Chip tone="danger">{summary.failedAnalysis} failed</Chip>}
                {summary.invalid > 0 && <Chip tone="danger">{summary.invalid} can’t be uploaded</Chip>}
                {items.some((i) => i.restored) && <Chip tone="accent" title="Analysis and edits restored from your earlier visit">{items.filter((i) => i.restored).length} restored</Chip>}
                {summary.duplicates > 0 && <Chip tone="warn">{summary.duplicates} duplicate{summary.duplicates === 1 ? '' : 's'}</Chip>}
                {summary.withPrivacyWarnings > 0 && <Chip tone="danger">⚠ {summary.withPrivacyWarnings} privacy warning{summary.withPrivacyWarnings === 1 ? '' : 's'}</Chip>}
                {uploadStarted && <Chip tone="ok">{summary.uploaded} uploaded</Chip>}
                {summary.uploadFailed > 0 && <Chip tone="danger">{summary.uploadFailed} failed to upload</Chip>}
                {!uploadStarted && <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => inputRef.current?.click()}>Add more videos</Button>}
                {summary.uploadFailed > 0 && !uploading && <Button size="sm" kind="primary" style={{ marginLeft: 'auto' }} onClick={() => void startUpload(true)}>Retry failed uploads</Button>}
              </div>
              <ProgressBar value={uploadStarted ? uploadFraction : overall} tone={uploadStarted && finished && summary.uploadFailed === 0 ? 'ok' : 'accent'} />
            </div>

            {!analysing && !uploadStarted && (
              <ProposalPanel groups={proposals} taxonomy={taxonomy} decisions={decisions} busyKey={busyProposal} error={proposalError}
                onCreate={(g) => void createProposal(g)} onReject={(g) => setDecisions((d) => ({ ...d, [g.key]: 'rejected' }))} />
            )}
            {!analysing && !uploadStarted && selectedIds.size > 0 && (
              <BulkBar count={selectedIds.size} taxonomy={taxonomy} tagsInSelection={tagsInSelection} onOp={bulk}
                onRemoveSelected={() => remove([...selectedIds])} onSetIncluded={(inc) => setIncluded(selectedIds, inc)} onClear={() => commit(itemsRef.current.map((i) => ({ ...i, selected: false })))} />
            )}
            {!analysing && !uploadStarted && items.some((i) => i.analysis === 'analysed') && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, font: font(400, 13, 1) }}>
                <Button size="sm" onClick={() => { const all = items.filter((i) => i.analysis === 'analysed'); const on = all.some((i) => !i.selected); commit(itemsRef.current.map((i) => (i.analysis === 'analysed' ? { ...i, selected: on } : i))); }}>
                  {items.filter((i) => i.analysis === 'analysed').every((i) => i.selected) ? 'Deselect all' : 'Select all'}
                </Button>
                <span style={{ color: T.muted }}>Select clips to edit several at once, or click a clip to review it on its own.</span>
              </div>
            )}

            <ReviewGrid items={items} taxonomy={taxonomy} locked={uploadStarted}
              onOpen={(id) => { patch(id, { reviewed: true }); setDetailId(id); }}
              onToggleSelect={(id) => patch(id, { selected: !get(id)!.selected })}
              onToggleInclude={(id) => { const it = get(id)!; const on = !it.included; patch(id, { included: on, duplicateOverride: on && hasExactDuplicate(it) }); }}
              onRemove={(id) => remove([id])}
              onRetryAnalysis={retryAnalysis} />

            {uploadStarted && items.some((i) => i.upload === 'failed') && (
              <div style={{ marginTop: 16, display: 'grid', gap: 6 }}>
                {items.filter((i) => i.upload === 'failed').map((i) => (
                  <div key={i.id} style={{ background: T.dangerSoft, border: `1px solid ${T.dangerBorder}`, borderRadius: 10, padding: '8px 12px', font: font(400, 13, 1.4), color: '#7F1D1D', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <StatusChip item={i} /> <strong>{i.edit?.title || i.fileName}</strong>: {i.uploadError}
                    {i.uploadErrorCode === 'duplicate' && !uploading && (
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                        <Button size="sm" onClick={() => remove([i.id])}>Remove from batch</Button>
                        <Button size="sm" kind="danger" onClick={() => { patch(i.id, { duplicateOverride: true, uploadError: null, uploadErrorCode: null, upload: 'failed' }); void startUpload(true); }}>Upload anyway</Button>
                      </span>
                    )}
                  </div>
                ))}
                <div style={{ font: font(400, 12.5, 1.4), color: T.muted }}>Retrying uploads again only the failed clips. A clip whose file already reached storage is saved again without re-uploading, and a repeat can never create a duplicate record.</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Approval footer: the only way to start uploading */}
      {items.length > 0 && !uploadStarted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 24px', background: '#fff', borderTop: `1px solid ${T.border}` }}>
          <div style={{ font: font(500, 14, 1.3) }}>
            {analysing ? 'Waiting for the analysis to finish…' : `${approvable.length} of ${items.length} clips ready to upload`}
            {!analysing && uncategorised > 0 && <span style={{ color: T.warn }}> · {uncategorised} without a category</span>}
          </div>
          <Button kind="primary" style={{ marginLeft: 'auto' }} disabled={analysing || approvable.length === 0} onClick={() => setConfirmOpen(true)}>Review and approve upload…</Button>
        </div>
      )}
      {finished && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 24px', background: '#fff', borderTop: `1px solid ${T.border}` }}>
          <div style={{ font: font(500, 14, 1.3) }}>{summary.uploaded} clip{summary.uploaded === 1 ? '' : 's'} added to the library{summary.uploadFailed > 0 ? `, ${summary.uploadFailed} failed` : ''}.</div>
          <Button kind="primary" style={{ marginLeft: 'auto' }} onClick={onClose}>Done</Button>
        </div>
      )}

      {confirmOpen && (
        <ModalShell title={`Upload ${approvable.length} clip${approvable.length === 1 ? '' : 's'}?`} onClose={() => setConfirmOpen(false)}>
          <div style={{ font: font(400, 14, 1.6), marginBottom: 12 }}>
            The approved videos go straight to storage and are added to the B-roll library with the metadata you reviewed.
          </div>
          <ul style={{ margin: '0 0 14px', paddingLeft: 18, font: font(400, 13.5, 1.7) }}>
            <li>{approvable.length} clip{approvable.length === 1 ? '' : 's'} will be uploaded.</li>
            {items.length - approvable.length > 0 && <li>{items.length - approvable.length} will <strong>not</strong> be uploaded (excluded, duplicate, invalid or failed analysis).</li>}
            {uncategorised > 0 && <li style={{ color: T.warn }}>{uncategorised} {uncategorised === 1 ? 'has' : 'have'} no category and will stay hidden from the library until categorised.</li>}
            {withPrivacy > 0 && <li style={{ color: T.danger }}>{withPrivacy} {withPrivacy === 1 ? 'has' : 'have'} privacy warnings. Nothing has been blurred or removed; check them before you approve.</li>}
            <li>No new category is created by approving this upload.</li>
          </ul>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={() => setConfirmOpen(false)}>Back to review</Button>
            <Button kind="primary" onClick={() => void startUpload(false)}>Approve and upload</Button>
          </div>
        </ModalShell>
      )}

      {detail && (
        <ReviewDetail item={detail} file={filesRef.current.get(detail.id)} taxonomy={taxonomy} readOnly={locked(detail)} index={detailIndex} count={detailItems.length}
          onChange={(p) => edit(detail.id, p)} onPrev={() => setDetailId(detailItems[detailIndex - 1]?.id ?? null)} onNext={() => setDetailId(detailItems[detailIndex + 1]?.id ?? null)}
          onClose={() => setDetailId(null)} onRetryAnalysis={() => retryAnalysis(detail.id)} />
      )}
    </div>
  );
}
