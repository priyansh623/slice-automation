import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

/** In-memory stand-in for the R2 parts of the storage layer that Studio uses. */
export class FakeR2 {
  objects = new Map<string, { buf: Buffer; contentType: string }>();
  puts: string[] = [];
  deletes: string[] = [];
  available = true;
  failPut = false;
  private k = (b: string, key: string) => `${b}/${key}`;
  r2Configured() { return this.available; }
  directUploadAvailable() { return this.available; }
  async signedDirectUpload(_b: string, key: string, contentType: string, size: number) { return { url: `https://r2.test/${key}?size=${size}`, method: 'PUT' as const, headers: { 'Content-Type': contentType } }; }
  async headR2(b: string, key: string) { const o = this.objects.get(this.k(b, key)); return o ? { size: o.buf.length, contentType: o.contentType, etag: 'e' } : null; }
  async downloadR2Only(b: string, key: string) { const o = this.objects.get(this.k(b, key)); if (!o) throw new Error('missing'); return o.buf; }
  async putR2Only(b: string, key: string, buf: Buffer, opts: { contentType: string }) {
    if (!this.available || this.failPut) throw new Error('r2 down');
    if (this.objects.has(this.k(b, key))) { const { ObjectExistsError } = await import('@/lib/object-store/types'); throw new ObjectExistsError(b as 'uploads', key); }
    this.puts.push(key); this.objects.set(this.k(b, key), { buf, contentType: opts.contentType }); return { provider: 'r2' as const };
  }
  async deleteFromR2(b: string, key: string) { this.deletes.push(key); this.objects.delete(this.k(b, key)); }
  async signedReadUrls(b: string, keys: string[]) { return new Map(keys.filter((k) => this.objects.has(this.k(b, k))).map((k) => [k, `https://r2.test/${k}?sig=1`] as [string, string])); }
  browserPut(key: string, buf: Buffer, contentType: string) { this.objects.set(this.k('uploads', key), { buf, contentType }); }
  has(key: string) { return this.objects.has(this.k('uploads', key)); }
  get(key: string) { return this.objects.get(this.k('uploads', key))!.buf; }
}

const ROOT = path.resolve(__dirname, '../../..');

/** Builds the schema in an in-memory Postgres from the repository's real migration files. */
export async function migrate(target: PGlite): Promise<void> {
  await target.exec(`create schema if not exists auth; create or replace function auth.uid() returns uuid language sql as 'select null::uuid'; create or replace function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;`);
  const files = fs.readdirSync(path.join(ROOT, 'drizzle/pg')).filter((f) => /^00\d\d_.*\.sql$/.test(f) && !f.includes('verification')).sort();
  for (const f of files.filter((m) => m < '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
  await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/0009_broll_categories.sql'), 'utf8'));
  for (const f of files.filter((m) => m >= '0022_')) await target.exec(fs.readFileSync(path.join(ROOT, 'drizzle/pg', f), 'utf8'));
}

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
export async function call(handler: unknown, opts: { method?: string; body?: unknown; query?: string; params?: Record<string, string> } = {}) {
  const url = `http://localhost/api${opts.query ? `?${opts.query}` : ''}`;
  const req = new NextRequest(url, { method: opts.method ?? 'GET', ...(opts.body !== undefined ? { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } } : {}) });
  const res = await (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/**
 * Makes the database look like a Studio worker is running and reporting: batches are only accepted while a worker that uses the
 * same provider as the web app is ready. `ageMs` makes the report old (a worker that stopped reporting).
 */
export async function reportFakeWorker(target: PGlite, over: { id?: string; provider?: string | null; mode?: 'disabled' | 'mock' | 'real'; ready?: boolean; r2Ready?: boolean; enabled?: boolean; ageMs?: number } = {}): Promise<void> {
  const provider = over.provider === undefined ? 'mock' : over.provider;
  const mode = over.mode ?? (provider === 'mock' ? 'mock' : provider ? 'real' : 'disabled');
  const ready = over.ready ?? true;
  const seen = Date.now() - (over.ageMs ?? 0);
  await target.query(
    `insert into studio_worker_status (worker_id, provider, mode, generation_ready, r2_ready, worker_enabled, analysis_ready, details, started_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, true, '{}'::jsonb, $7, $7)
     on conflict (worker_id) do update set provider = $2, mode = $3, generation_ready = $4, r2_ready = $5, worker_enabled = $6, last_seen_at = $7`,
    [over.id ?? 'test-worker', provider, mode, ready, over.r2Ready ?? true, over.enabled ?? true, seen],
  );
}
