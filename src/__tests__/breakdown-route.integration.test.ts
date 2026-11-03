/**
 * Integration tests for PUT /api/v1/video-projects/[id]/breakdown
 *
 * These tests import the route handler directly, construct NextRequest objects,
 * and mock @/db and @/lib/supabase/server to isolate the route logic from the
 * real database and authentication infrastructure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks (must be declared before any import that transitively uses them) ────

vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build the Drizzle-style query chain mock. Supports .select().from().where().limit() and .update().set().where() */
function makeChain(resolveValue: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.from   = self;
  chain.where  = self;
  chain.limit  = () => Promise.resolve(resolveValue);
  chain.update = self;
  chain.set    = self;
  chain.insert = self;
  chain.values = self;
  chain.returning = () => Promise.resolve(Array.isArray(resolveValue) ? resolveValue : [resolveValue]);
  chain.delete = self;
  chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);
  return chain;
}

/** Create a db mock whose methods all resolve with the values in the provided queue */
function buildDb(callQueue: Array<unknown>) {
  let callIndex = 0;
  const next = () => callQueue[callIndex++] ?? [];

  return {
    select: vi.fn(() => {
      const val = next();
      return makeChain(val);
    }),
    update: vi.fn(() => {
      const val = next();
      return makeChain(val);
    }),
    insert: vi.fn(() => {
      const val = next();
      return makeChain(val);
    }),
    delete: vi.fn(() => {
      const val = next();
      return makeChain(val);
    }),
  };
}

