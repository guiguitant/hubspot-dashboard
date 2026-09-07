'use strict';

// Conversion CUMUL <-> PART pour la saisie de l'avancement des missions.
// Voir docs/superpowers/specs/2026-08-31-ca-avancement-design.md, sections 5.1 sexies et 5.1 octies.
//
// Constat de Nathan sur la grille livree (5.1 ter/quater/quinquies) : elle demandait le CUMUL au
// 31/12 de chaque exercice, ce qui se lit comme une somme absurde en parcourant une ligne ("50 % en
// 2026, faut mettre 100 % en 2027, ca fait 150 % en lecture directe"). Ce module fait desormais
// l'aller-retour entre ce CUMUL (ce que la table mission_avancements stocke, et ce que le serveur
// attend dans POST /api/avancement { pct }) et la PART affichee/saisie par l'utilisateur (la part du
// travail realisee DANS l'exercice) : part(N) = cumul(N) - cumul(N-1) ; cumul(N) = cumul(N-1) +
// part(N). Le STOCKAGE ne change pas (§5.1 sexies point a) : c'est une affaire de presentation.
//
// Ajout §5.1 octies point a : quand la toute premiere ligne suivie d'une mission saute par-dessus
// EXERCICE_ANCRE (aucune ancre pour combler le trou), le cumul stocke sous-estime l'avancement reel
// d'autant que ce qui a deja ete facture sur les exercices manques. pointDepartImplicite/
// cumulEffectif/partAffichee corrigent cette sous-estimation, PUREMENT a l'affichage et dans la
// suggestion : le stockage, pctFin et le calcul du CA a l'avancement restent strictement inchanges.
//
// Duplique inline dans public/pilot.html (fonctions prefixees avancementCumulAuPlusTard,
// avancementLigneExacte, avancementPartExercice, avancementPctFactureAvant, avancementPointDepartImplicite,
// avancementCumulEffectif, avancementSuggestionPart, avancementPlanSaisiePart) : pilot.html est un
// fichier HTML autonome sans bundler, le navigateur ne peut pas require() ce module. Les deux copies
// DOIVENT rester identiques ; toute correction de la logique ou des messages doit etre reportee des
// deux cotes (voir le rapport de tache pour la liste des messages exacts).
//
// Module PUR : aucune I/O. `pctFin` est repris tel quel de utils/caAvancement.js (meme semantique de
// report en avant : la ligne de l'exercice le plus recent <= exercice, 0 si aucune) plutot que
// reimplemente, pour ne jamais diverger de la fonction qui sert au calcul du CA cote serveur. Lecture
// seule de ce module (require), aucune modification (contrainte du lot).
const { pctFin, EXERCICE_ANCRE } = require('./caAvancement');

// Cumul (%) de la mission au plus tard a `exercice`, avec report en avant. Alias direct de pctFin :
// nomme differemment ici pour rester lisible dans le vocabulaire "cumul" de ce module.
const cumulAuPlusTard = pctFin;

// Ligne exacte d'un exercice (PAS de report en avant) : sert a distinguer "aucune saisie pour CET
// exercice precis" (la part n'est pas definie, seule une suggestion peut etre proposee) de "une
// saisie existe, sa part est calculable".
function ligneExacte(lignesMission, exercice) {
  return (lignesMission || []).find(l => l && Number(l.exercice) === Number(exercice)) || null;
}

// Part affichable pour un exercice : null si aucune ligne exacte n'existe pour cet exercice precis
// (rien de saisi). Sinon cumul(exercice) - cumul(exercice-1), qui peut etre negatif si l'avancement a
// ete revise a la baisse (revision au jugé, acceptee par la spec §3.2 du design initial).
function partExercice(lignesMission, exercice) {
  const ligne = ligneExacte(lignesMission, exercice);
  if (!ligne) return null;
  return (Number(ligne.pct) || 0) - cumulAuPlusTard(lignesMission, exercice - 1);
}

