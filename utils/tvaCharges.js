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
//   cle la plus fiable disponible sans appel par facture. Limites assumees (documentees aussi devant
//   buildIndexExactTVA ci-dessous) : factures en devise etrangere exclues (pas de champ HT en euros
//   fiable sur /supplier_invoices hors EUR), paiements fractionnes exclus (montant de la ligne de
//   reglement ne correspond plus au TTC total de la facture), collision (date, montant) entre deux
//   factures differentes A HT DIFFERENT = repli sur la table pour les deux (jamais de choix
//   arbitraire) ; si tous les candidats d'une collision donnent le MEME HT, elle est indexee quand
//   meme (le resultat de la conversion ne depend pas du candidat retenu, cf buildIndexExactTVA).

const { normalizeLabel } = require('./chargesPerimetre');

// Construit la cle de recherche dans indexExact pour une transaction Qonto. Exportee pour que
// server.js puisse determiner, SANS dupliquer cette logique, si une transaction sera couverte par
// la priorite 0 (indicateur tvaExacte expose par computeChargesHybride, cf brief Tache 6 Step 3).
//
// M4 (revue) : `tx.settled_at` (Qonto) est un horodatage UTC ; la `date` de la ligne comptable de
// reglement (Pennylane, cote producteur) est une date "civile" sans fuseau explicite. Une
// transaction survenant tard le soir en heure locale (ex. apres 22h UTC = apres minuit heure de
// Paris en ete) pourrait donc en theorie tomber sur des jours calendaires differents selon la
// source, et manquer la cle malgre une correspondance reelle. Non traite : aucune transaction du
// jeu de donnees mesure (jan-juil 2026 + marge) n'est concernee (0 transaction a settled_at >= 22h
// UTC), et une transaction manquee par ce decalage retombe simplement sur la table (prudence, pas
// de risque de conversion erronee, juste une couverture priorite 0 legerement sous-estimee).
function buildIndexExactKey(tx) {
  if (!tx || !tx.settled_at) return null;
  const dateStr = String(tx.settled_at).slice(0, 10);
  if (dateStr.length < 10) return null;
  const montant = Math.abs(Number(tx.amount) || 0);
  return `${dateStr}|${montant.toFixed(2)}`;
}