function makeRequest(projectId: number, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/video-projects/${projectId}/breakdown`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const USER_ID   = 'user-uuid-001';
const PROJECT_ID = 42;

// ── Test suite ────────────────────────────────────────────────────────────────

describe('PUT /api/v1/video-projects/[id]/breakdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupAuthMock(userId: string) {
    const { createClient } = await import('@/lib/supabase/server');
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    } as unknown as Awaited<ReturnType<typeof createClient>>);
  }

  it('returns 401 when user is not authenticated', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const { PUT } = await import('@/app/api/v1/video-projects/[id]/breakdown/route');
    const res = await PUT(
      makeRequest(PROJECT_ID, { screens: [] }),
      { params: Promise.resolve({ id: String(PROJECT_ID) }) },
    );

    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not the project owner', async () => {
    await setupAuthMock(USER_ID);

    const { db } = await import('@/db');
    // requireProjectOwner → select from videoProjects → returns a different userId
    (db as unknown as Record<string, unknown>).select = vi.fn(() =>
      makeChain([{ userId: 'some-other-user', id: PROJECT_ID, name: 'test' }]),
    );

    const { PUT } = await import('@/app/api/v1/video-projects/[id]/breakdown/route');
    const res = await PUT(
      makeRequest(PROJECT_ID, { screens: [{ screenNumber: 1, dialogue: 'Hi' }] }),
      { params: Promise.resolve({ id: String(PROJECT_ID) }) },
    );

    expect(res.status).toBe(403);
  });

  it('returns 409 when a removed screen has prompt version history', async () => {
    await setupAuthMock(USER_ID);

    const { db } = await import('@/db');
    let selectCall = 0;
    (db as unknown as Record<string, unknown>).select = vi.fn(() => {
      selectCall++;
      // Call 1: requireProjectOwner → project row with correct userId
      if (selectCall === 1)
        return makeChain([{ userId: USER_ID, id: PROJECT_ID, name: 'test' }]);
      // Call 2: existing screens — includes screen #2 which won't be in incoming
      if (selectCall === 2)
        return makeChain([
          { id: 10, screenNumber: 1, dialogue: 'Hello', videoProjectId: PROJECT_ID, position: 1, durationSeconds: null, durationNote: null, createdAt: 0, updatedAt: 0 },
          { id: 11, screenNumber: 2, dialogue: 'World', videoProjectId: PROJECT_ID, position: 2, durationSeconds: null, durationNote: null, createdAt: 0, updatedAt: 0 },
        ]);
      // Call 3 (pvRows): prompt versions exist for screen 11
      if (selectCall === 3) return makeChain([{ videoScreenId: 11 }]);
      // Call 4 (genRows): no generations
      if (selectCall === 4) return makeChain([]);
      return makeChain([]);
    });
    // Promise.all calls both in parallel — we need both mocks to work
    // Reset to allow two concurrent results

    const { PUT } = await import('@/app/api/v1/video-projects/[id]/breakdown/route');
    const res = await PUT(
      // Incoming: only screen 1 — screen 2 is being "removed"
      makeRequest(PROJECT_ID, { screens: [{ screenNumber: 1, dialogue: 'Hello' }] }),
      { params: Promise.resolve({ id: String(PROJECT_ID) }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toHaveProperty('blockedScreenNumbers');
    expect(body.blockedScreenNumbers).toContain(2);
    expect(body.error).toMatch(/Cannot remove screens/);
  });

  it('returns 409 when a removed screen has generation history', async () => {
    await setupAuthMock(USER_ID);

    const { db } = await import('@/db');
    let selectCall = 0;
    (db as unknown as Record<string, unknown>).select = vi.fn(() => {
      selectCall++;
      if (selectCall === 1) return makeChain([{ userId: USER_ID, id: PROJECT_ID, name: 'test' }]);
      if (selectCall === 2) return makeChain([
        { id: 10, screenNumber: 1, dialogue: 'A', videoProjectId: PROJECT_ID, position: 1, durationSeconds: null, durationNote: null, createdAt: 0, updatedAt: 0 },
        { id: 11, screenNumber: 2, dialogue: 'B', videoProjectId: PROJECT_ID, position: 2, durationSeconds: null, durationNote: null, createdAt: 0, updatedAt: 0 },
      ]);
      // pvRows: no prompt versions
      if (selectCall === 3) return makeChain([]);
      // genRows: generation exists for screen 11
      if (selectCall === 4) return makeChain([{ videoScreenId: 11 }]);
      return makeChain([]);
    });

    const { PUT } = await import('@/app/api/v1/video-projects/[id]/breakdown/route');
    const res = await PUT(
      makeRequest(PROJECT_ID, { screens: [{ screenNumber: 1, dialogue: 'A' }] }),
      { params: Promise.resolve({ id: String(PROJECT_ID) }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.blockedScreenNumbers).toContain(2);
  });

  it('marks prompt versions stale when dialogue changes', async () => {
    await setupAuthMock(USER_ID);

    const { db } = await import('@/db');
    const updateMock = vi.fn(() => makeChain([]));
    let selectCall = 0;
    (db as unknown as Record<string, unknown>).select = vi.fn(() => {
      selectCall++;
      // requireProjectOwner
      if (selectCall === 1) return makeChain([{ userId: USER_ID, id: PROJECT_ID, name: 'test' }]);
      // existingScreens — one screen with dialogue 'Old text'
      if (selectCall === 2) return makeChain([
        { id: 10, screenNumber: 1, dialogue: 'Old text', videoProjectId: PROJECT_ID, position: 1, durationSeconds: null, durationNote: null, createdAt: 0, updatedAt: 0 },
      ]);
      // Final select of all screens
      return makeChain([
        { id: 10, screenNumber: 1, dialogue: 'New text', videoProjectId: PROJECT_ID, position: 1, durationSeconds: null, durationNote: null, createdAt: 0, updatedAt: 0 },
      ]);
    });
    (db as unknown as Record<string, unknown>).update = updateMock;

    const { PUT } = await import('@/app/api/v1/video-projects/[id]/breakdown/route');
    const res = await PUT(
      makeRequest(PROJECT_ID, {
        screens: [{ screenNumber: 1, dialogue: 'New text' }],
      }),
      { params: Promise.resolve({ id: String(PROJECT_ID) }) },
    );

    expect(res.status).toBe(200);
    // update should have been called to mark stale + update videoProjects
    expect(updateMock).toHaveBeenCalled();
  });

  it('allows removing a screen that has no prompt version or generation history', async () => {
    await setupAuthMock(USER_ID);

    const { db } = await import('@/db');
    const deleteMock = vi.fn(() => makeChain([]));
    let selectCall = 0;
    (db as unknown as Record<string, unknown>).select = vi.fn(() => {
      selectCall++;
      if (selectCall === 1) return makeChain([{ userId: USER_ID, id: PROJECT_ID, name: 'test' }]);
      if (selectCall === 2) return makeChain([
        { id: 10, screenNumber: 1, dialogue: 'A', videoProjectId: PROJECT_ID, position: 1, durationSeconds: null, durationNote: null, createdAt: 0, updatedAt: 0 },
        { id: 11, screenNumber: 2, dialogue: 'B', videoProjectId: PROJECT_ID, position: 2, durationSeconds: null, durationNote: null, createdAt: 0, updatedAt: 0 },
      ]);
      // pvRows: no history
      if (selectCall === 3) return makeChain([]);
      // genRows: no history
      if (selectCall === 4) return makeChain([]);
      // Final getAllScreens after upsert
      return makeChain([
        { id: 10, screenNumber: 1, dialogue: 'A', videoProjectId: PROJECT_ID, position: 1, durationSeconds: null, durationNote: null, createdAt: 0, updatedAt: 0 },
      ]);
    });
    (db as unknown as Record<string, unknown>).delete = deleteMock;
    (db as unknown as Record<string, unknown>).update = vi.fn(() => makeChain([]));
    (db as unknown as Record<string, unknown>).insert = vi.fn(() => makeChain([]));

    const { PUT } = await import('@/app/api/v1/video-projects/[id]/breakdown/route');
    const res = await PUT(
      makeRequest(PROJECT_ID, { screens: [{ screenNumber: 1, dialogue: 'A' }] }),
      { params: Promise.resolve({ id: String(PROJECT_ID) }) },
    );

    expect(res.status).toBe(200);
    // delete should have been called for screen 2
    expect(deleteMock).toHaveBeenCalled();
  });
});