// Part deja comptee (%) par Pilot sur les exercices STRICTEMENT anterieurs a `exercice`, pour une
// mission SANS ancre. Sert de repli pour suggestionPart ci-dessous (spec 5.1 septies, point e).
//
// CORRECTIF (ronde de revue 1) : la premiere version reconstruisait les annees depuis les dates
// d'emission BRUTES (dateFactureAcompte/dateFactureFinale), un volet sans date etant alors exclu
// purement et simplement. C'etait le mauvais rattachement : ce n'est PAS ainsi que Pilot compte deja
// le CA d'une mission non suivie. `signedAmountForYear`/`totalCaAnnee` (utils/kpiCompute.js, la base
// "CA signe" partagee par Cockpit/Analytics/KPI/CR) rattachent chaque volet a `anneeAcompte`/
// `anneeSolde` : l'annee de la date d'emission SI elle est connue, SINON un repli sur le champ Notion
// « Annee final ». La premiere version de cette fonction ne voyait donc pas ce repli, et sous-estimait
// ce qui etait deja compte : exactement le meme defaut de double comptage que Café Méo, par un autre
// chemin (contre-exemple mesure en revue : mission 20 000 EUR, acompte 8 000 EUR facture en mars 2025,
// solde 12 000 EUR JAMAIS facture mais "Annee final" = 2025, aucune ancre ; Pilot a deja compte les
// 20 000 EUR en CA 2025 via ce repli ; l'ancienne version de cette fonction ne voyait que l'acompte
// [dateFactureFinale nulle -> solde exclu a tort] et suggerait 60 % pour 2026, ce qui aurait recompte
// les 12 000 EUR restants).
//
// Corrige : lit directement `mission.anneeAcompte`/`mission.anneeSolde`, deja calcules cote serveur
// avec ce meme repli (utils/avancementMissionInfo.js, missionAvancementInfo) et deja exposes par
// GET /api/avancement -- jamais recalcules depuis les dates brutes ici, pour ne jamais diverger de la
// regle de rattachement reellement utilisee par le CA "hors avancement" (utils/kpiCompute.js,
// intouche, lu mais jamais require depuis ce module pur, meme parti pris que
// utils/avancementMissionInfo.js qui reimplemente cette regle plutot que d'exposer un symbole croise
// entre modules purs).
function pctFactureAvant(mission, exercice) {
  const m = mission || {};
  const ca = Number(m.ca) || 0;
  if (ca <= 0) return 0;
  const acompte = Number(m.montantAcompte) || 0;
  const solde = Math.max(0, ca - acompte);
  const anneeAcompte = m.anneeAcompte != null ? Number(m.anneeAcompte) : null;
  const anneeSolde = m.anneeSolde != null ? Number(m.anneeSolde) : null;
  let total = 0;
  if (acompte > 0 && anneeAcompte != null && anneeAcompte < exercice) total += acompte;
  if (solde > 0 && anneeSolde != null && anneeSolde < exercice) total += solde;
  return (total / ca) * 100;
}

