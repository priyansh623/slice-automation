/**
 * The approved B-roll vocabulary (categories, activities, settings, brands, tags) and the helpers that map free values
 * onto it. Pure functions: the server builds a Taxonomy from the database, the browser receives the same shape, and the
 * AI output is checked against it. Nothing here creates, renames or deletes anything.
 */
export interface TaxCategory {
  id: number;
  name: string;
  parentId: number | null;
  /** "Parent > Child" */
  path: string;
  scope: string;
  brandScope: string | null;
}
export interface Taxonomy {
  categories: TaxCategory[];
  /** Exact stored values (a value may carry a trailing space, as "Payment " does today). */
  activities: string[];
  settings: string[];
  brands: string[];
  tags: { tag: string; count: number }[];
}

export const emptyTaxonomy = (): Taxonomy => ({ categories: [], activities: [], settings: [], brands: [], tags: [] });

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const key = (s: string) => squash(s).toLowerCase();
const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The tag convention in use: lower case, single spaces, no leading '#'. Returns null for something that is not a tag. */
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = squash(squash(raw).replace(/^#+/, '')).toLowerCase();
  return t.length >= 2 && t.length <= 40 ? t : null;
}

/** Maps a value onto the approved list ignoring case and spacing; returns the stored value exactly, or null. */
export function matchAllowed(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const exact = allowed.find((a) => a === value);
  if (exact !== undefined) return exact;
  const k = key(value);
  return allowed.find((a) => key(a) === k) ?? null;
}

/** The existing brand this name refers to (case, spacing and punctuation ignored), or null. */
export function canonicalBrand(name: unknown, brands: readonly string[]): string | null {
  if (typeof name !== 'string') return null;
  const a = alnum(name);
  if (!a) return null;
  return brands.find((b) => alnum(b) === a) ?? null;
}

/** An existing tag this one is a variation of (e.g. "Credit-Card" or "credit  card" for "credit card"), or the normalised tag itself. */
export function canonicalTag(raw: unknown, vocab: readonly string[]): { tag: string; known: boolean } | null {
  const n = normalizeTag(raw);
  if (!n) return null;
  if (vocab.includes(n)) return { tag: n, known: true };
  const a = alnum(n);
  const near = vocab.find((v) => alnum(v) === a);
  return near ? { tag: near, known: true } : { tag: n, known: false };
}

export const categoryById = (t: Taxonomy, id: unknown): TaxCategory | null =>
  typeof id === 'number' && Number.isInteger(id) ? t.categories.find((c) => c.id === id) ?? null : null;

/** Builds the "Parent > Child" paths and a stable order from raw category rows. */
export function withPaths(rows: { id: number; name: string; parentId: number | null; scope: string; brandScope: string | null; sortOrder?: number }[]): TaxCategory[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path = (r: { name: string; parentId: number | null }): string => {
    const parent = r.parentId != null ? byId.get(r.parentId) : undefined;
    return parent ? `${path(parent)} > ${r.name}` : r.name;
  };
  return [...rows]
    .sort((a, b) => path(a).localeCompare(path(b)))
    .map((r) => ({ id: r.id, name: r.name, parentId: r.parentId, path: path(r), scope: r.scope, brandScope: r.brandScope }));
}

/** Counts how often each distinct value appears, keeping the most common spelling of values that differ only in case. */
export function distinctByUse(values: (string | null | undefined)[]): string[] {
  const groups = new Map<string, Map<string, number>>();
  for (const v of values) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const k = key(v);
    const g = groups.get(k) ?? new Map<string, number>();
    g.set(v, (g.get(v) ?? 0) + 1);
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => [...g.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0])
    .sort((a, b) => a.localeCompare(b));
}
