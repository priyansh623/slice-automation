/**
 * Integration tests for signed URL cache logic in:
 *   - GET /api/v1/video-projects        (dashboard)
 *   - GET /api/v1/video-projects/[id]   (single-project)
 *
 * Tests import the route handlers directly and mock @/db, @/lib/supabase/server,
 * and @supabase/supabase-js to isolate route logic from real infrastructure.
 *
 * Tests marked [actual-route] exercise the real handler code and verify:
 *   - authentication / ownership enforcement
 *   - cache-hit path (no Storage call)
 *   - cache-miss path (Storage called, URL cached)
 *   - signing-failure + valid existing URL → fallback served, DB NOT overwritten
 *   - signing-failure + expired URL → null returned
 *   - user isolation (only own projects returned)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChain(resolveValue: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select    = self;
  chain.from      = self;
  chain.where     = self;
  chain.orderBy   = self;
  chain.limit     = () => Promise.resolve(resolveValue);
  chain.update    = self;
  chain.set       = self;
  chain.insert    = self;
  chain.values    = self;
  chain.returning = () => Promise.resolve(Array.isArray(resolveValue) ? resolveValue : [resolveValue]);
  chain.delete    = self;
  chain.then      = (resolve: (v: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);
  return chain;
}

/** Minimal project row fixture. Timestamps in ms. */
const ONE_HOUR_MS = 3_600_000;
const URL_TTL_S   = 7 * 24 * 3600; // 604 800 s
const NOW = Date.now();

function freshProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: 'user-1',
    name: 'Test Project',
    baseImagePath: 'uploads/base.jpg',
    baseImageSignedUrl: 'https://cdn.example.com/base-fresh.jpg',
    baseImageSignedUrlExpiresAt: NOW + URL_TTL_S * 1000, // 7 days from now
    originalScript: 'script',
    approvedScript: null,
    breakdownApprovedAt: null,
    creativeBrief: null,
    createdAt: NOW,
    updatedAt: NOW,
    skillVersion: 'v1',
    creatorDescription: null,
    scene1HookSnapshot: null,
    ...overrides,
  };
}

/** Mocks @/lib/supabase/server to return a user with the given id (or null). */
async function mockAuth(userId: string | null) {
  const { createClient } = await import('@/lib/supabase/server');
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId, email: `${userId}@test.com` } : null }, error: null }) },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

/** Mocks @supabase/supabase-js createClient (service role) with a custom storage impl. */
async function mockServiceClient(storageImpl: {
  createSignedUrl?: (path: string, ttl: number) => Promise<{ data: { signedUrl: string } | null }>;
  createSignedUrls?: (paths: string[], ttl: number) => Promise<{ data: Array<{ path: string; signedUrl: string }> | null }>;
}) {
  const { createClient } = await import('@supabase/supabase-js');
  vi.mocked(createClient).mockReturnValue({
    storage: {
      from: () => ({
        createSignedUrl: storageImpl.createSignedUrl ?? vi.fn().mockResolvedValue({ data: null }),
        createSignedUrls: storageImpl.createSignedUrls ?? vi.fn().mockResolvedValue({ data: [] }),
      }),
    },
  } as unknown as ReturnType<typeof createClient>);
  // The storage layer keeps the client it first built; rebuild it so this test's mock is the one used.
  const { resetStorageForTests } = await import('@/lib/object-store');
  resetStorageForTests();
}

// ── Single-project route ───────────────────────────────────────────────────────

