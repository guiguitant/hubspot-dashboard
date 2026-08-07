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
//
// Contrat de `indexExact` (Tache 6, priorite 0, produit par fetchIndexExactTVA dans server.js) :
//   Map<cle, { ht, ttc, tax, invoiceId }>  (ou objet brut equivalent : voir buildIndexExactKey)
//   cle = buildIndexExactKey(tx) = `${date}|${montant}`
//     - date  : jour (YYYY-MM-DD) de la ligne comptable de REGLEMENT (401, cote banque), tronque
//       depuis tx.settled_at (Qonto) cote consommateur, depuis ledger_entry_line.date cote
//       producteur. C'est la date du mouvement bancaire reel, pas forcement celle d'emission de
//       la facture (une facture de decembre peut etre payee en janvier).
//     - montant : valeur absolue en euros du reglement, formatee a 2 decimales (Qonto tx.amount
//       est toujours positif pour un debit, cf filtre `side === 'debit'` en amont dans server.js).
//   Cle etablie via le LETTRAGE comptable Pennylane (ledger_entry_lines, compte 401 fournisseurs),
//   PAS via un identifiant de transaction bancaire partage : Pennylane ne fournit aucun champ
//   reliant directement sa propre transaction interne a l'id Qonto d'origine (verifie par sonde
//   directe de /transactions, aucun champ qonto_id/external_bank_id). (date, montant) est donc la
//   cle la plus fiable disponible sans appel par facture. Limites assumees (documentees aussi dans
//   fetchIndexExactTVA, server.js) : factures en devise etrangere exclues (pas de champ HT en euros
//   fiable sur /supplier_invoices hors EUR), paiements fractionnes exclus (montant de la ligne de
//   reglement ne correspond plus au TTC total de la facture), collision (date, montant) entre deux
//   factures differentes = repli sur la table pour les deux (jamais de choix arbitraire).

const { normalizeLabel } = require('./chargesPerimetre');

// Construit la cle de recherche dans indexExact pour une transaction Qonto. Exportee pour que
// server.js puisse determiner, SANS dupliquer cette logique, si une transaction sera couverte par
// la priorite 0 (indicateur tvaExacte expose par computeChargesHybride, cf brief Tache 6 Step 3).
function buildIndexExactKey(tx) {
  if (!tx || !tx.settled_at) return null;
  const dateStr = String(tx.settled_at).slice(0, 10);
  if (dateStr.length < 10) return null;
  const montant = Math.abs(Number(tx.amount) || 0);
  return `${dateStr}|${montant.toFixed(2)}`;
}

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

// Convertit une transaction Qonto (montant TTC) en montant HT. Priorite de resolution :
//   0) TVA EXACTE de la facture fournisseur Pennylane rattachee (indexExact, Tache 6) : la
//      transaction est retrouvee via le lettrage comptable (cle date+montant, cf buildIndexExactKey
//      et le contrat de indexExact en tete de fichier). HT = currency_amount_before_tax de la
//      facture (deja calcule cote producteur, cf fetchIndexExactTVA). Source la plus fiable :
//      concordance mesuree a 0,3% avec le grand livre (comptes 4456*, cf task-7-report). Ne depend
//      PAS de tableTaux : peut s'appliquer meme si la table du classeur est vide/absente.
//   1) a defaut, taux trouve pour le couple categorie/sous-categorie (cle normalisee, tableTaux.parCouple)
//   2) a defaut, taux trouve pour la categorie seule (tableTaux.parCategorie)
//   3) aucun taux connu : montant TTC inchange (prudence : on ne devine jamais un taux)
// Si l'entree retenue (priorite 1/2) marque la TVA comme NON recuperable, le montant TTC est le
// vrai cout definitif pour l'entreprise : renvoye inchange (pas de conversion).
// tx : objet transaction Qonto, meme forme que celle deja lue ailleurs dans server.js
//      (agregParMois / /api/charges) : { amount, cashflow_category: { name }, category,
//      cashflow_subcategory: { name }, settled_at }. category/cashflow_category.name : l'un ou
//      l'autre. settled_at n'est requis que pour la priorite 0 (indexExact) ; absent, celle-ci est
//      simplement ignoree et la hierarchie retombe sur la table, comme avant la Tache 6.
// indexExact : 3e parametre OPTIONNEL (retro-compatible : absent ou undefined, comportement
//      identique a avant la Tache 6). Map (ou objet brut) au contrat documente en tete de fichier.
function montantHT(tx, tableTaux, indexExact) {
  const montant = Number(tx && tx.amount) || 0;
  if (!tx) return montant;

  if (indexExact) {
    const cle = buildIndexExactKey(tx);
    if (cle) {
      const exact = (typeof indexExact.get === 'function') ? indexExact.get(cle) : indexExact[cle];
      if (exact) return Math.round(exact.ht * 100) / 100; // priorite 0 : TVA exacte, ignore la table
    }
  }

  if (!tableTaux) return montant;

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
  buildIndexExactKey,
  COUPLE_SEP,
};
