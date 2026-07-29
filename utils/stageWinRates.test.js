'use strict';
const { wilson } = require('./stageWinRates');

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
