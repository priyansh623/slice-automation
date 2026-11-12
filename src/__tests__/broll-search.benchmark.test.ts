/**
 * Search benchmark plus behavioural guarantees. Metrics are computed against hand-labelled expectations
 * (fixtures/broll-search-benchmark.ts) on the real classified library. Set WRITE_BENCHMARK_REPORT=1 to write
 * the full per-query table to broll-import/search-benchmark-report.md.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import library from './fixtures/broll-benchmark-library.json';
import { BENCHMARK } from './fixtures/broll-search-benchmark';
import { searchClips, interpretQuery, type SearchClip } from '@/lib/broll-search';
import { applyLibraryFilters } from '@/lib/broll-filters';

interface FixtureClip { ref: string; id: number; title: string; categoryIds: number[]; userTags: string[]; brands: string[] }
const categories = library.categories;
const clips: (SearchClip & { ref: string })[] = (library.clips as unknown as FixtureClip[]).map((c, i) => ({
  ...c,
  brands: c.brands.map((brandName) => ({ brandName })),
  createdAt: 1_000 + i, // fixed, so tie-breaking is deterministic
}));
const refOf = new Map(clips.map((c) => [c.id, (c as { ref: string }).ref]));
const run = (q: string, pool = clips) => searchClips(q, pool, categories);
const refs = (q: string, pool = clips) => run(q, pool).hits.map((h) => refOf.get(h.clip.id)!);

interface Row {
  q: string; kind: string; returned: string[]; tiers: string[]; direct: string[]; related: string[];
  p3Strict: number | null; p3Lenient: number | null; r5: number | null;
  falsePositives: string[]; missed: string[]; directBeforeRelated: boolean; interpretedAs: string;
}

function evaluate(): Row[] {
  return BENCHMARK.map((b) => {
    const result = run(b.q);
    const returned = result.hits.map((h) => refOf.get(h.clip.id)!);
    const direct = new Set(b.direct);
    const related = new Set(b.related ?? []);
    const top3 = returned.slice(0, 3);
    const top5 = returned.slice(0, 5);
    const p3 = (rel: Set<string>) => (top3.length ? top3.filter((r) => rel.has(r)).length / top3.length : null);
    const firstRelated = result.hits.findIndex((h) => h.tier === 'related');
    const lastDirect = result.hits.map((h) => h.tier).lastIndexOf('direct');
    const lastExpectedDirect = Math.max(-1, ...returned.map((r, i) => (direct.has(r) ? i : -1)));
    const firstExpectedRelated = returned.findIndex((r) => related.has(r) && !direct.has(r));
    return {
      q: b.q, kind: b.kind, returned, tiers: result.hits.map((h) => h.tier), direct: b.direct, related: [...related],
      p3Strict: direct.size ? p3(direct) : null,
      p3Lenient: direct.size ? p3(new Set([...direct, ...related])) : null,
      r5: direct.size ? top5.filter((r) => direct.has(r)).length / Math.min(direct.size, 5) : null,
      falsePositives: returned.filter((r) => !direct.has(r) && !related.has(r)),
      missed: b.direct.filter((r) => !returned.includes(r)),
      directBeforeRelated: (firstRelated === -1 || firstRelated > lastDirect) && (firstExpectedRelated === -1 || lastExpectedDirect < firstExpectedRelated),
      interpretedAs: `${result.interpretation.kind}: ${[...result.interpretation.concepts, ...result.interpretation.plainWords.map((w) => `"${w}"`)].join(' + ')}`,
    };
  });
}

const rows = evaluate();
const mean = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.reduce((a, b) => a + b, 0) / v.length; };

describe('benchmark size and mix', () => {
  it('has at least 50 queries covering vague and specific wording', () => {
    expect(BENCHMARK.length).toBeGreaterThanOrEqual(50);
    expect(BENCHMARK.filter((b) => b.kind === 'broad').length).toBeGreaterThanOrEqual(20);
    expect(BENCHMARK.filter((b) => b.kind === 'specific').length).toBeGreaterThanOrEqual(20);
    expect(BENCHMARK.filter((b) => b.direct.length === 0).length).toBeGreaterThanOrEqual(8);
  });
  it('labels only clips that exist, and no clip as both direct and related', () => {
    const known = new Set(clips.map((c) => (c as { ref: string }).ref));
    for (const b of BENCHMARK) {
      for (const r of [...b.direct, ...(b.related ?? [])]) expect(known.has(r), `${b.q}: ${r}`).toBe(true);
      expect((b.related ?? []).filter((r) => b.direct.includes(r)), b.q).toEqual([]);
    }
  });
  it('classifies each query as broad or specific as labelled', () => {
    for (const r of rows) expect(r.interpretedAs.split(':')[0], r.q).toBe(r.kind);
  });
});

describe('guarantees (every query)', () => {
  it('direct matches rank above related matches, and the expected direct clips above expected related ones', () => {
    expect(rows.filter((r) => !r.directBeforeRelated).map((r) => r.q)).toEqual([]);
  });
  it('specific queries never return a related-tier match and never return an unlabelled clip', () => {
    for (const r of rows.filter((x) => x.kind === 'specific')) {
      expect(r.tiers.includes('related'), `${r.q} tiers`).toBe(false);
      expect(r.falsePositives, `${r.q} false positives`).toEqual([]);
    }
  });
  it('queries labelled as having no footage return nothing, rather than stretching to a weak match', () => {
    for (const r of rows.filter((x) => x.direct.length === 0)) expect(r.returned, r.q).toEqual([]);
  });
  it('returns no clip that was labelled irrelevant for broad queries either', () => {
    for (const r of rows.filter((x) => x.kind === 'broad')) expect(r.falsePositives, r.q).toEqual([]);
  });
});

describe('aggregate quality', () => {
  it('Precision@3 (direct only) and Recall@5 are high across the benchmark', () => {
    expect(mean(rows.map((r) => r.p3Strict))).toBeGreaterThanOrEqual(0.9);
    expect(mean(rows.map((r) => r.r5))).toBeGreaterThanOrEqual(0.95);
  });
  it('every labelled direct clip is returned somewhere', () => {
    expect(rows.filter((r) => r.missed.length).map((r) => `${r.q}: ${r.missed.join(',')}`)).toEqual([]);
  });
});

describe('filters stay strict', () => {
  const food = new Set(categories.filter((c) => [10, 16, 17, 18, 52].includes(c.id)).map((c) => c.id));
  const cafeOnly = new Set([16]);

  it('search never returns a clip the filters removed, for any benchmark query', () => {
    const pools = [
      applyLibraryFilters(clips, {}, food),
      applyLibraryFilters(clips, {}, cafeOnly),
      applyLibraryFilters(clips, { userTags: 'client product' }, null),
      applyLibraryFilters(clips, { brand: 'Blinkit' }, null),
    ];
    for (const pool of pools) {
      const allowed = new Set(pool.map((c) => c.id));
      for (const b of BENCHMARK) {
        for (const h of run(b.q, pool).hits) expect(allowed.has(h.clip.id), `${b.q} -> ${h.clip.title}`).toBe(true);
      }
    }
  });

  it('a clip that matches the query but not the selected category is not brought back', () => {
    expect(refs('coffee')).toContain('C12'); // matches coffee unfiltered
    expect(refs('coffee', applyLibraryFilters(clips, {}, cafeOnly))).toEqual(expect.not.arrayContaining(['C12']));
    expect(refs('coffee', applyLibraryFilters(clips, {}, cafeOnly)).sort()).toEqual(['C25', 'C31']);
  });

  it('related matches are only drawn from inside the filtered pool', () => {
    const pool = applyLibraryFilters(clips, {}, new Set([49])); // Rewards cashback only
    expect(refs('payment', pool)).toEqual(expect.arrayContaining(['C21', 'C26']));
    expect(refs('payment', pool)).not.toContain('C20');
    expect(refs('payment', pool)).not.toContain('C31');
  });

  it('an empty filtered pool gives no results, whatever the query', () => {
    const empty = applyLibraryFilters(clips, {}, new Set([9999]));
    expect(empty).toEqual([]);
    expect(refs('payment', empty)).toEqual([]);
    expect(refs('', empty)).toEqual([]);
  });

  it('an empty query leaves the filtered list unchanged and in order', () => {
    const pool = applyLibraryFilters(clips, {}, food);
    expect(run('', pool).hits.map((h) => h.clip.id)).toEqual(pool.map((c) => c.id));
    expect(run('   ', pool).interpretation.kind).toBe('empty');
  });
});

describe('query understanding', () => {
  it('drops filler words and reads the concept', () => {
    expect(interpretQuery('person using phone')).toMatchObject({ kind: 'broad', concepts: ['phone'], plainWords: [] });
    expect(interpretQuery('someone working')).toMatchObject({ kind: 'broad', concepts: ['work'] });
  });
  it('treats a query with any word it cannot place as specific', () => {
    expect(interpretQuery('scanning QR code').kind).toBe('specific');
    expect(interpretQuery('person paying with cash')).toMatchObject({ kind: 'specific', concepts: ['payment'], plainWords: ['cash'] });
  });
  it('does not widen a narrow word to its whole category', () => {
    expect(interpretQuery('snack')).toMatchObject({ kind: 'specific', concepts: [] });
    expect(interpretQuery('cinema').kind).toBe('specific');
  });
  it('is case, plural and apostrophe insensitive', () => {
    expect(refs('Payments')).toEqual(refs('payment'));
    expect(refs("LAY'S").sort()).toEqual(['C19', 'C32']);
  });
});

describe('ranking', () => {
  it('puts the clip that names the thing in its title above one matched only by category', () => {
    const r = run('coffee').hits;
    expect(refOf.get(r[0].clip.id)).toBeDefined();
    const byTitle = r.filter((h) => h.why.some((w) => w.startsWith('title')));
    expect(byTitle.length).toBeGreaterThan(0);
    expect(r.slice(0, byTitle.length).map((h) => h.clip.id).sort()).toEqual(byTitle.map((h) => h.clip.id).sort());
  });
  it('orders related matches by strength: close relations before loose ones', () => {
    const tiers = run('payment').hits.filter((h) => h.tier === 'related');
    const scores = tiers.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(refOf.get(tiers[0].clip.id)).toMatch(/C21|C26/); // rewards/banking (close) before card (loose)
    expect(refOf.get(tiers[tiers.length - 1].clip.id)).toBe('C31');
  });
  it('flags related hits so the UI never presents them as exact', () => {
    const hits = run('payment').hits;
    expect(hits[0]).toMatchObject({ tier: 'direct' });
    expect(hits.filter((h) => h.tier === 'related').every((h) => h.why.some((w) => w.startsWith('related to')))).toBe(true);
  });
});

describe('report', () => {
  it('prints the per-query table (and writes it when WRITE_BENCHMARK_REPORT=1)', () => {
    const fmt = (n: number | null) => (n === null ? '–' : n.toFixed(2));
    const lines = [
      '# B-roll search benchmark',
      '',
      `Library: ${clips.length} classified clips. Queries: ${rows.length} (${rows.filter((r) => r.kind === 'broad').length} broad, ${rows.filter((r) => r.kind === 'specific').length} specific, ${rows.filter((r) => r.direct.length === 0).length} with no footage in the library).`,
      '',
      `Mean Precision@3, direct only: ${fmt(mean(rows.map((r) => r.p3Strict)))}  |  counting related as relevant: ${fmt(mean(rows.map((r) => r.p3Lenient)))}`,
      `Mean Recall@5 (direct): ${fmt(mean(rows.map((r) => r.r5)))}`,
      `Direct above related: ${rows.filter((r) => r.directBeforeRelated).length}/${rows.length}`,
      `Specific queries returning a related-tier or unlabelled clip: ${rows.filter((r) => r.kind === 'specific' && (r.tiers.includes('related') || r.falsePositives.length)).length}/${rows.filter((r) => r.kind === 'specific').length}`,
      `Zero-result queries answered with zero results: ${rows.filter((r) => r.direct.length === 0 && r.returned.length === 0).length}/${rows.filter((r) => r.direct.length === 0).length}`,
      '',
      '| Query | Read as | P@3 | P@3 incl. related | R@5 | Returned (d = direct, r = related) | Missed | Unlabelled returned |',
      '|---|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.q} | ${r.interpretedAs} | ${fmt(r.p3Strict)} | ${fmt(r.p3Lenient)} | ${fmt(r.r5)} | ${r.returned.map((x, i) => `${x}${r.tiers[i] === 'direct' ? 'd' : 'r'}`).join(' ') || '(none)'} | ${r.missed.join(' ') || ''} | ${r.falsePositives.join(' ') || ''} |`),
    ];
    console.log(lines.join('\n'));
    if (process.env.WRITE_BENCHMARK_REPORT === '1') fs.writeFileSync(path.join(process.cwd(), 'broll-import', 'search-benchmark-report.md'), `${lines.join('\n')}\n`);
    expect(rows.length).toBe(BENCHMARK.length);
  });
});
