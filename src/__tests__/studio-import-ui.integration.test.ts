/**
 * What the Repository shows about imported images: the source of every field, review and brand flags, composition and file facts,
 * the explicit archived views, and the guarantee that nothing about a person is exposed and nothing is hidden. API routes against an
 * in-memory Postgres; components rendered to static markup.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate, call } from './helpers/studio-fakes';

const USER = '00000000-0000-4000-8000-00000000000a';
const holder = vi.hoisted(() => ({ db: undefined as unknown, store: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }) } }) }));
vi.mock('@/lib/object-store', async (orig) => ({ ...(await orig<typeof import('@/lib/object-store')>()), getStorage: () => holder.store }));

import { GET as packsGet } from '@/app/api/v1/studio/packs/route';
import { GET as packAssetsGet } from '@/app/api/v1/studio/packs/[id]/assets/route';
import { POST as packArchive } from '@/app/api/v1/studio/packs/[id]/archive/route';
import { PUT as metaPut } from '@/app/api/v1/studio/assets/[id]/metadata/route';
import { runImport } from '@/lib/studio/import/importer';
import type { ImportManifest, ManifestImage } from '@/lib/studio/import/manifest';
import { importInfoOf, needsReview } from '@/lib/studio/import-info';
import ImportPanel from '@/components/studio/ImportPanel';
import AssetGrid from '@/components/studio/AssetGrid';
import AssetDetail from '@/components/studio/AssetDetail';
import type { StudioAsset } from '@/lib/studio/client';
import { listAssetVersions } from '@/lib/studio/repository';

let pg: PGlite; let db: PgliteDatabase<typeof schema>; let manifest: ImportManifest; let files: Map<string, Buffer>; let r2: FakeR2;
const PERSON = /\b(man|woman|he|she|his|her|him|beard|hair|persona|gender|ethnic\w*)\b/i;

beforeAll(async () => {
  pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg); r2 = new FakeR2(); holder.store = r2;
  files = new Map();
  const mk = async (n: number, review: ManifestImage['review'], flags: string[], brand: { slice?: boolean }): Promise<ManifestImage> => {
    const b = await sharp({ create: { width: 20, height: 36, channels: 3, background: { r: n * 40, g: 10, b: 10 } } }).png().toBuffer(); files.set(`1/f${n}.png`, b);
    return { importKey: `IMG-00${n}`, source: { folder: '1', file: `f${n}.png`, relativePath: `1/f${n}.png` }, sha256: crypto.createHash('sha256').update(b).digest('hex'), sha1: 'x', sizeBytes: b.length, width: 20, height: 36, format: 'png', pack: 'p', secondaryConcepts: [], confidence: 'medium', review,
      imported: { fields: { environment: `env ${n}`, activity: 'cooking', tags: ['kitchen'] }, composition: { pose: 'standing', gaze: 'to camera', face_visibility: 'full', subject_position: 'center', subject_scale: 'large' }, operational: { flags, brand: { slice: brand.slice, notes: brand.slice ? ['Card text'] : undefined }, review }, technical: { format: 'PNG', width: 20, height: 36, file_size_bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') } } };
  };
  manifest = { manifestVersion: 1, sourceDirectory: 'x', packs: [{ key: 'p', letter: 'A', name: 'Kitchen Scenes', description: 'Kitchens' }], images: [
    await mk(1, [{ kind: 'metadata_draft' }, { kind: 'classification_uncertain', note: 'Could also fit another pack.', alt_pack: 'q' }], ['FACE_PARTIAL', 'BRAND_UI'], { slice: true }),
    await mk(2, [{ kind: 'metadata_draft' }], [], {}),
  ] };
  await runImport(manifest, { storage: r2, userId: USER, readSource: async (p) => files.get(p) ?? null }, { apply: true });
}, 120_000);
afterAll(async () => { await pg.close(); });

const packId = async () => (await db.select().from(schema.studioPacks))[0].id;

describe('the API tells the Repository where every field came from', () => {
  it('returns provenance "imported", the permanent ID and the import info; manual edits win and say so', async () => {
    const id = await packId();
    let res = await call(packAssetsGet, { params: { id: String(id) } });
    expect(res.status).toBe(200);
    const one = res.json.assets.find((a: StudioAsset) => a.importKey === 'IMG-001') as StudioAsset;
    expect(one.provenance).toMatchObject({ environment: 'imported', activity: 'imported', tags: 'imported', lighting: 'none' });
    expect(one.metadata.environment).toBe('env 1');
    expect(one.importInfo).toMatchObject({ importKey: 'IMG-001', status: 'needs_human_review', brand: { slice: true }, flags: ['FACE_PARTIAL', 'BRAND_UI'] });
    expect(needsReview(one.importInfo ?? null)).toBe(true);
    const edit = await call(metaPut, { method: 'PUT', params: { id: String(one.id) }, body: { fields: { environment: 'my env' } } });
    expect(edit.status).toBe(200);
    expect(edit.json.asset.provenance.environment).toBe('manual');
    const back = await call(metaPut, { method: 'PUT', params: { id: String(one.id) }, body: { revert: ['environment'] } });
    expect(back.json.asset.provenance.environment).toBe('imported');
    res = await call(packAssetsGet, { params: { id: String(id) } });
    expect(res.json.assets.length).toBe(2); // every image is listed
  });

  it('exposes nothing about a person, however the imported layer is shaped', async () => {
    const id = await packId();
    const res = await call(packAssetsGet, { params: { id: String(id) } });
    expect(JSON.stringify(res.json.assets)).not.toMatch(PERSON);
    const sneaky = importInfoOf({ fields: {}, persona_description: 'woman with long hair', gender: 'f', status: 'needs_human_review', operational: { flags: ['FACE_PARTIAL'] }, extra: { appearance: 'tall' } } as never);
    expect(JSON.stringify(sneaky)).not.toMatch(/woman|hair|gender|tall|appearance|persona/i);
    expect(importInfoOf({})).toBeNull();
    expect(importInfoOf(null)).toBeNull();
  });
});

describe('the explicit archived views', () => {
  it('an archived pack appears only with includeArchived; an archived version only with includeArchived; nothing is deleted', async () => {
    const id = await packId();
    const [old] = await listAssetVersions('IMG-002');
    await db.update(schema.studioAssets).set({ archivedAt: Date.now() }).where(eq(schema.studioAssets.id, old.id));
    expect((await call(packAssetsGet, { params: { id: String(id) } })).json.assets.map((a: StudioAsset) => a.importKey)).toEqual(['IMG-001']);
    const withArchived = (await call(packAssetsGet, { params: { id: String(id) }, query: 'includeArchived=1' })).json.assets as StudioAsset[];
    expect(withArchived.map((a) => a.importKey)).toEqual(['IMG-001', 'IMG-002']);
    expect(withArchived.find((a) => a.importKey === 'IMG-002')!.archived).toBe(true);
    await db.update(schema.studioAssets).set({ archivedAt: null }).where(eq(schema.studioAssets.id, old.id));

    const arch = await call(packArchive, { method: 'POST', params: { id: String(id) }, body: { archived: true } });
    expect(arch.status).toBe(200);
    expect((await call(packsGet)).json.packs).toHaveLength(0);
    expect((await call(packsGet, { query: 'includeArchived=1' })).json.packs).toHaveLength(1);
    await call(packArchive, { method: 'POST', params: { id: String(id) }, body: { archived: false } });
  });
});

describe('the components', () => {
  const base = (over: Partial<StudioAsset> = {}): StudioAsset => ({
    id: 1, packId: 1, originalFilename: 'f1.png', mime: 'image/png', sizeBytes: 1048576, width: 20, height: 36, analysisStatus: 'skipped', analysisError: null, archived: false, archivedAt: null, createdAt: 1,
    thumbUrl: 'https://r2.test/t.webp', imageUrl: null, ai: null, manual: {}, metadata: { environment: 'kitchen', description: 'd', tags: ['a'] },
    provenance: { environment: 'imported', activity: 'manual', objects_props: 'none', camera_angle: 'ai', framing: 'none', character_position: 'none', lighting: 'none', composition: 'none', description: 'imported', tags: 'imported' },
    hasManualEdits: true, importKey: 'IMG-001',
    importInfo: importInfoOf({ fields: {}, source: { import_key: 'IMG-001', source_folder: '1', source_file: 'f1.png' }, status: 'needs_human_review', version: 2, lineage: { version: 2, supersedes_asset_id: 4 },
      composition: { pose: 'standing', gaze: 'to camera' }, technical: { format: 'PNG', sha256: 'abcdef0123456789', file_size_bytes: 1048576 },
      operational: { flags: ['BRAND_UI', 'FACE_PARTIAL'], brand: { slice: true, notes: ['Card text'] }, review: [{ kind: 'metadata_draft' }, { kind: 'setting_discrepancy', note: 'Looks like a home.' }] } }),
    ...over,
  } as StudioAsset);

  it('the detail panel shows the source of each field (Imported, AI, Edited), review, brand, composition and file details', () => {
    const html = renderToStaticMarkup(createElement(AssetDetail, { asset: base(), onChange: () => {}, onClose: () => {} }));
    expect(html).toContain('Imported'); expect(html).toContain('Edited by you'); expect(html).toContain('AI');
    expect(html).toContain('Needs review'); expect(html).toContain('Looks like a home.');
    expect(html).toContain('Shows a Slice card or app screen'); expect(html).toContain('stays visible and can be selected');
    expect(html).toContain('Composition (for character replacement)'); expect(html).toContain('Not used to search, recommend, rank or hide images.');
    expect(html).toContain('IMG-001'); expect(html).toContain('version 2'); expect(html).toContain('abcdef012345');
    expect(html).toContain('Use imported or AI value'); // reverting a manual edit shows the imported value
    expect(html).not.toMatch(PERSON);
  });
  it('an image that was uploaded by hand shows no import panel and keeps the plain wording', () => {
    const html = renderToStaticMarkup(createElement(AssetDetail, { asset: base({ importKey: null, importInfo: null }), onChange: () => {}, onClose: () => {} }));
    expect(html).not.toContain('import-panel'); expect(html).toContain('Use AI value');
  });
  it('the grid flags review and brand without hiding anything, including archived images', () => {
    const html = renderToStaticMarkup(createElement(AssetGrid, { assets: [base(), base({ id: 2, importInfo: null, importKey: null }), base({ id: 3, archived: true })], selectedId: null, onSelect: () => {} }));
    expect(html.match(/Branded/g)?.length).toBe(2); expect(html.match(/Needs review/g)?.length).toBe(2);
    expect(html.match(/aria-label="Open/g)?.length).toBe(3); expect(html).toContain('Archived');
  });
  it('the panel alone says nothing when there is nothing imported', () => {
    expect(renderToStaticMarkup(createElement(ImportPanel, { asset: base({ importInfo: null }) }))).toBe('');
  });
});
