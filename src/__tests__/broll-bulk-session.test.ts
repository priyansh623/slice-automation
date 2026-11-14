import { describe, expect, it } from 'vitest';
import { sanitiseAnalysis } from '@/lib/broll-bulk/analysis-schema';
import { initialEdit, isUploadable, newItem, summarise, type BulkItem } from '@/lib/broll-bulk/batch';
import { applyEntry, findEntry, hasUnfinishedWork, mergeForSave, missingEntries, readSession, revalidateEdit, SESSION_TTL_MS, snapshotItems, summariseSession, type Session } from '@/lib/broll-bulk/session';
import { withPaths, type Taxonomy } from '@/lib/broll-bulk/taxonomy';

const tax: Taxonomy = {
  categories: withPaths([{ id: 1, name: 'Payments', parentId: null, scope: 'soma', brandScope: null }, { id: 22, name: 'Mobile payment', parentId: 1, scope: 'soma', brandScope: null }]),
  activities: ['Payment ', 'Eating'], settings: ['Cafe'], brands: ['Paytm'], tags: [{ tag: 'qr code', count: 2 }],
};
const sha = (c: string) => c.repeat(64).slice(0, 64);

function analysed(id: string, over: Partial<BulkItem> = {}, sug: Record<string, unknown> = {}): BulkItem {
  const s = sanitiseAnalysis({ title: `Clip ${id}`, description: 'A phone scans a QR code.', category_id: 22, category_confidence: 'high', activity: 'Payment', setting: 'Cafe', brands: [{ name: 'Paytm', role: 'hero', evidence: 'logo' }], tags: ['qr code'], visible_text: ['PASSENGER J RAO'], privacy: [{ type: 'name', detail: 'Name J RAO visible', severity: 'high' }], summary: 'Passenger J RAO at gate 4', overall_confidence: 'high', ...sug }, tax);
  return { ...newItem(id, { name: `${id}.mp4`, size: 1000 }, 'video/mp4'), analysis: 'analysed', suggestion: s, edit: initialEdit(s, `${id}.mp4`), included: true, sha256: sha(id), thumbnail: 'data:image/jpeg;base64,THUMB', ...over };
}

describe('what is saved', () => {
  it('keeps the work, and never the video, frames, thumbnail, on-screen text, summary or privacy details', () => {
    const snap = snapshotItems([analysed('a')], 1000);
    const json = JSON.stringify(snap);
    for (const secret of ['J RAO', 'PASSENGER', 'THUMB', 'logo']) expect(json).not.toContain(secret);
    expect(json).not.toMatch(/"frames"|"thumbnail"|"blob"|data:image|base64/i);
    expect(snap.entries[0]).toMatchObject({ sha256: sha('a'), fileName: 'a.mp4', stage: 'analysed', included: true });
    expect(snap.entries[0].edit).toMatchObject({ title: 'Clip a', categoryId: 22, activity: 'Payment ', setting: 'Cafe', tags: ['qr code'] });
    expect(snap.entries[0].suggestion.privacy[0]).toMatchObject({ type: 'name', severity: 'high' });   // the warning survives, its details do not
  });
  it('saves only analysed videos whose checksum is known (the only ones that can be matched again)', () => {
    const items = [analysed('a'), analysed('nosha', { sha256: null }), { ...newItem('p', { name: 'p.mp4', size: 1 }, null), analysis: 'analysing' as const }, { ...analysed('bad'), analysis: 'invalid' as const }];
    expect(snapshotItems(items).entries.map((e) => e.fileName)).toEqual(['a.mp4']);
  });
  it('records how far each video got, and an upload that reached storage but was not saved', () => {
    const snap = snapshotItems([analysed('a'), analysed('b', { reviewed: true }), analysed('c', { upload: 'uploaded', clipId: 9 }), analysed('d', { storagePath: 'u/broll/x.mp4', upload: 'failed' })]);
    expect(snap.entries.map((e) => [e.fileName, e.stage])).toEqual([['a.mp4', 'analysed'], ['b.mp4', 'reviewed'], ['c.mp4', 'uploaded'], ['d.mp4', 'upload_incomplete']]);
    expect(snap.entries[2]).toMatchObject({ clipId: 9, storagePath: null });
    expect(snap.entries[3].storagePath).toBe('u/broll/x.mp4');
  });
  it('never records an approval: an upload in progress is saved as not uploaded', () => {
    const e = snapshotItems([analysed('a', { upload: 'uploading', uploadProgress: 0.5 })]).entries[0];
    expect(Object.keys(e)).not.toContain('upload');
    expect(JSON.stringify(e)).not.toMatch(/approved|uploading|queued/);
  });
});