// --- Construction de l'index exact TVA (Tache 6, priorite 0) ---
//
// But : retrouver, pour une transaction Qonto (TTC), la TVA EXACTE de la facture fournisseur
// Pennylane qu'elle regle, SANS appel par facture (contrainte du brief : jamais de N+1, jamais
// `matched_transactions` par facture, ce qui ferait 349 factures = 349 appels, interdit).
//
// Jointure retenue : le LETTRAGE comptable. Une facture cree une ecriture sur un compte 401
// (fournisseurs) ; son reglement (le mouvement bancaire) cree une autre ecriture sur le MEME
// compte 401 ; Pennylane relie les deux lignes via `lettered_ledger_entry_lines.ids`, deja inclus
// dans la reponse bulk de /ledger_entry_lines (pas d'appel supplementaire necessaire). Verifie par
// sonde directe (lecture seule, GET, `.env` local) : pour une facture "Facture Restaurants" de
// 142,50 € TTC (id 27154348175360), la ligne 401 de son ecriture propre (credit 142,50 €) et la
// ligne 401 de son reglement (debit 142,50 €, ecriture differente) partagent bien la meme paire
// dans `lettered_ledger_entry_lines.ids`.
//
// Reste alors a relier cette ligne de reglement a la transaction QONTO d'origine (celle que
// `computeChargesHybride`/`/api/charges` agregent). Sonde de /transactions (Pennylane) : aucun champ
// ne porte l'id Qonto d'origine (pas de qonto_id/external_bank_id). La cle la plus fiable sans appel
// supplementaire est donc (date, montant) du mouvement bancaire : la ligne de reglement porte sa
// propre date et son propre montant (401), qui correspondent au settled_at/amount de la transaction
// Qonto d'origine. Cle : voir buildIndexExactKey ci-dessus, partagee entre production (ici) et
// consommation (montantHT).
//
// Prudence (repli sur la table plutot que deviner), cas exclus de l'index :
//  - facture en devise etrangere (`currency !== 'EUR'`) : `currency_amount*` sont dans la devise
//    d'origine (ex. USD), pas en euros ; les melanger au TTC Qonto (toujours EUR) fausserait le
//    montant. Verifie sur une facture OpenAI 20 USD / 17,36 € reglés : aucun champ HT en euros
//    fiable n'existe sur /supplier_invoices pour reconvertir simplement (seul `amount`/`tax` existe
//    en euros, mais TTC seulement, pas de `amount_before_tax` EUR dedie) : plutot que d'improviser
//    un calcul par taux de change, ces factures restent hors index (repli table).
//  - paiement fractionne (plus d'une "autre" ligne dans le lettrage, ou montant de la ligne de
//    reglement != TTC facture a 1 centime pres) : le montant de chaque virement partiel ne
//    correspond plus au TTC total de la facture, prudence.
//  - facture non reglee (pas de ligne 401 de reglement retrouvee, ex. accounting_status 'entry',
//    reconciled false) : normal, la transaction bancaire correspondante n'existe pas encore.
//  - collision (date, montant) entre DEUX factures differentes A HT DIFFERENT : vraie ambiguite,
//    aucune des deux n'est indexee (jamais de choix arbitraire). CORRECTIF revue C1 : quand TOUS
//    les candidats d'une collision donnent le MEME HT (a 1 centime pres, ex. deux factures de
//    6 000 € TTC / 5 000 € HT reglees le meme jour), le resultat de la conversion est IDENTIQUE quel
//    que soit le candidat retenu : ce n'est pas une ambiguite reelle, on indexe avec ce HT commun.
//    Mesure sur les donnees reelles (jan-juil 2026 + marge) : 11 collisions sur 12 se resolvent
//    ainsi ; la seule vraie ambiguite restante (2025-12-30, 200 € TTC, HT 200 vs 166,67) reste
//    exclue.
//
// Fonction pure (aucune dependance reseau) : `invoices`/`lines` sont les tableaux `items` deja
// fetches en bulk par server.js (`/supplier_invoices` + `/ledger_entry_lines`), passes tels quels.
function buildIndexExactTVA(invoices, lines) {
  const lineById = new Map();
  for (const l of lines) lineById.set(l.id, l);

  // Lignes du compte 401 (fournisseurs), regroupees par ecriture (ledger_entry.id) : une ecriture
  // porte soit la facture (credit), soit son reglement (debit).
  const lines401ByEntryId = new Map();
  for (const l of lines) {
    const num = (l.ledger_account && l.ledger_account.number) || '';
    if (!num.startsWith('401')) continue;
    const eid = l.ledger_entry && l.ledger_entry.id;
    if (eid == null) continue;
    if (!lines401ByEntryId.has(eid)) lines401ByEntryId.set(eid, []);
    lines401ByEntryId.get(eid).push(l);
  }

  const candidates = [];
  for (const inv of invoices) {
    if (inv.currency !== 'EUR') continue; // devise etrangere : voir commentaire ci-dessus
    const entryId = inv.ledger_entry && inv.ledger_entry.id;
    const inv401Lines = lines401ByEntryId.get(entryId) || [];
    if (inv401Lines.length === 0) continue; // pas encore comptabilisee dans la fenetre fetchee

    let paymentLine = null;
    let ambiguousPayment = false;
    for (const invLine of inv401Lines) {
      const letteredIds = (invLine.lettered_ledger_entry_lines && invLine.lettered_ledger_entry_lines.ids) || [];
      const otherIds = letteredIds.filter(id => id !== invLine.id);
      if (otherIds.length === 0) continue; // pas encore lettree (facture pas reglee)
      if (otherIds.length > 1) { ambiguousPayment = true; continue; } // reglement fractionne : prudence
      const candidate = lineById.get(otherIds[0]);
      if (candidate) paymentLine = candidate; // absente si hors fenetre fetchee (limite documentee)
    }
    if (ambiguousPayment || !paymentLine) continue;

    const ttc = Math.abs(parseFloat(inv.currency_amount) || 0);
    const paymentAmount = Math.abs(parseFloat(paymentLine.debit) || parseFloat(paymentLine.credit) || 0);
    if (Math.abs(paymentAmount - ttc) > 0.01) continue; // reglement partiel : prudence

    const ht = parseFloat(inv.currency_amount_before_tax) || 0;
    const tax = parseFloat(inv.currency_tax) || 0;
    const key = `${paymentLine.date}|${paymentAmount.toFixed(2)}`; // meme format que buildIndexExactKey
    candidates.push({ key, invoiceId: inv.id, ht, ttc, tax });
  }

  // Collision (date, montant) partagee par plusieurs factures : cf commentaire C1 en tete de
  // fonction. Si tous les candidats d'une cle donnent le meme HT (a 1 centime pres), la conversion
  // est identique quel que soit le candidat retenu : on indexe avec ce HT commun. Sinon, vraie
  // ambiguite : on exclut la cle plutot que de deviner laquelle est la bonne.
  const byKey = new Map();
  for (const c of candidates) {
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key).push(c);
  }
  const index = new Map();
  let ambiguousKeys = 0;
  let resolvedByEqualHt = 0;
  for (const [key, arr] of byKey.entries()) {
    if (arr.length === 1) { index.set(key, arr[0]); continue; }
    const firstHtCents = Math.round(arr[0].ht * 100);
    const allSameHt = arr.every(c => Math.round(c.ht * 100) === firstHtCents);
    if (allSameHt) {
      index.set(key, arr[0]); // n'importe lequel des candidats : meme HT pour tous
      resolvedByEqualHt++;
    } else {
      ambiguousKeys++; // vraie ambiguite (HT differents) : exclue, prudence
    }
  }
  return {
    index,
    stats: {
      totalInvoices: invoices.length,
      totalLines: lines.length,
      matched: index.size,
      ambiguousKeys,
      resolvedByEqualHt,
    },
  };
}

