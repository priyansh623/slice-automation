import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { Sha256, sha256OfBlob } from '@/lib/broll-bulk/sha256-stream';
import * as rules from '@/lib/broll-bulk/rules';
import { isPortrait916 as serverIsPortrait916 } from '@/lib/broll-probe';
import { canonicalBrand, canonicalTag, distinctByUse, matchAllowed, normalizeTag, withPaths, type Taxonomy } from '@/lib/broll-bulk/taxonomy';
import { detectPiiInText, redactForStorage, sanitiseAnalysis, SEVERITY_FLOOR } from '@/lib/broll-bulk/analysis-schema';
import { buildSystemPrompt } from '@/lib/broll-bulk/analyzer';
import {
  applyBulkEdit, blockers, buildCompletePayload, groupProposals, initialEdit, isUploadable, markBatchDuplicates, newItem, runPool, summarise, uploadApproved,
  type BulkItem, type UploadDeps,
} from '@/lib/broll-bulk/batch';

const tax: Taxonomy = {
  categories: withPaths([
    { id: 1, name: 'Payments', parentId: null, scope: 'soma', brandScope: null },
    { id: 22, name: 'Mobile payment', parentId: 1, scope: 'soma', brandScope: null },
    { id: 8, name: 'Travel', parentId: null, scope: 'soma', brandScope: null },
    { id: 50, name: 'Cab & ride hailing', parentId: 8, scope: 'soma', brandScope: null },
  ]),
  activities: ['Payment ', 'Riding in a vehicle', 'Eating'],
  settings: ['Cafe', 'Cab or auto', 'Street or outdoor'],
  brands: ['Paytm', 'PhonePe', 'Nike'],
  tags: [{ tag: 'qr code', count: 9 }, { tag: 'credit card', count: 5 }, { tag: 'travel', count: 3 }],
};