describe('reading a saved session back', () => {
  const good = snapshotItems([analysed('a'), analysed('b')], 1_000_000);
  it('accepts a fresh session and drops expired or malformed entries without throwing', () => {
    expect(readSession(good, 1_000_000 + 1000)!.entries).toHaveLength(2);
    expect(readSession(good, 1_000_000 + SESSION_TTL_MS + 1)).toBeNull();                      // expired: nothing left
    const mixed: Session = { ...good, entries: [good.entries[0], { ...good.entries[1], savedAt: 1_000_000 - SESSION_TTL_MS - 1 }] };
    expect(readSession(mixed, 1_000_000 + 1000)!.entries.map((e) => e.fileName)).toEqual(['a.mp4']);
    for (const junk of [null, undefined, 'x', 5, {}, { version: 99, entries: [] }, { version: 1, entries: 'no' }, { version: 1, entries: [{}] }, { version: 1, entries: [null] }]) expect(readSession(junk, 1000)).toBeNull();
    expect(readSession({ ...good, entries: [{ ...good.entries[0], sha256: 'not-a-sha' }] }, 1_000_000 + 1000)).toBeNull();
  });
  it('can tell when there is unfinished work worth returning for', () => {
    expect(hasUnfinishedWork(null)).toBe(false);
    expect(hasUnfinishedWork(snapshotItems([analysed('a', { upload: 'uploaded', clipId: 1 })]))).toBe(false);
    expect(hasUnfinishedWork(snapshotItems([analysed('a'), analysed('b', { upload: 'uploaded', clipId: 1 })]))).toBe(true);
  });
});

