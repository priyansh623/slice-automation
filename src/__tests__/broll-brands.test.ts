import { describe, it, expect } from 'vitest';
import { IDENTIFIED_UNRESOLVED_BRANDS, planBrandAssociations, validateBrandAssociation, type BrandAssociation } from '@/lib/broll-brands';

const notes = (value: unknown) => JSON.stringify(value);

describe('validateBrandAssociation', () => {
  const base: BrandAssociation = { brandName: 'Subway', role: 'hero', clearanceStatus: 'unresolved', note: null };

  it('accepts all four roles', () => {
    expect(validateBrandAssociation(base)).toEqual([]);
    expect(validateBrandAssociation({ ...base, brandName: 'Hyundai', role: 'incidental' })).toEqual([]);
    expect(validateBrandAssociation({ ...base, brandName: null, role: 'client_product', note: 'Payments app' })).toEqual([]);
    expect(validateBrandAssociation({ ...base, brandName: 'Disney', role: 'unresolved' })).toEqual([]);
    expect(validateBrandAssociation({ ...base, brandName: null, role: 'unresolved', note: 'Cup branding, partly legible' })).toEqual([]);
  });

  it('rejects an unknown role or clearance status', () => {
    expect(validateBrandAssociation({ ...base, role: 'sponsor' as never })).not.toEqual([]);
    expect(validateBrandAssociation({ ...base, clearanceStatus: 'approved' as never })).not.toEqual([]);
  });

  it('does not invent brands: a hero or incidental brand needs a real name', () => {
    expect(validateBrandAssociation({ ...base, brandName: null })).not.toEqual([]);
    expect(validateBrandAssociation({ ...base, brandName: null, role: 'incidental', note: 'something' })).not.toEqual([]);
    for (const name of ['Unknown', 'unidentified brand', 'N/A', 'brand not legible', '   ']) {
      expect(validateBrandAssociation({ ...base, brandName: name })).not.toEqual([]);
    }
  });

  it('requires a note on an unnamed association so the observation is not lost', () => {
    expect(validateBrandAssociation({ ...base, brandName: null, role: 'unresolved', note: null })).not.toEqual([]);
    expect(validateBrandAssociation({ ...base, brandName: null, role: 'unresolved', note: '  ' })).not.toEqual([]);
  });
});

describe('planBrandAssociations', () => {
  it('keeps several brands on one clip as separate associations', () => {
    const plan = planBrandAssociations(notes({
      brands: [
        { name: 'Subway', role: 'hero', clearance: 'unresolved' },
        { name: 'Hyundai', role: 'incidental', clearance: 'unresolved' },
      ],
    }));
    expect(plan.associations.map((a) => [a.brandName, a.role])).toEqual([['Subway', 'hero'], ['Hyundai', 'incidental']]);
    expect(plan.skipped).toEqual([]);
  });

  it('records a client product without inventing a brand name', () => {
    const plan = planBrandAssociations(notes({ clientProduct: { what: 'Payments app on a phone', brandConfirmed: false }, brands: [] }));
    expect(plan.associations).toEqual([
      { brandName: null, role: 'client_product', clearanceStatus: 'unresolved', note: 'Payments app on a phone' },
    ]);
  });

  it('never carries a clearance decision over from notes', () => {
    const plan = planBrandAssociations(notes({ clearance: 'cleared', brands: [{ name: 'Starbucks', role: 'hero', clearance: 'cleared' }] }));
    expect(plan.associations[0].clearanceStatus).toBe('unresolved');
  });

  it('keeps an identifiable brand with an undecided role as a named unresolved association', () => {
    expect(IDENTIFIED_UNRESOLVED_BRANDS.has('disney')).toBe(true);
    const plan = planBrandAssociations(notes({ brands: [{ name: 'Disney', role: 'unresolved', clearance: 'unresolved', note: 'Character print on the hero bag.' }] }));
    expect(plan.associations).toEqual([
      { brandName: 'Disney', role: 'unresolved', clearanceStatus: 'unresolved', note: 'Character print on the hero bag.' },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('does not treat PLAY (the C23 tape) as an identified brand', () => {
    expect(IDENTIFIED_UNRESOLVED_BRANDS.has('play')).toBe(false);
    const [a] = planBrandAssociations(notes({ brands: [{ name: 'PLAY', role: 'unresolved', clearance: 'unresolved' }] })).associations;
    expect(a.brandName).toBeNull();
    expect(a.note).toBe('PLAY');
  });

  it('stores unidentified observations without a brand name and keeps the description', () => {
    const plan = planBrandAssociations(notes({
      brands: [
        { name: 'Printed tape reading "PLAY"', role: 'unresolved', clearance: 'unresolved', note: 'Not an identifiable brand.' },
        { name: 'Snack packet, brand not legible', role: 'unresolved', clearance: 'unresolved' },
        { name: 'Football video game, title not identified', role: 'unresolved', clearance: 'unresolved' },
        { name: 'Cup branding, partly legible', role: 'unresolved', clearance: 'unresolved' },
      ],
    }));
    expect(plan.skipped).toEqual([]);
    expect(plan.associations).toHaveLength(4);
    for (const a of plan.associations) {
      expect(a.brandName).toBeNull();
      expect(a.role).toBe('unresolved');
      expect(a.clearanceStatus).toBe('unresolved');
    }
    expect(plan.associations[0].note).toBe('Printed tape reading "PLAY" — Not an identifiable brand.');
    expect(plan.associations[1].note).toBe('Snack packet, brand not legible');
  });

  it('keeps the role of an observation separate from its clearance', () => {
    const [a] = planBrandAssociations(notes({ brands: [{ name: 'Cup branding, partly legible', role: 'unresolved', clearance: 'cleared' }] })).associations;
    expect(a.role).toBe('unresolved');
    expect(a.clearanceStatus).toBe('unresolved');
  });

  it('skips and reports an entry whose role is not recognised', () => {
    const plan = planBrandAssociations(notes({ brands: [{ name: 'Acme', role: 'sponsor' }, { name: 'Blinkit', role: 'hero' }] }));
    expect(plan.associations.map((a) => a.brandName)).toEqual(['Blinkit']);
    expect(plan.skipped.map((s) => s.name)).toEqual(['Acme']);
  });

  it('does not duplicate a brand listed twice in the same role', () => {
    const plan = planBrandAssociations(notes({ brands: [{ name: "Lay's", role: 'incidental' }, { name: "lay's", role: 'incidental' }] }));
    expect(plan.associations).toHaveLength(1);
  });

  it('returns nothing for empty, null or non-JSON notes', () => {
    for (const value of [null, '', 'free text note', '[]', '{}']) {
      expect(planBrandAssociations(value).associations).toEqual([]);
    }
  });
});