describe('SHA-256 stream', () => {
  it('matches node:crypto for lengths around every block boundary and for any chunking', () => {
    for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 100_001]) {
      const data = crypto.randomBytes(len);
      const want = crypto.createHash('sha256').update(data).digest('hex');
      expect(new Sha256().update(data).digestHex()).toBe(want);
      for (const chunk of [1, 7, 63, 64, 65, 1000]) {
        const h = new Sha256();
        for (let i = 0; i < data.length; i += chunk) h.update(data.subarray(i, i + chunk));
        expect(h.digestHex()).toBe(want);
      }
    }
  });
  it('knows the standard test vectors', () => {
    expect(new Sha256().digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(Buffer.from('abc')).digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('hashes a Blob in chunks without needing it all in memory', async () => {
    const data = crypto.randomBytes(5_000_000);
    const progress: number[] = [];
    expect(await sha256OfBlob(new Blob([data]), (f) => progress.push(f), 1_000_000)).toBe(crypto.createHash('sha256').update(data).digest('hex'));
    expect(progress.length).toBe(5);
    expect(progress.at(-1)).toBe(1);
  });
});

describe('technical validation rules', () => {
  it('uses the same 9:16 rule as the server', () => {
    for (const [w, h] of [[720, 1280], [716, 1284], [1076, 1928], [1080, 1920], [1920, 1080], [828, 1108], [1000, 1000], [0, 100], [100, 0]]) {
      expect(rules.isPortrait916(w, h)).toBe(h > 0 && serverIsPortrait916({ width: w, height: h }));
    }
  });
  it('accepts mp4, mov, webm and avi; rejects other formats with a clear reason', () => {
    for (const name of ['a.mp4', 'a.MOV', 'a.webm', 'a.avi']) expect(rules.validateFileBasics({ name, type: '', size: 10 })).toEqual([]);
    expect(rules.validateFileBasics({ name: 'a.mkv', type: 'video/x-matroska', size: 10 })[0].code).toBe('unsupported_format');
    expect(rules.validateFileBasics({ name: 'a.pdf', type: 'application/pdf', size: 10 })[0].severity).toBe('error');
    expect(rules.validateFileBasics({ name: 'a.exe', type: '', size: 10 })[0].code).toBe('unsupported_format');
  });
  it('flags an empty file, an oversize file, and a name/type mismatch', () => {
    expect(rules.validateFileBasics({ name: 'a.mp4', type: 'video/mp4', size: 0 }).map((i) => i.code)).toContain('empty_file');
    expect(rules.validateFileBasics({ name: 'a.mp4', type: 'video/mp4', size: rules.BULK_MAX_BYTES + 1 }).map((i) => i.code)).toContain('too_large');
    expect(rules.validateFileBasics({ name: 'a.mp4', type: 'video/mp4', size: rules.BULK_MAX_BYTES })).toEqual([]);
    expect(rules.validateFileBasics({ name: 'a.mp4', type: 'video/webm', size: 10 }).map((i) => i.code)).toContain('type_mismatch');
  });
  it('checks dimensions, aspect ratio and duration', () => {
    expect(rules.validateVideoFacts({ width: 720, height: 1280, durationSeconds: 5 })).toEqual([]);
    expect(rules.validateVideoFacts({ width: 1920, height: 1080, durationSeconds: 5 }).map((i) => i.code)).toEqual(['not_9_16']);
    expect(rules.validateVideoFacts({ width: 0, height: 0, durationSeconds: 5 }).map((i) => i.code)).toContain('no_dimensions');
    expect(rules.validateVideoFacts({ width: 720, height: 1280, durationSeconds: 0 }).map((i) => i.code)).toContain('no_duration');
    const long = rules.validateVideoFacts({ width: 720, height: 1280, durationSeconds: 300 });
    expect(long[0]).toMatchObject({ code: 'long_video', severity: 'warning' });
    expect(rules.hasBlockingIssue(long)).toBe(false);
  });
});

describe('taxonomy helpers', () => {
  it('maps values onto the approved list ignoring case and spacing, keeping the stored value exactly', () => {
    expect(matchAllowed('payment', tax.activities)).toBe('Payment '); // the stored value has a trailing space
    expect(matchAllowed('  riding   in a VEHICLE ', tax.activities)).toBe('Riding in a vehicle');
    expect(matchAllowed('Sprinting', tax.activities)).toBeNull();
    expect(matchAllowed(null, tax.activities)).toBeNull();
  });
  it('reuses an existing brand regardless of case or punctuation, so no duplicate record appears', () => {
    expect(canonicalBrand('PAYTM', tax.brands)).toBe('Paytm');
    expect(canonicalBrand('Phone-Pe', tax.brands)).toBe('PhonePe');
    expect(canonicalBrand('Zomato', tax.brands)).toBeNull();
  });
  it('normalises tags to the existing convention and folds variations onto existing tags', () => {
    expect(normalizeTag('  #Credit   Card ')).toBe('credit card');
    expect(normalizeTag('x')).toBeNull();
    expect(canonicalTag('Credit-Card', tax.tags.map((t) => t.tag))).toEqual({ tag: 'credit card', known: true });
    expect(canonicalTag('Brand New Tag', tax.tags.map((t) => t.tag))).toEqual({ tag: 'brand new tag', known: false });
  });
  it('builds category paths and picks the most used spelling of a value', () => {
    expect(tax.categories.find((c) => c.id === 22)!.path).toBe('Payments > Mobile payment');
    expect(distinctByUse(['Cafe', 'cafe', 'cafe', 'Mall', null, ''])).toEqual(['cafe', 'Mall']);
  });
});

describe('sanitising the AI output (grounding in the approved taxonomy)', () => {
  const raw = { title: 'Scanning a QR', summary: 's', description: 'A phone scans a QR code.', category_id: 22, category_confidence: 'high', activity: 'Payment', setting: 'Cafe', brands: [{ name: 'paytm', role: 'hero', evidence: 'logo' }], tags: ['QR Code', 'cafe', 'Brand New'], privacy: [], visible_text: [], unresolved: [], overall_confidence: 'high' };

  it('keeps valid taxonomy values and canonicalises them', () => {
    const s = sanitiseAnalysis(raw, tax);
    expect(s).toMatchObject({ categoryId: 22, needsCategoryReview: false, activity: 'Payment ', setting: 'Cafe', confidence: 'high' });
    expect(s.brands).toEqual([{ name: 'Paytm', role: 'hero', existing: true, evidence: 'logo' }]);
    expect(s.tags).toEqual([{ tag: 'qr code', known: true }, { tag: 'cafe', known: false }, { tag: 'brand new', known: false }]);
  });
  it('never accepts an invented category id: it becomes Needs review', () => {
    for (const bad of [999, -1, 22.5, '22', null, undefined, {}]) {
      const s = sanitiseAnalysis({ ...raw, category_id: bad }, tax);
      expect(s.categoryId).toBeNull();
      expect(s.needsCategoryReview).toBe(true);
      expect(s.unresolved).toContain('category');
    }
  });
  it('turns a proposal into a PROPOSAL only, validating its parent against existing categories', () => {
    const s = sanitiseAnalysis({ ...raw, category_id: null, proposed_category: { name: 'Fuel stations', parent_id: 8, reason: 'No refuelling category.' } }, tax);
    expect(s.categoryId).toBeNull();
    expect(s.proposedCategory).toEqual({ name: 'Fuel stations', parentId: 8, reason: 'No refuelling category.' });
    expect(sanitiseAnalysis({ ...raw, category_id: null, proposed_category: { name: 'Fuel', parent_id: 12345, reason: 'x' } }, tax).proposedCategory!.parentId).toBeNull();
  });
  it('maps a proposal that names an existing category onto that category instead of proposing a duplicate', () => {
    const s = sanitiseAnalysis({ ...raw, category_id: null, proposed_category: { name: 'mobile payment', parent_id: 1, reason: 'x' } }, tax);
    expect(s.categoryId).toBe(22);
    expect(s.proposedCategory).toBeNull();
  });
  it('drops activity and setting that are not approved values, flags them, and remembers what was rejected', () => {
    const s = sanitiseAnalysis({ ...raw, activity: 'Sprinting', setting: 'Spaceship' }, tax);
    expect(s.activity).toBeNull(); expect(s.setting).toBeNull();
    expect(s.unresolved).toEqual(expect.arrayContaining(['activity', 'setting']));
    expect(s.rejectedValues).toEqual({ activity: 'Sprinting', setting: 'Spaceship' });
  });
  it('is safe against junk: wrong types, huge lists, duplicates', () => {
    const s = sanitiseAnalysis({ brands: 'x', tags: [1, null, 'ok tag', 'ok tag'], privacy: [{ type: 'bogus' }], visible_text: [5], category_id: 'a', overall_confidence: 'great' }, tax);
    expect(s.tags).toEqual([{ tag: 'ok tag', known: false }]);
    expect(s.privacy[0]).toMatchObject({ type: 'other_pii', severity: 'medium' });
    expect(s.confidence).toBe('low');
    expect(sanitiseAnalysis(null, tax).needsCategoryReview).toBe(true);
    expect(sanitiseAnalysis({ brands: Array.from({ length: 30 }, (_, i) => ({ name: `B${i}`, role: 'hero' })) }, tax).brands).toHaveLength(6);
  });
  it('uses the page\'s field names for what the model could not settle, without duplicates', () => {
    const s = sanitiseAnalysis({ ...raw, category_id: null, unresolved: ['category_id', 'category', 'brand', 'activity'] }, tax);
    expect(s.unresolved).toEqual(['category', 'brands', 'activity']);
  });
  it('does not duplicate a brand mentioned twice', () => {
    expect(sanitiseAnalysis({ ...raw, brands: [{ name: 'Nike', role: 'hero' }, { name: 'NIKE', role: 'incidental' }] }, tax).brands).toHaveLength(1);
  });
  it('adds privacy warnings found by pattern in the text the model read', () => {
    expect(detectPiiInText(['Contact: jane@example.com']).map((p) => p.type)).toEqual(['email']);
    expect(detectPiiInText(['Call 98765 43210']).map((p) => p.type)).toEqual(['phone']);
    expect(detectPiiInText(['4111 1111 1111 1111']).map((p) => p.type)).toEqual(['payment_details']);
    expect(detectPiiInText(['Rs 120 paid', 'Super Slicer'])).toEqual([]);
    const s = sanitiseAnalysis({ ...raw, visible_text: ['mail me at a@b.co'], privacy: [{ type: 'face', detail: 'A face is visible.', severity: 'high' }] }, tax);
    expect(s.privacy.map((p) => p.type)).toEqual(['face', 'email']);
  });
});

function analysed(id: string, over: Partial<BulkItem> = {}, sug: Record<string, unknown> = {}): BulkItem {
  const s = sanitiseAnalysis({ title: `Clip ${id}`, description: 'd', category_id: 22, category_confidence: 'high', activity: 'Eating', setting: 'Cafe', brands: [{ name: 'Nike', role: 'hero', evidence: 'e' }], tags: ['qr code'], overall_confidence: 'high', ...sug }, tax);
  return { ...newItem(id, { name: `${id}.mp4`, size: 1000 }, 'video/mp4'), analysis: 'analysed', suggestion: s, edit: initialEdit(s, `${id}.mp4`), included: true, sha256: id.padEnd(64, '0'), ...over };
}

describe('bulk editing', () => {
  const items = [analysed('a'), analysed('b', {}, { activity: 'Payment', setting: 'Street or outdoor', tags: ['travel'] }), analysed('c')];
  const ids = new Set(['a', 'b']);

  it('applies a category to the selected clips only and leaves every other field alone', () => {
    const out = applyBulkEdit(items, ids, { kind: 'category', categoryId: 50 }, tax);
    expect(out.map((i) => i.edit!.categoryId)).toEqual([50, 50, 22]);
    expect(out[1].edit).toEqual({ ...items[1].edit, categoryId: 50 });          // b's own activity, setting and tags are preserved
    expect(out[2]).toBe(items[2]);                                              // unselected: the very same object
  });
  it('sets activity and setting from the approved lists only', () => {
    const out = applyBulkEdit(items, ids, { kind: 'activity', activity: 'Riding in a vehicle' }, tax);
    expect(out.map((i) => i.edit!.activity)).toEqual(['Riding in a vehicle', 'Riding in a vehicle', 'Eating']);
    expect(applyBulkEdit(items, ids, { kind: 'activity', activity: 'Sprinting' }, tax)[0].edit!.activity).toBe('Eating'); // not approved: unchanged
    expect(applyBulkEdit(items, ids, { kind: 'setting', setting: 'Cab or auto' }, tax)[1].edit!.setting).toBe('Cab or auto');
    expect(applyBulkEdit(items, ids, { kind: 'category', categoryId: 99999 }, tax)[0].edit!.categoryId).toBe(22);        // unknown id: unchanged
  });
  it('adds a brand once (reusing the existing spelling) and removes it again', () => {
    const added = applyBulkEdit(items, ids, { kind: 'addBrand', name: 'paytm', role: 'incidental' }, tax);
    expect(added[0].edit!.brands).toEqual([{ name: 'Nike', role: 'hero' }, { name: 'Paytm', role: 'incidental' }]);
    expect(applyBulkEdit(added, ids, { kind: 'addBrand', name: 'PAYTM', role: 'hero' }, tax)[0].edit!.brands).toHaveLength(2);
    expect(applyBulkEdit(added, ids, { kind: 'removeBrand', name: 'nike' }, tax)[0].edit!.brands).toEqual([{ name: 'Paytm', role: 'incidental' }]);
  });
  it('adds and removes tags across the selection without touching other tags', () => {
    const added = applyBulkEdit(items, ids, { kind: 'addTags', tags: ['Credit-Card', 'new thing'] }, tax);
    expect(added[0].edit!.tags).toEqual(['qr code', 'credit card', 'new thing']);
    expect(added[1].edit!.tags).toEqual(['travel', 'credit card', 'new thing']);
    expect(added[2].edit!.tags).toEqual(['qr code']);
    const removed = applyBulkEdit(added, ids, { kind: 'removeTags', tags: ['QR Code', 'travel'] }, tax);
    expect(removed[0].edit!.tags).toEqual(['credit card', 'new thing']);
    expect(removed[1].edit!.tags).toEqual(['credit card', 'new thing']);
  });
  it('skips items that have nothing to edit yet', () => {
    const waiting = newItem('w', { name: 'w.mp4', size: 1 }, 'video/mp4');
    expect(applyBulkEdit([waiting], new Set(['w']), { kind: 'category', categoryId: 22 }, tax)[0]).toBe(waiting);
  });
});

describe('duplicates, readiness and summary', () => {
  it('flags later copies of the same content in a batch and keeps the first clean', () => {
    const out = markBatchDuplicates([analysed('a', { sha256: 'x'.repeat(64) }), analysed('b', { sha256: 'x'.repeat(64) }), analysed('c')]);
    expect(out[0].duplicates).toEqual([]);
    expect(out[1].duplicates).toEqual([{ kind: 'batch_exact', otherItemId: 'a' }]);
    expect(out[2].duplicates).toEqual([]);
    expect(markBatchDuplicates(out.filter((i) => i.id !== 'a'))[0].duplicates).toEqual([]); // removing the first frees the other
  });
  it('keeps invalid and unfinished items out of the upload batch and says why', () => {
    const invalid = { ...newItem('i', { name: 'i.mp4', size: 1 }, 'video/mp4'), analysis: 'invalid' as const, issues: [{ code: 'not_9_16', severity: 'error' as const, message: 'Video must be 9:16 aspect ratio. Detected 1920×1080.' }] };
    expect(isUploadable({ ...invalid, included: true })).toBe(false);
    expect(blockers(invalid)[0]).toContain('9:16');
    const failed = { ...analysed('f'), analysis: 'failed' as const };
    expect(blockers(failed).join(' ')).toContain('Retry');
    expect(blockers({ ...analysed('t'), edit: { ...analysed('t').edit!, tags: [] } })).toContain('At least one tag is required.');
    expect(isUploadable(analysed('ok'))).toBe(true);
    expect(isUploadable({ ...analysed('ok'), included: false })).toBe(false);
    expect(isUploadable({ ...analysed('ok'), upload: 'uploaded' })).toBe(false);
  });
  it('summarises the batch', () => {
    const items = [analysed('a'), analysed('b', { included: false, duplicates: [{ kind: 'library_exact', clipId: 3, title: 't' }] }), { ...newItem('c', { name: 'c.mp4', size: 1 }, null), analysis: 'analysing' as const }, analysed('d', {}, { category_id: null, privacy: [{ type: 'face', detail: 'x', severity: 'high' }] })];
    const s = summarise(items);
    expect(s).toMatchObject({ total: 4, analysed: 3, analysing: 1, duplicates: 1, selectedForUpload: 2, uncategorised: 1, withPrivacyWarnings: 1, analysisDone: false });
    expect(summarise(items.slice(0, 2)).analysisDone).toBe(true);
  });
});

describe('controlled concurrency', () => {
  it('never runs more than the limit at once, and a failing task does not stop the rest', async () => {
    let running = 0, peak = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; if (i === 3) throw new Error('boom'); return i; });
    const res = await runPool(tasks, 3);
    expect(peak).toBe(3);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(9);
    expect(res[3]).toMatchObject({ status: 'rejected' });
  });
});

