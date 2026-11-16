/** Small, pure helpers the Studio UI uses to read the API's data in the shape the supplied design shows it. */
import type { StudioAsset, StudioProject } from './client';
import { needsReview } from './import-info';

export const STEP_NAMES = ['Setup', 'Script', 'Selecting images', 'Generating', 'Ready to review'] as const;

/** The code shown on an image tile: its permanent import ID, or its number for an image added by hand. */
export const codeOf = (a: { importKey?: string | null; id: number }): string => a.importKey ?? `#${a.id}`;

/** The status chip of an image (design: Archived grey, Analysing purple, Needs review amber), or null for a ready image. */
export function chipOf(a: Pick<StudioAsset, 'archived' | 'analysisStatus' | 'importInfo'>): { text: string; bg: string; fg: string } | null {
  if (a.archived) return { text: 'Archived', bg: '#F3F4F6', fg: '#6B7280' };
  if (a.analysisStatus === 'pending' || a.analysisStatus === 'processing') return { text: 'Analysing', bg: '#EDE9FE', fg: '#6D28D9' };
  if (a.importInfo && needsReview(a.importInfo)) return { text: 'Needs review', bg: '#FEF3C7', fg: '#92400E' };
  return null;
}

export interface ProjectRowInfo { step: 0 | 1 | 2 | 3 | 4; key: 'prod' | 'attn' | 'saved'; pill: string; pillBg: string; pillFg: string; progress: string; pct: number; bar: string }

/** Where a project is, from its own counts: the Projects table's Progress and Status columns. */
export function projectInfo(p: StudioProject): ProjectRowInfo {
  const sel = p.selectionCount ?? 0, jobs = p.jobCount ?? 0, active = p.jobsActive ?? 0, outs = p.outputCount ?? 0, saved = p.outputsSaved ?? 0;
  const hasScript = p.script.trim().length > 0;
  const step = (!p.hasCharacter ? 0 : !hasScript || (p.recommendations.length === 0 && (p.approvedPackCount ?? 0) === 0 && sel === 0) ? 1 : jobs === 0 ? 2 : active > 0 ? 3 : 4) as 0 | 1 | 2 | 3 | 4;
  const done = step === 4 && outs > 0 && saved === outs;
  const progress = done || step === 4 ? `${saved} of ${outs} approved` : ['Not started', 'Script pending', `${sel} selected`, `Generating ${jobs}`][step];
  const pct = done ? 100 : step === 4 ? (outs ? Math.round((saved / outs) * 100) : 90) : [0, 15, 40, 70][step];
  const key = done ? 'saved' : step === 2 ? 'attn' : 'prod';
  if (done) return { step, key, pill: 'Saved', pillBg: '#EFEBFF', pillFg: '#6C47FF', progress, pct, bar: '#6C47FF' };
  return { step, key, pill: STEP_NAMES[step], pillBg: step === 4 ? '#6C47FF' : step === 2 ? '#F0F0EC' : '#EFEFEC', pillFg: step === 4 ? '#fff' : step === 2 ? '#111113' : '#5E5E65', progress, pct, bar: '#111113' };
}

export const initialsOf = (email: string | null | undefined): string => {
  if (!email) return '?';
  const parts = email.split('@')[0].split(/[._-]/);
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : email.slice(0, 2).toUpperCase();
};