// Point de depart implicite (%) d'une mission SANS ancre sur un exercice anterieur (spec 5.1 octies
// point a). Cas reel qui a revele le defaut : Café Méo, 18 000 EUR au total, acompte 5 400 EUR
// facture le 24/11/2025, solde 12 600 EUR facture le 16/07/2026, AUCUNE ancre 2025 (exercice fige).
// Nathan saisit 70 % pour 2026 (via planSaisiePart, ecrit le cumul 2026 = 0 + 70 = 70, puisque
// cumulAuPlusTard(2025) = 0 faute d'ancre). Consequence en cascade AVANT ce correctif : la colonne
// 2025 restait VIDE (aucune ligne exacte a 2025) et suggestionPart proposait 30 % pour 2027 alors que
// la mission est facturee a 100 % fin 2026 (5 400 + 12 600 = 18 000) et qu'il ne reste rien a
// reconnaitre -- parce que la premiere ligne (2026, pct=70) a ete calculee sur l'hypothese fausse
// cumulAuPlusTard(2025) = 0, qui sous-estime de 30 points ce qui etait deja facture.
//
// Le stockage et pctFin/caAvancementMission NE BOUGENT PAS (contrainte absolue de la spec) : le cumul
// stocke a 2026 (70) doit rester tel quel pour que caAvancementMission(2026) = 18000 x (70-0)/100 =
// 12 600 EUR, exactement le solde facture. C'est PUREMENT un correctif d'affichage/suggestion : ce
// que Pilot a deja compte au 31/12 de l'exercice qui precede la toute premiere ligne suivie est la
// part deja FACTUREE cumulee sur les exercices manquants (le CA "hors avancement", avant toute
// saisie, est compte a la date de facture -- meme regle que pctFactureAvant ci-dessus).
//
// Rend 0 si la mission n'a encore AUCUNE ligne (rien a corriger tant que le suivi n'a pas commence),
// ou si sa toute premiere ligne se situe DES EXERCICE_ANCRE (2025) : une ancre y existe alors, elle
// EST deja la verite complete validee par le cabinet (§3.4 du design), il ne faut jamais lui ajouter
// de la facturation par-dessus (cela ferait double emploi avec une donnee deja exacte). Le "trou" que
// ce correctif comble n'existe QUE quand la premiere ligne suivie saute par-dessus EXERCICE_ANCRE.
//
// Borne a [0, 100] (correctif Minor, ronde de revue 1) : pctFactureAvant peut depasser 100 avec une
// donnee Notion incoherente en amont (ex. acompte saisi superieur au prix total de la mission) ; sans
// plafond, la cellule "exercice precedent" afficherait "150 % (deduit)", absurde a l'ecran. Le RESTE
// (cumulEffectif, suggestionPart) etait deja protege par son propre Math.max(0, ...)/`reste > 0`, donc
// aucun chiffre du reste de la fonctionnalite n'etait faux ; seul l'affichage isole de cette valeur
// pouvait choquer. Un test dedie (mission avec acompte > ca) verrouille ce plafond.
function pointDepartImplicite(lignesMission, mission) {
  const lignes = lignesMission || [];
  if (!lignes.length) return 0;
  const exercices = lignes.map(l => Number(l && l.exercice)).filter(Number.isFinite);
  if (!exercices.length) return 0;
  const premiere = Math.min(...exercices);
  if (premiere <= EXERCICE_ANCRE) return 0; // une ancre existe des le plancher : rien d'implicite
  const valeur = pctFactureAvant(mission, premiere);
  return valeur > 0 ? Math.min(100, Math.round(valeur)) : 0;
}

// Cumul "effectif" (%) au 31/12/`exercice` : cumulAuPlusTard (le stockage brut, INCHANGE) plus le
// point de depart implicite ci-dessus, qui corrige une seule fois, pour de bon, la sous-estimation
// causee par l'absence d'ancre. S'applique uniformement a TOUT exercice (pas seulement celui qui suit
// immediatement le "trou") : le report en avant de pctFin propage la meme sous-estimation a chaque
// exercice suivant tant qu'aucune nouvelle ligne ne la corrige, donc la correction doit suivre. Vaut
// exactement cumulAuPlusTard quand pointDepartImplicite rend 0 (mission ancree normalement, ou non
// suivie) : aucune regression sur le comportement existant dans ce cas.
//
// Utilise par suggestionPart (reste des exercices suivants) ET par la grille (colonne "Reste apres
// {n+1}", pilot.html) : les deux doivent voir la MEME verite corrigee, jamais pctFin brut seul, sans
// quoi le "reste" afficherait 30 % pendant que la suggestion afficherait 0 % pour le meme exercice.
function cumulEffectif(lignesMission, exercice, mission) {
  return cumulAuPlusTard(lignesMission, exercice) + pointDepartImplicite(lignesMission, mission);
}

