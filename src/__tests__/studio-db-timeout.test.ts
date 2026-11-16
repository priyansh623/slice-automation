import { describe, it, expect } from 'vitest';
import { withTimeout } from '../worker/studio';

describe('withTimeout (a quick database step that never answers must not stall the analysis loop)', () => {
  it('passes the value through when the step answers in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 'a step', 50)).resolves.toBe(7);
  });
  it('rejects with the step name when it never answers', async () => {
    await expect(withTimeout(new Promise<number>(() => {}), 'reading the hourly budget', 20)).rejects.toThrow(/reading the hourly budget did not answer within/);
  });
  it('passes an error from the step through unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 'a step', 50)).rejects.toThrow('boom');
  });
});
