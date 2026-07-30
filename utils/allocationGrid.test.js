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
    const a = { sourcing: ['A'], rdv_nego: ['A'], prez: ['A'], relance: ['A'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 100 });
  });

  it('newsale, A source / B gere le reste -> 30 / 70', () => {
    const a = { sourcing: ['A'], rdv_nego: ['B'], prez: ['B'], relance: ['B'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 30, B: 70 });
  });

  it('newsale, A sourcing+relance / B rdv+prez -> 50 / 50', () => {
    const a = { sourcing: ['A'], relance: ['A'], rdv_nego: ['B'], prez: ['B'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 50, B: 50 });
  });

  it('upsale, A apporteur / C operationnel / B rdv+prez -> 30 / 35 / 35', () => {
    const a = { sourcing: ['A'], operationnel: ['C'], rdv_nego: ['B'], prez: ['B'] };
    expect(computeAllocation('upsale', a)).toEqual({ A: 30, C: 35, B: 35 });
  });

  it('composante partagee -> poids reparti a parts egales', () => {
    const a = { sourcing: ['A', 'B'], rdv_nego: ['A'], prez: ['A'], relance: ['A'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 85, B: 15 });
  });

  it('composante non assuree -> poids redistribue (normalisation)', () => {
    const a = { sourcing: ['A'], rdv_nego: ['B'], prez: ['B'] };
    expect(computeAllocation('upsale', a)).toEqual({ A: 46, B: 54 });
  });

  it('somme toujours exactement 100', () => {
    const a = { sourcing: ['A'], rdv_nego: ['B'], prez: ['C'], relance: ['C'] };
    const r = computeAllocation('newsale', a);
    expect(r).toEqual({ A: 30, B: 30, C: 40 });
    expect(Object.values(r).reduce((s, v) => s + v, 0)).toBe(100);
  });

  it('aucune composante assuree -> {}', () => {
    expect(computeAllocation('newsale', {})).toEqual({});
  });

  it('type inconnu -> leve une erreur', () => {
    expect(() => computeAllocation('autre', {})).toThrow();
  });
});
