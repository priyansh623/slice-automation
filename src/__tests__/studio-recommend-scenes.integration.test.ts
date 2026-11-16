/**
 * Scene-based recommendations, without a live model: the pack profiles built from the REAL import manifest (metadata only; the
 * pixels are synthetic), the prompt the model would receive, and the rules that keep a recommendation relevant, explained and
 * never forced. Also: nothing about a person can reach a profile, a prompt, a ranking or a search.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '@/db/schema.pg';
import { FakeR2, migrate } from './helpers/studio-fakes';

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/db', () => ({ db: new Proxy({}, { get(_t, prop) { const real = holder.db as Record<string | symbol, unknown>; const v = real[prop]; return typeof v === 'function' ? v.bind(real) : v; } }) }));

import { runImport } from '@/lib/studio/import/importer';
import type { ImportManifest } from '@/lib/studio/import/manifest';
import { analyseProjectScript, buildRecommendationPrompt, groundRecommendations, isBrandOnly, refreshStaleProfiles, sanitiseRecommendations, MIN_SCORE, type PackForPrompt, type PackProfile, type Recommendation } from '@/lib/studio/recommend';
import { mentionsPerson, stripPersonWords } from '@/lib/studio/import/scene-metadata';
import { editMetadata, listPackAssets } from '@/lib/studio/repository';
import type { StudioMessagesClient } from '@/lib/studio/ai-client';

const USER = '00000000-0000-4000-8000-00000000000a';
const ROOT = path.resolve(__dirname, '../..');
let pg: PGlite; let db: PgliteDatabase<typeof schema>;
let packs: PackForPrompt[] = []; const byLetter: Record<string, PackForPrompt> = {};

const PERSON_IN_PROMPT = /\b(man|men|woman|women|male|female|boy|girl|he|she|his|her|him|beard|bearded|hair|skin|young|old|elderly|gender|ethnic\w*|appearance)\b/i;
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');
const vocabOf = (p: PackForPrompt): Set<string> => new Set([p.name, p.description ?? '', ...(p.profile?.environments ?? []), ...(p.profile?.activities ?? []), ...(p.profile?.objects ?? []), ...(p.profile?.concepts ?? []), ...(p.profile?.tags ?? [])].flatMap((t) => t.toLowerCase().match(/[a-z]{2,}/g) ?? []).map(stem));
const has = (p: PackForPrompt, term: string) => term.toLowerCase().split(/\s+/).every((w) => vocabOf(p).has(stem(w)));

beforeAll(async () => {
  pg = new PGlite(); db = drizzle(pg, { schema }); holder.db = db; await migrate(pg);
  // The real manifest's metadata, with a tiny synthetic image per ID so the importer's checks pass without the source folder.
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/studio-import/manifest.json'), 'utf8')) as ImportManifest;
  const files = new Map<string, Buffer>();
  const manifest: ImportManifest = { ...real, images: await Promise.all(real.images.map(async (im, i) => {
    const b = await sharp({ create: { width: 20, height: 36, channels: 3, background: { r: i * 4 % 256, g: (i * 7) % 256, b: (i * 13) % 256 } } }).png().toBuffer();
    files.set(im.source.relativePath, b);
    return { ...im, sha256: crypto.createHash('sha256').update(b).digest('hex'), sizeBytes: b.length, width: 20, height: 36 };
  })) };
  const rep = await runImport(manifest, { storage: new FakeR2(), userId: USER, readSource: async (p) => files.get(p) ?? null }, { apply: true });
  expect(rep.counts.create).toBe(54);
  await refreshStaleProfiles();
  const rows = await db.select().from(schema.studioPacks);
  packs = rows.map((r) => ({ id: r.id, name: r.name, description: r.description, profile: r.profile as PackProfile }));
  for (const m of real.packs) byLetter[m.letter] = packs.find((p) => rows.find((r) => r.id === p.id)!.importKey === m.key)!;
}, 180_000);
afterAll(async () => { await pg.close(); });

describe('profiles describe scenes only', () => {
  it('no profile value names or describes a person, wears clothing, or is a facial expression', () => {
    for (const p of packs) for (const v of [...p.profile!.environments, ...p.profile!.activities, ...p.profile!.objects, ...p.profile!.tags, ...(p.profile!.concepts ?? [])]) {
      expect(mentionsPerson(v), `${p.name}: "${v}"`).toBe(false);
      expect(v).not.toMatch(/\b(tee|polo|jeans|trousers|shorts|beanie|bracelet|sunglasses|round glasses|smiling|surprised)\b/i);
    }
  });
  it('the brand note is informational: a pack that holds branded scenes says so, and says it is not a reason', () => {
    const prompt = buildRecommendationPrompt('anything', packs);
    expect(byLetter.H.profile!.brand!.slice).toBeGreaterThanOrEqual(5);
    expect(prompt).toMatch(/Brand note: \d+ of \d+ images show a Slice card or app screen\. Relevant only to scripts about that offer; not a reason by itself\./);
  });
  it('each pack lists the concepts that make it distinct, not just the most frequent tags', () => {
    expect(byLetter.D.profile!.concepts).toEqual(expect.arrayContaining(['gym']));
    expect(byLetter.E.profile!.concepts).toEqual(expect.arrayContaining(['waterfall']));
  });
});

// The twelve acceptance cases. Each says which packs the scenes of the library can serve (and which words prove it), and which packs
// cannot. They are checks on the pack vocabulary and on the filtering rules, not forced model outputs.
const CASES: Array<{ n: number; script: string; serve: Record<string, string[]>; cannot: Record<string, string[]> }> = [
  { n: 1, script: 'Every morning I grab a coffee and a pastry at the cafe near my office. A few hundred rupees, but it adds up.', serve: { A: ['coffee', 'cafe', 'dessert'] }, cannot: { D: ['coffee', 'pastry'], E: ['coffee', 'pastry'] } },
  { n: 2, script: 'Instead of ordering pizza again, I cook at home and save money.', serve: { B: ['cooking', 'kitchen'], A: ['pizza'] }, cannot: { D: ['pizza', 'kitchen'], E: ['pizza', 'kitchen'] } },
  { n: 3, script: 'I freelance from home on my laptop, chasing deadlines.', serve: { C: ['laptop', 'desk'], B: ['sofa'] }, cannot: { D: ['laptop'], E: ['laptop'] } },
  { n: 4, script: "I have been paying for a gym membership I never use.", serve: { D: ['gym'] }, cannot: { A: ['gym'], E: ['gym'], B: ['gym'] } },
  { n: 5, script: 'This weekend: a trek to a waterfall and a long bike ride.', serve: { E: ['waterfall', 'trekking', 'motorcycle'] }, cannot: { C: ['waterfall'], D: ['waterfall'] } },
  { n: 6, script: 'Open the Slice app, apply for the UPI credit card and show your card at checkout.', serve: { H: ['card', 'phone'] }, cannot: { D: ['credit card'], E: ['credit card'] } },
  { n: 7, script: 'The restaurant bill came out huge and I just stared at the long receipt.', serve: { A: ['restaurant'], H: ['receipt'] }, cannot: { D: ['receipt'], E: ['receipt'] } },
  { n: 8, script: "Hi, I'm the founder, and today I will explain how this works.", serve: { G: ['talking'] }, cannot: { D: ['talking'], E: ['talking'] } },
  { n: 9, script: 'My night skincare routine: cleanser, serum and moisturiser.', serve: {}, cannot: Object.fromEntries('ABCDEFGH'.split('').map((l) => [l, ['skincare', 'serum', 'cleanser', 'moisturiser']])) },
  { n: 10, script: 'Paying by QR at the corner shop.', serve: { A: ['qr'] }, cannot: { D: ['qr'], E: ['qr'] } },
  { n: 11, script: 'Planning a staycation and a quiet evening in a hotel lounge.', serve: { F: ['lounge'] }, cannot: { D: ['lounge'], E: ['lounge'] } },
];
describe('acceptance cases (deterministic)', () => {
  for (const c of CASES) {
    it(`#${c.n}: ${c.script.slice(0, 50)}...`, () => {
      for (const [l, terms] of Object.entries(c.serve)) for (const t of terms) expect(has(byLetter[l], t), `pack ${l} should hold "${t}"`).toBe(true);
      for (const [l, terms] of Object.entries(c.cannot)) for (const t of terms) expect(has(byLetter[l], t), `pack ${l} should not hold "${t}"`).toBe(false);
      // the prompt carries the script and every pack, and nothing about a person outside the script itself
      const prompt = buildRecommendationPrompt(c.script, packs);
      expect(prompt).toContain(c.script.trim());
      const withoutScript = prompt.replace(c.script.trim(), '');
      expect(withoutScript).not.toMatch(PERSON_IN_PROMPT);
    });
  }
  it('#9 skincare: no pack serves it, so an empty answer is right and a forced one is rejected', () => {
    const forced: Recommendation[] = [{ packId: byLetter.H.id, score: 0.9, reasons: ['Shows a Slice card'], moments: ['serum'], scenes: ['card'] }, { packId: byLetter.G.id, score: 0.2, reasons: ['Plain backdrop portraits'], moments: [] }];
    expect(groundRecommendations(forced, packs)).toEqual([]);
  });
});

describe('relevance, explanation and no forcing', () => {
  const good = (): Recommendation => ({ packId: byLetter.A.id, score: 0.8, reasons: ['The cafe coffee scenes show the daily coffee habit'], moments: ['grab a coffee'], scenes: ['coffee', 'cafe', 'made up scene'] });
  it('keeps a relevant, grounded, explained recommendation and removes scenes the pack does not hold', () => {
    const [r] = groundRecommendations([good()], packs);
    expect(r.scenes).toEqual(['coffee', 'cafe']);
    expect(r.reasons[0]).toMatch(/coffee/);
  });
  it('drops: weak scores, missing reasons, unknown packs, and reasons that mention nothing the pack holds', () => {
    expect(groundRecommendations([{ ...good(), score: MIN_SCORE - 0.05 }], packs)).toEqual([]);
    expect(groundRecommendations([{ ...good(), reasons: [] }], packs)).toEqual([]);
    expect(groundRecommendations([{ ...good(), packId: 9_999_999 }], packs)).toEqual([]);
    expect(groundRecommendations([{ ...good(), reasons: ['Great fit overall'], scenes: [] }], packs)).toEqual([]);
  });
  it('branding alone is not relevance', () => {
    expect(isBrandOnly(['Shows a Slice card', 'The red super slicer card app screen'])).toBe(true);
    expect(isBrandOnly(['Receipt scene supports the bill shock moment'])).toBe(false);
    const brandOnly: Recommendation = { packId: byLetter.H.id, score: 0.95, reasons: ['It contains a Slice card and an app screen'], moments: [], scenes: ['card', 'app screen'] };
    expect(groundRecommendations([brandOnly], packs)).toEqual([]);
    const real: Recommendation = { packId: byLetter.H.id, score: 0.7, reasons: ['The credit card and phone demonstration scenes support the apply-in-the-app step'], moments: ['apply in the app'], scenes: ['phone', 'card'] };
    expect(groundRecommendations([real], packs)).toHaveLength(1);
  });
  it('sanitising stays structural and bounded (the stored contract is unchanged: packId, score, reasons, moments)', () => {
    const out = sanitiseRecommendations({ recommendations: [{ pack_id: byLetter.A.id, score: 7, reasons: ['r'], moments: ['m'], scenes: ['x'] }] }, new Set([byLetter.A.id]));
    expect(out[0]).toMatchObject({ packId: byLetter.A.id, score: 1, reasons: ['r'], moments: ['m'] });
  });
});

describe('the model call: end to end with a scripted model', () => {
  async function project(name: string, script: string, characterKey: string | null) {
    const [p] = await db.insert(schema.studioProjects).values({ name, script, scriptHash: crypto.createHash('sha256').update(script).digest('hex'), characterKey, createdBy: USER, createdAt: 1, updatedAt: 1 }).returning();
    return p.id;
  }
  const reply = (recs: unknown) => ({ content: [{ type: 'tool_use', name: 'recommend_scene_packs', id: 't', input: { recommendations: recs } }] });
  const client = (recs: unknown) => { const create = vi.fn(async () => reply(recs)); return { client: { messages: { create } } as unknown as StudioMessagesClient, create }; };

  it('an unrelated script with an empty answer stores no recommendations (not forced) and the run is completed', async () => {
    const id = await project('skin', 'My night skincare routine: cleanser, serum and moisturiser.', null);
    const { client: c } = client([]);
    const row = await analyseProjectScript(id, { client: c });
    expect(row.analysisStatus).toBe('completed');
    expect(row.recommendations).toEqual([]);
  });

  it('a model that forces an ungrounded, brand-only recommendation is overruled', async () => {
    const id = await project('skin2', 'My night skincare routine.', null);
    const { client: c } = client([{ pack_id: byLetter.H.id, score: 0.9, reasons: ['It has a Slice card'], moments: ['skincare'], scenes: ['card'] }]);
    expect((await analyseProjectScript(id, { client: c })).recommendations).toEqual([]);
  });

  it('changing the project character reference changes nothing the model receives or the recommendations stored', async () => {
    const script = 'Every morning I grab a coffee at the cafe near my office.';
    const recs = [{ pack_id: byLetter.A.id, score: 0.8, reasons: ['Cafe coffee scenes show the habit'], moments: ['grab a coffee'], scenes: ['coffee'] }];
    const a = client(recs); const b = client(recs);
    const one = await analyseProjectScript(await project('one', script, 'studio/projects/1/character/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png'), { client: a.client });
    const two = await analyseProjectScript(await project('two', script, 'studio/projects/2/character/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png'), { client: b.client });
    expect(JSON.stringify(a.create.mock.calls[0])).toBe(JSON.stringify(b.create.mock.calls[0]));
    expect(two.recommendations).toEqual(one.recommendations);
  });

  it('male and female wording in the script does not change the pack part of the prompt or the stored recommendations', async () => {
    const he = 'He grabs a coffee at the cafe every morning and he is spending too much.';
    const she = 'She grabs a coffee at the cafe every morning and she is spending too much.';
    const recs = [{ pack_id: byLetter.A.id, score: 0.8, reasons: ['Cafe coffee scenes show the habit'], moments: ['grabs a coffee'], scenes: ['coffee'] }];
    const a = client(recs); const b = client(recs);
    const r1 = await analyseProjectScript(await project('he', he, null), { client: a.client });
    const r2 = await analyseProjectScript(await project('she', she, null), { client: b.client });
    const arg = (c: ReturnType<typeof client>) => (c.create.mock.calls[0] as unknown as [{ messages: Array<{ content: string }>; system: string }])[0];
    const section = (c: ReturnType<typeof client>, script: string) => arg(c).messages[0].content.replace(script, '');
    expect(section(a, he)).toBe(section(b, she));
    expect(arg(a).system).toBe(arg(b).system);
    expect(r1.recommendations).toEqual(r2.recommendations);
  });
});

describe('a person can never rank, filter, hide or be searched for', () => {
  it('edits that add person terms, clothing or expressions to scene fields do not enter the profile', async () => {
    const before = JSON.stringify(byLetter.A.profile);
    const [a] = await db.select().from(schema.studioAssets).where(eq(schema.studioAssets.packId, byLetter.A.id)).limit(1);
    await editMetadata(a.id, { set: { tags: ['woman', 'bearded', 'white tee', 'smiling', 'gen z', 'cafe'], objects_props: 'blue jeans, round glasses, mug' }, revert: [] }, USER);
    await refreshStaleProfiles();
    const p = (await db.select().from(schema.studioPacks).where(eq(schema.studioPacks.id, byLetter.A.id)))[0].profile as PackProfile;
    const all = [...p.tags, ...p.objects, ...(p.concepts ?? [])].join(' | ');
    expect(all).not.toMatch(/woman|bearded|white tee|smiling|gen z|jeans|round glasses/i);
    expect(p.environments).toEqual((JSON.parse(before) as PackProfile).environments); // scene parts are not disturbed
    await editMetadata(a.id, { set: {}, revert: ['tags', 'objects_props'] }, USER); // leave the library as imported for the next tests
  });

  it('composition (pose, gaze, position, scale, face visibility) is kept on the asset but is not in any profile or prompt', async () => {
    const [a] = await db.select().from(schema.studioAssetMetadata).limit(1);
    expect((a.imported as { composition?: Record<string, string> }).composition).toBeTruthy();
    const prompt = buildRecommendationPrompt('x', packs);
    for (const w of ['face visibility', 'partial', 'gaze', 'leaning', 'subject scale']) expect(prompt.toLowerCase()).not.toContain(w);
  });

  it('search never finds a person, clothing or composition term anywhere in the library, and always finds scene terms; nothing is hidden', async () => {
    for (const l of 'ABCDEFGH') {
      const all = (await listPackAssets(byLetter[l].id, {})).totalActive;
      for (const term of ['man', 'woman', 'beard', 'polo', 'jeans', 'leaning', 'gaze', 'partial']) expect((await listPackAssets(byLetter[l].id, { search: term })).items.length, `${l}:${term}`).toBe(0);
      expect((await listPackAssets(byLetter[l].id, {})).items.length, `${l} lists every image`).toBe(all);
    }
    expect((await listPackAssets(byLetter.D.id, { search: 'gym' })).items.length).toBeGreaterThan(0);
  });
});

describe('R1: AI-written text cannot put a person into a profile or a prompt', () => {
  it('AI environment, activity, objects and tags that describe a person or clothing are left out of the profile', async () => {
    const [pk] = await db.insert(schema.studioPacks).values({ name: 'AI only pack', description: 'Desk scenes', createdBy: USER, createdAt: 1, updatedAt: 1 }).returning();
    const [a] = await db.insert(schema.studioAssets).values({ packId: pk.id, storageKey: 'studio/assets/00000000-0000-4000-8000-0000000000a1.png', mime: 'image/png', sizeBytes: 1, sha256: 'ai-only-1', analysisStatus: 'completed', createdBy: USER, createdAt: 1, updatedAt: 1 }).returning();
    await db.insert(schema.studioAssetMetadata).values({ assetId: a.id, ai: { environment: 'office desk', activity: 'typing on a laptop', objects_props: 'laptop, white hoodie, sunglasses, notebook', tags: ['laptop', 'woman', 'young man', 'jeans', 'smiling', 'notebook'], description: 'A young woman in a hoodie' }, manual: {}, imported: {}, createdAt: 1, updatedAt: 1 });
    await db.insert(schema.studioAssetMetadata).values({ assetId: (await db.insert(schema.studioAssets).values({ packId: pk.id, storageKey: 'studio/assets/00000000-0000-4000-8000-0000000000a2.png', mime: 'image/png', sizeBytes: 1, sha256: 'ai-only-2', analysisStatus: 'completed', createdBy: USER, createdAt: 1, updatedAt: 1 }).returning())[0].id, ai: { environment: 'a man at a desk', activity: 'woman typing', tags: [] }, manual: {}, imported: {}, createdAt: 1, updatedAt: 1 });
    await refreshStaleProfiles();
    const p = (await db.select().from(schema.studioPacks).where(eq(schema.studioPacks.id, pk.id)))[0].profile as PackProfile;
    const all = [...p.environments, ...p.activities, ...p.objects, ...p.tags, ...(p.concepts ?? [])].join(' | ');
    expect(all).not.toMatch(/woman|\bman\b|young|hoodie|sunglasses|jeans|smiling/i);
    expect(p.environments).toEqual(['office desk']);
    expect(p.activities).toEqual(['typing on a laptop']);
    expect(p.objects).toEqual(expect.arrayContaining(['laptop', 'notebook']));
    const prompt = buildRecommendationPrompt('x', [{ id: pk.id, name: pk.name, description: pk.description, profile: p }]);
    expect(prompt).not.toMatch(/woman|\bman\b|young|hoodie|sunglasses|jeans/i);
  });

  it('person words in a pack name or description are not sent to the model; the rest is', () => {
    const prompt = buildRecommendationPrompt('x', [{ id: 99, name: 'Cafe scenes', description: 'A young woman drinking coffee in a cafe, wearing a white tee', profile: null }]);
    expect(prompt).toContain('Pack 99: Cafe scenes');
    expect(prompt).toContain('drinking coffee in a cafe, wearing a white');
    expect(prompt).not.toMatch(/young|woman|\btee\b/i);
    expect(stripPersonWords('Plain Backdrop: Portraits & Talking Head')).toBe('Plain Backdrop: Portraits & Talking Head');
  });
});

describe('G1: an archived pack is never recommended', () => {
  const reply = (recs: unknown) => ({ content: [{ type: 'tool_use', name: 'recommend_scene_packs', id: 't', input: { recommendations: recs } }] });
  it('an archived pack is not offered to the model, and a recommendation for it is dropped while a live one stays', async () => {
    const [arch] = await db.insert(schema.studioPacks).values({ name: 'Retired Cafe Pack', description: 'Old cafe test', createdBy: USER, createdAt: 1, updatedAt: 1, archivedAt: 5 }).returning();
    const script = 'Every morning I grab a coffee at the cafe near my office.';
    const [pr] = await db.insert(schema.studioProjects).values({ name: 'g1', script, scriptHash: crypto.createHash('sha256').update(script).digest('hex'), createdBy: USER, createdAt: 1, updatedAt: 1 }).returning();
    const create = vi.fn(async () => reply([
      { pack_id: arch.id, score: 0.95, reasons: ['Cafe scenes'], moments: ['coffee'], scenes: ['coffee'] },
      { pack_id: byLetter.A.id, score: 0.8, reasons: ['Cafe coffee scenes show the habit'], moments: ['grab a coffee'], scenes: ['coffee'] },
    ]));
    const row = await analyseProjectScript(pr.id, { client: { messages: { create } } as unknown as StudioMessagesClient });
    const sent = JSON.stringify(create.mock.calls[0]);
    expect(sent).not.toContain('Retired Cafe Pack');
    expect(sent).not.toContain(`Pack ${arch.id}:`);
    expect((row.recommendations as Recommendation[]).map((r) => r.packId)).toEqual([byLetter.A.id]);
  });
});
