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

// Étapes du funnel dans l'ordre commercial (ids internes HubSpot).
const FUNNEL = [
  { id: 'qualifiedtobuy',        label: 'RDV Qualif' },
  { id: 'presentationscheduled', label: 'RDV Propale' },
  { id: 'decisionmakerboughtin', label: 'Négociation' },
  { id: 'contractsent',          label: 'Contrat envoyé' },
];
const IDX = Object.fromEntries(FUNNEL.map((s, i) => [s.id, i]));

// Reconstruit le statut et l'étape max atteinte d'un deal à partir de l'historique dealstage.
// historyValues : liste des valeurs successives de dealstage (l'ordre n'importe pas ici).
function analyzeDeal({ historyValues, isClosedWon, isClosed }) {
  const won = isClosedWon === true;
  const closed = isClosed === true;
  const lost = closed && !won;
  const open = !closed;
  let reached = -1;
  for (const v of historyValues || []) {
    if (v in IDX) reached = Math.max(reached, IDX[v]);
  }
  return { won, lost, open, reached };
}

const CONFIDENCE_MIN = 30; // seuil "échantillon solide"

// Pour chaque étape du funnel : P(gagné | a atteint l'étape), sur les deals RÉSOLUS.
function computeStageWinRates(deals) {
  const resolved = (deals || []).filter(d => d.won || d.lost);
  return FUNNEL.map((s, i) => {
    const reached = resolved.filter(d => d.reached >= i);
    const n = reached.length;
    const w = reached.filter(d => d.won).length;
    const p = n ? w / n : null;
    const ci = wilson(w, n);
    let confidence = 'none';
    if (n >= CONFIDENCE_MIN) confidence = 'ok';
    else if (n > 0) confidence = 'low';
    return {
      id: s.id,
      label: s.label,
      won: w,
      resolved: n,
      suggested: p == null ? null : Math.round(p * 100),
      ciLow: ci.low == null ? null : Math.round(ci.low * 100),
      ciHigh: ci.high == null ? null : Math.round(ci.high * 100),
      confidence,
    };
  });
}

module.exports = { wilson, analyzeDeal, computeStageWinRates, FUNNEL, CONFIDENCE_MIN };
