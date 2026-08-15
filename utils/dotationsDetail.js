'use strict';

// Detail des dotations aux amortissements, une ligne par immobilisation (spec B.1 et correctif B.2 de
// docs/superpowers/specs/2026-08-13-cr-retraite-design.md ; extraction actee par la revue T2 pour
// rendre l'invariant I8 testable hors serveur).
//
// Module PUR, sans acces reseau ni base, et SANS FORMULE PROPRE : server.js charge les lignes des
// tables `immobilisations` / `immobilisation_postes` puis INJECTE ses deux helpers de calcul
// (`montantAmortissable`, `computeDotationForYear`) en parametre. La source unique des formules
// d'amortissement reste donc server.js : ce module ne fait qu'orchestrer. Meme role et meme patron que
// utils/productionImmobilisee.js (qui, lui, reproduit les formules et doit rester synchronise).
//
// Ce detail alimente DEUX consommateurs a la fois :
//   - le total des dotations du compte de resultat COMPTABLE (sumDotationsForYear en est un wrapper) ;
//   - la neutralisation de la vue hors capitalisation (computeRetraiteForYear).
// Les deux lisent donc exactement les memes lignes : c'est ce qui garantit l'invariant I2 (dotations
// neutralisees + conservees = amortissements affiches).

/**
 * Annee d'imputation des postes d'une immobilisation (correctif B.2).
 *
 * Un poste sans `annee` etait lu de TROIS facons differentes selon l'endroit : `_prorataPoste`
 * (server.js) renvoyait 1, donc le montant PLEIN entrait dans la base amortissable ;
 * utils/productionImmobilisee.js le rattache a l'annee de mise en service avec un vrai prorata ;
 * `sumCreditsForYear` applique deja ce meme repli. Correctif : une SEULE lecture de l'annee, faite en
 * amont, partagee ensuite par la base amortissable, les dotations, l'invariant de survie et l'effet
 * cumule.
 *
 * @param {Object} immo - ligne de `immobilisations` (seule `date_mise_en_service` est lue ici).
 * @param {Array} postes - postes bruts de cette immo.
 * @returns {Array} copies des postes, `annee` toujours renseignee. L'entree n'est jamais mutee.
 *   Repli : annee de mise en service ; si elle est absente ou invalide, annee courante (jamais NaN,
 *   qui est falsy et ferait retomber `_prorataPoste` dans le bug corrige ici).
 */
function normaliserPostesImmo(immo, postes) {
  const d = immo && immo.date_mise_en_service ? new Date(immo.date_mise_en_service) : null;
  const fallbackYear = (d && !isNaN(d.getTime())) ? d.getFullYear() : new Date().getFullYear();
  return (postes || []).map(p => ({ ...p, annee: p.annee != null ? p.annee : fallbackYear }));
}

/**
 * Meme normalisation, appliquee a la map complete rendue par `fetchPostesByImmo()`.
 * Tous les consommateurs (detail des dotations, computeProductionImmobilisee, invariant sur donnees
 * reelles, effet cumule) travaillent sur cette map normalisee, jamais sur les postes bruts.
 *
 * @param {Array} immos - lignes de `immobilisations`.
 * @param {Object} postesByImmo - { immobilisation_id: [postes bruts] }.
 * @returns {Object} { immobilisation_id: [postes normalises] } (une entree par immo, meme vide).
 */
function normaliserPostesByImmo(immos, postesByImmo) {
  const out = {};
  for (const immo of (immos || [])) {
    if (!immo) continue;
    out[immo.id] = normaliserPostesImmo(immo, (postesByImmo && postesByImmo[immo.id]) || []);
  }
  return out;
}

/**
 * Nom d'affichage d'une immobilisation : MEME repli que utils/productionImmobilisee.js (`_nomImmo`),
 * pour que les libelles du detail des dotations et ceux de la production immobilisee se correspondent
 * ligne a ligne dans le pont de reconciliation du compte de resultat.
 */
function nomImmoAffichage(immo) {
  const n = ((immo && (immo.libelle || immo.nom || immo.titre)) || '').toString().trim();
  return n || 'Immobilisation sans libelle';
}

/**
 * Perimetre « immo a postes » de la spec, DEFINITION UNIQUE (precision B.5, revue T2) :
 * `traitement === 'immobilise'` ET au moins un poste, toutes annees confondues.
 *
 * Le critere reel derriere ce test est « cet actif a-t-il produit du compte 72 » (les postes sont
 * exactement ce qui alimente la production immobilisee), donc « sa dotation doit-elle etre neutralisee
 * dans la vue hors capitalisation ». Une immo passee en CHARGES ne produit aucun compte 72 et n'a
 * aucune dotation : elle reste hors perimetre, sans quoi elle ferait sonner l'invariant de survie,
 * afficherait une ligne a 0 € dans la modale et pourrait declencher a tort le badge « credit adosse
 * aux dotations ».
 *
 * @returns {boolean} booleen STRICT (le module pur utils/crRetraite.js teste `=== true`).
 */
function estImmoAPostes(immo, postes) {
  return Boolean(immo && immo.traitement === 'immobilise' && postes && postes.length > 0);
}

// Contrat d'injection : ce module ne calcule aucune dotation lui-meme. Un helper manquant est une
// erreur de cablage, pas une donnee absente : on echoue bruyamment plutot que de renvoyer un total de
// 0 € qui passerait pour un exercice sans immobilisations.
function _helpers(helpers) {
  const h = helpers || {};
  if (typeof h.montantAmortissable !== 'function' || typeof h.computeDotationForYear !== 'function') {
    throw new TypeError('dotationsDetail : helpers { montantAmortissable, computeDotationForYear } requis (injectes par server.js)');
  }
  return h;
}

/**
 * Detail des dotations d'une annee (calcul pur : les donnees sont deja chargees et normalisees).
 *
 * @param {Array} immos - lignes de `immobilisations`.
 * @param {Object} postesNormalisesByImmo - sortie de `normaliserPostesByImmo`.
 * @param {number} year - exercice demande.
 * @param {{montantAmortissable: function, computeDotationForYear: function}} helpers - helpers
 *   serveur injectes (base amortissable effective ; dotation d'une immo pour une annee civile).
 * @returns {{total:number, parImmo:Array<{nom:string, dotation:number, aPostes:boolean, assietteCredit:string}>}}
 *   `total` = somme des dotations (identique au total historique de sumDotationsForYear).
 *   `aPostes` = perimetre ci-dessus, booleen strict. `assietteCredit` = 'depenses' (methode A, defaut)
 *   ou 'amortissement' (methode B, migration 40), lu tel quel pour la garde creditAdosseAuxDotations.
 */
function buildDotationsDetail(immos, postesNormalisesByImmo, year, helpers) {
  const { montantAmortissable, computeDotationForYear } = _helpers(helpers);
  const parImmo = [];
  let total = 0;
  for (const immo of (immos || [])) {
    if (!immo) continue;
    const postes = (postesNormalisesByImmo && postesNormalisesByImmo[immo.id]) || [];
    const dotation = computeDotationForYear({ ...immo, montant: montantAmortissable(immo, postes) }, year);
    total += dotation;
    parImmo.push({
      nom: nomImmoAffichage(immo),
      dotation,
      aPostes: estImmoAPostes(immo, postes),
      assietteCredit: immo.assiette_credit || 'depenses',
    });
  }
  return { total, parImmo };
}

module.exports = {
  normaliserPostesImmo,
  normaliserPostesByImmo,
  nomImmoAffichage,
  estImmoAPostes,
  buildDotationsDetail,
};
