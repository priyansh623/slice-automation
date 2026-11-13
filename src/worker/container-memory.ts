/**
 * Read-only measurement of the worker container's memory, from the Linux cgroup files the kernel exposes.
 *
 * Why: the Render worker has a hard 512 MB limit, and Render's own metrics are sampled every 30 seconds, which is too
 * coarse to see the peak of a short FFmpeg compilation. The kernel keeps an exact high-water mark of the whole container
 * (the worker process plus every child such as FFmpeg); that is the number the out-of-memory killer compares with the limit.
 *
 * This module only reads and formats. It never writes anything, never throws into the caller, and nothing in the worker
 * depends on its result: where the files do not exist (macOS, a different kernel) it simply reports "unavailable".
 */
import * as fs from 'node:fs';

const MIB = 1024 * 1024;

export interface MemorySnapshot {
  source: 'cgroup-v2' | 'cgroup-v1';
  /** Memory in use by the container right now. */
  currentBytes: number | null;
  /** The container's high-water mark since it started (kernel 5.19+ for v2). null when the kernel does not report it. */
  peakBytes: number | null;
  /** The container's limit. null means no limit is set. */
  limitBytes: number | null;
  /** How many times the kernel has killed a process in this container for lack of memory. */
  oomKills: number | null;
}

export type FileReader = (path: string) => string | null;

const defaultReader: FileReader = (p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
};

const toNumber = (text: string | null): number | null => {
  if (text === null) return null;
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null; // "max", empty or garbage
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** The kernel reports "no limit" as the string "max" (v2) or an absurdly large number (v1). */
const toLimit = (text: string | null): number | null => {
  const n = toNumber(text);
  return n === null || n >= 2 ** 60 ? null : n;
};

const eventCount = (text: string | null, key: string): number | null => {
  if (text === null) return null;
  const m = new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'm').exec(text);
  return m ? Number(m[1]) : null;
};

/** Reads the container's memory figures, or returns null when no cgroup memory files are available. */
export function readContainerMemory(read: FileReader = defaultReader): MemorySnapshot | null {
  // cgroup v2 (unified hierarchy). Inside a container the cgroup root is normally the container's own cgroup.
  const v2Dirs = ['/sys/fs/cgroup'];
  const own = /^0::(\/.*)$/m.exec(read('/proc/self/cgroup') ?? '');
  if (own && own[1] !== '/') v2Dirs.push(`/sys/fs/cgroup${own[1]}`);
  for (const dir of v2Dirs) {
    const current = toNumber(read(`${dir}/memory.current`));
    if (current === null) continue;
    return {
      source: 'cgroup-v2',
      currentBytes: current,
      peakBytes: toNumber(read(`${dir}/memory.peak`)),
      limitBytes: toLimit(read(`${dir}/memory.max`)),
      oomKills: eventCount(read(`${dir}/memory.events`), 'oom_kill'),
    };
  }
  // cgroup v1
  const v1 = '/sys/fs/cgroup/memory';
  const current = toNumber(read(`${v1}/memory.usage_in_bytes`));
  if (current === null) return null;
  return {
    source: 'cgroup-v1',
    currentBytes: current,
    peakBytes: toNumber(read(`${v1}/memory.max_usage_in_bytes`)),
    limitBytes: toLimit(read(`${v1}/memory.limit_in_bytes`)),
    oomKills: eventCount(read(`${v1}/memory.oom_control`), 'oom_kill'),
  };
}

/** Runs a measurement and returns null if it throws: the worker wraps every call to this module in it. */
export function safely<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

/** Like readContainerMemory, but can never throw. This is what the worker calls. */
export function snapshotMemory(read?: FileReader): MemorySnapshot | null {
  try { return readContainerMemory(read); } catch { return null; }
}

const mib = (bytes: number | null): string => (bytes === null ? 'n/a' : String(Math.round(bytes / MIB)));

/**
 * One log line per finished compilation. The key=value part is stable so it can be read by a script:
 *   [memory] compilation 42 completed: peak_mib=207 peak_before_mib=135 current_mib=140 limit_mib=512 ...
 * peak_mib is the container's high-water mark since it started. It only ever rises, so when it is higher than
 * peak_before_mib this compilation set a new record, and peak_mib is its peak; when it is equal, the compilation stayed
 * below the earlier record.
 */
export function formatCompilationMemory(compilationId: number, outcome: string, before: MemorySnapshot | null, after: MemorySnapshot | null, nodeMaxRssBytes: number | null): string {
  if (!after) return `[memory] compilation ${compilationId} ${outcome}: unavailable (no cgroup memory files on this host)`;
  const limit = after.limitBytes;
  const pct = after.peakBytes !== null && limit ? ` (${Math.round((after.peakBytes / limit) * 100)}% of limit)` : '';
  const kills = after.oomKills === null ? 'n/a' : String(after.oomKills);
  const killsBefore = before?.oomKills ?? null;
  const newKills = after.oomKills !== null && killsBefore !== null ? after.oomKills - killsBefore : null;
  const peakNote = after.peakBytes === null ? ' [kernel does not report a peak: only current usage is known]' : '';
  return `[memory] compilation ${compilationId} ${outcome}: `
    + `peak_mib=${mib(after.peakBytes)} peak_before_mib=${mib(before?.peakBytes ?? null)} current_mib=${mib(after.currentBytes)} `
    + `limit_mib=${limit === null ? 'none' : mib(limit)} oom_kills=${kills} oom_kills_new=${newKills ?? 'n/a'} `
    + `node_max_rss_mib=${mib(nodeMaxRssBytes)} source=${after.source}${pct}${peakNote}`;
}

/** Logs the memory line for a finished compilation. Never throws. */
export function logCompilationMemory(
  compilationId: number,
  outcome: 'completed' | 'failed',
  before: MemorySnapshot | null,
  snapshot: () => MemorySnapshot | null = snapshotMemory,
): void {
  try {
    const maxRssKb = typeof process.resourceUsage === 'function' ? process.resourceUsage().maxRSS : null; // kilobytes
    console.log(formatCompilationMemory(compilationId, outcome, before, snapshot(), maxRssKb === null ? null : maxRssKb * 1024));
  } catch {
    // measurement must never affect a job
  }
}

/** Logs the container's memory limit and current usage once when the worker starts. Never throws. */
export function logStartupMemory(snapshot: () => MemorySnapshot | null = snapshotMemory): void {
  try {
    const s = snapshot();
    console.log(s
      ? `[memory] worker start: current_mib=${mib(s.currentBytes)} peak_mib=${mib(s.peakBytes)} limit_mib=${s.limitBytes === null ? 'none' : mib(s.limitBytes)} oom_kills=${s.oomKills ?? 'n/a'} source=${s.source}`
      : '[memory] worker start: container memory figures unavailable on this host');
  } catch {
    // measurement must never affect the worker
  }
}
