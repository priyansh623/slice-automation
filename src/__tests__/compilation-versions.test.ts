import { describe, it, expect } from 'vitest';
import { annotateVersions, compilationView } from '@/lib/compilation-versions';

const row = (id: number, status: string, version: number | null, createdAt: number) => ({ id, status, version, createdAt });

describe('annotateVersions', () => {
  it('returns newest first and marks exactly the newest successful compilation as current', () => {
    const out = annotateVersions([row(1, 'completed', 1, 100), row(2, 'completed', 2, 200), row(3, 'completed', 3, 300)]);
    expect(out.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(out.filter((r) => r.isCurrent).map((r) => r.id)).toEqual([3]);
  });

  it('a failed or running compilation never becomes current and has no version', () => {
    const out = annotateVersions([row(1, 'completed', 1, 100), row(2, 'failed', null, 200), row(3, 'processing', null, 300)]);
    expect(out.find((r) => r.id === 1)).toMatchObject({ version: 1, isCurrent: true });
    expect(out.find((r) => r.id === 2)).toMatchObject({ version: null, isCurrent: false });
    expect(out.find((r) => r.id === 3)).toMatchObject({ version: null, isCurrent: false });
  });

  it('a newer failure does not replace an older success as current', () => {
    const out = annotateVersions([row(5, 'completed', 2, 500), row(6, 'failed', null, 600)]);
    expect(out.find((r) => r.isCurrent)?.id).toBe(5);
  });

  it('numbers completed rows that have no stored version by creation order', () => {
    const out = annotateVersions([row(10, 'completed', null, 100), row(11, 'completed', null, 200)]);
    expect(out.map((r) => [r.id, r.version, r.isCurrent])).toEqual([[11, 2, true], [10, 1, false]]);
  });

  it('has no current compilation when none has succeeded', () => {
    expect(annotateVersions([row(1, 'failed', null, 1), row(2, 'pending', null, 2)]).some((r) => r.isCurrent)).toBe(false);
  });
});

describe('compilationView', () => {
  it('lists versions newest first and says what the next version number will be', () => {
    const v = compilationView([row(1, 'completed', 1, 1), row(2, 'failed', null, 2), row(3, 'completed', 2, 3)]);
    expect(v.versions.map((x) => x.version)).toEqual([2, 1]);
    expect(v.current?.id).toBe(3);
    expect(v.nextVersion).toBe(3); // the failed attempt did not use up a number
    expect(v.active).toBeNull();
  });

  it('reports a running compilation, so a page reopened mid-compile resumes showing it', () => {
    const v = compilationView([row(1, 'completed', 1, 1), row(2, 'pending', null, 2)]);
    expect(v.active?.id).toBe(2);
    expect(v.current?.id).toBe(1);
    expect(v.lastFailed).toBeNull();
  });

  it('shows the latest failure only while nothing newer has succeeded or is running', () => {
    expect(compilationView([row(1, 'completed', 1, 1), row(2, 'failed', null, 2)]).lastFailed?.id).toBe(2);
    expect(compilationView([row(1, 'failed', null, 1), row(2, 'completed', 1, 2)]).lastFailed).toBeNull();
    expect(compilationView([row(1, 'failed', null, 1), row(2, 'processing', null, 2)]).lastFailed).toBeNull();
  });

  it('starts at version 1 for a project that has never been compiled', () => {
    const v = compilationView([]);
    expect(v).toMatchObject({ current: null, active: null, lastFailed: null, nextVersion: 1 });
  });
});

import { describeActiveCompilation } from '@/lib/compilation-versions';

describe('describeActiveCompilation', () => {
  it('describes a pending job as queued and waiting for the worker, not as being made', () => {
    const t = describeActiveCompilation('pending', 3, 2);
    expect(t.queued).toBe(true);
    expect(t.headline).toBe('Version 3 is queued');
    expect(t.detail).toMatch(/waiting for the worker/i);
    expect(t.headline + t.detail).not.toMatch(/compiling|processing/i);
    expect(t.detail).toMatch(/Version 2 stays available/);
  });

  it('describes a processing job as being made now', () => {
    const t = describeActiveCompilation('processing', 3, 2);
    expect(t.queued).toBe(false);
    expect(t.headline).toBe('Compiling version 3');
    expect(t.detail).not.toMatch(/waiting for the worker/i);
    expect(t.detail).toMatch(/Version 2 stays available/);
  });

  it('says nothing about an earlier version when there is none', () => {
    expect(describeActiveCompilation('pending', 1, null).detail).not.toMatch(/stays available/);
    expect(describeActiveCompilation('processing', 1, null).detail).not.toMatch(/stays available/);
  });
});

describe('the last successful version stays reviewable while a newer compilation is not finished', () => {
  const finished = [row(1, 'completed', 1, 100), row(2, 'completed', 2, 200)];
  for (const status of ['pending', 'processing', 'failed']) {
    it(`while a newer compilation is ${status}: Version 2 is still current, and both versions are still listed for play and download`, () => {
      const v = compilationView([...finished, row(3, status, null, 300)]);
      expect(v.current).toMatchObject({ id: 2, version: 2, isCurrent: true });
      expect(v.versions.map((x) => x.version)).toEqual([2, 1]);
      expect(v.nextVersion).toBe(3);
      if (status === 'failed') expect(v.lastFailed?.id).toBe(3);
      else expect(v.active?.id).toBe(3);
    });
  }
});
