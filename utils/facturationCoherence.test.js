'use strict';
const { TVA_RATE, lineExpectedTTC, computeEcart } = require('./facturationCoherence');

describe('lineExpectedTTC', () => {
  it('acompte = montantAcompte HT × 1.2', () => {
    expect(lineExpectedTTC({ ca: 10000, montantAcompte: 4000 }, 'acompte')).toBeCloseTo(4800, 5);
  });
  it('solde = (ca - montantAcompte) HT × 1.2', () => {
    expect(lineExpectedTTC({ ca: 10000, montantAcompte: 4000 }, 'solde')).toBeCloseTo(7200, 5);
  });
  it('champs manquants → 0', () => {
    expect(lineExpectedTTC({}, 'acompte')).toBe(0);
    expect(lineExpectedTTC(null, 'solde')).toBe(0);
  });
});

describe('computeEcart', () => {
  it('calcule écart absolu et relatif', () => {
    const r = computeEcart(14400, 13200);
    expect(r.sumTTC).toBe(14400);
    expect(r.targetTTC).toBe(13200);
    expect(r.ecart).toBeCloseTo(1200, 5);
    expect(r.ecartPct).toBeCloseTo(1200 / 13200, 5);
  });
  it('cible nulle → ecartPct null (pas de division par zéro)', () => {
    const r = computeEcart(500, 0);
    expect(r.ecart).toBe(500);
    expect(r.ecartPct).toBeNull();
  });
  it('TVA_RATE exporté = 1.2', () => {
    expect(TVA_RATE).toBe(1.2);
  });
});
