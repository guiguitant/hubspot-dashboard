'use strict';

// Grilles d'allocation du CA entre co-partners commerciaux (SOURCE DE VERITE).
// Spec : docs/superpowers/specs/2026-07-30-allocation-copartner-commercial-design.md
// Un MIROIR de GRIDS + computeAllocation existe dans public/pilot.html (calculateur front) :
// toute modification des poids ou de la logique ici DOIT y etre repercutee.

const GRIDS = {
  newsale: [
    { key: 'sourcing', label: 'Sourcing du prospect', weight: 40 },
    { key: 'rdv_nego', label: 'RDV + negociation', weight: 30 },
    { key: 'prez', label: 'Redaction prez / proposition', weight: 30 },
  ],
  upsale: [
    { key: 'sourcing', label: "Sourcing / apporteur d'origine", weight: 35 },
    { key: 'operationnel', label: 'Aspect operationnel (retention)', weight: 35 },
    { key: 'rdv_nego', label: 'RDV + negociation', weight: 15 },
    { key: 'prez', label: 'Redaction prez / proposition', weight: 15 },
  ],
};

// Convertit des poids reels en pourcentages ENTIERS dont la somme vaut exactement 100
// (methode des plus forts restes). {} si le total est nul.
function roundTo100(weightsByPerson) {
  const persons = Object.keys(weightsByPerson);
  const total = persons.reduce((s, p) => s + weightsByPerson[p], 0);
  if (total <= 0) return {};
  const exact = {};
  const floored = {};
  let sumFloor = 0;
  for (const p of persons) {
    exact[p] = (weightsByPerson[p] / total) * 100;
    floored[p] = Math.floor(exact[p]);
    sumFloor += floored[p];
  }
  const remainder = 100 - sumFloor;
  const byFrac = persons.slice().sort((a, b) => (exact[b] - floored[b]) - (exact[a] - floored[a]));
  const out = Object.assign({}, floored);
  for (let i = 0; i < remainder; i++) out[byFrac[i % byFrac.length]] += 1;
  return out;
}

// type : 'newsale' | 'upsale'
// assignments : { composanteKey: [prenoms] }. Une composante partagee repartit son poids
// a parts egales entre ses personnes. Une composante sans personne est ignoree : son poids
// est redistribue au prorata des composantes assurees (via la normalisation finale).
function computeAllocation(type, assignments) {
  const grid = GRIDS[type];
  if (!grid) throw new Error(`Type d'allocation inconnu : ${type}`);
  const weightsByPerson = {};
  for (const comp of grid) {
    const raw = assignments && assignments[comp.key];
    const people = Array.isArray(raw) ? raw.filter(Boolean) : [];
    if (people.length === 0) continue;
    const share = comp.weight / people.length;
    for (const person of people) {
      weightsByPerson[person] = (weightsByPerson[person] || 0) + share;
    }
  }
  return roundTo100(weightsByPerson);
}

module.exports = { GRIDS, computeAllocation, roundTo100 };
