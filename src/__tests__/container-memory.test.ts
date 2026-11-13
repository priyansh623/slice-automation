import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeKernel, MIB } from './helpers/fake-cgroup';
import {
  isolateRunPeak, logStartupMemory, readContainerMemory, resetLifetimeCountersForTests, safely, snapshotMemory, startMemoryProbe,
  useCgroupIoForTests, WORKER_LIFETIME, type MemorySnapshot,
} from '@/worker/container-memory';

const files = (map: Record<string, string>) => (p: string) => (p in map ? map[p] : null);

describe('readContainerMemory', () => {
  const V2 = {
    '/sys/fs/cgroup/memory.current': `${140 * MIB}\n`,
    '/sys/fs/cgroup/memory.peak': `${207 * MIB}\n`,
    '/sys/fs/cgroup/memory.max': `${512 * MIB}\n`,
    '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 0\noom 1\noom_kill 1\n',
    '/sys/fs/cgroup/memory.stat': `anon ${100 * MIB}\nfile ${30 * MIB}\nshmem ${10 * MIB}\n`,
  };

  it('reads cgroup v2: current, peak, limit, OOM kills and the anon/file/shmem split', () => {
    expect(readContainerMemory(files(V2))).toEqual({
      source: 'cgroup-v2', currentBytes: 140 * MIB, peakBytes: 207 * MIB, limitBytes: 512 * MIB, oomKills: 1,
      anonBytes: 100 * MIB, fileBytes: 30 * MIB, shmemBytes: 10 * MIB, peakPath: '/sys/fs/cgroup/memory.peak',
    });
  });

  it('treats "max" as no limit, and a kernel without memory.peak as peak unknown (never a made-up number)', () => {
    const s = readContainerMemory(files({ '/sys/fs/cgroup/memory.current': '1000\n', '/sys/fs/cgroup/memory.max': 'max\n' }))!;
    expect(s).toMatchObject({ currentBytes: 1000, peakBytes: null, limitBytes: null, oomKills: null });
  });

  it('falls back to cgroup v1 (no per-descriptor reset there) and treats its huge "unlimited" value as no limit', () => {
    const v1 = {
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${100 * MIB}`,
      '/sys/fs/cgroup/memory/memory.max_usage_in_bytes': `${180 * MIB}`,
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      '/sys/fs/cgroup/memory/memory.oom_control': 'oom_kill_disable 0\nunder_oom 0\noom_kill 0\n',
    };
    expect(readContainerMemory(files(v1))).toMatchObject({ source: 'cgroup-v1', currentBytes: 100 * MIB, peakBytes: 180 * MIB, limitBytes: null, oomKills: 0, peakPath: null });
  });

  it('follows /proc/self/cgroup when the container is not at the cgroup root', () => {
    const nested = { '/proc/self/cgroup': '0::/kubepods/pod1/abc\n', '/sys/fs/cgroup/kubepods/pod1/abc/memory.current': '5000', '/sys/fs/cgroup/kubepods/pod1/abc/memory.peak': '9000', '/sys/fs/cgroup/kubepods/pod1/abc/memory.max': '20000' };
    expect(readContainerMemory(files(nested))).toMatchObject({ currentBytes: 5000, peakBytes: 9000, limitBytes: 20000, peakPath: '/sys/fs/cgroup/kubepods/pod1/abc/memory.peak' });
  });

  it('returns null where there are no cgroup memory files (for example macOS) and ignores garbage', () => {
    expect(readContainerMemory(files({}))).toBeNull();
    expect(readContainerMemory(files({ '/sys/fs/cgroup/memory.current': 'not a number' }))).toBeNull();
  });

  it('snapshotMemory and safely never throw', () => {
    expect(snapshotMemory(() => { throw new Error('boom'); })).toBeNull();
    expect(safely(() => { throw new Error('boom'); })).toBeNull();
  });
});

describe('isolateRunPeak: how one run\'s peak is separated from the cumulative one', () => {
  const snap = (peak: number | null): MemorySnapshot => ({ source: 'cgroup-v2', currentBytes: 100 * MIB, peakBytes: peak === null ? null : peak * MIB, limitBytes: 512 * MIB, oomKills: 0, anonBytes: null, fileBytes: null, shmemBytes: null, peakPath: 'x' });

  it('uses the descriptor reading when the reset is proven: exact, even if the cumulative peak did not move', () => {
    expect(isolateRunPeak(snap(300), snap(300), 200 * MIB, true)).toEqual({ bytes: 200 * MIB, basis: 'reset' });
  });
  it('a risen cumulative peak IS the run\'s peak (it can only rise through the run\'s highest moment)', () => {
    expect(isolateRunPeak(snap(110), snap(250), null, false)).toEqual({ bytes: 250 * MIB, basis: 'new-record' });
    expect(isolateRunPeak(snap(110), snap(250), 250 * MIB, false)).toEqual({ bytes: 250 * MIB, basis: 'new-record' }); // unproven reset is not trusted
  });
  it('an unchanged cumulative peak only gives an upper bound, and says so', () => {
    expect(isolateRunPeak(snap(300), snap(300), null, false)).toEqual({ bytes: 300 * MIB, basis: 'upper-bound' });
  });
  it('an unverified window reading is NEVER mixed in: it cannot lower an upper bound or turn it into an exact peak', () => {
    for (const bogus of [1 * MIB, 50 * MIB, 220 * MIB, 299 * MIB, 5000 * MIB]) {
      expect(isolateRunPeak(snap(300), snap(300), bogus, false)).toEqual({ bytes: 300 * MIB, basis: 'upper-bound' });
    }
    expect(isolateRunPeak(snap(110), snap(250), 80 * MIB, false)).toEqual({ bytes: 250 * MIB, basis: 'new-record' });
  });
  it('is unknown rather than guessed when the readings are missing', () => {
    expect(isolateRunPeak(null, snap(300), null, false)).toEqual({ bytes: null, basis: 'unknown' });
    expect(isolateRunPeak(snap(300), snap(null), null, false)).toEqual({ bytes: null, basis: 'unknown' });
    expect(isolateRunPeak(snap(300), null, null, false)).toEqual({ bytes: null, basis: 'unknown' });
  });
});

describe('a compilation measured against a fake kernel', () => {
  let kernel: FakeKernel;
  let lines: string[];
  beforeEach(() => {
    kernel = new FakeKernel();
    useCgroupIoForTests(kernel.io());
    resetLifetimeCountersForTests();
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => { lines.push(String(l)); });
  });
  afterEach(() => { useCgroupIoForTests(); vi.restoreAllMocks(); });

  const run = (id: number, peakMiB: number, endMiB = 120, outcome: 'completed' | 'failed' = 'completed') => {
    const probe = startMemoryProbe();
    kernel.use(peakMiB * MIB);   // the work
    kernel.use(endMiB * MIB);    // and memory falls back afterwards
    probe.finish(id, outcome);
    return lines[lines.length - 1];
  };
  const field = (line: string, key: string) => new RegExp(`${key}=(\\S+)`).exec(line)?.[1];

  it('records current and peak before and after, the lifetime, and the isolated run peak for every run', () => {
    const line = run(1, 250);
    expect(line).toContain('[memory] compilation 1 completed:');
    expect(field(line, 'lifetime')).toBe(WORKER_LIFETIME.id);
    expect(field(line, 'job_n')).toBe('1');
    expect(field(line, 'before_current_mib')).toBe('110');
    expect(field(line, 'before_peak_mib')).toBe('110');
    expect(field(line, 'after_current_mib')).toBe('120');
    expect(field(line, 'after_peak_mib')).toBe('250');
    expect(field(line, 'run_peak_mib')).toBe('250');
    expect(field(line, 'basis')).toBe('new-record');
    expect(field(line, 'limit_mib')).toBe('512');
    expect(field(line, 'oom_kills_new')).toBe('0');
    expect(field(line, 'before_anon_mib')).toBe('90');
  });

  it('each run\'s "before" equals the previous run\'s "after" within one lifetime, and a larger run gets its exact peak', () => {
    const a = run(1, 200);
    const b = run(2, 300);
    expect(field(b, 'before_peak_mib')).toBe(field(a, 'after_peak_mib'));
    expect(field(b, 'before_current_mib')).toBe(field(a, 'after_current_mib'));
    expect(field(b, 'run_peak_mib')).toBe('300');
    expect(field(b, 'basis')).toBe('reset');   // proven after run 1 raised the peak well above current usage
    expect(field(b, 'job_n')).toBe('2');
  });

  it('without any reset support the same ascending ramp is still exact, because every run sets a new record', () => {
    kernel.resetSupported = false;
    const a = run(1, 200);
    const b = run(2, 300);
    expect(field(a, 'basis')).toBe('new-record');
    expect(field(b, 'basis')).toBe('new-record');
    expect(field(b, 'run_peak_mib')).toBe('300');
    expect(field(b, 'before_peak_mib')).toBe(field(a, 'after_peak_mib'));
  });

  it('with the per-descriptor reset available and proven, a run below the earlier record still gets its EXACT peak', () => {
    kernel.use(400 * MIB); kernel.use(110 * MIB); // an earlier spike set a 400 MiB record
    const line = run(3, 210);
    expect(field(line, 'window')).toBe('reset-proven');
    expect(field(line, 'after_peak_mib')).toBe('400');   // cumulative did not move
    expect(field(line, 'window_peak_mib')).toBe('210');  // the run's own peak, from the reset descriptor
    expect(field(line, 'run_peak_mib')).toBe('210');
    expect(field(line, 'basis')).toBe('reset');
  });

  it('without reset support, a run below the earlier record is reported only as an UPPER BOUND, never as exact', () => {
    kernel.resetSupported = false;
    kernel.use(400 * MIB); kernel.use(110 * MIB);
    const line = run(4, 210);
    expect(field(line, 'window')).toBe('unavailable:reset-refused');
    expect(field(line, 'run_peak_mib')).toBe('400');
    expect(field(line, 'basis')).toBe('upper-bound');
    expect(line).toContain('upper bound');
  });

  it('on a read-only cgroup mount or a kernel without memory.peak the run still has before/after readings, and says why there is no reset', () => {
    kernel.writable = false;
    const ro = run(5, 250);
    expect(field(ro, 'window')).toBe('unavailable:EROFS');
    expect(field(ro, 'basis')).toBe('new-record');
    kernel.noPeakFile = true;
    const noPeak = run(6, 260);
    expect(noPeak).toContain('[kernel does not report a peak]');
    expect(field(noPeak, 'basis')).toBe('unknown');
    expect(field(noPeak, 'run_peak_mib')).toBe('n/a');
  });

  it('flags OOM kills that happened during the run', () => {
    const probe = startMemoryProbe();
    kernel.use(500 * MIB);
    kernel.oomKills += 1;
    probe.finish(7, 'failed');
    expect(lines[lines.length - 1]).toContain('oom_kills_new=1');
    expect(lines[lines.length - 1]).toContain('failed:');
  });

  it('logs only once per probe even if finish is called again (for example after a later step fails)', () => {
    const probe = startMemoryProbe();
    probe.finish(8, 'completed');
    probe.finish(8, 'failed');
    expect(lines.filter((l) => l.startsWith('[memory] compilation 8'))).toHaveLength(1);
  });

  describe('memory moving around the start of the window (the former gap between the snapshot and the reset)', () => {
    it('a spike BEFORE the reset is part of the baseline, never the run: with a proven reset the run gets its own exact peak', () => {
      kernel.hooks.beforeReset = () => { kernel.use(400 * MIB); kernel.use(110 * MIB); };  // spikes just before the reset is applied
      const line = run(20, 210);
      expect(field(line, 'before_peak_mib')).toBe('400');   // the baseline, read after the reset, already contains the spike
      expect(field(line, 'window')).toBe('reset-proven');
      expect(field(line, 'run_peak_mib')).toBe('210');      // not 400
      expect(field(line, 'basis')).toBe('reset');
    });

    it('the same spike when the run does NOT beat it: reported as an upper bound at the spike, never as a "new record" of the run', () => {
      kernel.writable = false;                                // no reset possible, so only the baseline logic is left
      kernel.use(400 * MIB); kernel.use(110 * MIB);           // the spike happened before the run's measurement began
      const line = run(21, 210);
      expect(field(line, 'before_peak_mib')).toBe('400');
      expect(field(line, 'basis')).toBe('upper-bound');
      expect(field(line, 'run_peak_mib')).toBe('400');
      expect(line).toContain('upper bound');
    });

    it('with the old ordering the spike would have looked like the run\'s own new record; a run that really raises the peak still does', () => {
      kernel.hooks.beforeReset = () => { kernel.use(400 * MIB); kernel.use(110 * MIB); };
      const line = run(22, 450);                              // a real run above the spike
      expect(field(line, 'before_peak_mib')).toBe('400');
      expect(field(line, 'run_peak_mib')).toBe('450');
      expect(['reset', 'new-record']).toContain(field(line, 'basis'));
    });

    it('a spike in the instants AFTER the reset makes the window unclean: no exact claim, only the baseline upper bound', () => {
      kernel.use(400 * MIB); kernel.use(110 * MIB);           // an earlier record, so the reset could otherwise be proven
      kernel.hooks.afterReset = () => { kernel.use(300 * MIB); kernel.use(115 * MIB); };
      const line = run(23, 200);
      expect(field(line, 'window')).toBe('reset-unclean');
      expect(field(line, 'basis')).toBe('upper-bound');
      expect(field(line, 'run_peak_mib')).toBe('400');
    });

    it('tiny movement (within 2 MiB) does not spoil a window; larger movement does', () => {
      kernel.use(400 * MIB); kernel.use(110 * MIB);
      kernel.hooks.afterReset = () => { kernel.use(109 * MIB); };                            // fell by 1 MiB
      expect(field(run(24, 200), 'window')).toBe('reset-proven');
      kernel.use(400 * MIB); kernel.use(110 * MIB);
      kernel.hooks.afterReset = () => { kernel.use(103 * MIB); };                            // fell by 7 MiB
      expect(field(run(25, 200), 'window')).toBe('reset-unclean');
    });

    it('a window that cannot be trusted (a reading below current usage, impossible for a real one) is never used, whatever it says', () => {
      kernel.use(400 * MIB); kernel.use(110 * MIB);
      kernel.bogusWindowBytes = 50 * MIB;
      const line = run(26, 210);
      expect(field(line, 'window_peak_mib')).toBe('50');     // shown for information
      expect(field(line, 'window')).toBe('reset-unclean');
      expect(field(line, 'run_peak_mib')).toBe('400');        // not 50, and not a lowered "bound"
      expect(field(line, 'basis')).toBe('upper-bound');
    });

    it('a window that looks fine at the start but reads impossibly at the end is not trusted either', () => {
      kernel.use(400 * MIB); kernel.use(110 * MIB);
      const probe = startMemoryProbe();
      kernel.use(210 * MIB); kernel.use(120 * MIB);
      kernel.bogusWindowBytes = 5000 * MIB;                   // above the cumulative peak: impossible
      probe.finish(27, 'completed');
      const line = lines[lines.length - 1];
      expect(field(line, 'window')).toBe('reset-implausible');
      expect(field(line, 'basis')).toBe('upper-bound');
      expect(field(line, 'run_peak_mib')).toBe('400');
    });

    it('an unproven reset in a fresh container never claims reset: an ascending run is exact through new-record, a low one is only a bound', () => {
      const first = run(28, 250);
      expect(field(first, 'window')).toBe('reset-unproven');
      expect(field(first, 'basis')).toBe('new-record');
      kernel.bogusWindowBytes = 60 * MIB;                      // an unverifiable reading must not be able to lower anything
      const low = run(29, 150);
      expect(field(low, 'basis')).not.toBe('reset');
      expect(field(low, 'run_peak_mib')).toBe('250');
    });
  });

  it('a worker restart is a new lifetime: new id, job numbering starts over, and the baseline is logged', async () => {
    run(9, 220);
    const firstId = WORKER_LIFETIME.id;
    vi.resetModules();                                             // a new worker process loads the module afresh
    const restarted = await import('@/worker/container-memory');
    restarted.useCgroupIoForTests(new FakeKernel().io());
    expect(restarted.WORKER_LIFETIME.id).not.toBe(firstId);
    lines.length = 0;
    restarted.logStartupMemory();
    expect(lines[0]).toContain(`lifetime=${restarted.WORKER_LIFETIME.id}`);
    const probe = restarted.startMemoryProbe();
    probe.finish(10, 'completed');
    expect(field(lines[1], 'job_n')).toBe('1');
    expect(field(lines[1], 'lifetime')).toBe(restarted.WORKER_LIFETIME.id);
    restarted.useCgroupIoForTests();
  });

  it('logs the baseline of a lifetime at start: kernel, usage, limit, the cache/program split and whether memory.peak is writable', () => {
    logStartupMemory();
    expect(lines[0]).toMatch(/^\[memory\] worker start: lifetime=[0-9a-f]{8} kernel=\S+ current_mib=110 peak_mib=110 limit_mib=512 anon_mib=90 file_mib=15 shmem_mib=2 oom_kills=0 source=cgroup-v2 peak_file=writable reset_write=accepted$/);
    kernel.writable = false;
    lines.length = 0;
    logStartupMemory();
    expect(lines[0]).toContain('peak_file=read-only:EROFS');
    expect(lines[0]).toContain('reset_write=n/a');
    kernel.writable = true;
    kernel.resetSupported = false;
    lines.length = 0;
    logStartupMemory();
    expect(lines[0]).toContain('peak_file=writable reset_write=refused');
  });

  it('where there are no cgroup files it says unavailable', () => {
    useCgroupIoForTests({ read: () => null, openPeak: () => ({ error: 'ENOENT' }) });
    const probe = startMemoryProbe();
    probe.finish(11, 'completed');
    expect(lines[0]).toContain('unavailable (no cgroup memory files on this host)');
  });

  it('swallows every failure: a throwing kernel or a throwing logger changes nothing for the caller', () => {
    useCgroupIoForTests({ read: () => { throw new Error('boom'); }, openPeak: () => { throw new Error('boom'); } });
    expect(() => startMemoryProbe().finish(12, 'failed')).not.toThrow();
    expect(() => logStartupMemory()).not.toThrow();
    useCgroupIoForTests(kernel.io());
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('logger broke'); });
    expect(() => startMemoryProbe().finish(13, 'completed')).not.toThrow();
  });
});
