import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';
import { ClipProviderError, type ClipInput, type ClipPoll, type ClipProvider, type ClipSubmit } from './clip-provider';

/** A stand-in for development and tests: makes a small synthetic video locally. No network, no cost. Its output is labelled test output by the id 'mock'. */
export interface MockClipOptions {
  pollsBeforeDone?: number;
  failSubmit?: (input: ClipInput) => { code: string; message: string; retryable: boolean; outcome?: 'rejected' | 'unknown' } | null;
  failPoll?: (id: string) => { code: string; message: string; retryable: boolean } | null;
  /** Declare idempotent submits. Default true, like the real provider. */
  idempotent?: boolean;
}

export class MockClipProvider implements ClipProvider {
  readonly id = 'mock';
  readonly model = 'mock-image-to-video';
  readonly idempotentSubmit: boolean;
  /** Everything this instance was asked to submit (tests prove what was sent, and how many times). */
  readonly submitted: Array<{ idempotencyKey: string; prompt: string; durationSeconds: number; imageBytes: number }> = [];
  readonly polls = new Map<string, number>();
  /** Idempotency key -> request id, so replaying a key returns the first request, like the real API. */
  private byKey = new Map<string, string>();
  constructor(private readonly opts: MockClipOptions = {}) { this.idempotentSubmit = opts.idempotent !== false; }

  async submit(input: ClipInput): Promise<ClipSubmit> {
    this.submitted.push({ idempotencyKey: input.idempotencyKey, prompt: input.prompt, durationSeconds: input.durationSeconds, imageBytes: input.image.length });
    const fail = this.opts.failSubmit?.(input);
    if (fail) throw new ClipProviderError(fail.message, fail.code, fail.retryable, fail.outcome ?? 'rejected');
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return { providerRequestId: existing };
    const id = `mockclip-${this.byKey.size + 1}-${input.durationSeconds}`;
    this.byKey.set(input.idempotencyKey, id);
    return { providerRequestId: id };
  }

  async poll(id: string): Promise<ClipPoll> {
    const fail = this.opts.failPoll?.(id);
    if (fail) return { status: 'failed', ...fail };
    const n = (this.polls.get(id) ?? 0) + 1; this.polls.set(id, n);
    if (n <= (this.opts.pollsBeforeDone ?? 1)) return { status: 'processing' };
    return { status: 'succeeded', video: makeMockVideo(Number(id.split('-').pop()) || 5), mime: 'video/mp4' };
  }
}

/** A landscape-free portrait clip with a tone, to prove the pipeline normalises size and strips sound. */
export function makeMockVideo(seconds: number): Buffer {
  if (!ffmpegStaticPath) throw new Error('ffmpeg-static binary not found');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-mockclip-'));
  const out = path.join(dir, 'clip.mp4');
  try {
    const r = spawnSync(ffmpegStaticPath, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=green:s=768x1344:r=24:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=700:sample_rate=44100:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out], { stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`mock clip failed: ${r.stderr?.toString().slice(-300)}`);
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
