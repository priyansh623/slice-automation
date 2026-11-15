import { describe, it, expect } from 'vitest';
import {
  sanitiseAiMetadata, parseManualPatch, applyManualPatch, effectiveMetadata, MAX_TAGS, MAX_TAG_CHARS, MAX_TEXT_CHARS,
} from '@/lib/studio/metadata';
import {
  checkImageInit, newAssetKey, isStudioAssetKey, assetThumbKey, newCharacterKey, isStudioCharacterKey, characterThumbKey,
  outputKey, outputThumbKey, verifyStoredImage, STUDIO_IMAGE_MAX_BYTES,
} from '@/lib/studio/keys';

describe('metadata: AI output is sanitised', () => {
  it('keeps only known fields, trims, bounds and de-duplicates tags', () => {
    const m = sanitiseAiMetadata({
      environment: '  a   sunny\n kitchen ', activity: 'x'.repeat(5000), lighting: 42, gender: 'female', age: '30',
      tags: ['Kitchen', 'kitchen', ' Morning ', 'y'.repeat(200), ...Array.from({ length: 80 }, (_, i) => `t${i}`)],
    });
    expect(m.environment).toBe('a sunny kitchen');
    expect((m.activity as string).length).toBe(MAX_TEXT_CHARS);
    expect(m.lighting).toBeUndefined();
    expect(Object.keys(m)).not.toContain('gender');
    expect(Object.keys(m)).not.toContain('age');
    const tags = m.tags as string[];
    expect(tags.length).toBeLessThanOrEqual(MAX_TAGS);
    expect(tags.slice(0, 2)).toEqual(['kitchen', 'morning']);
    expect(tags.every((t) => t.length <= MAX_TAG_CHARS)).toBe(true);
  });
  it('returns nothing for junk', () => {
    expect(sanitiseAiMetadata(null)).toEqual({});
    expect(sanitiseAiMetadata('text')).toEqual({});
  });
});

describe('metadata: manual precedence and provenance', () => {
  const ai = { environment: 'kitchen', activity: 'cooking', description: 'A person cooks.', tags: ['food'] };

  it('uses the AI value until a person edits, and says where each value came from', () => {
    const e = effectiveMetadata(ai, {});
    expect(e.values.environment).toBe('kitchen');
    expect(e.provenance.environment).toBe('ai');
    expect(e.provenance.lighting).toBe('none');
    expect(e.hasManualEdits).toBe(false);
  });

  it('a manual value wins over the AI value, and a deliberate clear wins too', () => {
    const p1 = parseManualPatch({ fields: { environment: 'Living room', activity: null } });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const manual = applyManualPatch({}, p1.patch);
    const e = effectiveMetadata(ai, manual);
    expect(e.values.environment).toBe('Living room');
    expect(e.provenance.environment).toBe('manual');
    expect(e.values.activity).toBeNull(); // cleared on purpose, not "falls back to the AI value"
    expect(e.provenance.activity).toBe('manual');
    expect(e.values.description).toBe('A person cooks.');
    expect(e.provenance.description).toBe('ai');
    expect(e.hasManualEdits).toBe(true);
  });

  it('re-analysis (a new ai object) never changes a manually edited field', () => {
    const manual = { environment: 'Living room', tags: ['custom'] };
    const reanalysed = { environment: 'office', activity: 'typing', tags: ['work'] };
    const e = effectiveMetadata(reanalysed, manual);
    expect(e.values.environment).toBe('Living room');
    expect(e.values.tags).toEqual(['custom']);
    expect(e.values.activity).toBe('typing'); // not edited: follows the new AI value
  });

  it('reverting a field gives it back to the AI value; the patch does not mutate its input', () => {
    const manual = { environment: 'Living room' };
    const p = parseManualPatch({ revert: ['environment'] });
    if (!p.ok) throw new Error('patch');
    const next = applyManualPatch(manual, p.patch);
    expect(manual).toEqual({ environment: 'Living room' });
    expect(effectiveMetadata(ai, next).provenance.environment).toBe('ai');
  });

  it('rejects unknown fields, bad types, empty edits and edit-plus-revert of the same field', () => {
    expect(parseManualPatch({ fields: { gender: 'x' } }).ok).toBe(false);
    expect(parseManualPatch({ fields: { environment: 5 } }).ok).toBe(false);
    expect(parseManualPatch({ fields: { tags: 'a,b' } }).ok).toBe(false);
    expect(parseManualPatch({}).ok).toBe(false);
    expect(parseManualPatch({ revert: ['nope'] }).ok).toBe(false);
    expect(parseManualPatch({ fields: { environment: 'x' }, revert: ['environment'] }).ok).toBe(false);
    expect(parseManualPatch(null).ok).toBe(false);
  });
});

describe('keys', () => {
  it('builds server-chosen keys and recognises only its own', () => {
    const k = newAssetKey('png');
    expect(isStudioAssetKey(k)).toBe(true);
    expect(assetThumbKey(k)).toMatch(/^studio\/assets\/thumbs\/[0-9a-f-]{36}\.webp$/);
    expect(isStudioAssetKey('studio/assets/../x.png')).toBe(false);
    expect(isStudioAssetKey('other/assets/' + k.slice(14))).toBe(false);
    expect(assetThumbKey('x/y.png')).toBeNull();
    const c = newCharacterKey(7, 'jpg');
    expect(isStudioCharacterKey(7, c)).toBe(true);
    expect(isStudioCharacterKey(8, c)).toBe(false); // another project's folder
    expect(characterThumbKey(c)).toMatch(/^studio\/projects\/7\/character\/thumbs\/[0-9a-f-]{36}\.webp$/);
    expect(outputKey(7, 12, 2, 'png')).toBe('studio/projects/7/outputs/12-a2.png');
    expect(outputThumbKey(7, 12, 2)).toBe('studio/projects/7/outputs/thumbs/12-a2.webp');
  });

  it('checks an upload request', () => {
    expect(checkImageInit({ contentType: 'image/png', fileSize: 1000, fileName: 'a.png' })).toMatchObject({ ok: true, ext: 'png' });
    expect(checkImageInit({ contentType: 'image/gif', fileSize: 1000 })).toMatchObject({ ok: false, status: 415 });
    expect(checkImageInit({ contentType: 'image/png', fileSize: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(checkImageInit({ contentType: 'image/png', fileSize: STUDIO_IMAGE_MAX_BYTES + 1 })).toMatchObject({ ok: false, status: 413 });
    expect(checkImageInit({ contentType: 'image/png', fileSize: 10, fileName: 'a.exe' })).toMatchObject({ ok: false, status: 415 });
  });

  it('verifies what storage really holds', () => {
    const want = { size: 100, contentType: 'image/png' };
    expect(verifyStoredImage(null, want)).toMatchObject({ ok: false, status: 409 });
    expect(verifyStoredImage({ size: 0, contentType: 'image/png' }, want)).toMatchObject({ ok: false, status: 422 });
    expect(verifyStoredImage({ size: 99, contentType: 'image/png' }, want)).toMatchObject({ ok: false, status: 422 });
    expect(verifyStoredImage({ size: 100, contentType: 'image/jpeg' }, want)).toMatchObject({ ok: false, status: 422 });
    expect(verifyStoredImage({ size: 100, contentType: 'image/png' }, want)).toMatchObject({ ok: true });
  });
});