describe('category proposals', () => {
  it('groups the same proposal across clips and ignores clips that already have a category', () => {
    const p = { category_id: null, proposed_category: { name: 'Fuel stations', parent_id: 8, reason: 'No refuelling category.' } };
    const items = [analysed('a', {}, p), analysed('b', {}, { ...p, proposed_category: { ...p.proposed_category, name: 'fuel stations ' } }), analysed('c', {}, { category_id: 22 }), analysed('d', {}, { category_id: null, proposed_category: { name: 'Gym', reason: 'x' } })];
    const g = groupProposals(items);
    expect(g.map((x) => [x.name, x.itemIds])).toEqual([['Fuel stations', ['a', 'b']], ['Gym', ['d']]]);
    const assigned = items.map((i) => (i.id === 'a' ? { ...i, edit: { ...i.edit!, categoryId: 50 } } : i));
    expect(groupProposals(assigned)[0].itemIds).toEqual(['b']);
  });
});

describe('the request sent for an approved clip', () => {
  it('carries the reviewer\'s final choices: existing category ids only, brands, tags and the checksum', () => {
    const it = analysed('a', { sha256: 'a'.repeat(64) }, { visible_text: ['SALE'], privacy: [{ type: 'face', detail: 'x', severity: 'medium' }] });
    const p = buildCompletePayload(it, 'u/broll/x.mp4');
    expect(p).toMatchObject({ storagePath: 'u/broll/x.mp4', title: 'Clip a', userTags: ['qr code'], activity: 'Eating', setting: 'Cafe', brand: 'Nike', categoryIds: [22], sha256: 'a'.repeat(64) });
    expect(p.brands).toEqual([{ name: 'Nike', role: 'hero' }]);
    expect(p.classification.flags).toEqual(['brand', 'text', 'person (face visible)']);
    expect(p.classification.review).toContain('approved by a reviewer');
    expect(buildCompletePayload({ ...it, edit: { ...it.edit!, categoryId: null } }, 'k').categoryIds).toEqual([]);
  });
  it('asks the server to allow a duplicate only when the reviewer explicitly chose "upload anyway"', () => {
    const it = analysed('a', { sha256: 'a'.repeat(64), duplicates: [{ kind: 'library_exact', clipId: 3, title: 't' }] });
    expect(buildCompletePayload(it, 'k').allowDuplicate).toBeUndefined();
    expect(buildCompletePayload({ ...it, duplicateOverride: true }, 'k').allowDuplicate).toBe(true);
  });
});

