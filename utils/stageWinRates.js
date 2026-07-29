'use strict';

// Intervalle de confiance de Wilson à 95 % pour une proportion x/n.
// Renvoie des proportions dans [0, 1] (converties en % par computeStageWinRates).
function wilson(x, n) {
  if (!n) return { low: null, high: null };
  const z = 1.96;
  const phat = x / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

module.exports = { wilson };
