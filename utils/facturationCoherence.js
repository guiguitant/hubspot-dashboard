'use strict';

// Taux TVA pour convertir les montants HT (Notion) en TTC (Pennylane).
// Aligné sur la convention server.js (TTC = HT × 1.2).
const TVA_RATE = 1.2;

// Montant TTC attendu d'une ligne (mission, type) à partir des montants HT Notion.
// acompte → montantAcompte ; solde → ca - montantAcompte (cf. server.js:2438-2439).
function lineExpectedTTC(mission, type) {
  if (!mission) return 0;
  const ca = Number(mission.ca) || 0;
  const acpt = Number(mission.montantAcompte) || 0;
  const ht = type === 'acompte' ? acpt : (ca - acpt);
  return ht * TVA_RATE;
}

// Compare une somme TTC à une cible TTC. ecartPct = null si cible nulle.
function computeEcart(sumTTC, targetTTC) {
  const sum = Number(sumTTC) || 0;
  const target = Number(targetTTC) || 0;
  const ecart = sum - target;
  const ecartPct = target !== 0 ? ecart / target : null;
  return { sumTTC: sum, targetTTC: target, ecart, ecartPct };
}

module.exports = { TVA_RATE, lineExpectedTTC, computeEcart };