describe('uploading one approved clip: failures, retries and resuming', () => {
  const base = analysed('a');
  const mk = (o: Partial<UploadDeps> = {}) => {
    const calls: string[] = [];
    const deps: UploadDeps = {
      init: async () => { calls.push('init'); return { storagePath: `u/broll/${calls.length}.mp4`, uploadUrl: 'https://r2/x', headers: {} }; },
      put: async () => { calls.push('put'); },
      complete: async () => { calls.push('complete'); return { id: 7 }; },
      ...o,
    };
    return { deps, calls };
  };

  it('uploads, verifies and saves in order', async () => {
    const { deps, calls } = mk();
    const updates: Partial<BulkItem>[] = [];
    const r = await uploadApproved(base, 'video/mp4', 'a.mp4', deps, (p) => updates.push(p));
    expect(calls).toEqual(['init', 'put', 'complete']);
    expect(r).toMatchObject({ upload: 'uploaded', clipId: 7 });
    expect(updates.map((u) => u.upload).filter(Boolean)).toEqual(['uploading', 'verifying']);
  });
  it('a network failure during the upload leaves nothing saved, and a retry starts the upload again', async () => {
    const { deps, calls } = mk({ put: async () => { throw new Error('The upload was interrupted (network problem).'); } });
    const r = await uploadApproved(base, 'video/mp4', 'a.mp4', deps, () => {});
    expect(r).toMatchObject({ upload: 'failed', storagePath: null });
    expect(calls).not.toContain('complete');
    const retry = mk();
    expect((await uploadApproved({ ...base, ...r }, 'video/mp4', 'a.mp4', retry.deps, () => {})).upload).toBe('uploaded');
    expect(retry.calls).toEqual(['init', 'put', 'complete']);
  });
  it('when only the save fails, the retry skips the upload: a successful upload is never repeated', async () => {
    let fail = true;
    const first = mk({ complete: async () => { if (fail) throw Object.assign(new Error('Could not verify the upload.'), { status: 502 }); return { id: 9 }; } });
    const r1 = await uploadApproved(base, 'video/mp4', 'a.mp4', first.deps, () => {});
    expect(r1).toMatchObject({ upload: 'failed', storagePath: 'u/broll/1.mp4' }); // the file is remembered
    fail = false;
    const second: string[] = [];
    const r2 = await uploadApproved({ ...base, ...r1 }, 'video/mp4', 'a.mp4', { init: async () => { second.push('init'); throw new Error('must not be called'); }, put: async () => { second.push('put'); }, complete: first.deps.complete }, () => {});
    expect(second).toEqual([]);
    expect(r2).toMatchObject({ upload: 'uploaded', clipId: 9, storagePath: 'u/broll/1.mp4' });
  });
  it('a refused duplicate is reported with its reason code, and the next attempt uploads again (the server removed it)', async () => {
    const { deps } = mk({ complete: async () => { throw Object.assign(new Error('This file is identical to the existing clip “x”.'), { status: 409, code: 'duplicate' }); } });
    expect(await uploadApproved(base, 'video/mp4', 'a.mp4', deps, () => {})).toMatchObject({ upload: 'failed', uploadErrorCode: 'duplicate', storagePath: null });
  });
  it('a verification time-out keeps the uploaded file, so the retry only repeats the verification', async () => {
    const { deps } = mk({ complete: async () => { throw Object.assign(new Error('Verifying the file took too long.'), { status: 504, code: 'verification_timeout' }); } });
    const r = await uploadApproved(base, 'video/mp4', 'a.mp4', deps, () => {});
    expect(r).toMatchObject({ upload: 'failed', uploadErrorCode: 'verification_timeout' });
    expect(r.storagePath).toMatch(/^u\/broll\//);
  });
  it('re-uploads when the server cannot find the file (409) or the checksum differs (422)', async () => {
    for (const status of [409, 422]) {
      const { deps } = mk({ complete: async () => { throw Object.assign(new Error('x'), { status }); } });
      expect(await uploadApproved(base, 'video/mp4', 'a.mp4', deps, () => {})).toMatchObject({ upload: 'failed', storagePath: null });
    }
  });
});

describe('what may be kept in the browser (redactForStorage)', () => {
  const raw = {
    title: 'Holding two boarding passes', subject: 'Boarding passes', summary: 'Passenger J. Rao, flight 6E 204, seat 14A', description: 'Two boarding passes held at a gate.',
    subjects: ['J. Rao'], objects: ['boarding pass'], descriptors: ['indoor'], visible_text: ['J. RAO', '6E 204', 'PNR AB12CD'],
    category_id: 22, category_confidence: 'high', activity: 'Eating', setting: 'Cafe', brands: [{ name: 'Nike', role: 'hero', evidence: 'Swoosh on the passenger\'s bag' }],
    tags: ['qr code'], privacy: [{ type: 'travel_document', detail: 'Boarding pass for J. Rao on flight 6E 204 is legible.', severity: 'high' }], overall_confidence: 'high',
  };
  it('drops everything read out of the footage (text, names, evidence, privacy details) and keeps what would be saved anyway', () => {
    const s = sanitiseAnalysis(raw, tax);
    expect(s.visibleText).toEqual(['J. RAO', '6E 204', 'PNR AB12CD']);
    const kept = redactForStorage(s);
    const json = JSON.stringify(kept);
    for (const secret of ['J. RAO', 'J. Rao', '6E 204', 'PNR AB12CD', 'AB12CD', 'Swoosh', 'seat 14A']) expect(json).not.toContain(secret);
    expect(kept).toMatchObject({ title: 'Holding two boarding passes', description: 'Two boarding passes held at a gate.', categoryId: 22, activity: 'Eating', setting: 'Cafe', hasVisibleText: true });
    expect(kept.brands).toEqual([{ name: 'Nike', role: 'hero', existing: true, evidence: '' }]);
    expect(kept.tags).toEqual([{ tag: 'qr code', known: true }]);
  });
  it('still shows the privacy warning (type and severity) after a refresh, and still flags that text was present', () => {
    const kept = redactForStorage(sanitiseAnalysis(raw, tax));
    expect(kept.privacy).toHaveLength(1);
    expect(kept.privacy[0]).toMatchObject({ type: 'travel_document', severity: 'high' });
    expect(kept.privacy[0].detail).toContain('not kept');
    const it = { ...analysed('r'), suggestion: kept };
    expect(buildCompletePayload(it, 'k').classification.flags).toEqual(expect.arrayContaining(['text', 'privacy: travel document']));
  });
  it('is stable when applied to a suggestion that was already redacted', () => {
    const once = redactForStorage(sanitiseAnalysis(raw, tax));
    expect(redactForStorage(once)).toEqual(once);
  });
});

describe('privacy severity calibration', () => {
  const sev = (type: string, severity: unknown) => sanitiseAnalysis({ privacy: [{ type, detail: 'what is visible and why', severity }] }, tax).privacy[0].severity;

  it('always rates financial information, payment details and travel documents high, whatever the model said', () => {
    for (const type of ['financial_info', 'payment_details', 'travel_document']) for (const given of ['low', 'medium', 'high', undefined, 'extreme']) expect(sev(type, given)).toBe('high');
  });
  it('rates names, phone numbers, emails, addresses and receipts at least medium, and keeps a higher rating', () => {
    for (const type of ['name', 'phone', 'email', 'address', 'receipt']) { expect(sev(type, 'low')).toBe('medium'); expect(sev(type, 'medium')).toBe('medium'); expect(sev(type, 'high')).toBe('high'); }
  });
  it('leaves faces to the model\'s judgement: no floor, and nothing is ever lowered', () => {
    expect(SEVERITY_FLOOR.face).toBeUndefined();
    expect(['low', 'medium', 'high'].map((s) => sev('face', s))).toEqual(['low', 'medium', 'high']);
    for (const type of Object.keys(SEVERITY_FLOOR)) expect(['medium', 'high']).toContain(sev(type, 'high'));
  });
  it('keeps the model\'s explanation of the severity and does not add or remove warnings', () => {
    const s = sanitiseAnalysis({ privacy: [{ type: 'face', detail: 'Large, frontal and sharp, so identifiable.', severity: 'medium' }, { type: 'face', detail: 'Small and distant seated people.', severity: 'low' }] }, tax);
    expect(s.privacy.map((p) => [p.type, p.severity, p.detail])).toEqual([['face', 'medium', 'Large, frontal and sharp, so identifiable.'], ['face', 'low', 'Small and distant seated people.']]);
  });
});

describe('the analysis instructions', () => {
  const prompt = buildSystemPrompt(tax);
  it('separate a visible person, an identifiable person and legible sensitive information, with severity rules for each', () => {
    expect(prompt).toContain('PRIVACY:');
    expect(prompt).toMatch(/a person is visible; \(2\) a person is identifiable; \(3\) sensitive personal information is legible/);
    expect(prompt).toMatch(/identifiable face is the main subject/);
    expect(prompt).toMatch(/clearly identifiable/);
    expect(prompt).toMatch(/distant, small, blurred, turned away/);
    expect(prompt).toMatch(/merely in the background is not high by default/);
    expect(prompt).toMatch(/financial information.*high/);
    expect(prompt).toMatch(/travel or identity documents.*high/);
    expect(prompt).toMatch(/phone numbers, email addresses and addresses/);
    expect(prompt).toMatch(/ordinary signage/);
  });
  it('ask for the reason behind each severity, without repeating personal data, and forbid identifying anyone', () => {
    expect(prompt).toMatch(/"detail" must say what is visible and why it has that severity/);
    expect(prompt).toMatch(/without repeating any personal data/);
    expect(prompt).toMatch(/do not identify anyone/i);
  });
  it('tell the model to classify by the main subject, read categories through their parent, and propose rather than force', () => {
    expect(prompt).toContain('CHOOSING A CATEGORY:');
    expect(prompt).toMatch(/MAIN SUBJECT/);
    expect(prompt).toMatch(/never by a word that merely appears in a category name/);
    expect(prompt).toMatch(/together with its parent/);
    expect(prompt).toMatch(/Packaging, boxes, parcels, bags and carried purchases are not payment cards/);
    expect(prompt).toMatch(/Unboxing, shopping, carrying purchases and after-purchase footage belongs with the shopping and purchase categories/);
    expect(prompt).toMatch(/A broad parent category that is merely related to the subject.*is NOT a fit/);
    expect(prompt).toMatch(/return category_id null and propose a category separately/);
    expect(prompt).toMatch(/never invent an id/);
  });
  it('stay general: no mention of any particular brand, product, test clip or category in the guidance', () => {
    const guidance = prompt.slice(prompt.indexOf('CHOOSING A CATEGORY:'), prompt.indexOf('EXISTING CATEGORIES'));
    for (const word of ['Nike', 'shoe', 'sofa', 'fuel', 'IndiGo', 'Paytm', 'V6', 'N52']) expect(guidance).not.toContain(word);
  });
  it('still lists the approved taxonomy unchanged', () => {
    expect(prompt).toContain('22: Payments > Mobile payment');
    expect(prompt).toContain('"Payment "');
  });
});
