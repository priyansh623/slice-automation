/**
 * Compilation version history, shared by the API and the pages.
 *
 * Every successful compilation of a project is kept as its own numbered version (1, 2, 3, ...). Version numbers are
 * stored on completed compilations only, so failed attempts never use one up. The CURRENT compilation is, by
 * definition, the completed compilation with the highest version: it is derived here, never stored.
 */

export type CompilationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface CompilationRowLike {
  id: number;
  status: string;
  version: number | null;
  createdAt: number;
}

export type WithVersionInfo<T> = T & {
  /** Version number of a successful compilation; null for pending, processing and failed ones. */
  version: number | null;
  /** True for exactly one completed compilation per project: the newest successful one. */
  isCurrent: boolean;
};

const newestFirst = (a: CompilationRowLike, b: CompilationRowLike) => b.createdAt - a.createdAt || b.id - a.id;
const oldestFirst = (a: CompilationRowLike, b: CompilationRowLike) => a.createdAt - b.createdAt || a.id - b.id;

/**
 * Adds `version` and `isCurrent` to one project's compilations and returns them newest first.
 * A completed row without a stored version (only possible in the moments between running the migration and the worker
 * restarting on the new code) is numbered by creation order, which is how the migration numbers existing rows.
 */
export function annotateVersions<T extends CompilationRowLike>(rows: readonly T[]): WithVersionInfo<T>[] {
  const completed = rows.filter((r) => r.status === 'completed');
  const derived = new Map<number, number>();
  [...completed].sort(oldestFirst).forEach((r, i) => derived.set(r.id, i + 1));

  const versionOf = (r: T): number | null => (r.status === 'completed' ? (r.version ?? derived.get(r.id) ?? null) : null);

  let current: T | null = null;
  for (const r of completed) {
    if (!current) { current = r; continue; }
    const a = versionOf(r)!;
    const b = versionOf(current)!;
    if (a > b || (a === b && newestFirst(r, current) < 0)) current = r;
  }

  return [...rows].sort(newestFirst).map((r) => ({ ...r, version: versionOf(r), isCurrent: current !== null && r.id === current.id }));
}

export interface CompilationView<T> {
  /** Successful compilations, newest version first. */
  versions: WithVersionInfo<T>[];
  /** The newest successful compilation, or null if none has succeeded yet. */
  current: WithVersionInfo<T> | null;
  /** A compilation that is waiting or running, if any. At most one can exist per project. */
  active: WithVersionInfo<T> | null;
  /** The newest failed attempt, only when nothing newer has succeeded or is running; otherwise null. */
  lastFailed: WithVersionInfo<T> | null;
  /** The version number the next successful compilation will get. */
  nextVersion: number;
}

export function compilationView<T extends CompilationRowLike>(rows: readonly T[]): CompilationView<T> {
  const all = annotateVersions(rows); // newest first
  const versions = all.filter((r) => r.status === 'completed').sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  const current = versions.find((r) => r.isCurrent) ?? null;
  const active = all.find((r) => r.status === 'pending' || r.status === 'processing') ?? null;
  const newestFailed = all.find((r) => r.status === 'failed') ?? null;
  const failedIsLatest = newestFailed !== null && !active && (!current || newestFailed.createdAt > current.createdAt || (newestFailed.createdAt === current.createdAt && newestFailed.id > current.id));
  return {
    versions,
    current,
    active,
    lastFailed: failedIsLatest ? newestFailed : null,
    nextVersion: Math.max(0, ...versions.map((v) => v.version ?? 0)) + 1,
  };
}

export const MIN_COMPILATION_CLIPS = 2;
export const MAX_COMPILATION_CLIPS = 10;

export interface ActiveCompilationText {
  /** True while the job has not been picked up by the worker yet (status 'pending'). */
  queued: boolean;
  headline: string;
  detail: string;
}

/**
 * What to tell the user about a compilation that is waiting or running. A queued job is only waiting for the worker and
 * must not be described as already being made; a processing job is being made now. The last successful version, if there
 * is one, stays available and is mentioned in both cases.
 */
export function describeActiveCompilation(status: string, nextVersion: number, currentVersion: number | null): ActiveCompilationText {
  const stays = currentVersion !== null ? ` Version ${currentVersion} stays available meanwhile.` : '';
  if (status === 'pending') {
    return {
      queued: true,
      headline: `Version ${nextVersion} is queued`,
      detail: `Waiting for the worker to pick it up. This is usually quick, but it can take longer while other videos are being generated. You can leave this page; it will start on its own.${stays}`,
    };
  }
  return {
    queued: false,
    headline: `Compiling version ${nextVersion}`,
    detail: `Joining your scenes into one video. This can take a few minutes. You can leave this page; it keeps going.${stays}`,
  };
}
