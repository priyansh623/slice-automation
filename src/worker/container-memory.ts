/**
 * Read-only measurement of the worker container's memory, from the Linux cgroup files the kernel exposes.
 *
 * Why: the Render worker has a hard 512 MB limit, and Render's own metrics are sampled every 30 seconds, which is too
 * coarse to see the peak of a short FFmpeg compilation. The kernel keeps an exact high-water mark of the whole container
 * (the worker process plus every child such as FFmpeg).
 *
 * THE CUMULATIVE-PEAK PROBLEM. memory.peak is the highest usage since the container started; it never goes down. So the
 * value after a compilation says nothing about that compilation unless it happened to set a new record. Each run therefore
 * takes these readings, immediately before and immediately after the work:
 *   - memory.current  (usage at that instant)
 *   - memory.peak     (cumulative, read through a fresh file descriptor)
 *   - memory.stat anon / file / shmem (how much of it is reclaimable cache and how much is not)
 *
 * NO GAP BEFORE THE RUN. The order at the start of a run is: open memory.peak, RESET it for this descriptor, and only THEN
 * take the "before" readings. Everything that happened before the reset is therefore part of the baseline (the cumulative
 * peak read after the reset already contains it) and can never be attributed to the run. A spike in the instants between
 * the reset and the baseline reading is detected (the descriptor's peak is above current usage) and makes the window
 * "unclean", so it is not used for an exact claim.
 *
 * Each run's peak is stated with a `basis=`, and a basis is only claimed when it is guaranteed:
 *   reset        Kernel 6.12+ lets a process reset memory.peak for ITS OWN open file descriptor by writing to it. Reading
 *                that descriptor at the end gives the exact peak of the run alone. Claimed only when the reset is PROVEN
 *                effective (the cumulative peak was at least 16 MiB above the descriptor's value right after the reset) and
 *                the window started CLEAN (the descriptor's peak was within 2 MiB of current usage at the baseline).
 *   new-record   The cumulative peak, compared with the baseline read after the reset, rose during the run. It can only rise
 *                through the highest moment since the baseline, so the new value is the run's peak. Needs no reset support.
 *   upper-bound  The cumulative peak did not rise above the baseline, so, because the cumulative peak never goes down, the
 *                run stayed at or below the baseline: its peak is <= the baseline. Nothing else is mixed in: a descriptor
 *                reading that could not be verified is shown for information but is never used to label or lower a result.
 *   unknown      Anything else (readings missing).
 *
 * CONTAINER LIFETIMES. Peaks must never be compared across worker restarts. Every line carries `lifetime=` (a random id
 * created when the worker process starts) and `uptime_s=`, and the worker logs a baseline line at start. A different
 * lifetime means a different container: the readings start over.
 *
 * This module only reads and formats (the single write is the per-descriptor peak reset above, which changes nothing but
 * that descriptor's own view). It never throws into the caller, and nothing in the worker depends on its result: where the
 * files do not exist (macOS, a different kernel) it reports "unavailable".
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

const MIB = 1024 * 1024;
/** The cumulative peak must exceed the value read right after a reset by this much for the reset to count as proven. */
const RESET_PROOF_MARGIN = 16 * MIB;
/** At the baseline the descriptor's peak must be this close to current usage, otherwise something moved during the reset. */
const CLEAN_START_TOLERANCE = 2 * MIB;

// ── Container lifetime ───────────────────────────────────────────────────────────────────────────────────────────────

/** One per worker process. A new id means the worker (and with it the container's memory history) started over. */
export const WORKER_LIFETIME = { id: randomUUID().slice(0, 8), startedAtMs: Date.now() };
let jobsInLifetime = 0;

// ── Reading the cgroup ───────────────────────────────────────────────────────────────────────────────────────────────