// Part a afficher dans la colonne "exercice precedent" de la grille (spec 5.1 octies point a, corrige
// 5.1 sexies point c) : jamais VIDE quand une part est deductible de la facturation. Retourne
// { part, implicite } : `part` est un nombre ou null (rien a afficher, comportement inchange),
// `implicite` distingue une valeur DEDUITE (jamais enregistree, en lecture seule) d'une vraie ancre.
//
// Ne se declenche QUE sur le "trou" precis : l'exercice precedent demande est EXACTEMENT celui qui
// precede la toute premiere ligne suivie de la mission (premiere - 1) ET aucune ligne exacte n'existe
// deja pour cet exercice (sinon la vraie ancre prime, gere par l'appelant AVANT d'appeler cette
// fonction -- voir avancementCellPartLectureSeule dans pilot.html). Une mission pas encore suivie
// (aucune ligne) ou dont le "trou" ne correspond pas a l'exercice demande ne montre rien : comportement
// inchange, pas de bruit sur les lignes non concernees (meme doctrine que le correctif §5.1 septies
// point c : ne rien afficher plutot qu'une valeur qui ne veut rien dire pour cette cellule precise).
function partAffichee(lignesMission, exercice, mission) {
  const lignes = lignesMission || [];
  if (ligneExacte(lignes, exercice)) return { part: partExercice(lignes, exercice), implicite: false };
  if (!lignes.length) return { part: null, implicite: false };
  const exercices = lignes.map(l => Number(l && l.exercice)).filter(Number.isFinite);
  if (!exercices.length) return { part: null, implicite: false };
  const premiere = Math.min(...exercices);
  if (exercice !== premiere - 1) return { part: null, implicite: false };
  const valeur = pointDepartImplicite(lignes, mission);
  return valeur > 0 ? { part: valeur, implicite: true } : { part: null, implicite: false };
}

// Montant (EUR) correspondant a une part (%) de la mission (spec 5.1 nonies point b) : "le montant
// d'un exercice vaut toujours prix total x part de l'exercice", pour l'exercice courant comme pour
// l'exercice precedent affiche en lecture seule (que sa part vienne d'une ancre ou soit deduite de la
// facturation via partAffichee ci-dessus). Meme arithmetique que caAvancementMission
// (utils/caAvancement.js, INTOUCHE) : Math.round(ca x part / 100). Cette fonction ne remplace ce
// module pour aucun exercice deja couvert par caAvancementMission (le calcul du CA continue de
// reposer exclusivement sur lui) ; elle sert uniquement a l'affichage de la colonne "exercice
// precedent" de la grille, qui n'a pas d'equivalent cote serveur puisque GET /api/avancement ne
// couvre que les deux exercices demandes (N et N+1), jamais N-1.
function montantPart(mission, part) {
  const ca = Number(mission && mission.ca) || 0;
  const p = Number(part) || 0;
  return Math.round((ca * p) / 100);
}

