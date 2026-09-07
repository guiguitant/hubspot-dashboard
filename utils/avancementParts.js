'use strict';

// Conversion CUMUL <-> PART pour la saisie de l'avancement des missions.
// Voir docs/superpowers/specs/2026-08-31-ca-avancement-design.md, section 5.1 sexies.
//
// Constat de Nathan sur la grille livree (5.1 ter/quater/quinquies) : elle demandait le CUMUL au
// 31/12 de chaque exercice, ce qui se lit comme une somme absurde en parcourant une ligne ("50 % en
// 2026, faut mettre 100 % en 2027, ca fait 150 % en lecture directe"). Ce module fait desormais
// l'aller-retour entre ce CUMUL (ce que la table mission_avancements stocke, et ce que le serveur
// attend dans POST /api/avancement { pct }) et la PART affichee/saisie par l'utilisateur (la part du
// travail realisee DANS l'exercice) : part(N) = cumul(N) - cumul(N-1) ; cumul(N) = cumul(N-1) +
// part(N). Le STOCKAGE ne change pas (§5.1 sexies point a) : c'est une affaire de presentation.
//
// Duplique inline dans public/pilot.html (fonctions prefixees avancementCumulAuPlusTard,
// avancementLigneExacte, avancementPartExercice, avancementPctFactureAvant, avancementSuggestionPart,
// avancementPlanSaisiePart) : pilot.html est un fichier HTML autonome sans bundler, le navigateur ne
// peut pas require() ce module. Les deux copies DOIVENT rester identiques ; toute correction de la
// logique ou des messages doit etre reportee des deux cotes (voir le rapport de tache pour la liste
// des messages exacts).
//
// Module PUR : aucune I/O. `pctFin` est repris tel quel de utils/caAvancement.js (meme semantique de
// report en avant : la ligne de l'exercice le plus recent <= exercice, 0 si aucune) plutot que
// reimplemente, pour ne jamais diverger de la fonction qui sert au calcul du CA cote serveur. Lecture
// seule de ce module (require), aucune modification (contrainte du lot).
const { pctFin } = require('./caAvancement');

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

// Part deja facturee (%) sur les exercices STRICTEMENT anterieurs a `exercice`, a partir des VOLETS
// REELS de la mission (montant + date d'emission), pas de l'avancement saisi. Sert de repli pour
// suggestionPart ci-dessous quand aucune ancre n'existe (spec 5.1 septies, point e). Meme regle de
// rattachement que contributionsDepuisVolets (utils/caAvancement.js, base du CR : "factures emises
// datees dans l'annee"), reimplementee ici pour rester un module autonome plutot que d'exposer un
// symbole croise entre modules purs (meme parti pris que utils/avancementMissionInfo.js, qui ne
// require pas non plus caAvancement.js). Un volet SANS date d'emission ne compte JAMAIS : le repli
// "Annee final" (utilise ailleurs pour le rattachement comptable des missions suivies) est
// volontairement exclu ici, ce champ ne dit rien de ce qui a REELLEMENT ete facture.
function pctFactureAvant(mission, exercice) {
  const m = mission || {};
  const ca = Number(m.ca) || 0;
  if (ca <= 0) return 0;
  const anneeDe = (d) => (d ? Number(String(d).slice(0, 4)) : null);
  const acompte = Number(m.montantAcompte) || 0;
  const solde = Math.max(0, ca - acompte);
  const anneeAcompte = anneeDe(m.dateFactureAcompte);
  const anneeSolde = anneeDe(m.dateFactureFinale);
  let total = 0;
  if (acompte > 0 && anneeAcompte != null && anneeAcompte < exercice) total += acompte;
  if (solde > 0 && anneeSolde != null && anneeSolde < exercice) total += solde;
  return (total / ca) * 100;
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
function suggestionPart(lignesMission, exercice, mission) {
  const lignes = lignesMission || [];
  const aAncreAvant = lignes.some(l => l && Number.isFinite(Number(l.exercice)) && Number(l.exercice) < exercice);
  const pointDepart = aAncreAvant ? cumulAuPlusTard(lignes, exercice - 1) : pctFactureAvant(mission, exercice);
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
  suggestionPart,
  planSaisiePart,
};
