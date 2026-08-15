'use strict';

// CR hors capitalisation (ex "CR retraite") : module PUR qui calcule le contrefactuel "comme si les
// developpements etaient restes en charges", a cote du compte de resultat comptable. Prolonge
// utils/productionImmobilisee.js (compte 72) : ce module retire la production immobilisee de l'EBE
// et reprend en face les dotations aux amortissements des immobilisations qu'elle a financees,
// colonne par colonne (factuel et projete separement). Spec de reference :
// docs/superpowers/specs/2026-08-13-cr-retraite-design.md, section A (formules), B.3/B.5 (helpers)
// et D (invariants).
//
// Module PUR, sans acces reseau ni base : recoit des montants deja calcules par server.js (EBE,
// production immobilisee, detail des dotations par immo) et le bareme d'IS en parametre (isFn =
// computeIS de server.js) : la source unique du bareme (env-configurable) reste server.js, ce module
// n'en duplique jamais les seuils.
//
// Rappel de perimetre (spec, section contexte) : ce que ce module calcule ne touche JAMAIS le CA, le
// pipeline pondere, les charges d'exploitation, le credit d'impot lui-meme (seul son adossement est
// signale via creditAdosseAuxDotations) ni la tresorerie. C'est un affichage de pilotage, pas une
// ecriture.

// Convertit une entree quelconque en nombre exploitable ; toute valeur non numerique (undefined,
// null, NaN, chaine invalide) devient 0. Le module ne doit jamais jeter, meme avec des entrees
// partielles ou mal typees (tables absentes, saisies en cours, etc.).
function _n(x) {
  return Number(x) || 0;
}

/**
 * Calcule le CR hors capitalisation a partir des agregats deja calcules par server.js.
 *
 * @param {Object} input
 * @param {{factuel:number, projete:number}} [input.ebe] - EBE classique (deja calcule).
 * @param {{factuel:number, projete:number}} [input.productionImmobilisee] - compte 72 de l'annee.
 * @param {Array<{nom:string, dotation:number, aPostes:boolean, assietteCredit:string}>} [input.dotationsParImmo]
 *   - detail des dotations aux amortissements de l'annee, une ligne par immobilisation. `aPostes`
 *   strictement `true` signifie que l'immo a au moins un poste (elle a produit du compte 72) : sa
 *   dotation est neutralisee. Toute autre valeur (false, absente) la garde en dotation conservee.
 * @param {number} [input.creditTotal] - credit d'impot CII/CIR de l'annee (identique au classique en
 *   phase 1 : voir creditAdosseAuxDotations pour la garde de coherence).
 * @param {function(number): number} [input.isFn] - bareme IS (computeIS de server.js), applique par
 *   colonne au resultat d'exploitation hors capitalisation. Absent -> IS force a 0 (jamais d'appel a
 *   une fonction indefinie).
 * @param {number} [input.amortissements] - total des dotations aux amortissements affiche par le CR
 *   classique (source independante du detail par immo), utilise uniquement pour la garde
 *   ecartDotations ci-dessous. Absent -> garde a 0 (rien a comparer).
 * @returns {{
 *   ebe: {factuel:number, projete:number},
 *   dotationsNeutralisees: {montant:number, parImmo: Array<{nom:string, dotation:number}>},
 *   amortissements: number,
 *   ecartDotations: number,
 *   resultatExploitation: {factuel:number, projete:number},
 *   is: {factuel:number, projete:number},
 *   impotNet: {factuel:number, projete:number},
 *   resultatNet: {factuel:number, projete:number},
 *   creditAdosseAuxDotations: boolean
 * }}
 */