// Suggestion de part (spec point d de 5.1 sexies, CORRIGEE spec 5.1 septies point e : defaut de
// chiffre, double comptage). Reste theorique a realiser = 100 % moins le point de depart deja acquis
// avant cet exercice. Ce point de depart est :
//   - l'ANCRE reportee (cumul de l'avancement saisi) des qu'une ligne existe pour un exercice
//     strictement anterieur a `exercice` : elle prime TOUJOURS, meme si des volets contradictoires
//     sont fournis (une mission ancree a ete validee par le cabinet, sa part reelle peut differer de
//     ce que les seules dates de facture donneraient) ;
//   - a defaut (aucune ligne d'avancement anterieure : mission jamais ancree/suivie avant N), la part
//     deja FACTUREE sur les exercices anterieurs (pctFactureAvant ci-dessus), pour ne jamais
//     recompter au numerateur ce que Pilot a deja compte a la date de facture sur un exercice clos
//     SANS ancre.
//
// Defaut avant correctif (cas reel mesure, Café Méo : 18 000 EUR au total, acompte 5 400 EUR facture
// le 24/11/2025, solde 12 600 EUR facture le 16/07/2026, aucune ancre 2025) : l'ancienne regle valait
// 100 % - cumul des ANCRES uniquement, soit 100 % - 0 % = 100 % pour 2026 ; validee telle quelle elle
// aurait donne 18 000 EUR de CA 2026, recomptant les 5 400 EUR deja comptes en CA 2025 (a la date de
// facture, hors avancement puisque sans ancre). La regle corrigee vaut 100 % - pctFactureAvant(...) =
// 100 % - (5 400 / 18 000 x 100) = 70 %, ce qui redonne exactement les 12 600 EUR restants.
//
// Cette regle ne touche QUE la suggestion (un placeholder jamais enregistre seul) : le CALCUL du CA a
// l'avancement continue de reposer exclusivement sur les ancres (caAvancementMission, pctFin,
// utils/caAvancement.js), jamais sur les volets factures.
//
// `mission` est optionnel : les rares appelants qui n'ont pas cet objet sous la main gardent l'ancien
// comportement pour une mission jamais facturee (repli 0, donc suggestion 100 %). Jamais negative :
// une mission deja a 100 % n'a rien a suggerer (en pratique deja intercepte en amont par le grisage
// des missions terminees, la fonction reste defensive).
//
// CORRECTIF (spec 5.1 octies point a) : la branche "ancre reportee" utilisait cumulAuPlusTard brut,
// qui rate le meme point de depart implicite que la colonne "exercice precedent" (voir
// pointDepartImplicite ci-dessus) des que la toute premiere ligne suivie de la mission saute par-dessus
// EXERCICE_ANCRE. Cas reel : Café Méo, une fois 70 % saisi pour 2026 (lignes = [{2026, pct:70}]),
// suggestionPart(lignes, 2027, caféMéo) prenait aAncreAvant=true (une ligne 2026 < 2027 existe) et
// pointDepart = cumulAuPlusTard(2026) = 70, donc suggerait 30 % pour 2027 -- alors que la mission est
// facturee a 100 % fin 2026 et qu'il ne reste rien. cumulEffectif corrige : 70 (stocke) + 30 (implicite,
// deja facture avant que le suivi ne commence) = 100, donc suggestion 2027 = 0 %. Remplacer
// cumulAuPlusTard par cumulEffectif ici ne change RIEN quand pointDepartImplicite rend 0 (le cas normal,
// ancre a EXERCICE_ANCRE ou mission jamais facturee avant son suivi) : tous les tests preexistants
// de cette branche (Alphapro groupe, mission ancree a 100 %, volets contradictoires) restent inchanges,
// verifie ci-dessous.
function suggestionPart(lignesMission, exercice, mission) {
  const lignes = lignesMission || [];
  const aAncreAvant = lignes.some(l => l && Number.isFinite(Number(l.exercice)) && Number(l.exercice) < exercice);
  const pointDepart = aAncreAvant ? cumulEffectif(lignes, exercice - 1, mission) : pctFactureAvant(mission, exercice);
  const reste = 100 - pointDepart;
  return reste > 0 ? Math.round(reste) : 0;
}

