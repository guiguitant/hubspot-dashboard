'use strict';

// Champs additifs exposes par GET /api/avancement (spec docs/superpowers/specs/2026-08-31-ca-avancement-design.md
// §5.1 bis, amendement 2026-09-01 : recherche par nom/client, lecture directe des volets, filtre
// "a cheval" du selecteur front de la modale "Avancement des missions").
//
// Module PUR (aucune I/O), extrait de server.js pour rester testable sans appel HTTP (contrainte du
// lot). Ne modifie ni ne require utils/caAvancement.js ni utils/kpiCompute.js (intouches par
// consigne) : la regle de rattachement d'annee est reimplementee ici a l'identique de
// signedAmountForYear (utils/kpiCompute.js), plutot que requise depuis ce module, pour rester dans
// l'esprit "chaque module pur reste autonome" deja suivi par utils/caAvancement.js
// (contributionsDepuisFonction recoit sa fonction de base en parametre, jamais par require croise
// entre modules purs).

const MIN_MONTANT = 5; // seuil coherent avec utils/billing.js (volet neglige en dessous, logique TRE)

// Annee (number) d'une date de facture ('2025-12-15' ou ISO), sinon null. Extraction par slice (pas
// de parsing Date) pour rester insensible au fuseau horaire, meme logique que yearOfDate/quarterOfDate
// de utils/kpiCompute.js.
function yearOfDate(d) {
  return d ? Number(String(d).slice(0, 4)) : null;
}

// Infos de facturation d'une mission pour le selecteur front (spec §5.1 bis) :
//   - montantSolde = max(0, ca - montantAcompte), comme partout ailleurs dans le lot (signedAmountForYear) ;
//   - anneeAcompte/anneeSolde = annee de la date de facture du volet si elle est emise, sinon annee
//     du champ Notion "Annee final" (repli), sinon null. Meme regle de rattachement que signedAmountForYear.
//   - aCheval = vrai quand les deux volets existent (montant >= MIN_MONTANT), que les deux annees de
//     rattachement sont connues, et qu'elles different. Deux volets sur la meme annee = mission lancee
//     et terminee dans l'annee, sans interet pour l'avancement (demande de Nathan, retour "moteur de
//     recherche nul"). Ne PAS confondre avec le cas "produit constate d'avance" d'une mission
//     facturee en une fois (ex. Alphapro groupe) : elle n'est jamais aCheval au sens de cette
//     fonction, l'echappatoire "afficher toutes les missions" existe cote front exactement pour ca.
function missionAvancementInfo(mission) {
  const m = mission || {};
  const ca = Number(m.ca) || 0;
  const montantAcompte = Number(m.montantAcompte) || 0;
  const montantSolde = Math.max(0, ca - montantAcompte);
  const anneeFinal = m.anneeFinal ? Number(m.anneeFinal) : null;
  const anneeAcompte = m.dateFactureAcompte ? yearOfDate(m.dateFactureAcompte) : anneeFinal;
  const anneeSolde = m.dateFactureFinale ? yearOfDate(m.dateFactureFinale) : anneeFinal;
  const aCheval = montantAcompte >= MIN_MONTANT
    && montantSolde >= MIN_MONTANT
    && anneeAcompte != null
    && anneeSolde != null
    && anneeAcompte !== anneeSolde;
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

module.exports = { missionAvancementInfo, MIN_MONTANT };