export interface MemorySnapshot {
  source: 'cgroup-v2' | 'cgroup-v1';
  /** Memory in use by the container right now (includes reclaimable page cache). */
  currentBytes: number | null;
  /** The container's cumulative high-water mark since it started. null when the kernel does not report it. */
  peakBytes: number | null;
  /** The container's limit. null means no limit is set. */
  limitBytes: number | null;
  /** How many times the kernel has killed a process in this container for lack of memory. */
  oomKills: number | null;
  /** From memory.stat: program memory (not reclaimable), cached file data (reclaimable), and shared/tmpfs memory (not reclaimable). */
  anonBytes: number | null;
  fileBytes: number | null;
  shmemBytes: number | null;
  /** Path of the memory.peak file this snapshot came from (cgroup v2 only). */
  peakPath: string | null;
}

export type FileReader = (path: string) => string | null;

/** An open memory.peak file whose peak can be reset for this descriptor only (kernel 6.12+). */
export interface PeakFile {
  /** Resets this descriptor's peak to the current usage. Returns false if the kernel refused. */
  reset(): boolean;
  /** Reads the peak as seen by this descriptor. */
  readBytes(): number | null;
  close(): void;
}

export interface CgroupIo {
  read: FileReader;
  /** Opens memory.peak for reading and writing. error explains why not (read-only mount, old kernel, missing file...). */
  openPeak(path: string): { file: PeakFile } | { error: string };
}

const realIo: CgroupIo = {
  read(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  },
  openPeak(p) {
    let fd: number;
    try { fd = fs.openSync(p, 'r+'); } catch (e) { return { error: (e as NodeJS.ErrnoException).code ?? 'open failed' }; }
    return {
      file: {
        reset() { try { fs.writeSync(fd, '1'); return true; } catch { return false; } },
        readBytes() {
          try {
            const buf = Buffer.alloc(64);
            const n = fs.readSync(fd, buf, 0, 64, 0);
            return toNumber(buf.subarray(0, n).toString('utf8'));
          } catch { return null; }
        },
        close() { try { fs.closeSync(fd); } catch { /* ignore */ } },
      },
    };
  },
};

let io: CgroupIo = realIo;
/** Tests substitute a fake kernel here; pass nothing to restore the real one. */
export function useCgroupIoForTests(fake?: CgroupIo): void { io = fake ?? realIo; }
/** Tests restart the "worker process" by calling this. */
export function resetLifetimeCountersForTests(): void { jobsInLifetime = 0; }

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

const keyedCount = (text: string | null, key: string): number | null => {
  if (text === null) return null;
  const m = new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'm').exec(text);
  return m ? Number(m[1]) : null;
};

/** The cgroup v2 directory that holds this container's memory files, or null. */
function locateV2Dir(reader: FileReader): string | null {
  const dirs = ['/sys/fs/cgroup'];
  const own = /^0::(\/.*)$/m.exec(reader('/proc/self/cgroup') ?? '');
  if (own && own[1] !== '/') dirs.push(`/sys/fs/cgroup${own[1]}`);
  return dirs.find((d) => toNumber(reader(`${d}/memory.current`)) !== null) ?? null;
}

