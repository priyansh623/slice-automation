/**
 * Writes the video inside a concatenation answer straight to a file, chunk by chunk. The answer is JSON holding the whole MP4 as base64
 * (`encodedVideo`; older answers used `video` or `videoBase64`): parsing it in memory held the video several times over on a 512 MB worker.
 * Returns the bytes written, or -1 with the start of the answer when there is no video field (it may hold a `videoUrl` or an error).
 */
import * as fs from 'node:fs';

const KEYS = ['"encodedVideo":"', '"videoBase64":"', '"video":"'];
const KEEP_FOR_DIAGNOSIS = 100_000;

export async function decodeConcatAnswer(body: ReadableStream<Uint8Array>, outputPath: string): Promise<{ bytes: number; rest: string }> {
  const reader = body.getReader();
  const out = fs.createWriteStream(outputPath);
  const write = (b: Buffer) => new Promise<void>((resolve, reject) => out.write(b, (e) => (e ? reject(e) : resolve())));
  let head = ''; let found = false; let done = false; let carry = ''; let bytes = 0; let tail = '';
  try {
    while (!done) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      let text = Buffer.from(value).toString('latin1');
      if (!found) {
        head += text;
        const hit = KEYS.map((k) => ({ k, at: head.indexOf(k) })).filter((x) => x.at !== -1).sort((a, b) => a.at - b.at)[0];
        if (!hit) { if (head.length > KEEP_FOR_DIAGNOSIS) head = head.slice(-64); continue; }
        found = true; text = head.slice(hit.at + hit.k.length); head = '';
      }
      const end = text.indexOf('"');
      if (end !== -1) { text = text.slice(0, end); done = true; }
      text = tail + text; tail = '';
      if (text.endsWith('\\') && !done) { tail = '\\'; text = text.slice(0, -1); }   // an escape split across chunks
      carry += text.replace(/\\\//g, '/').replace(/\\[rn]|[\r\n]/g, '');
      const usable = carry.length - (carry.length % 4);
      if (usable > 0) { const b = Buffer.from(carry.slice(0, usable), 'base64'); bytes += b.length; await write(b); carry = carry.slice(usable); }
    }
    if (found && !done) throw new Error('The concatenation answer ended in the middle of the video.');   // never keep a truncated video
    if (found && carry.length > 0) { const b = Buffer.from(carry, 'base64'); bytes += b.length; await write(b); }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
    reader.cancel().catch(() => {});
  }
  return { bytes: found ? bytes : -1, rest: found ? '' : head };
}
