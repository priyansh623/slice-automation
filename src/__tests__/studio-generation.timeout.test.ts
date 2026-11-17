import { describe, it, expect } from 'vitest';
import { generationRound } from '@/lib/studio/generation';

describe('the generation loop cannot freeze silently', () => {
  const never = () => new Promise<never>(() => {});
  const deps = { provider: () => { throw new Error('unused'); }, read: async () => Buffer.alloc(0), put: async () => 'created' as const };
  it('a claim that never answers becomes an error after the limit, so the loop logs it and tries again', async () => {
    const t0 = Date.now();
    await expect(generationRound({ ...deps, dbTimeoutMs: 60, claim: never as never }, { submit: 1, poll: 1 })).rejects.toThrow(/claiming queued images did not answer within/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('a lookup of due jobs that never answers is turned into an error too', async () => {
    await expect(generationRound({ ...deps, dbTimeoutMs: 60, claim: (async () => []) as never, due: never as never }, { submit: 1, poll: 1 })).rejects.toThrow(/finding images to check did not answer/);
  });
  it('with no limit set nothing changes (the claim result is used as is)', async () => {
    expect(await generationRound({ ...deps, claim: (async () => []) as never, due: (async () => []) as never }, { submit: 1, poll: 1 })).toBe(0);
  });
});
