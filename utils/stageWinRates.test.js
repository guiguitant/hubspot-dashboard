'use strict';
const { wilson, analyzeDeal, computeStageWinRates } = require('./stageWinRates');

// Fabrique n deals résolus ayant atteint l'étape `reached`, dont w gagnés.
function resolvedDeals(reached, w, total) {
  const out = [];
  for (let i = 0; i < total; i++) {
    const won = i < w;
    out.push({ won, lost: !won, open: false, reached });
  }
  return out;
}

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

describe('computeStageWinRates', () => {
  it('renvoie une ligne par étape du funnel', () => {
    const r = computeStageWinRates([]);
    expect(r.map(s => s.id)).toEqual(['qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin', 'contractsent']);
  });
  it('étape sans deal résolu → confidence none, suggested null', () => {
    const r = computeStageWinRates([]);
    expect(r[0].confidence).toBe('none');
    expect(r[0].suggested).toBeNull();
  });
  it('tous gagnés à Contrat → 100 % à toutes les étapes atteintes', () => {
    const deals = resolvedDeals(3, 40, 40); // 40 gagnés, reached = 3 (donc >= toutes les étapes)
    const r = computeStageWinRates(deals);
    expect(r[0].suggested).toBe(100);
    expect(r[3].suggested).toBe(100);
    expect(r[0].confidence).toBe('ok'); // 40 >= 30
  });
  it('confidence low si moins de 30 résolus', () => {
    const deals = resolvedDeals(0, 5, 10); // 10 résolus atteignant Qualif, 5 gagnés
    const r = computeStageWinRates(deals);
    expect(r[0].resolved).toBe(10);
    expect(r[0].suggested).toBe(50);
    expect(r[0].confidence).toBe('low');
  });
  it('deals ouverts exclus du calcul', () => {
    const deals = [
      { won: true, lost: false, open: false, reached: 0 },
      { won: false, lost: false, open: true, reached: 0 }, // ouvert : ignoré
    ];
    const r = computeStageWinRates(deals);
    expect(r[0].resolved).toBe(1);
    expect(r[0].suggested).toBe(100);
  });
});
