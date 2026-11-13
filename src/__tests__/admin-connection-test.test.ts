import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const holder = vi.hoisted(() => ({ ping: vi.fn(), constructed: 0 }));
vi.mock('@/db', () => ({ db: { execute: async () => [{ '?column?': 1 }] } }));
vi.mock('@/lib/api-auth', () => ({ requireUser: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) }, storage: { from: () => ({ list: async () => ({ error: null }) }) } }),
}));
vi.mock('@/lib/object-store/r2-provider', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/object-store/r2-provider')>();
  return { ...real, R2Provider: class { constructor() { holder.constructed++; } ping() { return holder.ping(); } } };
});

import { GET } from '@/app/api/v1/admin/connection-test/route';

const R2_VARS = { R2_ACCOUNT_ID: 'acct1', R2_ACCESS_KEY_ID: 'AKID-SECRET-ID', R2_SECRET_ACCESS_KEY: 'very-secret-value', R2_BUCKET_VIDEOS: 'v', R2_BUCKET_UPLOADS: 'u' };
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [...Object.keys(R2_VARS), 'ANTHROPIC_API_KEY', 'USEAPI_TOKEN', 'STORAGE_WRITE_PROVIDER']) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.ANTHROPIC_API_KEY = 'x'; process.env.USEAPI_TOKEN = 'x';
  holder.ping.mockReset(); holder.constructed = 0;
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const run = async () => (await GET()).json() as Promise<{ ok: boolean; results: Record<string, { ok: boolean; detail: string; configured?: boolean }> }>;

describe('admin connection test: storage providers', () => {
  it('reports an unconfigured R2 as not configured, makes no R2 call, and stays healthy', async () => {
    const body = await run();
    expect(body.results.r2).toMatchObject({ ok: true, configured: false });
    expect(body.results.r2.detail).toMatch(/not configured/i);
    expect(holder.constructed).toBe(0);
    expect(body.results.storage.ok).toBe(true); // Supabase storage check unchanged
    expect(body.ok).toBe(true);
  });

  it('reports a reachable R2 as connected', async () => {
    Object.assign(process.env, R2_VARS);
    holder.ping.mockResolvedValue([{ bucket: 'videos', ok: true, detail: 'Bucket "v" reachable' }, { bucket: 'uploads', ok: true, detail: 'Bucket "u" reachable' }]);
    const body = await run();
    expect(body.results.r2).toMatchObject({ ok: true, configured: true });
    expect(body.ok).toBe(true);
  });

  it('reports a configured R2 that fails as a failure, distinct from not configured, without leaking secrets', async () => {
    Object.assign(process.env, R2_VARS);
    holder.ping.mockResolvedValue([{ bucket: 'videos', ok: false, detail: 'Bucket "v": AccessDenied' }, { bucket: 'uploads', ok: true, detail: 'ok' }]);
    const body = await run();
    expect(body.results.r2).toMatchObject({ ok: false, configured: true });
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('very-secret-value');
    expect(JSON.stringify(body)).not.toContain('AKID-SECRET-ID');
  });

  it('turns a thrown R2 error into a failure and never throws', async () => {
    Object.assign(process.env, R2_VARS);
    holder.ping.mockRejectedValue(new Error('network down'));
    const body = await run();
    expect(body.results.r2).toMatchObject({ ok: false, configured: true });
    expect(body.results.r2.detail).toContain('network down');
  });

  it('says where new files go, and flags R2 writes requested without R2 configured', async () => {
    expect((await run()).results.storageRouting.detail).toContain('New files go to Supabase');
    process.env.STORAGE_WRITE_PROVIDER = 'r2';
    const body = await run();
    expect(body.results.storageRouting.ok).toBe(false);
    expect(body.results.storageRouting.detail).toMatch(/not configured/i);
  });
});
