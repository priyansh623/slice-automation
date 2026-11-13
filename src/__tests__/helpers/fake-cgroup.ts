import type { CgroupIo, PeakFile } from '@/worker/container-memory';

export const MIB = 1024 * 1024;

/**
 * A stand-in for the Linux cgroup memory files with the kernel's real semantics:
 *  - memory.peak is cumulative and only ever rises;
 *  - on a kernel that supports it (6.12+), writing to an open memory.peak resets the peak for THAT descriptor only
 *    (other readers keep seeing the cumulative value);
 *  - the mount can be read-only, or the kernel can refuse the reset.
 */
export class FakeKernel {
  current = 110 * MIB;
  peak = 110 * MIB;
  limit: number | null = 512 * MIB;
  oomKills = 0;
  anon = 90 * MIB;
  file = 15 * MIB;
  shmem = 2 * MIB;
  /** Kernel 6.12+: writing to memory.peak resets the peak of that descriptor. */
  resetSupported = true;
  /** false = the cgroup mount is read-only, so memory.peak cannot be opened for writing. */
  writable = true;
  /** true = memory.peak is not exposed at all (kernel older than 5.19). */
  noPeakFile = false;
  /**
   * Moments at which the test can make memory move, to reproduce races: just before the reset is applied (the gap that
   * used to sit between the "before" snapshot and the reset), and just after it (the stretch before the baseline is read).
   */
  hooks: { beforeReset?: () => void; afterReset?: () => void } = {};
  /** Simulates a descriptor whose readings cannot be trusted (an unverified measurement): it always reports this value. */
  bogusWindowBytes: number | null = null;
  private windows: { local: number | null }[] = [];

  /** The container's memory usage moves to this value; peaks follow. */
  use(bytes: number): void {
    this.current = bytes;
    this.peak = Math.max(this.peak, bytes);
    for (const w of this.windows) if (w.local !== null) w.local = Math.max(w.local, bytes);
  }

  io(): CgroupIo {
    const files: Record<string, () => string | null> = {
      '/sys/fs/cgroup/memory.current': () => String(this.current),
      '/sys/fs/cgroup/memory.peak': () => (this.noPeakFile ? null : String(this.peak)),
      '/sys/fs/cgroup/memory.max': () => (this.limit === null ? 'max' : String(this.limit)),
      '/sys/fs/cgroup/memory.events': () => `low 0\nhigh 0\nmax 0\noom 0\noom_kill ${this.oomKills}\n`,
      '/sys/fs/cgroup/memory.stat': () => `anon ${this.anon}\nfile ${this.file}\nshmem ${this.shmem}\nkernel 5000000\n`,
    };
    return {
      read: (p) => (p in files ? files[p]() : null),
      openPeak: (p) => {
        if (p !== '/sys/fs/cgroup/memory.peak' || this.noPeakFile) return { error: 'ENOENT' };
        if (!this.writable) return { error: 'EROFS' };
        const win = { local: null as number | null };
        this.windows.push(win);
        const file: PeakFile = {
          reset: () => {
            if (!this.resetSupported) return false;
            this.hooks.beforeReset?.();
            win.local = this.current;
            this.hooks.afterReset?.();
            return true;
          },
          readBytes: () => (this.bogusWindowBytes !== null ? this.bogusWindowBytes : win.local !== null ? win.local : this.peak),
          close: () => { this.windows = this.windows.filter((w) => w !== win); },
        };
        return { file };
      },
    };
  }
}