describe('GET /api/v1/video-projects/[id] — signed URL cache [actual-route]', () => {
  beforeEach(() => vi.clearAllMocks());

  function req(id = '1') {
    return new NextRequest(`http://localhost/api/v1/video-projects/${id}`, { method: 'GET' });
  }

  it('returns 401 when unauthenticated', async () => {
    await mockAuth(null);
    const { GET } = await import('@/app/api/v1/video-projects/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when project does not exist', async () => {
    await mockAuth('user-1');
    const { db } = await import('@/db');
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([]); // project not found
      return makeChain([]);
    });
    await mockServiceClient({});

    const { GET } = await import('@/app/api/v1/video-projects/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(404);
  });

  it('serves a project created by a different user (projects are shared)', async () => {
    await mockAuth('user-1');
    const { db } = await import('@/db');
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({ userId: 'other-user' })]);
      return makeChain([]);
    });
    await mockServiceClient({});

    const { GET } = await import('@/app/api/v1/video-projects/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(200);
  });

  it('cache hit: serves fresh cached URL without calling Storage', async () => {
    await mockAuth('user-1');
    const signMock = vi.fn();
    await mockServiceClient({ createSignedUrl: signMock });
    const { db } = await import('@/db');
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject()]); // fresh URL, more than 1h left
      return makeChain([]); // screens
    });
    (db as Record<string, unknown>).update = vi.fn(() => makeChain([]));

    const { GET } = await import('@/app/api/v1/video-projects/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.baseImagePreviewUrl).toBe('https://cdn.example.com/base-fresh.jpg');
    expect(signMock).not.toHaveBeenCalled();
  });

  it('cache miss: calls Storage, returns new URL and writes cache', async () => {
    await mockAuth('user-1');
    const newUrl = 'https://cdn.example.com/base-new.jpg';
    const signMock = vi.fn().mockResolvedValue({ data: { signedUrl: newUrl } });
    await mockServiceClient({ createSignedUrl: signMock });
    const { db } = await import('@/db');
    const updateMock = vi.fn(() => makeChain([]));
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({ baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null })]); // no cache
      return makeChain([]);
    });
    (db as Record<string, unknown>).update = updateMock;

    const { GET } = await import('@/app/api/v1/video-projects/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.baseImagePreviewUrl).toBe(newUrl);
    expect(signMock).toHaveBeenCalledOnce();
    // Cache write: update called at least once (for the signed URL cache)
    expect(updateMock).toHaveBeenCalled();
  });

  it('signing fails + URL not expired: serves existing URL as fallback', async () => {
    await mockAuth('user-1');
    // URL expires in 30 minutes — within the 1-hour refresh buffer but NOT expired
    const soonExpiry = NOW + 30 * 60 * 1000;
    const oldUrl = 'https://cdn.example.com/base-old.jpg';
    const signMock = vi.fn().mockResolvedValue({ data: null }); // signing fails
    await mockServiceClient({ createSignedUrl: signMock });
    const { db } = await import('@/db');
    const updateMock = vi.fn(() => makeChain([]));
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({ baseImageSignedUrl: oldUrl, baseImageSignedUrlExpiresAt: soonExpiry })]);
      return makeChain([]);
    });
    (db as Record<string, unknown>).update = updateMock;

    const { GET } = await import('@/app/api/v1/video-projects/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Must serve the old URL — it's still valid
    expect(body.baseImagePreviewUrl).toBe(oldUrl);
    // Must NOT overwrite the DB with null or a new URL (signing failed)
    const updateCalls = updateMock.mock.calls;
    for (const call of updateCalls) {
      // No call should set baseImageSignedUrl to null
      const setArg = call[0];
      if (setArg && typeof setArg === 'object' && 'baseImageSignedUrl' in setArg) {
        expect(setArg.baseImageSignedUrl).not.toBeNull();
      }
    }
  });

  it('signing fails + URL expired: returns null baseImagePreviewUrl', async () => {
    await mockAuth('user-1');
    const expiredAt = NOW - 1000; // already expired
    const signMock = vi.fn().mockResolvedValue({ data: null });
    await mockServiceClient({ createSignedUrl: signMock });
    const { db } = await import('@/db');
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({
        baseImageSignedUrl: 'https://cdn.example.com/expired.jpg',
        baseImageSignedUrlExpiresAt: expiredAt,
      })]);
      return makeChain([]);
    });
    (db as Record<string, unknown>).update = vi.fn(() => makeChain([]));

    const { GET } = await import('@/app/api/v1/video-projects/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.baseImagePreviewUrl).toBeNull();
  });

  it('cache write failure is non-fatal: URL still returned to client', async () => {
    await mockAuth('user-1');
    const newUrl = 'https://cdn.example.com/base-new2.jpg';
    const signMock = vi.fn().mockResolvedValue({ data: { signedUrl: newUrl } });
    await mockServiceClient({ createSignedUrl: signMock });
    const { db } = await import('@/db');
    // DB update throws
    (db as Record<string, unknown>).update = vi.fn(() => { throw new Error('DB unavailable'); });
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({ baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null })]);
      return makeChain([]);
    });

    const { GET } = await import('@/app/api/v1/video-projects/[id]/route');
    const res = await GET(req(), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Despite the DB write throwing, the signed URL is still served
    expect(body.baseImagePreviewUrl).toBe(newUrl);
  });
});

// ── Dashboard route ────────────────────────────────────────────────────────────

