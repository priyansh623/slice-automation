import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatCompilationMemory, logCompilationMemory, logStartupMemory, readContainerMemory, snapshotMemory, type MemorySnapshot } from '@/worker/container-memory';

const MIB = 1024 * 1024;
const files = (map: Record<string, string>) => (p: string) => (p in map ? map[p] : null);

const V2 = {
  '/sys/fs/cgroup/memory.current': `${140 * MIB}\n`,
  '/sys/fs/cgroup/memory.peak': `${207 * MIB}\n`,
  '/sys/fs/cgroup/memory.max': `${512 * MIB}\n`,
  '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 0\noom 1\noom_kill 1\n',
};

describe('readContainerMemory', () => {
  it('reads cgroup v2: current, peak, limit and OOM kills', () => {
    expect(readContainerMemory(files(V2))).toEqual({ source: 'cgroup-v2', currentBytes: 140 * MIB, peakBytes: 207 * MIB, limitBytes: 512 * MIB, oomKills: 1 });
  });

  it('treats "max" as no limit, and a kernel without memory.peak as peak unknown (never a made-up number)', () => {
    const s = readContainerMemory(files({ '/sys/fs/cgroup/memory.current': '1000\n', '/sys/fs/cgroup/memory.max': 'max\n' }))!;
    expect(s).toMatchObject({ currentBytes: 1000, peakBytes: null, limitBytes: null, oomKills: null });
  });

  it('falls back to cgroup v1 and treats its huge "unlimited" value as no limit', () => {
    const v1 = {
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${100 * MIB}`,
      '/sys/fs/cgroup/memory/memory.max_usage_in_bytes': `${180 * MIB}`,
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      '/sys/fs/cgroup/memory/memory.oom_control': 'oom_kill_disable 0\nunder_oom 0\noom_kill 0\n',
    };
    expect(readContainerMemory(files(v1))).toEqual({ source: 'cgroup-v1', currentBytes: 100 * MIB, peakBytes: 180 * MIB, limitBytes: null, oomKills: 0 });
  });

  it('follows /proc/self/cgroup when the container is not at the cgroup root', () => {
    const nested = { '/proc/self/cgroup': '0::/kubepods/pod1/abc\n', '/sys/fs/cgroup/kubepods/pod1/abc/memory.current': '5000', '/sys/fs/cgroup/kubepods/pod1/abc/memory.peak': '9000', '/sys/fs/cgroup/kubepods/pod1/abc/memory.max': '20000' };
    expect(readContainerMemory(files(nested))).toMatchObject({ currentBytes: 5000, peakBytes: 9000, limitBytes: 20000 });
  });

  it('returns null where there are no cgroup memory files (for example macOS) and ignores garbage', () => {
    expect(readContainerMemory(files({}))).toBeNull();
    expect(readContainerMemory(files({ '/sys/fs/cgroup/memory.current': 'not a number' }))).toBeNull();
  });

  it('snapshotMemory never throws, even if reading throws', () => {
    expect(snapshotMemory(() => { throw new Error('boom'); })).toBeNull();
  });
});

describe('formatCompilationMemory', () => {
  const snap = (peak: number | null, current: number, kills: number | null = 0): MemorySnapshot => ({ source: 'cgroup-v2', currentBytes: current * MIB, peakBytes: peak === null ? null : peak * MIB, limitBytes: 512 * MIB, oomKills: kills });

  it('gives the peak, the earlier peak, the limit and the share of the limit in a stable key=value form', () => {
    const line = formatCompilationMemory(42, 'completed', snap(135, 130), snap(380, 140), 160 * 1024 * 1024);
    expect(line).toContain('[memory] compilation 42 completed:');
    expect(line).toContain('peak_mib=380');
    expect(line).toContain('peak_before_mib=135');
    expect(line).toContain('current_mib=140');
    expect(line).toContain('limit_mib=512');
    expect(line).toContain('oom_kills=0');
    expect(line).toContain('oom_kills_new=0');
    expect(line).toContain('node_max_rss_mib=160');
    expect(line).toContain('(74% of limit)');
  });

  it('reports a new OOM kill during the job', () => {
    expect(formatCompilationMemory(7, 'failed', snap(300, 100, 0), snap(512, 100, 1), null)).toContain('oom_kills_new=1');
  });

  it('says so plainly when the peak or the whole measurement is unavailable', () => {
    expect(formatCompilationMemory(1, 'completed', null, snap(null, 100), null)).toMatch(/peak_mib=n\/a.*kernel does not report a peak/);
    expect(formatCompilationMemory(1, 'completed', null, null, null)).toBe('[memory] compilation 1 completed: unavailable (no cgroup memory files on this host)');
  });
});

describe('logging never affects the caller', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs one line per compilation and one at startup', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const s: MemorySnapshot = { source: 'cgroup-v2', currentBytes: 130 * MIB, peakBytes: 200 * MIB, limitBytes: 512 * MIB, oomKills: 0 };
    logCompilationMemory(9, 'completed', s, () => s);
    logStartupMemory(() => s);
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0][0])).toContain('compilation 9 completed');
    expect(String(log.mock.calls[1][0])).toContain('[memory] worker start');
  });

  it('swallows every failure: a throwing snapshot or a throwing logger changes nothing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('logger broke'); });
    expect(() => logCompilationMemory(1, 'failed', null, () => { throw new Error('boom'); })).not.toThrow();
    expect(() => logStartupMemory(() => { throw new Error('boom'); })).not.toThrow();
  });
});
