'use strict';

// Helper pur de classification des credits Qonto de la categorie "Subventions et aides", pour
// distinguer les VRAIS produits d'exploitation (subvention pure, aide a l'embauche) d'un financement
// qui n'en est jamais un (avance remboursable = emprunt a taux 0, sa place est en tresorerie/passif,
// jamais dans l'EBE). Feature A, docs/superpowers/specs/2026-08-08-produits-et-suivis-design.md#A.
//
// L'utilisateur a cree 3 sous-categories Qonto dediees sous "Subventions et aides" mais ne les a
// pas encore utilisees au moment d'ecrire ce module : leurs libelles EXACTS sont donc inconnus.
// On reconnait par MOTIFS normalises (accents/casse indifferents, comme les primes -- cf
// chargesPerimetre.isPrimeSubcategory), pas par une liste figee de libelles exacts, pour rester
// robuste une fois les sous-categories effectivement utilisees.
//
// Module pur, sans effet de bord. Consomme par server.js (produits hybrides /api/ebe).

const { normalizeLabel } = require('./chargesPerimetre');

// Categorie parente Qonto des subventions/aides (normalisee). Un credit sous une AUTRE categorie
// (ex. "Impots et taxes" pour un remboursement d'IS, ou un encaissement client) est hors sujet ici :
// il ne doit jamais remonter comme produit, il est simplement ignore par ce helper (null).
const CATEGORIE_SUBVENTIONS = normalizeLabel('Subventions et aides');

// Motifs qui designent un financement EXCLU des produits : avance remboursable = emprunt a taux 0
// (jamais un produit d'exploitation, sa place est en tresorerie/passif). "avance" seul est inclus
// pour couvrir un libelle raccourci ("Avance BFT" par ex.), "pret"/"prêt" pour un pret classique.
const MOTIFS_EXCLU = ['avance remboursable', 'avance', 'pret'].map(normalizeLabel);

// Motifs qui designent un produit d'exploitation : subvention pure ou aide (a l'embauche, etc.).
const MOTIFS_PRODUIT = ['subvention', 'aide'].map(normalizeLabel);

/**
 * Classe un credit Qonto de categorie "Subventions et aides" a partir des libelles bruts
 * (categorie + sous-categorie) de la transaction.
 *
 * @param {string} cat - libelle brut de la categorie Qonto (cashflow_category.name)
 * @param {string} sousCat - libelle brut de la sous-categorie Qonto (cashflow_subcategory.name)
 * @returns {'produit'|'exclu'|'inconnu'|null}
 *   - null      : categorie parente differente de "Subventions et aides" -> hors sujet, ignorer.
 *   - 'exclu'   : avance remboursable / avance / pret -> financement, JAMAIS un produit (EBE).
 *   - 'produit' : subvention / aide -> produit d'exploitation (EBE).
 *   - 'inconnu' : sous-categorie absente ou non reconnue -> A SIGNALER (jamais exclu en silence,
 *     lecon du chantier charges : un montant non classe doit rester visible pour verification).
 */
function classifyProduitSubvention(cat, sousCat) {
  if (normalizeLabel(cat) !== CATEGORIE_SUBVENTIONS) return null;
  const n = normalizeLabel(sousCat);
  if (!n) return 'inconnu';
  if (MOTIFS_EXCLU.some(motif => n.includes(motif))) return 'exclu';
  if (MOTIFS_PRODUIT.some(motif => n.includes(motif))) return 'produit';
  return 'inconnu';
}

module.exports = {
  classifyProduitSubvention,
  CATEGORIE_SUBVENTIONS,
  MOTIFS_EXCLU,
  MOTIFS_PRODUIT,
};