// Recherche l'entree de la table de taux (parCouple puis parCategorie) correspondant a la
// categorie/sous-categorie d'une transaction. Factorisee pour etre appelee a la fois par la
// hierarchie normale (priorite 1/2, taux) ET par le garde-fou "recuperable" de la priorite 0
// (cf montantHT, correctif revue I3) : une seule facon de retrouver l'entree, aucun risque de
// divergence entre les deux usages.
function findTauxEntry(tx, tableTaux) {
  if (!tx || !tableTaux) return null;
  const categorie = (tx.cashflow_category && tx.cashflow_category.name) || tx.category || null;
  if (!categorie) return null;
  const sousCategorie = (tx.cashflow_subcategory && tx.cashflow_subcategory.name) || null;
  const parCouple = tableTaux.parCouple || {};
  const parCategorie = tableTaux.parCategorie || {};
  let entry = null;
  if (sousCategorie) {
    entry = parCouple[buildCoupleKey(categorie, sousCategorie)] || null;
  }
  if (!entry) {
    entry = parCategorie[normalizeLabel(categorie)] || null;
  }
  return entry;
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
//      facture (deja calcule cote producteur, cf buildIndexExactTVA). Source la plus fiable :
//      concordance mesuree a 0,3% avec le grand livre (comptes 4456*, cf task-7-report). Ne depend
//      PAS de tableTaux pour trouver le montant HT : peut s'appliquer meme si la table du classeur
//      est vide/absente. EXCEPTION (correctif revue I3) : le flag "recuperable" de la table, quand
//      il est connu pour la categorie/couple de la transaction, prime meme sur la priorite 0 (voir
//      plus bas) : la spec 2.2 dit "la TVA non recuperable reste en charge", sans exception pour la
//      priorite 0.
//   1) a defaut, taux trouve pour le couple categorie/sous-categorie (cle normalisee, tableTaux.parCouple)
//   2) a defaut, taux trouve pour la categorie seule (tableTaux.parCategorie)
//   3) aucun taux connu : montant TTC inchange (prudence : on ne devine jamais un taux)
// Si l'entree retenue (priorite 0/1/2) marque la TVA comme NON recuperable, le montant TTC est le
// vrai cout definitif pour l'entreprise : renvoye inchange (pas de conversion), quelle que soit la
// source qui aurait autrement fourni le HT.
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

  // Garde-fou "recuperable" (correctif revue I3) : consulte AVANT la priorite 0, pour que le flag
  // de la table (quand il est connu) prime aussi sur l'index exact, pas seulement sur la table
  // elle-meme. findTauxEntry renvoie null si la categorie est inconnue de la table (dans ce cas, on
  // ne bloque rien : seul un flag EXPLICITE "non recuperable" doit court-circuiter la conversion).
  const tauxEntry = findTauxEntry(tx, tableTaux);
  if (tauxEntry && tauxEntry.recuperable === false) return montant; // TVA non recuperable : TTC = cout reel

  if (indexExact) {
    const cle = buildIndexExactKey(tx);
    if (cle) {
      const exact = (typeof indexExact.get === 'function') ? indexExact.get(cle) : indexExact[cle];
      if (exact) return Math.round(exact.ht * 100) / 100; // priorite 0 : TVA exacte (recuperable deja verifie ci-dessus)
    }
  }

  if (!tableTaux) return montant;
  if (!tauxEntry) return montant; // categorie/couple inconnu de la table : prudence, TTC inchange

  const taux = Number(tauxEntry.taux) || 0;
  const ht = montant / (1 + taux);
  return Math.round(ht * 100) / 100; // arrondi centime, coherent avec getOverrideTvaInfo
}

module.exports = {
  montantHT,
  buildCoupleKey,
  buildIndexExactKey,
  buildIndexExactTVA,
  COUPLE_SEP,
};
