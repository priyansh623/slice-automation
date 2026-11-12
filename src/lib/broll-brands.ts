import { inArray } from 'drizzle-orm';
import { brollClipBrands } from '../db/schema.pg';
import type { BrollDb } from './broll-db';
import { BROLL_CLEARANCE_STATUSES, type BrollClearanceStatus } from './broll-visibility';

// role is what the brand is to the clip. It is separate from clearanceStatus, which is
// whether the brand may be used. 'unresolved' means a brand or brand-like element is visible
// but its role has not been decided; it says nothing about clearance.
export const BROLL_BRAND_ROLES = ['hero', 'incidental', 'client_product', 'unresolved'] as const;
export type BrollBrandRole = (typeof BROLL_BRAND_ROLES)[number];

export interface BrandAssociation {
  // null when the identity is unknown (an unnamed client product or an unidentified observation).
  brandName: string | null;
  role: BrollBrandRole;
  clearanceStatus: BrollClearanceStatus;
  note: string | null;
}

export interface ApiBrandAssociation extends BrandAssociation {
  id: number;
}

export interface SkippedBrandEntry {
  name: string;
  reason: string;
}

export interface BrandAssociationPlan {
  associations: BrandAssociation[];
  skipped: SkippedBrandEntry[];
}

// Text a classifier writes when it could not identify a brand, such as "Unknown" or "brand not
// legible". A row with this as its name would invent an identity, so it is rejected.
const PLACEHOLDER_BRAND_NAME = /^(none|n\/?a)$|\b(unknown|unidentified|unresolved|unnamed|not (legible|identified|visible|known))\b/i;

export function validateBrandAssociation(a: BrandAssociation): string[] {
  const errors: string[] = [];
  if (!(BROLL_BRAND_ROLES as readonly string[]).includes(a.role)) errors.push(`unknown role '${String(a.role)}'`);
  if (!(BROLL_CLEARANCE_STATUSES as readonly string[]).includes(a.clearanceStatus)) errors.push(`unknown clearance status '${String(a.clearanceStatus)}'`);

  const name = a.brandName;
  const hasNote = typeof a.note === 'string' && a.note.trim().length > 0;
  if (name !== null) {
    if (name.trim().length === 0) errors.push('brand name is blank');
    else if (PLACEHOLDER_BRAND_NAME.test(name.trim())) errors.push(`'${name.trim()}' is a placeholder, not a brand name`);
  } else {
    if (a.role === 'hero' || a.role === 'incidental') errors.push(`a ${a.role} brand needs a name`);
    if (!hasNote) errors.push('an unnamed association needs a note describing what was observed');
  }
  return errors;
}

interface NotesBrand { name?: unknown; role?: unknown; note?: unknown }
interface NotesClientProduct { what?: unknown; brandConfirmed?: unknown }

// Names that classification notes list with role 'unresolved' but that are an identifiable
// brand (the role is undecided, the brand is not). Every other unresolved entry describes
// something whose identity is unknown and is stored as an unnamed observation.
export const IDENTIFIED_UNRESOLVED_BRANDS = new Set(['disney']);

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Turns the brand details kept in broll_clips.notes into association rows.
// Clearance is always 'unresolved': the notes are a classifier's observations, not a clearance decision.
// The notes themselves are never modified.
export function planBrandAssociations(notes: string | null): BrandAssociationPlan {
  const plan: BrandAssociationPlan = { associations: [], skipped: [] };
  if (!notes) return plan;

  let parsed: { brands?: unknown; clientProduct?: unknown };
  try {
    parsed = JSON.parse(notes);
  } catch {
    return plan;
  }
  if (!parsed || typeof parsed !== 'object') return plan;

  const seen = new Set<string>();
  const add = (a: BrandAssociation, label: string) => {
    const errors = validateBrandAssociation(a);
    if (errors.length > 0) {
      plan.skipped.push({ name: label, reason: errors.join('; ') });
      return;
    }
    const key = `${a.role}:${(a.brandName ?? '').toLowerCase()}:${a.brandName === null ? (a.note ?? '').toLowerCase() : ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    plan.associations.push(a);
  };

  const brands = Array.isArray(parsed.brands) ? (parsed.brands as NotesBrand[]) : [];
  for (const b of brands) {
    const name = cleanText(b?.name);
    if (!name) continue;
    const note = cleanText(b.note);
    const role = b.role;

    if (role === 'hero' || role === 'incidental' || role === 'client_product') {
      add({ brandName: name, role, clearanceStatus: 'unresolved', note }, name);
    } else if (role === 'unresolved') {
      if (IDENTIFIED_UNRESOLVED_BRANDS.has(name.toLowerCase())) {
        add({ brandName: name, role: 'unresolved', clearanceStatus: 'unresolved', note }, name);
      } else {
        // Identity unknown: keep what was observed, without a brand name.
        add({ brandName: null, role: 'unresolved', clearanceStatus: 'unresolved', note: note ? `${name} — ${note}` : name }, name);
      }
    } else {
      plan.skipped.push({ name, reason: `unrecognised role '${String(role)}'` });
    }
  }

  const client = parsed.clientProduct as NotesClientProduct | null | undefined;
  if (client && typeof client === 'object') {
    add({ brandName: null, role: 'client_product', clearanceStatus: 'unresolved', note: cleanText(client.what) }, 'client product');
  }

  return plan;
}

export async function loadClipBrands(database: BrollDb, clipIds: number[]): Promise<Map<number, ApiBrandAssociation[]>> {
  const byClip = new Map<number, ApiBrandAssociation[]>();
  if (clipIds.length === 0) return byClip;
  const rows = await database.select().from(brollClipBrands).where(inArray(brollClipBrands.clipId, clipIds)).orderBy(brollClipBrands.id);
  for (const r of rows) {
    const list = byClip.get(r.clipId) ?? [];
    list.push({
      id: r.id,
      brandName: r.brandName,
      role: r.role as BrollBrandRole,
      clearanceStatus: r.clearanceStatus as BrollClearanceStatus,
      note: r.note,
    });
    byClip.set(r.clipId, list);
  }
  return byClip;
}
