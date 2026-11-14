import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as crypto from 'node:crypto';
import { brollClips, storageObjects } from '@/db/schema.pg';
import { findBackfillCandidates, recordChecksum, runBackfill, type BackfillDeps } from '@/lib/broll-bulk/checksum-backfill';
import { addClip, createBrollTestDb, TEST_USER_ID, type BrollTestDb } from './helpers/broll-test-db';

let t: BrollTestDb;
beforeAll(async () => {
  t = await createBrollTestDb('current');
  await t.pg.exec(`create table if not exists storage_objects (bucket text not null, key text not null, provider text not null, size_bytes bigint, content_type text, sha256 text, verified_at bigint, created_at bigint not null, updated_at bigint not null, primary key (bucket, key))`);
}, 60_000);
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.reset(); await t.pg.exec('truncate storage_objects'); });

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
async function seed(key: string, content: string, over: { registrySha?: string | null; provider?: string; registrySize?: number; clipSize?: number } = {}) {
  const now = Date.now();
  const id = await addClip(t, { title: `Clip ${key}`, userId: TEST_USER_ID, storagePath: key, fileSizeBytes: over.clipSize ?? content.length });
  await t.db.insert(storageObjects).values({ bucket: 'uploads', key, provider: over.provider ?? 'r2', sizeBytes: over.registrySize ?? content.length, sha256: over.registrySha ?? null, createdAt: now, updatedAt: now });
  return id;
}
const contents: Record<string, string> = { a: 'content a', b: 'content b', c: 'content c' };
const deps = (over: Partial<BackfillDeps> = {}): BackfillDeps & { hashed: string[] } => {
  const hashed: string[] = [];
  return { hashed, hash: async (key) => { hashed.push(key); const c = contents[key]; if (c === undefined) throw new Error('cannot read'); return { sha256: sha(c), size: c.length }; }, record: (key, s, now) => recordChecksum(t.db, key, s, now), ...over };
};
const registry = async () => Object.fromEntries((await t.db.select().from(storageObjects)).map((r) => [r.key, r.sha256]));

describe('finding the clips that need a checksum', () => {
  it('lists only clips whose registry row has no checksum, in id order', async () => {
    await seed('a', contents.a); await seed('b', contents.b, { registrySha: sha(contents.b) }); await seed('c', contents.c);
    expect((await findBackfillCandidates(t.db)).map((c) => c.key)).toEqual(['a', 'c']);
  });
  it('ignores registry rows that no clip uses (for example the migrated project images)', async () => {
    const now = Date.now();
    await t.db.insert(storageObjects).values({ bucket: 'uploads', key: 'orphan.png', provider: 'r2', createdAt: now, updatedAt: now });
    expect(await findBackfillCandidates(t.db)).toEqual([]);
  });
});

describe('backfill', () => {
  it('the default list-only mode reads nothing and writes nothing', async () => {
    await seed('a', contents.a);
    const d = deps();
    const r = await runBackfill(await findBackfillCandidates(t.db), d, { hash: false, execute: false });
    expect(r[0].outcome).toBe('would-hash'); expect(d.hashed).toEqual([]);
    expect(await registry()).toEqual({ a: null });
  });
  it('--verify hashes and compares sizes but writes nothing', async () => {
    await seed('a', contents.a);
    const r = await runBackfill(await findBackfillCandidates(t.db), deps(), { hash: true, execute: false });
    expect(r[0]).toMatchObject({ outcome: 'verified', sha256: sha(contents.a) });
    expect(await registry()).toEqual({ a: null });
  });
  it('--execute fills the empty checksums and changes nothing else', async () => {
    const id = await seed('a', contents.a); await seed('b', contents.b);
    const clipsBefore = await t.db.select().from(brollClips);
    const r = await runBackfill(await findBackfillCandidates(t.db), deps(), { hash: true, execute: true }, 1234);
    expect(r.map((x) => x.outcome)).toEqual(['recorded', 'recorded']);
    expect(await registry()).toEqual({ a: sha(contents.a), b: sha(contents.b) });
    const [row] = await t.db.select().from(storageObjects).where(eq(storageObjects.key, 'a'));
    expect(row).toMatchObject({ provider: 'r2', sizeBytes: contents.a.length, verifiedAt: 1234 });
    expect(await t.db.select().from(brollClips)).toEqual(clipsBefore);          // clip rows untouched
    expect(id).toBeGreaterThan(0);
  });
  it('never replaces an existing checksum, even one that disagrees with what is read now', async () => {
    await seed('a', contents.a, { registrySha: sha('something else') });
    const r = await runBackfill([{ clipId: 1, title: 't', key: 'a', provider: 'r2', registrySize: contents.a.length, clipSize: contents.a.length }], deps(), { hash: true, execute: true });
    expect(r[0].outcome).toBe('already-set');
    expect(await registry()).toEqual({ a: sha('something else') });
  });
  it('refuses to record when the bytes read differ in size from the registry or the clip', async () => {
    await seed('a', contents.a, { registrySize: 999 }); await seed('b', contents.b, { clipSize: 999 });
    const r = await runBackfill(await findBackfillCandidates(t.db), deps(), { hash: true, execute: true });
    expect(r.map((x) => x.outcome)).toEqual(['size-mismatch', 'size-mismatch']);
    expect(await registry()).toEqual({ a: null, b: null });
  });
  it('a read failure on one object is reported and the others still complete', async () => {
    await seed('a', contents.a); await seed('missing', 'zzz'); await seed('c', contents.c);
    const r = await runBackfill(await findBackfillCandidates(t.db), deps(), { hash: true, execute: true });
    expect(Object.fromEntries(r.map((x) => [x.candidate.key, x.outcome]))).toEqual({ a: 'recorded', missing: 'hash-failed', c: 'recorded' });
    expect(await registry()).toEqual({ a: sha(contents.a), missing: null, c: sha(contents.c) });
  });
  it('skips objects the registry places outside R2 instead of reading them', async () => {
    await seed('a', contents.a, { provider: 'supabase' });
    const d = deps();
    expect((await runBackfill(await findBackfillCandidates(t.db), d, { hash: true, execute: true }))[0].outcome).toBe('not-on-r2');
    expect(d.hashed).toEqual([]);
  });
  it('is safe to run twice: the second run has nothing left to do', async () => {
    await seed('a', contents.a); await seed('b', contents.b);
    await runBackfill(await findBackfillCandidates(t.db), deps(), { hash: true, execute: true });
    expect(await findBackfillCandidates(t.db)).toEqual([]);
  });
  it('does not overwrite a checksum another process filled in between reading and writing', async () => {
    await seed('a', contents.a);
    const racing = deps({ record: async (key, s, now) => { await t.db.update(storageObjects).set({ sha256: sha('winner') }).where(eq(storageObjects.key, key)); return recordChecksum(t.db, key, s, now); } });
    expect((await runBackfill(await findBackfillCandidates(t.db), racing, { hash: true, execute: true }))[0].outcome).toBe('already-set');
    expect(await registry()).toEqual({ a: sha('winner') });
  });
});
