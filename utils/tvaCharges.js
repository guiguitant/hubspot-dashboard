'use strict';

// Module pur de conversion TTC -> HT pour une transaction Qonto (le reel bancaire est TTC,
// le budget GSheet est HT ; brancher cette conversion dans computeChargesHybride / /api/charges
// est le perimetre de la Tache 6, PAS de ce module).
//
// Contrat de `tableTaux` (produit par fetchAndParseCategoriesTVA dans server.js, consomme ici) :
//   {
//     parCategorie: { [normalizeLabel(categorie)]: { taux, recuperable } },
//     parCouple:    { [buildCoupleKey(categorie, sousCategorie)]: { taux, recuperable } },
//   }
// - `taux` est une fraction decimale (0.20 pour 20%, PAS 20) : meme convention que
//   OVERRIDE_TVA_DEFAULTS / getOverrideTvaInfo dans server.js (deja en place, on ne la duplique
//   pas differemment).
// - `recuperable` est un booleen : false = TVA non recuperable, le TTC est le vrai cout (inchange).
// - Les cles sont normalisees via normalizeLabel (accents/casse) : voir chargesPerimetre.js,
//   reutilise ici (pas de duplication de la normalisation).
// - `parCouple` n'existe que pour les lignes du classeur ecrites sous la forme
//   "Categorie > Sous-categorie" (voir server.js, fetchAndParseCategoriesTVA) : convention choisie
//   pour eviter d'ajouter une colonne "sous-categorie" au classeur (et le caractere '>' est le seul
//   separateur sans ambiguite : certains noms de categories contiennent deja '/', ex.
//   "Publicite / marketing", "Marketing/Communication").

const { normalizeLabel } = require('./chargesPerimetre');

// Separateur de cle pour les couples categorie/sous-categorie dans tableTaux.parCouple.
// Caractere de controle Unicode (SYMBOL FOR UNIT SEPARATOR) : ne peut pas apparaitre dans un
// libelle de categorie Qonto ou GSheet, donc aucun risque de collision avec le contenu normalise.
const COUPLE_SEP = '␟';

// Construit la cle normalisee d'un couple categorie/sous-categorie. Exportee pour que le parser
// GSheet (server.js) construise ses cles exactement de la meme facon que montantHT les lit
// (evite toute divergence silencieuse entre production et consommation de la cle).
function buildCoupleKey(categorie, sousCategorie) {
  return normalizeLabel(categorie) + COUPLE_SEP + normalizeLabel(sousCategorie);
}

// Convertit une transaction Qonto (montant TTC) en montant HT, selon la table de taux du classeur.
// Priorite de resolution du taux :
//   1) taux trouve pour le couple categorie/sous-categorie (cle normalisee, tableTaux.parCouple)
//   2) a defaut, taux trouve pour la categorie seule (tableTaux.parCategorie)
//   3) aucun taux connu : montant TTC inchange (prudence : on ne devine jamais un taux)
// Si l'entree retenue marque la TVA comme NON recuperable, le montant TTC est le vrai cout
// definitif pour l'entreprise : renvoye inchange (pas de conversion).
// tx : objet transaction Qonto, meme forme que celle deja lue ailleurs dans server.js
//      (agregParMois / /api/charges) : { amount, cashflow_category: { name }, category,
//      cashflow_subcategory: { name } }. category/cashflow_category.name : l'un ou l'autre.
function montantHT(tx, tableTaux) {
  const montant = Number(tx && tx.amount) || 0;
  if (!tx || !tableTaux) return montant;

  const categorie = (tx.cashflow_category && tx.cashflow_category.name) || tx.category || null;
  const sousCategorie = (tx.cashflow_subcategory && tx.cashflow_subcategory.name) || null;
  if (!categorie) return montant;

  const parCouple = tableTaux.parCouple || {};
  const parCategorie = tableTaux.parCategorie || {};

  let entry = null;
  if (sousCategorie) {
    entry = parCouple[buildCoupleKey(categorie, sousCategorie)] || null;
  }
  if (!entry) {
    entry = parCategorie[normalizeLabel(categorie)] || null;
  }

  if (!entry) return montant; // categorie/couple inconnu de la table : prudence, TTC inchange
  if (entry.recuperable === false) return montant; // TVA non recuperable : TTC = cout reel

  const taux = Number(entry.taux) || 0;
  const ht = montant / (1 + taux);
  return Math.round(ht * 100) / 100; // arrondi centime, coherent avec getOverrideTvaInfo
}

module.exports = {
  montantHT,
  buildCoupleKey,
  COUPLE_SEP,
};