/** Reads the container's memory figures, or returns null when no cgroup memory files are available. */
export function readContainerMemory(reader: FileReader = io.read): MemorySnapshot | null {
  // cgroup v2 (unified hierarchy). Inside a container the cgroup root is normally the container's own cgroup.
  const v2Dirs = ['/sys/fs/cgroup'];
  const own = /^0::(\/.*)$/m.exec(reader('/proc/self/cgroup') ?? '');
  if (own && own[1] !== '/') v2Dirs.push(`/sys/fs/cgroup${own[1]}`);
  for (const dir of v2Dirs) {
    const current = toNumber(reader(`${dir}/memory.current`));
    if (current === null) continue;
    const stat = reader(`${dir}/memory.stat`);
    return {
      source: 'cgroup-v2',
      currentBytes: current,
      peakBytes: toNumber(reader(`${dir}/memory.peak`)),
      limitBytes: toLimit(reader(`${dir}/memory.max`)),
      oomKills: keyedCount(reader(`${dir}/memory.events`), 'oom_kill'),
      anonBytes: keyedCount(stat, 'anon'),
      fileBytes: keyedCount(stat, 'file'),
      shmemBytes: keyedCount(stat, 'shmem'),
      peakPath: `${dir}/memory.peak`,
    };
  }
  // cgroup v1
  const v1 = '/sys/fs/cgroup/memory';
  const current = toNumber(reader(`${v1}/memory.usage_in_bytes`));
  if (current === null) return null;
  const stat = reader(`${v1}/memory.stat`);
  return {
    source: 'cgroup-v1',
    currentBytes: current,
    peakBytes: toNumber(reader(`${v1}/memory.max_usage_in_bytes`)),
    limitBytes: toLimit(reader(`${v1}/memory.limit_in_bytes`)),
    oomKills: keyedCount(reader(`${v1}/memory.oom_control`), 'oom_kill'),
    anonBytes: keyedCount(stat, 'rss'),
    fileBytes: keyedCount(stat, 'cache'),
    shmemBytes: keyedCount(stat, 'shmem'),
    peakPath: null, // v1 has no per-descriptor reset
  };
}

/** Runs a measurement and returns null if it throws: the worker wraps every call to this module in it. */
export function safely<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

/** Like readContainerMemory, but can never throw. */
export function snapshotMemory(reader?: FileReader): MemorySnapshot | null {
  try { return readContainerMemory(reader); } catch { return null; }
}

// ── Isolating one run's peak ─────────────────────────────────────────────────────────────────────────────────────────

export type PeakBasis = 'reset' | 'new-record' | 'upper-bound' | 'unknown';

export interface RunPeak {
  /** The run's peak, or for 'upper-bound' the value it is known not to exceed. */
  bytes: number | null;
  basis: PeakBasis;
}

/**
 * Works out the peak of one run from the readings around it. See the file header for what each basis means and when it
 * may be claimed.
 *  - before: the baseline, read right AFTER the reset (so it already contains everything that happened earlier)
 *  - windowPeak: the peak read through the descriptor that was reset at the start of the run
 *  - resetProven: the reset was shown to be effective AND the window started clean
 * An unproven window reading never changes the result: it cannot make a run "exact" and it cannot lower an upper bound.
 */
export function isolateRunPeak(before: MemorySnapshot | null, after: MemorySnapshot | null, windowPeak: number | null, resetProven: boolean): RunPeak {
  if (!after || after.peakBytes === null) return { bytes: null, basis: 'unknown' };
  if (resetProven && windowPeak !== null) return { bytes: windowPeak, basis: 'reset' };
  if (before && before.peakBytes !== null) {
    // The cumulative peak never goes down, so "no rise since the baseline" guarantees the run stayed at or below it.
    return after.peakBytes > before.peakBytes
      ? { bytes: after.peakBytes, basis: 'new-record' }
      : { bytes: before.peakBytes, basis: 'upper-bound' };
  }
  return { bytes: null, basis: 'unknown' };
}

// ── Per-compilation probe ────────────────────────────────────────────────────────────────────────────────────────────

export interface MemoryProbe {
  /** Takes the "after" readings immediately, closes the descriptor and logs one line. Never throws. */
  finish(compilationId: number, outcome: 'completed' | 'failed'): void;
}

export interface RunReadings {
  compilationId: number;
  outcome: string;
  jobNumber: number;
  uptimeStartS: number;
  uptimeEndS: number;
  before: MemorySnapshot | null;
  after: MemorySnapshot | null;
  /** Peak through the descriptor reset at the start of the run (informational unless windowState is reset-proven). */
  windowPeakBytes: number | null;
  windowState: 'reset-proven' | 'reset-unproven' | 'reset-unclean' | 'reset-implausible' | `unavailable:${string}`;
  nodeMaxRssBytes: number | null;
}

