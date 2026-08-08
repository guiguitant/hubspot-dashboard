'use strict';

// Rapprochement pur deals HubSpot gagnes <-> missions Notion, pour l'alerte "deal gagne sans
// mission Notion" (feature C, docs/superpowers/specs/2026-08-08-produits-et-suivis-design.md#C).
// La creation des missions Notion est 100% manuelle : un deal gagne peut etre oublie, ou son
// rapprochement manuel pose sur la mauvaise ligne (cas reel "Somarail" : date de signature d'un
// nouveau deal posee sur une vieille mission homonyme faute de mission de l'annee en cours).
//
// Module pur (aucun effet de bord, aucun appel reseau) : server.js se charge de fetcher les deals
// (fetchWonDealsForYear) et les missions (fetchAllNotionMissions), ce module ne fait que comparer.

const { normalizeLabel } = require('./chargesPerimetre');

// Tolerance de rapprochement sur le montant : +/-1 %.
const MONTANT_TOLERANCE = 0.01;

// Compare deux montants a +/-1% pres (relatif au plus grand des deux en valeur absolue).
// Deux montants nuls sont consideres "proches" (cas degenere, ne devrait pas arriver pour un
// deal gagne, mais evite une division par zero).
function montantsProches(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  const base = Math.max(Math.abs(x), Math.abs(y));
  if (base === 0) return true;
  return Math.abs(x - y) / base <= MONTANT_TOLERANCE;
}

// Periode trimestrielle ('YYYY-Qn') d'une date ISO. null si date absente/invalide : une mission
// sans date de signature (ou un deal sans closedate) ne peut jamais matcher sur ce critere.
function periodeTrimestre(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const quarter = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${quarter}`;
}

// Similarite de nom/client apres normalisation (accents/casse, cf. normalizeLabel) : match si le
// nom du deal contient (ou est contenu dans) le nom de la mission, ou le client de la mission.
// Chaine vide cote deal = jamais de match (evite un match trivial sur deux champs vides).
function nomsSimilaires(deal, mission) {
  const dealNom = normalizeLabel(deal && deal.nom);
  if (!dealNom) return false;
  const missionNom = normalizeLabel(mission && mission.nom);
  if (missionNom && (dealNom.includes(missionNom) || missionNom.includes(dealNom))) return true;
  const missionClient = normalizeLabel(mission && mission.client);
  if (missionClient && (dealNom.includes(missionClient) || missionClient.includes(dealNom))) return true;
  return false;
}

// Une mission est CANDIDATE pour couvrir un deal si le montant matche a +/-1% ET (le trimestre de
// la date de signature Notion = celui du closedate HubSpot OU les noms/clients sont similaires).
// Condition necessaire mais pas suffisante pour la couverture finale : voir orphanWonDeals
// ci-dessous pour l'unicite de couverture (une mission ne peut couvrir qu'un seul deal).
function dealMissionCandidate(deal, mission) {
  if (!montantsProches(deal && deal.montant, mission && mission.ca)) return false;
  const pDeal = periodeTrimestre(deal && deal.closedate);
  const pMission = periodeTrimestre(mission && mission.dateSignature);
  const memeTrimestre = !!pDeal && pDeal === pMission;
  return memeTrimestre || nomsSimilaires(deal, mission);
}

// Rapproche une liste de deals gagnes HubSpot ({ nom, montant, closedate }) et une liste de
// missions Notion ({ nom, client, ca, dateSignature }). Renvoie { couverts, orphelins }.
//
// Unicite de couverture : chaque mission ne peut couvrir qu'UN SEUL deal (sinon deux deals
// "jumeaux" au meme montant seraient tous les deux consideres couverts par la meme ligne Notion,
// masquant que l'un des deux n'a en realite AUCUNE mission). Algorithme par propagation de points
// fixes : on n'assigne que les paires SANS AMBIGUITE (le deal n'a qu'une mission candidate ET
// cette mission n'a que ce deal comme candidat), on retire la paire, on recommence tant que de
// nouvelles paires non-ambigues apparaissent. Toute ambiguite residuelle (deal sans mission
// candidate disponible, ou mission disputee par plusieurs deals sans autre issue) reste NON
// couverte : en cas de doute, on prefere une alerte de trop (verification humaine) qu'une
// couverture silencieuse potentiellement erronee.
function orphanWonDeals(deals, missions) {
  const dealsList = Array.isArray(deals) ? deals : [];
  const missionsList = Array.isArray(missions) ? missions : [];

  // Liste des index de missions candidates pour chaque deal (calculee une seule fois : le
  // resultat de dealMissionCandidate ne change pas au fil de l'algorithme, seule la disponibilite
  // de la mission/du deal evolue).
  const dealCandidats = dealsList.map(deal =>
    missionsList.reduce((acc, mission, mi) => {
      if (dealMissionCandidate(deal, mission)) acc.push(mi);
      return acc;
    }, [])
  );

  const dealCouvert = new Array(dealsList.length).fill(false);
  const missionUtilisee = new Array(missionsList.length).fill(false);

  let changed = true;
  while (changed) {
    changed = false;

    // Nombre de deals non-couverts encore candidats pour chaque mission non-utilisee.
    const dealsParMission = new Array(missionsList.length).fill(0);
    for (let di = 0; di < dealsList.length; di++) {
      if (dealCouvert[di]) continue;
      for (const mi of dealCandidats[di]) {
        if (!missionUtilisee[mi]) dealsParMission[mi]++;
      }
    }

    for (let di = 0; di < dealsList.length; di++) {
      if (dealCouvert[di]) continue;
      const candidatsDispo = dealCandidats[di].filter(mi => !missionUtilisee[mi]);
      if (candidatsDispo.length === 1 && dealsParMission[candidatsDispo[0]] === 1) {
        dealCouvert[di] = true;
        missionUtilisee[candidatsDispo[0]] = true;
        changed = true;
      }
    }
  }

  const orphelins = dealsList.filter((_, di) => !dealCouvert[di]);
  const couverts = dealCouvert.filter(Boolean).length;
  return { couverts, orphelins };
}

module.exports = {
  MONTANT_TOLERANCE,
  montantsProches,
  periodeTrimestre,
  nomsSimilaires,
  dealMissionCandidate,
  orphanWonDeals,
};