// Coeur du correctif (le "piege" documente dans la spec, point a) : plan d'ecriture pour une saisie
// de PART sur `exercice`. Retourne :
//   { ok: true, ecritures: [{exercice, pctCumule}, ...], cascade: bool }
//   { ok: false, message: '...' }                                        -- refus, aucune ecriture
//
// Decision retenue (documentee dans le rapport de tache) : quand l'exercice SUIVANT porte deja une
// ligne NON figee, on REECRIT son cumul pour PRESERVER la part qu'il affichait avant la modification
// -- mandat explicite de la spec ("il faut donc recalculer et reecrire la ligne N+1 pour preserver la
// part qu'elle affichait"). Si cette reecriture sortirait des bornes [0, 100] (cas Wienerberger reel :
// cumul 50 % en 2026 / 100 % en 2027, soit des parts de 50 % et 50 % ; monter la part 2026 a 60 %
// donnerait un cumul 2027 de 110 %), on REFUSE l'ENSEMBLE de la saisie AVANT tout appel reseau, avec
// un message qui donne la marge de manoeuvre reelle (part maximale ou minimale possible). Ni ecriture
// invalide silencieuse (qui fausserait durablement la part de l'exercice suivant), ni 400 serveur
// incomprehensible (le serveur rejette pct > 100, mais sans dire pourquoi ni quoi faire) : le front
// bloque plus tot, avec une explication actionnable.
//
// Alternative ecartee : laisser le cumul de l'exercice suivant INCHANGE et n'ecrire QUE l'exercice
// modifie, en tolerant que sa part affichee se recalcule automatiquement (silencieusement plus
// petite). Rejetee car la spec est explicite sur la preservation de la part suivante, et parce que
// Nathan doit rester en controle explicite de tout changement touchant une annee deja saisie, meme
// indirect : une confirmation (cote appelant, cf. pilot.html) precede toujours la double ecriture.
function planSaisiePart(lignesMission, exercice, partSaisie) {
  const part = Number(partSaisie);
  if (!Number.isFinite(part)) return { ok: false, message: 'Part invalide.' };

  const lignes = lignesMission || [];
  const cumulPrecedent = cumulAuPlusTard(lignes, exercice - 1);
  const nouveauCumul = Math.round(cumulPrecedent + part);
  if (nouveauCumul < 0 || nouveauCumul > 100) {
    return {
      ok: false,
      message: 'Cette part donnerait un cumul de ' + nouveauCumul + ' % au 31/12/' + exercice + ', hors bornes (0 à 100 %). '
        + 'Part maximale possible : ' + Math.max(0, Math.round(100 - cumulPrecedent)) + ' %.',
    };
  }

  const ecritures = [{ exercice: exercice, pctCumule: nouveauCumul }];

  const ligneSuivante = ligneExacte(lignes, exercice + 1);
  if (ligneSuivante && !ligneSuivante.fige_le) {
    const ancienCumulExercice = cumulAuPlusTard(lignes, exercice); // AVANT la modification en cours
    const partSuivantePreservee = (Number(ligneSuivante.pct) || 0) - ancienCumulExercice;
    const nouveauCumulSuivant = Math.round(nouveauCumul + partSuivantePreservee);
    if (nouveauCumulSuivant < 0 || nouveauCumulSuivant > 100) {
      let conseil;
      if (nouveauCumulSuivant > 100) {
        const max = Math.max(0, Math.round(100 - partSuivantePreservee - cumulPrecedent));
        conseil = 'Réduisez d\'abord la part ' + (exercice + 1) + ' (actuellement ' + partSuivantePreservee + ' %), '
          + 'ou limitez la part ' + exercice + ' à ' + max + ' % au maximum.';
      } else {
        const min = Math.min(100, Math.max(0, Math.round(0 - partSuivantePreservee - cumulPrecedent)));
        conseil = 'Augmentez d\'abord la part ' + (exercice + 1) + ' (actuellement ' + partSuivantePreservee + ' %), '
          + 'ou portez la part ' + exercice + ' à au moins ' + min + ' %.';
      }
      return {
        ok: false,
        message: 'Impossible : pour préserver la part ' + (exercice + 1) + ' telle qu\'elle est aujourd\'hui, le cumul '
          + (exercice + 1) + ' devrait passer à ' + nouveauCumulSuivant + ' %, ce qui est hors bornes (0 à 100 %). ' + conseil,
      };
    }
    ecritures.push({ exercice: exercice + 1, pctCumule: nouveauCumulSuivant });
  }

  return { ok: true, ecritures: ecritures, cascade: ecritures.length > 1 };
}

module.exports = {
  cumulAuPlusTard,
  ligneExacte,
  partExercice,
  pointDepartImplicite,
  cumulEffectif,
  partAffichee,
  montantPart,
  suggestionPart,
  planSaisiePart,
};
