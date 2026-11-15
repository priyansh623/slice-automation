import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { analyseImage, prepareForAnalysis, ANALYSIS_LONG_EDGE, type MessagesClient } from '@/lib/studio/analyzer';
import { ANALYSIS_SYSTEM_PROMPT, ANALYSIS_TOOL, ANALYSIS_TOOL_SCHEMA } from '@/lib/studio/analysis-schema';
import { METADATA_FIELDS } from '@/lib/studio/metadata';

const toolReply = (input: unknown) => ({ content: [{ type: 'tool_use', name: ANALYSIS_TOOL, id: 't', input }] }) as never;
const fakeClient = (reply: unknown) => {
  const create = vi.fn(async () => reply as never);
  return { client: { messages: { create } } as unknown as MessagesClient, create };
};
const copy = { base64: 'eA==', mediaType: 'image/jpeg' as const };

describe('prepareForAnalysis: the model sees a small copy, the original is untouched', () => {
  it('downscales a large image to a JPEG within 1568 px, without changing the input bytes', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#3366aa' } }).png().toBuffer();
    const snapshot = Buffer.from(big);
    const out = await prepareForAnalysis(big);
    expect(big.equals(snapshot)).toBe(true);
    const meta = await sharp(Buffer.from(out.base64, 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(ANALYSIS_LONG_EDGE);
    expect(out.base64.length * 0.75).toBeLessThan(4_000_000);
  });

  it('handles transparent PNGs and does not enlarge small images', async () => {
    const png = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.4 } } }).png().toBuffer();
    const meta = await sharp(Buffer.from((await prepareForAnalysis(png)).base64, 'base64')).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 200, height: 100 });
  });

  it('refuses bytes that are not an image', async () => {
    await expect(prepareForAnalysis(Buffer.from('nope'))).rejects.toThrow();
  });
});

describe('analyseImage', () => {
  it('sends one image, asks for the tool, never sends a file name, and returns sanitised metadata', async () => {
    const { client, create } = fakeClient(toolReply({ environment: ' busy  cafe ', description: 'A cafe.', tags: ['Cafe', 'cafe', 'coffee'], gender: 'x', unknown: 1 }));
    const r = await analyseImage(copy, { client, model: 'test-model' });
    expect(r.model).toBe('test-model');
    expect(r.metadata).toEqual({ environment: 'busy cafe', description: 'A cafe.', tags: ['cafe', 'coffee'] });
    const args = (create.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(args.tool_choice).toEqual({ type: 'auto' });
    expect(args.tools[0].name).toBe(ANALYSIS_TOOL);
    expect(args.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'eA==' } });
    expect(JSON.stringify(args)).not.toMatch(/\.(png|jpg|jpeg|webp)/i);
  });

  it('fails clearly when the model does not call the tool or returns nothing usable', async () => {
    await expect(analyseImage(copy, { client: fakeClient({ content: [{ type: 'text', text: 'hi' }] }).client })).rejects.toThrow('did not return structured metadata');
    await expect(analyseImage(copy, { client: fakeClient(toolReply({ gender: 'x' })).client })).rejects.toThrow('no usable metadata');
  });

  it('asks for exactly the agreed fields and tells the model not to describe people\'s appearance', () => {
    expect(Object.keys(ANALYSIS_TOOL_SCHEMA.properties).sort()).toEqual([...METADATA_FIELDS].sort());
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/gender, age, ethnicity/);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/Never identify anyone/);
  });
});
