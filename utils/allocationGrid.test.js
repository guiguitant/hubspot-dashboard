'use strict';
const { GRIDS, computeAllocation } = require('./allocationGrid');

describe('GRIDS', () => {
  it('chaque grille somme a 100', () => {
    for (const type of ['newsale', 'upsale']) {
      const total = GRIDS[type].reduce((s, c) => s + c.weight, 0);
      expect(total).toBe(100);
    }
  });
});

describe('computeAllocation', () => {
  it('newsale, une seule personne sur tout -> 100 %', () => {
    const a = { sourcing: ['A'], rdv_nego: ['A'], prez: ['A'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 100 });
  });

  it('newsale, A source / B gere le reste -> 40 / 60', () => {
    const a = { sourcing: ['A'], rdv_nego: ['B'], prez: ['B'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 40, B: 60 });
  });

  it('newsale, sourcing partage A&B, le reste a A -> 80 / 20', () => {
    const a = { sourcing: ['A', 'B'], rdv_nego: ['A'], prez: ['A'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 80, B: 20 });
  });

  it('upsale, A apporteur / C operationnel / B rdv+prez -> 30 / 35 / 35', () => {
    const a = { sourcing: ['A'], operationnel: ['C'], rdv_nego: ['B'], prez: ['B'] };
    expect(computeAllocation('upsale', a)).toEqual({ A: 30, C: 35, B: 35 });
  });

  it('composante non assuree -> poids redistribue (normalisation)', () => {
    const a = { sourcing: ['A'], rdv_nego: ['B'], prez: ['B'] };
    expect(computeAllocation('upsale', a)).toEqual({ A: 46, B: 54 });
  });

  it('somme toujours exactement 100', () => {
    const r = computeAllocation('newsale', { sourcing: ['A'], rdv_nego: ['B'], prez: ['C'] });
    expect(Object.values(r).reduce((s, v) => s + v, 0)).toBe(100);
  });

  it('aucune composante assuree -> {}', () => {
    expect(computeAllocation('newsale', {})).toEqual({});
  });

  it('type inconnu -> leve une erreur', () => {
    expect(() => computeAllocation('autre', {})).toThrow();
  });
});