function computeCrRetraite(input) {
  const inp = input || {};
  const ebeClassique = inp.ebe || {};
  const prodImmo = inp.productionImmobilisee || {};
  const dotationsParImmo = Array.isArray(inp.dotationsParImmo) ? inp.dotationsParImmo : [];
  const creditTotal = _n(inp.creditTotal);
  const isFn = typeof inp.isFn === 'function' ? inp.isFn : () => 0;

  // 1. EBE hors capitalisation = EBE classique moins production immobilisee, colonne a colonne.
  const ebe = {
    factuel: _n(ebeClassique.factuel) - _n(prodImmo.factuel),
    projete: _n(ebeClassique.projete) - _n(prodImmo.projete),
  };

  // 2. Dotations neutralisees (immos a postes) vs conservees (immos sans postes). Une seule boucle
  // sur les memes lignes garantit l'invariant I2 (neutralisees + conservees = total des dotations
  // passees) par construction : chaque ligne d'entree tombe dans un seul des deux paniers.
  let dotationsNeutraliseesMontant = 0;
  let amortissements = 0; // dotations conservees (immos sans postes)
  const parImmo = [];
  let creditAdosseAuxDotations = false;
  for (const item of dotationsParImmo) {
    if (!item) continue;
    const dotation = _n(item.dotation);
    if (item.aPostes === true) {
      dotationsNeutraliseesMontant += dotation;
      parImmo.push({ nom: item.nom, dotation });
      if (item.assietteCredit === 'amortissement') creditAdosseAuxDotations = true;
    } else {
      amortissements += dotation;
    }
  }

  // 2b. Garde de coherence produit (decision de revue) : si l'appelant fournit le total des dotations
  // affiche par le CR classique (input.amortissements, source independante du detail par immo), on le
  // compare a la reconstitution neutralisees + conservees issue de la boucle ci-dessus. Ecart non nul
  // = les deux sources divergent (bug de donnees en amont) ; 0 est la valeur attendue en fonctionnement
  // normal. Champ absent (null/undefined) -> rien a comparer, ecart force a 0.
  const amortissementsInput = inp.amortissements;
  const ecartDotations = amortissementsInput === null || amortissementsInput === undefined
    ? 0
    : Number(amortissementsInput) - (dotationsNeutraliseesMontant + amortissements);

  // 3. Resultat d'exploitation hors capitalisation = EBE hors capitalisation moins dotations
  // conservees (les dotations neutralisees ont deja disparu avec la production immobilisee).
  const resultatExploitation = {
    factuel: ebe.factuel - amortissements,
    projete: ebe.projete - amortissements,
  };

  // 4. IS theorique : meme bareme que le classique (passe en parametre), recalcule par colonne sur
  // la nouvelle base.
  const is = {
    factuel: _n(isFn(resultatExploitation.factuel)),
    projete: _n(isFn(resultatExploitation.projete)),
  };

  // 5. Impot net = IS theorique moins credit d'impot (credit inchange en phase 1, cf spec B.4).
  const impotNet = {
    factuel: is.factuel - creditTotal,
    projete: is.projete - creditTotal,
  };

  // 6. Resultat net estimatif = resultat d'exploitation moins impot net (memes conventions que le
  // champ resultatNet existant de /api/ebe).
  const resultatNet = {
    factuel: resultatExploitation.factuel - impotNet.factuel,
    projete: resultatExploitation.projete - impotNet.projete,
  };

  return {
    ebe,
    dotationsNeutralisees: { montant: dotationsNeutraliseesMontant, parImmo },
    amortissements,
    ecartDotations,
    resultatExploitation,
    is,
    impotNet,
    resultatNet,
    creditAdosseAuxDotations,
  };
}

/**
 * Effet cumule de la capitalisation depuis l'origine (spec B.5) : somme, annee par annee jusqu'a
 * l'annee cible, de (production immobilisee - dotations neutralisees), et premiere annee (toutes
 * annees confondues, y compris futures) ou cet ecart annuel devient negatif -- l'annee ou l'effort
 * de developpement "rembourse" au resultat d'exploitation ce qu'il lui avait retire.
 *
 * @param {Array<{annee:number, productionImmobilisee:number, dotationsNeutralisees:number}>} serie
 *   - une entree par annee, non necessairement triee.
 * @param {number} anneeCible - derniere annee incluse dans le cumul.
 * @returns {{montant:number, anneeBascule:(number|null)}}
 */
function computeEffetCumule(serie, anneeCible) {
  const arr = Array.isArray(serie) ? serie.filter(Boolean) : [];
  // Copie triee par annee croissante (sans muter l'entree) : l'annee de bascule doit etre la
  // PREMIERE chronologiquement, quel que soit l'ordre de la serie fournie.
  const triee = arr.slice().sort((a, b) => _n(a.annee) - _n(b.annee));
  const cible = _n(anneeCible);

  let montant = 0;
  let anneeBascule = null;
  for (const entree of triee) {
    const annee = _n(entree.annee);
    const ecart = _n(entree.productionImmobilisee) - _n(entree.dotationsNeutralisees);
    if (annee <= cible) montant += ecart;
    if (anneeBascule === null && ecart < 0) anneeBascule = annee;
  }
  return { montant, anneeBascule };
}

/**
 * Garde-fou de survie (spec B.3) : pour chaque immobilisation a postes, la somme de sa production
 * immobilisee sur toutes ses annees doit egaler sa base amortissable, a l'euro d'arrondi pres. Ce
 * module ne fait QUE la comparaison ; le chargement des sommes reelles reste a la charge du serveur.
 *
 * @param {Array<{nom:string, sommeProductionImmobilisee:number, montantAmortissable:number}>} items
 * @returns {Array<{nom:string, ecart:number}>} les immos dont l'ecart depasse 2 euros (tolerance
 *   d'arrondi) ; tableau vide si tout est coherent.
 */
function verifierInvariantImmos(items) {
  const arr = Array.isArray(items) ? items : [];
  const anomalies = [];
  for (const item of arr) {
    if (!item) continue;
    const ecart = _n(item.sommeProductionImmobilisee) - _n(item.montantAmortissable);
    if (Math.abs(ecart) > 2) anomalies.push({ nom: item.nom, ecart });
  }
  return anomalies;
}

module.exports = { computeCrRetraite, computeEffetCumule, verifierInvariantImmos };
