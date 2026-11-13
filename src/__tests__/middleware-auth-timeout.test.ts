import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const holder = vi.hoisted(() => ({ getUser: undefined as unknown as () => Promise<unknown> }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: () => holder.getUser() } }),
}));

import { middleware, AUTH_CHECK_TIMEOUT_MS } from '@/middleware';

const pageRequest = () => new NextRequest('http://localhost/broll');

describe('middleware auth check', () => {
  beforeEach(() => { vi.useFakeTimers(); process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid'; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'x'; });
  afterEach(() => { vi.useRealTimers(); });

  it('lets a signed-in visitor through', async () => {
    holder.getUser = async () => ({ data: { user: { id: 'u1' } } });
    const res = await middleware(pageRequest());
    expect(res.status).toBe(200);
  });

  it('redirects a signed-out visitor to /login', async () => {
    holder.getUser = async () => ({ data: { user: null } });
    const res = await middleware(pageRequest());
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
  });

  it('does not hang when Supabase Auth never answers: sends the visitor to /login after the time limit', async () => {
    holder.getUser = () => new Promise(() => undefined); // never resolves
    const pending = middleware(pageRequest());
    await vi.advanceTimersByTimeAsync(AUTH_CHECK_TIMEOUT_MS + 10);
    const res = await pending;
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
  });

  it('treats an auth error the same way', async () => {
    holder.getUser = async () => { throw new Error('boom'); };
    const res = await middleware(pageRequest());
    expect(res.status).toBe(307);
  });

  it('keeps the limit well under the 25 second platform cutoff', () => {
    expect(AUTH_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
