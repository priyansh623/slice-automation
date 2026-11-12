/**
 * Integration tests for POST /api/v1/analytics-events
 *
 * Tests actual route handler responses (auth, ownership, validation) by
 * importing the handler directly and mocking @/db + @/lib/supabase/server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function chain(val: unknown) {
  const self: Record<string, unknown> = {};
  const thennableArr = Array.isArray(val) ? val : [val];
  self.select    = () => self;
  self.from      = () => self;
  self.where     = () => self;
  self.limit     = () => Promise.resolve(thennableArr);
  self.insert    = () => self;
  self.values    = () => self;
  self.returning = () => Promise.resolve(thennableArr);
  return self;
}

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v1/analytics-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/analytics-events', () => {
  beforeEach(() => vi.clearAllMocks());

  async function mockUser(id: string | null) {
    const { createClient } = await import('@/lib/supabase/server');
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: id ? { id } : null }, error: null }) },
    } as unknown as Awaited<ReturnType<typeof createClient>>);
  }

  it('returns 401 when unauthenticated', async () => {
    await mockUser(null);

    const { POST } = await import('@/app/api/v1/analytics-events/route');
    const res = await POST(request({ eventType: 'test_event' }));

    expect(res.status).toBe(401);
  });

  it('returns 400 when eventType is missing', async () => {
    await mockUser('user-1');

    const { POST } = await import('@/app/api/v1/analytics-events/route');
    const res = await POST(request({ payload: { foo: 1 } }));

    expect(res.status).toBe(400);
  });

  it('returns 201 for an event with no videoProjectId', async () => {
    await mockUser('user-1');

    const { db } = await import('@/db');
    (db as unknown as Record<string, unknown>).insert = vi.fn(() =>
      chain([{ id: 1, eventType: 'test_event', userId: 'user-1', videoProjectId: null, payload: null, createdAt: 0 }]),
    );

    const { POST } = await import('@/app/api/v1/analytics-events/route');
    const res = await POST(request({ eventType: 'test_event' }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.eventType).toBe('test_event');
  });

  it('returns 404 when videoProjectId references a non-existent project', async () => {
    await mockUser('user-1');

    const { db } = await import('@/db');
    (db as unknown as Record<string, unknown>).select = vi.fn(() =>
      chain([]), // project not found → empty array
    );

    const { POST } = await import('@/app/api/v1/analytics-events/route');
    const res = await POST(request({ eventType: 'test_event', videoProjectId: 999 }));

    expect(res.status).toBe(404);
  });

  it('records the event when the referenced project was created by a different user (projects are shared)', async () => {
    await mockUser('user-other');

    const { db } = await import('@/db');
    (db as unknown as Record<string, unknown>).select = vi.fn(() =>
      chain([{ userId: 'user-owner', id: 42 }]), // project was created by a different user
    );
    (db as unknown as Record<string, unknown>).insert = vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }));

    const { POST } = await import('@/app/api/v1/analytics-events/route');
    const res = await POST(request({ eventType: 'test_event', videoProjectId: 42 }));

    expect(res.status).toBe(201);
  });

  it('returns 201 when user owns the referenced project', async () => {
    const ownerUserId = 'user-owner-ok';
    await mockUser(ownerUserId);

    const { db } = await import('@/db');
    let call = 0;
    (db as unknown as Record<string, unknown>).select = vi.fn(() => {
      call++;
      // Only the ownership check
      return chain([{ userId: ownerUserId, id: 42 }]);
    });
    (db as unknown as Record<string, unknown>).insert = vi.fn(() =>
      chain([{ id: 5, eventType: 'test_event', userId: ownerUserId, videoProjectId: 42, payload: null, createdAt: 0 }]),
    );

    const { POST } = await import('@/app/api/v1/analytics-events/route');
    const res = await POST(request({ eventType: 'test_event', videoProjectId: 42 }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userId).toBe(ownerUserId);
    expect(body.videoProjectId).toBe(42);
  });

  it('does not check ownership when videoProjectId is null', async () => {
    await mockUser('user-1');

    const { db } = await import('@/db');
    const selectMock = vi.fn(() => chain([]));
    (db as unknown as Record<string, unknown>).select = selectMock;
    (db as unknown as Record<string, unknown>).insert = vi.fn(() =>
      chain([{ id: 1, eventType: 'no_project', userId: 'user-1', videoProjectId: null, payload: null, createdAt: 0 }]),
    );

    const { POST } = await import('@/app/api/v1/analytics-events/route');
    const res = await POST(request({ eventType: 'no_project', videoProjectId: null }));

    expect(res.status).toBe(201);
    // select was never called for ownership check when videoProjectId is null
    expect(selectMock).not.toHaveBeenCalled();
  });
});
