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

// Longueur normalisee minimale pour qu'un containment compte comme similarite (M3, revue) : un nom
// court ("SA", "CO2"...) contenu dans presque n'importe quelle chaine produirait des faux positifs
// massifs. En dessous de ce seuil, ni dealNom ni le champ mission compare ne peuvent faire matcher
// par containment (les deux cotes doivent faire au moins MIN_NOM_LEN caracteres normalises).
const MIN_NOM_LEN = 4;

// Similarite de nom/client apres normalisation (accents/casse, cf. normalizeLabel) : match si le
// nom du deal contient (ou est contenu dans) le nom de la mission, ou le client de la mission.
// Chaine vide cote deal = jamais de match (evite un match trivial sur deux champs vides).
function nomsSimilaires(deal, mission) {
  const dealNom = normalizeLabel(deal && deal.nom);
  if (!dealNom || dealNom.length < MIN_NOM_LEN) return false;
  const missionNom = normalizeLabel(mission && mission.nom);
  if (missionNom && missionNom.length >= MIN_NOM_LEN && (dealNom.includes(missionNom) || missionNom.includes(dealNom))) return true;
  const missionClient = normalizeLabel(mission && mission.client);
  if (missionClient && missionClient.length >= MIN_NOM_LEN && (dealNom.includes(missionClient) || missionClient.includes(dealNom))) return true;
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

// Appariement biparti MAXIMUM entre deals et missions candidates (algorithme de Kuhn, chemins
// augmentants : quelques dizaines de deals par an, complexite O(deals x missions x candidats)
// totalement negligeable). dealCandidats[di] = liste des index de missions candidates du deal di.
// Renvoie matchDeal[di] = index de la mission appariee (-1 si aucune).
//
// Pourquoi un vrai appariement maximum et pas une heuristique "naked singles" (ancienne version,
// corrigee en revue) : sur N deals jumeaux (meme montant, meme trimestre) face a N missions
// jumelles, un appariement complet existe (chaque deal a sa propre mission) mais AUCUN deal n'a de
// candidat "unique" (chacun a N candidats) -> l'heuristique locale rendait 0 couvert au lieu de N,
// generant N fausses alertes. L'appariement maximum trouve la meilleure solution globale : autant
// de missions candidates que de deals jumeaux -> tous couverts ; moins de missions que de deals ->
// exactement le nombre manquant d'orphelins. C'est la vraie prudence (ni faux couverts, ni fausses
// alertes), pas une heuristique conservatrice qui sous-couvre par construction.
function maximumBipartiteMatching(dealCandidats, nbMissions) {
  const matchDeal = new Array(dealCandidats.length).fill(-1); // deal -> mission
  const matchMission = new Array(nbMissions).fill(-1); // mission -> deal

  // Cherche un chemin augmentant depuis le deal di : essaie chaque mission candidate non visitee
  // dans cette tentative ; si elle est libre ou que son deal actuel peut se reloger ailleurs
  // (recursion), on (re)affecte di <-> mi et on remonte "true".
  function tryAugment(di, visited) {
    for (const mi of dealCandidats[di]) {
      if (visited[mi]) continue;
      visited[mi] = true;
      if (matchMission[mi] === -1 || tryAugment(matchMission[mi], visited)) {
        matchMission[mi] = di;
        matchDeal[di] = mi;
        return true;
      }
    }
    return false;
  }

  for (let di = 0; di < dealCandidats.length; di++) {
    tryAugment(di, new Array(nbMissions).fill(false));
  }

  return matchDeal;
}

// Rapproche une liste de deals gagnes HubSpot ({ nom, montant, closedate }) et une liste de
// missions Notion ({ nom, client, ca, dateSignature }). Renvoie { couverts, orphelins }.
//
// Unicite de couverture : chaque mission ne peut couvrir qu'UN SEUL deal (sinon deux deals
// "jumeaux" au meme montant seraient tous les deux consideres couverts par la meme ligne Notion,
// masquant que l'un des deux n'a en realite AUCUNE mission). Resolu par appariement biparti
// MAXIMUM (voir maximumBipartiteMatching ci-dessus) entre l'ensemble des deals et l'ensemble des
// missions candidates : couverts = taille de l'appariement, orphelins = deals non apparies. Un
// deal sans AUCUNE mission candidate reste toujours orphelin (aucune ambiguite possible).
function orphanWonDeals(deals, missions) {
  const dealsList = Array.isArray(deals) ? deals : [];
  const missionsList = Array.isArray(missions) ? missions : [];

  // Liste des index de missions candidates pour chaque deal (dealMissionCandidate est pure, son
  // resultat ne depend que des donnees d'entree, jamais de l'appariement en cours de calcul).
  const dealCandidats = dealsList.map(deal =>
    missionsList.reduce((acc, mission, mi) => {
      if (dealMissionCandidate(deal, mission)) acc.push(mi);
      return acc;
    }, [])
  );

  const matchDeal = maximumBipartiteMatching(dealCandidats, missionsList.length);
  const orphelins = dealsList.filter((_, di) => matchDeal[di] === -1);
  const couverts = dealsList.length - orphelins.length;
  return { couverts, orphelins };
}

// --- Suggestions de missions pour la validation manuelle des orphelins (feature C-2) ---
//
// Pourquoi un second niveau de similarite : le rapprochement automatique ci-dessus est un-pour-un a
// +/-1 %, il ne peut structurellement PAS voir un deal decoupe en plusieurs missions Notion
// ("EPD - Ecoforest" 39 000 -> "Ecoforest Part1" 28 000 + "Ecoforest Part2" 11 000) ni un deal
// regroupe avec un autre client dans une mission unique ("Moulin du nord" 2 500 -> "Minoterie /
// Moulin" 5 000). Ces deals sortent en orphelins alors qu'ils SONT dans Notion. missionsProches ne
// couvre rien (aucun impact sur couverts/orphelins) : elle ne fait que proposer a l'utilisateur les
// lignes Notion plausibles, pour qu'il arbitre a la main.

// Longueur minimale d'un mot pour etre "significatif". En dessous, un mot est soit un mot outil
// ("de", "du", "la"), soit une abreviation ultra-repandue ("SA", "EPD", "ACV") qui rapprocherait
// n'importe quoi de n'importe quoi.
const MOT_MIN_LEN = 4;

// Mots trop generiques pour identifier un client : mots outils francais et vocabulaire metier
// present dans la moitie des intitules de deals/missions. Sans cette liste, "Renault - bilan
// carbone" et "Peugeot bilan carbone" seraient rapproches sur "bilan"/"carbone".
const MOTS_NON_SIGNIFICATIFS = new Set([
  // mots outils (>= MOT_MIN_LEN, les plus courts sont deja filtres par la longueur)
  'avec', 'dans', 'pour', 'sans', 'sous', 'leur', 'leurs', 'elle', 'elles', 'cette', 'ces', 'des',
  'les', 'une', 'aux', 'par', 'plus', 'tout', 'tous', 'autre', 'autres',
  // vocabulaire metier / structure de mission
  'mission', 'missions', 'projet', 'projets', 'client', 'clients', 'dossier', 'etude', 'etudes',
  'phase', 'part', 'part1', 'part2', 'part3', 'tranche', 'solde', 'acompte', 'devis', 'offre',
  'bilan', 'carbone', 'empreinte', 'audit', 'accompagnement', 'conseil', 'formation', 'strategie',
  'plan', 'societe', 'entreprise', 'groupe', 'group', 'france', 'sarl', 'sasu',
]);

// Mots significatifs d'un libelle : normalisation accents/casse (normalizeLabel), decoupe sur tout
// ce qui n'est ni lettre ni chiffre (tirets, slashs, esperluettes...), puis filtre longueur + liste
// des mots non significatifs.
function motsSignificatifs(s) {
  return normalizeLabel(s)
    .split(/[^a-z0-9]+/)
    .filter(mot => mot.length >= MOT_MIN_LEN && !MOTS_NON_SIGNIFICATIFS.has(mot));
}

// Vrai si les deux libelles partagent au moins un mot significatif. Complementaire du containment
// de nomsSimilaires, qui echoue des qu'un caractere separe les deux formes : "moulin du nord" n'est
// PAS une sous-chaine de "la minoterie & moulins du nord" (le "s" de "moulins" casse tout), alors
// que le mot "moulin" est bien commun aux deux.
function motsCommuns(a, b) {
  const setA = new Set(motsSignificatifs(a));
  if (setA.size === 0) return false;
  return motsSignificatifs(b).some(mot => setA.has(mot));
}

// Vrai si la mission est un candidat PLAUSIBLE pour ce deal aux yeux d'un humain (nom ou client
// similaire). Volontairement plus large que dealMissionCandidate : aucun critere de montant ni de
// date, puisque c'est justement l'ecart de montant (split/regroupement) qui empeche le
// rapprochement automatique.
function missionProcheDuDeal(deal, mission) {
  if (nomsSimilaires(deal, mission)) return true;
  const nomDeal = deal && deal.nom;
  return motsCommuns(nomDeal, mission && mission.nom) || motsCommuns(nomDeal, mission && mission.client);
}

// Missions Notion plausibles pour un deal orphelin, triees par ecart de montant croissant (la plus
// proche du montant du deal en premier : c'est l'ordre de lecture utile quand on cherche a
// reconstituer un split) et tronquees a `max`. Retourne { nom, montant, dateSignature } par mission.
// Le tri de V8 est stable : a ecart egal, l'ordre d'origine (celui de Notion) est conserve.
function missionsProches(deal, missions, max = 5) {
  const missionsList = Array.isArray(missions) ? missions : [];
  const montantDeal = Number(deal && deal.montant) || 0;
  return missionsList
    .filter(mission => missionProcheDuDeal(deal, mission))
    .map(mission => ({
      nom: mission.nom || 'Sans nom',
      montant: Number(mission.ca) || 0,
      dateSignature: mission.dateSignature || null,
    }))
    .sort((a, b) => Math.abs(a.montant - montantDeal) - Math.abs(b.montant - montantDeal))
    .slice(0, Math.max(0, Number(max) || 0));
}

module.exports = {
  MONTANT_TOLERANCE,
  MIN_NOM_LEN,
  MOT_MIN_LEN,
  montantsProches,
  periodeTrimestre,
  nomsSimilaires,
  dealMissionCandidate,
  maximumBipartiteMatching,
  orphanWonDeals,
  motsSignificatifs,
  motsCommuns,
  missionProcheDuDeal,
  missionsProches,
};