const mib = (bytes: number | null): string => (bytes === null ? 'n/a' : String(Math.round(bytes / MIB)));

/** The stable, machine-readable line written for every compilation. */
export function formatRunLine(r: RunReadings): string {
  if (!r.after) return `[memory] compilation ${r.compilationId} ${r.outcome}: lifetime=${WORKER_LIFETIME.id} unavailable (no cgroup memory files on this host)`;
  const run = isolateRunPeak(r.before, r.after, r.windowPeakBytes, r.windowState === 'reset-proven');
  const b = r.before;
  const a = r.after;
  const limit = a.limitBytes;
  const pct = run.bytes !== null && limit ? ` (${Math.round((run.bytes / limit) * 100)}% of limit${run.basis === 'upper-bound' ? ', upper bound' : ''})` : '';
  const newKills = a.oomKills !== null && b?.oomKills != null ? a.oomKills - b.oomKills : null;
  return `[memory] compilation ${r.compilationId} ${r.outcome}: lifetime=${WORKER_LIFETIME.id} job_n=${r.jobNumber} uptime_s=${r.uptimeStartS}->${r.uptimeEndS} `
    + `before_current_mib=${mib(b?.currentBytes ?? null)} before_peak_mib=${mib(b?.peakBytes ?? null)} `
    + `after_current_mib=${mib(a.currentBytes)} after_peak_mib=${mib(a.peakBytes)} `
    + `window_peak_mib=${mib(r.windowPeakBytes)} window=${r.windowState} `
    + `run_peak_mib=${mib(run.bytes)} basis=${run.basis}${pct} limit_mib=${limit === null ? 'none' : mib(limit)} `
    + `before_anon_mib=${mib(b?.anonBytes ?? null)} after_anon_mib=${mib(a.anonBytes)} before_file_mib=${mib(b?.fileBytes ?? null)} after_file_mib=${mib(a.fileBytes)} after_shmem_mib=${mib(a.shmemBytes)} `
    + `oom_kills_before=${b?.oomKills ?? 'n/a'} oom_kills_after=${a.oomKills ?? 'n/a'} oom_kills_new=${newKills ?? 'n/a'} `
    + `node_max_rss_mib=${mib(r.nodeMaxRssBytes)} source=${a.source}${a.peakBytes === null ? ' [kernel does not report a peak]' : ''}`;
}

const uptimeSeconds = (): number => Math.round((Date.now() - WORKER_LIFETIME.startedAtMs) / 1000);

/**
 * Call immediately before the work of one compilation. Takes the "before" readings and, where the kernel allows,
 * opens memory.peak and resets it for this run's descriptor. The returned probe takes the "after" readings and logs.
 */
