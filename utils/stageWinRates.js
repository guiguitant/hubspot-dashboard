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

module.exports = { wilson, analyzeDeal, FUNNEL };
