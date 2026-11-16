/** The pure helpers behind the Studio screens: what the Projects table shows, and the chip and code on an image tile. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chipOf, codeOf, initialsOf, projectInfo } from '@/lib/studio/ui';
import type { StudioProject } from '@/lib/studio/client';

const project = (over: Partial<StudioProject> = {}): StudioProject => ({
  id: 1, name: 'P', script: '', createdBy: 'u', archived: false, createdAt: 1, updatedAt: 1, hasCharacter: false, characterUrl: null, characterThumbUrl: null,
  analysis: { status: 'idle', error: null, at: null, current: false }, recommendations: [], approvedPackCount: 0, selectionCount: 0, jobCount: 0, jobsSucceeded: 0, jobsActive: 0, outputCount: 0, outputsSaved: 0, ...over,
});

describe('the Projects table', () => {
  it('shows where each project is', () => {
    expect(projectInfo(project())).toMatchObject({ step: 0, pill: 'Setup', progress: 'Not started', pct: 0 });
    expect(projectInfo(project({ hasCharacter: true }))).toMatchObject({ step: 1, pill: 'Script' });
    expect(projectInfo(project({ hasCharacter: true, script: 'x', selectionCount: 3 }))).toMatchObject({ step: 2, pill: 'Selecting images', progress: '3 selected', key: 'attn' });
    expect(projectInfo(project({ hasCharacter: true, script: 'x', selectionCount: 3, jobCount: 3, jobsActive: 2 }))).toMatchObject({ step: 3, pill: 'Generating', progress: 'Generating 3' });
    expect(projectInfo(project({ hasCharacter: true, script: 'x', selectionCount: 3, jobCount: 3, outputCount: 3, outputsSaved: 1 }))).toMatchObject({ step: 4, pill: 'Ready to review', progress: '1 of 3 approved', pct: 33 });
    expect(projectInfo(project({ hasCharacter: true, script: 'x', selectionCount: 3, jobCount: 3, outputCount: 3, outputsSaved: 3 }))).toMatchObject({ pill: 'Saved', key: 'saved', pct: 100 });
  });
  it('initials come from the owner email', () => { expect(initialsOf('ana.ruiz@x.com')).toBe('AR'); expect(initialsOf('leo@x.com')).toBe('LE'); expect(initialsOf(null)).toBe('?'); });
});

describe('an image tile', () => {
  const base = { archived: false, analysisStatus: 'completed' as const, importInfo: null };
  it('shows its permanent ID, or its number for an image added by hand', () => { expect(codeOf({ id: 9, importKey: 'IMG-011' })).toBe('IMG-011'); expect(codeOf({ id: 9, importKey: null })).toBe('#9'); });
  it('chips: Archived, Analysing, Needs review, or nothing', () => {
    expect(chipOf({ ...base, archived: true })?.text).toBe('Archived');
    expect(chipOf({ ...base, analysisStatus: 'processing' })?.text).toBe('Analysing');
    expect(chipOf({ ...base, analysisStatus: 'pending' })?.text).toBe('Analysing');
    expect(chipOf(base)).toBeNull();
    expect(chipOf({ ...base, analysisStatus: 'skipped' })).toBeNull(); // an imported image is "Not analysed", not "Analysing"
  });
});

describe('the Studio screens keep what the design does not show', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
  it('the Delete dialog says what really happens (archive), not "deleted"', () => {
    const t = read('src/components/studio/ProjectsList.tsx');
    expect(t).toMatch(/Archive project\?/); expect(t).toMatch(/Nothing is permanently deleted/); expect(t).not.toMatch(/cannot be undone/);
  });
  it('the Repository keeps edit, archive and restore pack, all metadata fields, import details and re-analysis', () => {
    const t = read('src/components/studio/RepositoryView.tsx');
    for (const k of ['Edit pack', 'Restore pack', 'Archive pack', 'camera_angle', 'character_position', 'composition', '<ImportPanel', 'Re-analyse', 'Use AI value']) expect(t, k).toContain(k);
  });
  it('a retry note is never sent, and the screen says so; the library option is marked unavailable', () => {
    const t = read('src/components/studio/ProjectFlow.tsx');
    expect(t).toMatch(/The note is not sent to the provider yet/); expect(t).not.toMatch(/\{ note \}|note \? \{ note/);
    expect(t).toMatch(/Not available yet/);
  });
});