export function startMemoryProbe(): MemoryProbe {
  const uptimeStartS = uptimeSeconds();
  jobsInLifetime += 1;
  const jobNumber = jobsInLifetime;

  // 1. Open memory.peak and RESET it first. Nothing is read before this, so no earlier memory spike can be mistaken for the run.
  let file: PeakFile | null = null;
  let windowState: RunReadings['windowState'] = 'unavailable:no-cgroup-v2-peak';
  const dir = safely(() => locateV2Dir(io.read));
  if (dir) {
    const opened = safely(() => io.openPeak(`${dir}/memory.peak`)) ?? { error: 'open-threw' };
    if ('error' in opened) {
      windowState = `unavailable:${opened.error}`;
    } else if (!safely(() => opened.file.reset())) {
      safely(() => opened.file.close());
      windowState = 'unavailable:reset-refused';
    } else {
      file = opened.file;
      windowState = 'reset-unproven'; // until the readings below prove it
    }
  }

  // 2. The baseline, read AFTER the reset: its cumulative peak already contains everything that happened before the reset.
  const before = snapshotMemory();
  // 3. The descriptor's own peak, read last: it covers the whole stretch from the reset to here.
  const windowAtStart = file ? file.readBytes() : null;

  if (file && windowState === 'reset-unproven') {
    // A valid descriptor peak is never below current usage, and right after a reset it is close to it. Above means usage moved
    // during the reset; below means the reading cannot be trusted. Either way the window is not used for an exact claim.
    const clean = windowAtStart !== null && before?.currentBytes != null && Math.abs(windowAtStart - before.currentBytes) <= CLEAN_START_TOLERANCE;
    // Proven only if the reset visibly lowered the peak below the cumulative one. In a fresh container the two are close and
    // this cannot be shown; the run then relies on basis=new-record / upper-bound, never on an unproven reset.
    const proven = clean && before?.peakBytes != null && windowAtStart !== null && before.peakBytes - windowAtStart >= RESET_PROOF_MARGIN;
    windowState = !clean ? 'reset-unclean' : proven ? 'reset-proven' : 'reset-unproven';
  }

  let finished = false;
  return {
    finish(compilationId, outcome) {
      if (finished) return; // the work's own reading stands even if a later step (the completion write) fails
      finished = true;
      try {
        // Back to back, as early as possible: the descriptor reading, then the fresh cumulative reading.
        const windowPeak = file ? file.readBytes() : null;
        const after = snapshotMemory();
        // A valid descriptor peak is a subset of the cumulative one and can never be below current usage. Anything else is
        // not trusted, whatever the start looked like.
        let finalState: RunReadings['windowState'] = windowState;
        if (finalState === 'reset-proven') {
          const plausible = windowPeak !== null && after?.currentBytes != null && after.peakBytes != null
            && windowPeak >= after.currentBytes - CLEAN_START_TOLERANCE && windowPeak <= after.peakBytes + CLEAN_START_TOLERANCE;
          if (!plausible) finalState = 'reset-implausible';
        }
        const uptimeEndS = uptimeSeconds();
        file?.close();
        const maxRssKb = typeof process.resourceUsage === 'function' ? process.resourceUsage().maxRSS : null; // kilobytes
        console.log(formatRunLine({
          compilationId, outcome, jobNumber, uptimeStartS, uptimeEndS, before, after,
          windowPeakBytes: windowPeak, windowState: finalState, nodeMaxRssBytes: maxRssKb === null ? null : maxRssKb * 1024,
        }));
      } catch {
        // measurement must never affect a job
      }
    },
  };
}

// ── Worker start ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The baseline of a container lifetime, logged once when the worker starts. Peaks are only comparable within one
 * lifetime id; a new id means the worker restarted and everything starts over from this line.
 */
export function logStartupMemory(): void {
  try {
    const s = snapshotMemory();
    let peakFile = 'n/a';
    let resetWrite = 'n/a';
    if (s?.peakPath) {
      const opened = io.openPeak(s.peakPath);
      if ('error' in opened) {
        peakFile = `read-only:${opened.error}`;
      } else {
        peakFile = 'writable';
        // Does the kernel accept the per-descriptor reset? (Whether it is EFFECTIVE is proven per run, see the header.)
        resetWrite = opened.file.reset() ? 'accepted' : 'refused';
        opened.file.close();
      }
    }
    const head = `[memory] worker start: lifetime=${WORKER_LIFETIME.id} kernel=${os.release()}`;
    console.log(s
      ? `${head} current_mib=${mib(s.currentBytes)} peak_mib=${mib(s.peakBytes)} limit_mib=${s.limitBytes === null ? 'none' : mib(s.limitBytes)} `
        + `anon_mib=${mib(s.anonBytes)} file_mib=${mib(s.fileBytes)} shmem_mib=${mib(s.shmemBytes)} oom_kills=${s.oomKills ?? 'n/a'} source=${s.source} peak_file=${peakFile} reset_write=${resetWrite}`
      : `${head} container memory figures unavailable on this host`);
  } catch {
    // measurement must never affect the worker
  }
}
