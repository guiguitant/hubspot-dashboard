'use strict';

// Champs additifs exposes par GET /api/avancement (spec docs/superpowers/specs/2026-08-31-ca-avancement-design.md
// §5.1 bis, amendement 2026-09-01 : recherche par nom/client, lecture directe des volets, filtre
// "a cheval" du selecteur front de la modale "Avancement des missions").
//
// Regle "a cheval" corrigee en §5.1 quinquies point a (2026-09-02, correctif) : le seuil de 5 euros
// (MIN_MONTANT de utils/billing.js, qui sert a decider l'affichage d'une ligne de facture) n'a rien a
// faire dans la detection du chevauchement, c'etait un contresens. Consequence mesuree avant correctif :
// "Wienerberger - Phaunis" (acompte 1 EUR au 01/12/2026, solde au 01/02/2027) etait declaree non a
// cheval a cause de son acompte symbolique, et la grille de cloture 2026 se retrouvait VIDE. Seules
// les DATES d'emission comptent desormais (doctrine de Nathan : "la date d'emission des factures fait
// foi") ; ce module ne connait donc plus de seuil de montant.
//
// Module PUR (aucune I/O), extrait de server.js pour rester testable sans appel HTTP (contrainte du
// lot). Ne modifie ni ne require utils/caAvancement.js ni utils/kpiCompute.js (intouches par
// consigne) : la regle de rattachement d'annee est reimplementee ici a l'identique de
// signedAmountForYear (utils/kpiCompute.js), plutot que requise depuis ce module, pour rester dans
// l'esprit "chaque module pur reste autonome" deja suivi par utils/caAvancement.js
// (contributionsDepuisFonction recoit sa fonction de base en parametre, jamais par require croise
// entre modules purs).

// Annee (number) d'une date de facture ('2025-12-15' ou ISO), sinon null. Extraction par slice (pas
// de parsing Date) pour rester insensible au fuseau horaire, meme logique que yearOfDate/quarterOfDate
// de utils/kpiCompute.js.
function yearOfDate(d) {
  return d ? Number(String(d).slice(0, 4)) : null;
}

// Infos de facturation d'une mission pour le selecteur front (spec §5.1 bis, regle aCheval corrigee
// en §5.1 quinquies point a) :
//   - montantSolde = max(0, ca - montantAcompte), comme partout ailleurs dans le lot (signedAmountForYear) ;
//   - anneeAcompte/anneeSolde = annee de la date de facture du volet si elle est emise, sinon annee
//     du champ Notion "Annee final" (repli), sinon null. Meme regle de rattachement que
//     signedAmountForYear. Ce repli sert au RATTACHEMENT COMPTABLE (consommateurs type
//     contributionsDepuisFonction) : distinction volontaire d'avec aCheval ci-dessous, a ne pas
//     fusionner, meme si les deux se ressemblent.
//   - aCheval = vrai quand les DEUX volets portent une date d'emission de facture connue (sans repli
//     sur "Annee final", et sans condition de montant) et que ces deux dates tombent sur des annees
//     differentes. Deux volets sur la meme annee = mission lancee et terminee dans l'annee, sans
//     interet pour l'avancement (demande de Nathan, retour "moteur de recherche nul"). Un acompte
//     symbolique (1 EUR) est desormais vu comme un volet a part entiere : c'est justement le motif
//     des factures a etablir facturees en symbolique (cas reel "Wienerberger - Phaunis" ci-dessus).
//     Ne PAS confondre avec le cas "produit constate d'avance" d'une mission facturee en une fois
//     (ex. Alphapro groupe) : ses deux dates, quand elles existent, tombent sur la meme annee, donc
//     elle n'est jamais aCheval au sens de cette fonction ; l'echappatoire "afficher toutes les
//     missions" existe cote front exactement pour ca.
function missionAvancementInfo(mission) {
  const m = mission || {};
  const ca = Number(m.ca) || 0;
  const montantAcompte = Number(m.montantAcompte) || 0;
  const montantSolde = Math.max(0, ca - montantAcompte);
  const anneeFinal = m.anneeFinal ? Number(m.anneeFinal) : null;
  const anneeAcompte = m.dateFactureAcompte ? yearOfDate(m.dateFactureAcompte) : anneeFinal;
  const anneeSolde = m.dateFactureFinale ? yearOfDate(m.dateFactureFinale) : anneeFinal;
  // aCheval : uniquement les dates d'emission REELLES des deux volets (jamais le repli "Annee final"
  // ci-dessus, jamais un montant) : yearOfDate(null) vaut null, donc un volet non emis exclut
  // naturellement la mission sans condition supplementaire.
  const anneeFactureAcompte = yearOfDate(m.dateFactureAcompte);
  const anneeFactureSolde = yearOfDate(m.dateFactureFinale);
  const aCheval = anneeFactureAcompte != null
    && anneeFactureSolde != null
    && anneeFactureAcompte !== anneeFactureSolde;
  return {
    montantAcompte,
    dateFactureAcompte: m.dateFactureAcompte || null,
    montantSolde,
    dateFactureFinale: m.dateFactureFinale || null,
    anneeAcompte,
    anneeSolde,
    aCheval,
  };
}

module.exports = { missionAvancementInfo };
