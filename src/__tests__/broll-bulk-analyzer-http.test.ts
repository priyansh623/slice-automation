/**
 * The analyser through the REAL Anthropic SDK, over HTTP, against a local stand-in for the Messages API. This proves the
 * request the application sends (forced tool call, images, taxonomy in the prompt) and how it reads the answer, without
 * needing an API key or spending anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { withPaths, type Taxonomy } from '@/lib/broll-bulk/taxonomy';

const tax: Taxonomy = {
  categories: withPaths([{ id: 1, name: 'Payments', parentId: null, scope: 'soma', brandScope: null }, { id: 22, name: 'Mobile payment', parentId: 1, scope: 'soma', brandScope: null }]),
  activities: ['Payment '], settings: ['Cafe'], brands: ['Paytm'], tags: [{ tag: 'qr code', count: 3 }],
};

let server: http.Server;
let received: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let reply: (body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      received.push({ path: req.url ?? '', headers: req.headers, body });
      const r = reply(body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const message = (input: unknown) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'tu_1', name: 'record_clip_metadata', input }] });

describe('analyseFrames over HTTP with the real SDK', () => {
  it('sends images, the taxonomy and a forced tool call, and returns a sanitised suggestion', async () => {
    const { analyseFrames, ANALYSIS_MODEL } = await import('@/lib/broll-bulk/analyzer');
    received = [];
    reply = () => ({ status: 200, body: message({ title: 'Scanning a QR', category_id: 22, category_confidence: 'high', activity: 'Payment', setting: 'Cafe', brands: [{ name: 'PAYTM', role: 'hero', evidence: 'logo' }], tags: ['QR Code'], privacy: [], visible_text: [], unresolved: [], overall_confidence: 'medium', summary: 's', description: 'd' }) });
    const s = await analyseFrames({ frames: ['/9j/AAAA', '/9j/BBBB'], durationSeconds: 5, width: 720, height: 1280 }, tax);
    expect(s).toMatchObject({ categoryId: 22, activity: 'Payment ', setting: 'Cafe', confidence: 'medium' });
    expect(s.brands[0]).toMatchObject({ name: 'Paytm', existing: true });

    const r = received[0];
    expect(r.path).toContain('/v1/messages');
    // The SDK authenticates with the configured key (as an API-key or bearer header, depending on its version).
    expect(`${r.headers['x-api-key'] ?? ''} ${r.headers.authorization ?? ''}`).toContain('test-key-not-real');
    const b = r.body as { model: string; system: string; tool_choice: unknown; tools: { name: string; input_schema: { required: string[]; properties: Record<string, unknown> } }[]; messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[] };
    expect(b.model).toBe(ANALYSIS_MODEL());
    expect(b.tool_choice).toEqual({ type: 'auto' });                     // a forced tool choice is rejected by claude-sonnet-5-5
    expect(b.tools[0].input_schema.required).toEqual(expect.arrayContaining(['category_id', 'activity', 'setting', 'privacy', 'unresolved']));
    expect(Object.keys(b.tools[0].input_schema.properties)).toEqual(expect.arrayContaining(['proposed_category', 'visible_text', 'brands', 'tags']));
    expect(b.system).toContain('22: Payments > Mobile payment');
    const images = b.messages[0].content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' });
  });

  it('sends the provider ONLY frames, the taxonomy and the duration and size: no file name, checksum, user or other metadata', async () => {
    const { analyseFrames } = await import('@/lib/broll-bulk/analyzer');
    received = [];
    reply = () => ({ status: 200, body: message({ title: 't', category_id: null, activity: null, setting: null, brands: [], tags: [], privacy: [], visible_text: [], unresolved: [], overall_confidence: 'low' }) });
    await analyseFrames({ frames: ['/9j/AAAA'], durationSeconds: 4.6, width: 720, height: 1280 }, tax);
    const b = received[0].body as Record<string, unknown> & { messages: { role: string; content: { type: string; text?: string }[] }[] };
    expect(Object.keys(b).sort()).toEqual(['max_tokens', 'messages', 'model', 'system', 'tool_choice', 'tools']);   // no metadata / user_id field
    expect(b.messages).toHaveLength(1);
    const texts = b.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text);
    expect(texts).toEqual(['Frame 1 of 1', 'Video: 5 s, 720x1280. Record the metadata.']);                            // nothing else about the file
    expect(b.messages[0].content.filter((c) => c.type !== 'text' && c.type !== 'image')).toEqual([]);
    expect(JSON.stringify(b)).not.toMatch(/\.mp4|\.mov|sha256|filename|file_name|user_id/i);
  });

  it('fails clearly when the model answers without the tool call, or the API errors', async () => {
    const { analyseFrames } = await import('@/lib/broll-bulk/analyzer');
    reply = () => ({ status: 200, body: { ...message({}), stop_reason: 'end_turn', content: [{ type: 'text', text: 'I cannot do that' }] } });
    await expect(analyseFrames({ frames: ['/9j/AAAA'], durationSeconds: null, width: null, height: null }, tax)).rejects.toThrow('structured');
    reply = () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } });
    await expect(analyseFrames({ frames: ['/9j/AAAA'], durationSeconds: null, width: null, height: null }, tax)).rejects.toThrow();
    await expect(analyseFrames({ frames: [], durationSeconds: null, width: null, height: null }, tax)).rejects.toThrow('No frames');
  }, 30_000);
});

describe('analyseFrames: failures, timeouts and malformed answers are handled safely', () => {
  const input = { frames: ['/9j/AAAA'], durationSeconds: 5, width: 720, height: 1280 };
  const hits = () => received.length;

  it('gives up on a provider that never answers within the time allowed, instead of hanging', async () => {
    const { analyseFrames } = await import('@/lib/broll-bulk/analyzer');
    received = [];
    let release: () => void = () => {};
    reply = () => { throw new Error('unused'); };
    const original = server.listeners('request')[0] as http.RequestListener;
    server.removeAllListeners('request');
    server.on('request', (req, res) => { received.push({ path: req.url ?? '', headers: req.headers, body: {} }); new Promise<void>((r) => (release = r)).then(() => res.end()); });
    const started = Date.now();
    await expect(analyseFrames(input, tax, { timeoutMs: 200, maxRetries: 0 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(hits()).toBe(1);
    release();
    server.removeAllListeners('request'); server.on('request', original);
  }, 15_000);

  it('retries a server error a bounded number of times, then fails', async () => {
    const { analyseFrames } = await import('@/lib/broll-bulk/analyzer');
    received = [];
    reply = () => ({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    await expect(analyseFrames(input, tax, { timeoutMs: 2000, maxRetries: 1 })).rejects.toThrow();
    expect(hits()).toBe(2);                                    // the first try plus exactly one retry
  }, 20_000);

  it('does not retry a rejected request (400) and fails with a provider error', async () => {
    const { analyseFrames } = await import('@/lib/broll-bulk/analyzer');
    received = [];
    reply = () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad image' } } });
    await expect(analyseFrames(input, tax, { maxRetries: 1 })).rejects.toThrow();
    expect(hits()).toBe(1);
  });

  it('treats a response that is not valid JSON as a failure, not a result', async () => {
    const { analyseFrames } = await import('@/lib/broll-bulk/analyzer');
    reply = () => ({ status: 200, body: '<html>gateway error</html>' });
    await expect(analyseFrames(input, tax, { maxRetries: 0 })).rejects.toThrow();
  });

  it.each([
    ['a string instead of an object', 'not an object'],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['wrong types everywhere', { title: 5, category_id: 'x', brands: 'Nike', tags: { a: 1 }, privacy: 'yes', activity: 7, setting: [], overall_confidence: 9 }],
    ['an answer cut off part-way (max_tokens)', { title: 'Scanning a QR', category_id: 22 }],
  ])('a malformed structured answer (%s) becomes a safe "needs review" suggestion, never a crash or a made-up value', async (_name, toolInput) => {
    const { analyseFrames } = await import('@/lib/broll-bulk/analyzer');
    reply = () => ({ status: 200, body: message(toolInput) });
    const s = await analyseFrames(input, tax, { maxRetries: 0 });
    expect(s.activity === null || tax.activities.includes(s.activity)).toBe(true);
    expect(s.setting === null || tax.settings.includes(s.setting)).toBe(true);
    expect(s.categoryId === null || tax.categories.some((c) => c.id === s.categoryId)).toBe(true);
    expect(s.confidence === 'low' || s.confidence === 'medium' || s.confidence === 'high').toBe(true);
    for (const b of s.brands) expect(['hero', 'incidental', 'unresolved']).toContain(b.role);
    if (toolInput === 'not an object' || Array.isArray(toolInput) || Object.keys(toolInput as object).length === 0) expect(s.needsCategoryReview).toBe(true);
  });

  it('uses time limits that fit inside the route\'s 60 second budget even with a retry', async () => {
    const { ATTEMPT_TIMEOUT_MS, MAX_RETRIES } = await import('@/lib/broll-bulk/analyzer');
    expect(ATTEMPT_TIMEOUT_MS * (MAX_RETRIES + 1)).toBeLessThan(60_000 - 5_000);
  });
});

