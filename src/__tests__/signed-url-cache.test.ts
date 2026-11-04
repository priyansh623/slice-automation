/**
 * Signed URL cache logic tests.
 *
 * These test the cache-hit / cache-miss / expiry logic extracted from the
 * dashboard (route.ts GET /api/v1/video-projects) and single-project
 * (route.ts GET /api/v1/video-projects/[id]) endpoints.
 *
 * Tests do NOT make network or DB calls; they validate the pure logic.
 */
import { describe, it, expect } from 'vitest';

const ONE_HOUR_MS = 3_600_000;
const URL_TTL_S = 7 * 24 * 3600; // 604800 seconds

interface ProjectCacheRow {
  id: number;
  baseImagePath: string;
  baseImageSignedUrl: string | null;
  baseImageSignedUrlExpiresAt: number | null;
}

/** Returns true when the cached URL is fresh enough (expires > now + 1 h). */
function isCacheFresh(row: ProjectCacheRow, now: number): boolean {
  return !!(
    row.baseImageSignedUrl &&
    row.baseImageSignedUrlExpiresAt &&
    row.baseImageSignedUrlExpiresAt >= now + ONE_HOUR_MS
  );
}

/** Returns the set of project ids that need their URL refreshed. */
function collectStale(rows: ProjectCacheRow[], now: number): number[] {
  return rows.filter((p) => !isCacheFresh(p, now)).map((p) => p.id);
}

/** Computes the resolved signed URL for a project, preferring cache over refreshedMap. */
function resolveUrl(
  row: ProjectCacheRow,
  refreshedMap: Map<string, string>,
  now: number,
): string | null {
  if (isCacheFresh(row, now)) return row.baseImageSignedUrl!;
  return refreshedMap.get(row.baseImagePath) ?? null;
}

describe('Signed URL cache: isCacheFresh', () => {
  const now = Date.now();

  it('returns false when no cached URL is stored', () => {
    expect(isCacheFresh({ id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null }, now)).toBe(false);
  });

  it('returns false when only the URL is stored (no expiry)', () => {
    expect(isCacheFresh({ id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: 'https://example.com/a.jpg', baseImageSignedUrlExpiresAt: null }, now)).toBe(false);
  });

  it('returns false when the URL expires within the 1-hour buffer', () => {
    const expiry = now + ONE_HOUR_MS - 1; // 1 ms before the buffer boundary
    expect(isCacheFresh({ id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: 'https://x.com/a.jpg', baseImageSignedUrlExpiresAt: expiry }, now)).toBe(false);
  });

  it('returns true when the URL expires exactly at the 1-hour boundary', () => {
    const expiry = now + ONE_HOUR_MS;
    expect(isCacheFresh({ id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: 'https://x.com/a.jpg', baseImageSignedUrlExpiresAt: expiry }, now)).toBe(true);
  });

  it('returns true when the URL has a fresh 7-day TTL', () => {
    const expiry = now + URL_TTL_S * 1000;
    expect(isCacheFresh({ id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: 'https://x.com/a.jpg', baseImageSignedUrlExpiresAt: expiry }, now)).toBe(true);
  });

  it('returns false when the expiry is in the past', () => {
    const expiry = now - 1000;
    expect(isCacheFresh({ id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: 'https://x.com/a.jpg', baseImageSignedUrlExpiresAt: expiry }, now)).toBe(false);
  });
});

describe('Signed URL cache: collectStale', () => {
  const now = Date.now();
  const freshExpiry = now + URL_TTL_S * 1000;
  const staleExpiry = now + ONE_HOUR_MS - 1;

  it('marks all projects as stale when no URLs are cached', () => {
    const rows: ProjectCacheRow[] = [
      { id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null },
      { id: 2, baseImagePath: 'b.jpg', baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null },
    ];
    expect(collectStale(rows, now)).toEqual([1, 2]);
  });

  it('marks only stale projects, leaves fresh ones alone', () => {
    const rows: ProjectCacheRow[] = [
      { id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: 'https://x/a.jpg', baseImageSignedUrlExpiresAt: freshExpiry },
      { id: 2, baseImagePath: 'b.jpg', baseImageSignedUrl: 'https://x/b.jpg', baseImageSignedUrlExpiresAt: staleExpiry },
    ];
    expect(collectStale(rows, now)).toEqual([2]);
  });

  it('returns empty array when all projects have fresh URLs', () => {
    const rows: ProjectCacheRow[] = [
      { id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: 'https://x/a.jpg', baseImageSignedUrlExpiresAt: freshExpiry },
    ];
    expect(collectStale(rows, now)).toHaveLength(0);
  });
});

describe('Signed URL cache: resolveUrl', () => {
  const now = Date.now();
  const freshExpiry = now + URL_TTL_S * 1000;
  const staleExpiry = now + ONE_HOUR_MS - 1;

  it('returns cached URL when fresh', () => {
    const row: ProjectCacheRow = { id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: 'https://cached.com/a.jpg', baseImageSignedUrlExpiresAt: freshExpiry };
    const refreshed = new Map<string, string>();
    expect(resolveUrl(row, refreshed, now)).toBe('https://cached.com/a.jpg');
  });

  it('returns refreshed URL when cache is stale', () => {
    const row: ProjectCacheRow = { id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: 'https://old.com/a.jpg', baseImageSignedUrlExpiresAt: staleExpiry };
    const refreshed = new Map([['a.jpg', 'https://new.com/a.jpg']]);
    expect(resolveUrl(row, refreshed, now)).toBe('https://new.com/a.jpg');
  });

  it('returns null when cache is stale and storage signing failed (not in refreshedMap)', () => {
    const row: ProjectCacheRow = { id: 1, baseImagePath: 'a.jpg', baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null };
    const refreshed = new Map<string, string>();
    expect(resolveUrl(row, refreshed, now)).toBeNull();
  });

  it('user isolation: resolveUrl uses per-project path, not cross-project data', () => {
    const row1: ProjectCacheRow = { id: 1, baseImagePath: 'user1/a.jpg', baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null };
    const row2: ProjectCacheRow = { id: 2, baseImagePath: 'user2/b.jpg', baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null };
    const refreshed = new Map([['user1/a.jpg', 'https://new.com/a.jpg']]);
    // row1 gets its URL, row2 does not (different path)
    expect(resolveUrl(row1, refreshed, now)).toBe('https://new.com/a.jpg');
    expect(resolveUrl(row2, refreshed, now)).toBeNull();
  });
});