describe('restoring after the files are selected again', () => {
  const session = snapshotItems([
    analysed('a', { reviewed: true, edit: { ...analysed('a').edit!, title: 'My corrected name', tags: ['qr code', 'custom tag'], activity: 'Eating' } }),
    analysed('b', { upload: 'uploaded', clipId: 42 }),
    analysed('c', { storagePath: 'u/broll/c.mp4', upload: 'failed', included: true }),
  ], 5000);

  it('matches by content (SHA-256), not by file name', () => {
    expect(findEntry(session, sha('a'))!.fileName).toBe('a.mp4');
    expect(findEntry(session, sha('zzz'))).toBeNull();
    expect(findEntry(session, null)).toBeNull();
    expect(findEntry(null, sha('a'))).toBeNull();
  });
  it('brings back the reviewer\'s edits, marks the item restored and reviewed, and uploads NOTHING', () => {
    const fresh = { ...newItem('x', { name: 'renamed-copy.mp4', size: 1000 }, 'video/mp4'), sha256: sha('a'), thumbnail: 'data:image/jpeg;base64,NEW', analysis: 'preparing' as const };
    const out = applyEntry(fresh, findEntry(session, sha('a'))!, tax);
    expect(out).toMatchObject({ analysis: 'analysed', restored: true, reviewed: true, upload: 'none', clipId: null, selected: false, thumbnail: 'data:image/jpeg;base64,NEW', fileName: 'renamed-copy.mp4' });
    expect(out.edit).toMatchObject({ title: 'My corrected name', activity: 'Eating', tags: ['qr code', 'custom tag'] });
    expect(out.suggestion!.privacy[0].detail).toContain('not kept');
  });
  it('a restored batch is not approved: the item is only uploadable after an explicit approval step, and summaries show nothing uploaded', () => {
    const restored = ['a', 'c'].map((id) => applyEntry({ ...newItem(id, { name: `${id}.mp4`, size: 1 }, 'video/mp4'), sha256: sha(id) }, findEntry(session, sha(id))!, tax));
    expect(summarise(restored)).toMatchObject({ uploaded: 0, uploadingNow: 0, uploadFailed: 0 });
    expect(restored.every((i) => i.upload === 'none')).toBe(true);
    // Uploading is only ever started by the page's approval button (startUpload); recovery produces no upload state at all.
    expect(restored.map((i) => i.upload)).toEqual(['none', 'none']);
  });
  it('an already-uploaded video comes back as uploaded and is left out of the batch, so it cannot be uploaded twice', () => {
    const out = applyEntry({ ...newItem('b', { name: 'b.mp4', size: 1 }, 'video/mp4'), sha256: sha('b') }, findEntry(session, sha('b'))!, tax);
    expect(out).toMatchObject({ upload: 'uploaded', clipId: 42, included: false });
    expect(isUploadable(out)).toBe(false);
  });
  it('an upload that reached storage but was not saved keeps its storage path, so approving later only repeats the save', () => {
    const out = applyEntry({ ...newItem('c', { name: 'c.mp4', size: 1 }, 'video/mp4'), sha256: sha('c') }, findEntry(session, sha('c'))!, tax);
    expect(out).toMatchObject({ upload: 'none', storagePath: 'u/broll/c.mp4', clipId: null });
  });
  it('re-checks saved values against today\'s taxonomy: anything that no longer exists is cleared, never trusted', () => {
    const e = revalidateEdit({ title: 'T', subject: '', categoryId: 999, activity: 'Sprinting', setting: 'Moon', brands: [{ name: 'PAYTM', role: 'hero' }, { name: '', role: 'hero' }, { name: 'New', role: 'boss' as never }], tags: ['QR  Code', '#x', 5 as never], description: 'd' }, tax);
    expect(e).toMatchObject({ categoryId: null, activity: null, setting: null, tags: ['qr code'] });
    expect(e.brands).toEqual([{ name: 'Paytm', role: 'hero' }, { name: 'New', role: 'unresolved' }]);
  });
});

describe('files that were not selected again, and keeping the saved work', () => {
  const session = snapshotItems([analysed('a'), analysed('b'), analysed('c')], 5000);
  it('lists saved videos whose file has not been selected yet', () => {
    expect(missingEntries(session, [analysed('a')]).map((e) => e.fileName)).toEqual(['b.mp4', 'c.mp4']);
    expect(missingEntries(session, [])).toHaveLength(3);
    expect(missingEntries(null, [])).toEqual([]);
  });
  it('summarises how far the earlier visit got, for the banner', () => {
    const s = snapshotItems([analysed('a'), analysed('b', { reviewed: true }), analysed('c', { upload: 'uploaded', clipId: 1 }), analysed('d', { storagePath: 'k' })]);
    expect(summariseSession(s)).toEqual({ total: 4, analysed: 1, reviewed: 1, uploaded: 1, incomplete: 1 });
  });
  it('selecting files one at a time never loses the rest of the saved work, and old entries still expire on their own schedule', () => {
    const now = 5000 + 1000;
    const merged = mergeForSave(snapshotItems([analysed('a')], now), session, now);
    expect(merged.entries.map((e) => e.fileName).sort()).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
    expect(merged.entries.find((e) => e.fileName === 'b.mp4')!.savedAt).toBe(5000);               // keeps its original age
    const later = 5000 + SESSION_TTL_MS + 10;
    expect(mergeForSave(snapshotItems([analysed('a')], later), session, later).entries.map((e) => e.fileName)).toEqual(['a.mp4']);
  });
});