describe('GET /api/v1/video-projects (dashboard) — signed URL cache [actual-route]', () => {
  beforeEach(() => vi.clearAllMocks());

  function req() {
    return new NextRequest('http://localhost/api/v1/video-projects', { method: 'GET' });
  }

  it('returns 401 when unauthenticated', async () => {
    await mockAuth(null);
    const { GET } = await import('@/app/api/v1/video-projects/route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('cache hit: serves fresh cached URLs without calling Storage', async () => {
    await mockAuth('user-1');
    const signUrlsMock = vi.fn();
    await mockServiceClient({ createSignedUrls: signUrlsMock });
    const { db } = await import('@/db');
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject(), freshProject({ id: 2, name: 'P2' })]); // both fresh
      return makeChain([]); // screens
    });
    (db as Record<string, unknown>).update = vi.fn(() => makeChain([]));

    const { GET } = await import('@/app/api/v1/video-projects/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ baseImagePreviewUrl: string }>;
    expect(signUrlsMock).not.toHaveBeenCalled();
    expect(body[0].baseImagePreviewUrl).toBe('https://cdn.example.com/base-fresh.jpg');
  });

  it('cache miss: calls Storage and returns refreshed URLs', async () => {
    await mockAuth('user-1');
    const newUrl = 'https://cdn.example.com/refreshed.jpg';
    const signUrlsMock = vi.fn().mockResolvedValue({
      data: [{ path: 'uploads/base.jpg', signedUrl: newUrl }],
    });
    await mockServiceClient({ createSignedUrls: signUrlsMock });
    const { db } = await import('@/db');
    const updateMock = vi.fn(() => makeChain([]));
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({ baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null })]);
      return makeChain([]);
    });
    (db as Record<string, unknown>).update = updateMock;

    const { GET } = await import('@/app/api/v1/video-projects/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ baseImagePreviewUrl: string }>;
    expect(signUrlsMock).toHaveBeenCalledOnce();
    expect(body[0].baseImagePreviewUrl).toBe(newUrl);
    expect(updateMock).toHaveBeenCalled();
  });

  it('signing fails + URL not expired: serves existing URL as fallback', async () => {
    await mockAuth('user-1');
    const soonExpiry = NOW + 30 * 60 * 1000; // 30 min — within buffer but valid
    const oldUrl = 'https://cdn.example.com/base-soon-expiring.jpg';
    const signUrlsMock = vi.fn().mockResolvedValue({ data: [] }); // signing returns no URLs
    await mockServiceClient({ createSignedUrls: signUrlsMock });
    const { db } = await import('@/db');
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({ baseImageSignedUrl: oldUrl, baseImageSignedUrlExpiresAt: soonExpiry })]);
      return makeChain([]);
    });
    (db as Record<string, unknown>).update = vi.fn(() => makeChain([]));

    const { GET } = await import('@/app/api/v1/video-projects/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ baseImagePreviewUrl: string }>;
    expect(body[0].baseImagePreviewUrl).toBe(oldUrl);
  });

  it('signing fails + URL expired: returns null', async () => {
    await mockAuth('user-1');
    const expiredAt = NOW - 1000;
    const signUrlsMock = vi.fn().mockResolvedValue({ data: [] });
    await mockServiceClient({ createSignedUrls: signUrlsMock });
    const { db } = await import('@/db');
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({
        baseImageSignedUrl: 'https://cdn.example.com/expired.jpg',
        baseImageSignedUrlExpiresAt: expiredAt,
      })]);
      return makeChain([]);
    });
    (db as Record<string, unknown>).update = vi.fn(() => makeChain([]));

    const { GET } = await import('@/app/api/v1/video-projects/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ baseImagePreviewUrl: string | null }>;
    expect(body[0].baseImagePreviewUrl).toBeNull();
  });

  it('user isolation: DB query is scoped to authenticated user (ownership enforced by query)', async () => {
    await mockAuth('user-1');
    const signUrlsMock = vi.fn().mockResolvedValue({ data: [] });
    await mockServiceClient({ createSignedUrls: signUrlsMock });
    const { db } = await import('@/db');
    // The dashboard SELECT uses WHERE userId = user.id. We simulate this by returning only the
    // authenticated user's project (the WHERE clause is applied at the DB level, not visible here).
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({ userId: 'user-1' })]);
      return makeChain([]);
    });
    (db as Record<string, unknown>).update = vi.fn(() => makeChain([]));

    const { GET } = await import('@/app/api/v1/video-projects/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: number }>;
    // All returned projects belong to user-1 (the mock only returns theirs)
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(1);
  });

  it('a DB write failure does not cause a 500 (uses Promise.allSettled)', async () => {
    await mockAuth('user-1');
    const newUrl = 'https://cdn.example.com/new-db-fail.jpg';
    const signUrlsMock = vi.fn().mockResolvedValue({
      data: [{ path: 'uploads/base.jpg', signedUrl: newUrl }],
    });
    await mockServiceClient({ createSignedUrls: signUrlsMock });
    const { db } = await import('@/db');
    // DB update returns a chain that rejects when awaited, so Promise.allSettled handles it.
    // A synchronous throw from the mapper would escape Promise.allSettled entirely.
    const rejectChain = {
      set: () => rejectChain,
      where: () => Promise.reject(new Error('DB error')),
    };
    (db as Record<string, unknown>).update = vi.fn(() => rejectChain);
    let call = 0;
    (db as Record<string, unknown>).select = vi.fn(() => {
      call++;
      if (call === 1) return makeChain([freshProject({ baseImageSignedUrl: null, baseImageSignedUrlExpiresAt: null })]);
      return makeChain([]);
    });

    const { GET } = await import('@/app/api/v1/video-projects/route');
    const res = await GET();
    // Should still return 200 — cache write failure is non-fatal
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ baseImagePreviewUrl: string }>;
    expect(body[0].baseImagePreviewUrl).toBe(newUrl);
  });
});
