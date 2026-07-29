'use strict';
const { wilson, analyzeDeal } = require('./stageWinRates');

describe('wilson : intervalle de confiance à 95 %', () => {
  it('n = 0 → bornes nulles', () => {
    expect(wilson(0, 0)).toEqual({ low: null, high: null });
  });
  it('50/100 → environ [0.40, 0.60]', () => {
    const ci = wilson(50, 100);
    expect(ci.low).toBeCloseTo(0.404, 2);
    expect(ci.high).toBeCloseTo(0.596, 2);
  });
  it('bornes toujours dans [0, 1]', () => {
    const a = wilson(0, 10);
    const b = wilson(10, 10);
    expect(a.low).toBeGreaterThanOrEqual(0);
    expect(b.high).toBeLessThanOrEqual(1);
  });
});

describe('analyzeDeal : reconstruction du parcours', () => {
  it('gagné passé par Qualif puis Propale → reached = 1', () => {
    const d = analyzeDeal({ historyValues: ['qualifiedtobuy', 'presentationscheduled', 'closedwon'], isClosedWon: true, isClosed: true });
    expect(d).toEqual({ won: true, lost: false, open: false, reached: 1 });
  });
  it('perdu monté jusqu\'à Contrat → lost, reached = 3', () => {
    const d = analyzeDeal({ historyValues: ['decisionmakerboughtin', 'contractsent', 'closedlost'], isClosedWon: false, isClosed: true });
    expect(d).toEqual({ won: false, lost: true, open: false, reached: 3 });
  });
  it('importé direct à gagné (aucune étape funnel) → reached = -1', () => {
    const d = analyzeDeal({ historyValues: ['closedwon'], isClosedWon: true, isClosed: true });
    expect(d.reached).toBe(-1);
    expect(d.won).toBe(true);
  });
  it('deal ouvert en Négociation → open, reached = 2', () => {
    const d = analyzeDeal({ historyValues: ['qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin'], isClosedWon: false, isClosed: false });
    expect(d).toEqual({ won: false, lost: false, open: true, reached: 2 });
  });
  it('saut d\'étape (Qualif puis Contrat) → reached = 3', () => {
    const d = analyzeDeal({ historyValues: ['qualifiedtobuy', 'contractsent'], isClosedWon: false, isClosed: false });
    expect(d.reached).toBe(3);
  });
});
