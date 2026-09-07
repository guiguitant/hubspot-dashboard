'use strict';

// Rapprochement pur entre les lignes de dette de primes du Google Sheet (onglet Dettes) et les
// debits Qonto de la sous-categorie HOMONYME. Garde-fou en lecture seule : ce module ne corrige
// jamais un montant, il signale un ecart.
// Spec : docs/superpowers/specs/2026-08-31-primes-reconciliation-dette-design.md
//
// Pourquoi ce module existe : le restant du de la ligne « Primes associes AAAA » est saisi a la
// main dans la colonne G du Sheet et n'etait verifie par rien. Seule l'avance BPI est reconciliee
// au reel (estAvance, server.js) ; le statut `verse` de computePrimePayments n'est jamais alimente
// (versements: [] en dur) ; et l'Option B exclut volontairement les virements de primes du reel
// Qonto. Un versement parti sans mise a jour du Sheet faisait donc sous-estimer la tresorerie
// nette de DEUX FOIS le versement, sans aucun signal.
//
// Module pur, sans effet de bord (hormis la lecture de process.env au chargement, meme convention
// que utils/chargesPerimetre.js) : server.js fetche les dettes (parseDettes) et les transactions
// Qonto, ce module ne fait que comparer. Meme decoupage que utils/dealsNotionCoherence.js.

const { normalizeLabel, PRIMES_SUBCATS } = require('./chargesPerimetre');

// Lit une variable d'environnement numerique. Ecrit a la main plutot qu'avec `Number(x) || defaut`
// parce que ce dernier ferait retomber la valeur '0' sur le defaut, ce qui interdirait une
// tolerance de zero euro.
function envNumber(raw, defaut) {
  if (raw === undefined || raw === null || raw === '') return defaut;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaut;
}

// Taux de TVA des factures de primes d'associes : la dette du Sheet est en HT, le virement Qonto
// est en TTC. Fixe et nomme volontairement, plutot que la cascade TVA a trois etages des charges :
// cette derniere retombe silencieusement sur le TTC quand Pennylane n'a pas la facture, ce qui
// fabriquerait un faux ecart de 20 % (spec section 3), soit exactement le signal que ce garde-fou
// cherche a rendre fiable.
const PRIMES_TVA_TAUX = envNumber(process.env.PRIMES_TVA_TAUX, 0.20);

// Tolerance d'ecart en euros : calibree pour n'absorber que l'arrondi de la division par 1,20.
const PRIMES_ECART_TOLERANCE = envNumber(process.env.PRIMES_ECART_TOLERANCE, 1);

// Une ligne du carnet de dettes est une ligne de primes si son libelle contient "prime".
// Meme convention que `estAvance = (label) => /avance/i.test(label)` cote server.js.
function estLignePrimes(label) {
  return /prime/i.test(String(label || ''));
}

// Somme des DEBITS Qonto par sous-categorie normalisee -> Map(cle -> { montant, nb }).
// Les credits sont ignores : un virement entrant d'un associe ne doit jamais eteindre une dette.
function agregerDebitsParSousCategorie(transactions) {
  const parSousCat = new Map();
  for (const tx of transactions || []) {
    if (!tx || tx.side !== 'debit') continue;
    const nom = (tx.cashflow_subcategory && tx.cashflow_subcategory.name) || '';
    const cle = normalizeLabel(nom);
    if (!cle) continue;
    const cur = parSousCat.get(cle) || { montant: 0, nb: 0 };
    cur.montant += Number(tx.amount) || 0;
    cur.nb += 1;
    parSousCat.set(cle, cur);
  }
  return parSousCat;
}

// Rapprochement principal. Entrees :
//   dettes        : [{ label, montantInitial, restant, controle }] issues de parseDettes (server.js)
//   transactions  : transactions Qonto brutes, tous comptes, deja bornees a la fenetre de lecture
//   primesSubcats : liste normalisee des sous-categories de primes (defaut PRIMES_SUBCATS)
//   tauxTva       : taux de TVA des factures de primes (defaut PRIMES_TVA_TAUX)
//   tolerance     : seuil d'ecart en euros (defaut PRIMES_ECART_TOLERANCE)
//
// Politique d'arrondi (spec section 4.1) : tous les montants sont arrondis a l'euro AVANT le
// calcul du statut, pour qu'un badge ne puisse jamais annoncer "ecart de 0 EUR" tout en etant en
// alerte. Les totaux somment les valeurs de ligne deja arrondies, donc l'invariant est exact.
function reconcilePrimes({
  dettes,
  transactions,
  primesSubcats = PRIMES_SUBCATS,
  tauxTva = PRIMES_TVA_TAUX,
  tolerance = PRIMES_ECART_TOLERANCE,
} = {}) {
  const parSousCat = agregerDebitsParSousCategorie(transactions);
  const lignes = [];

  for (const d of dettes || []) {
    if (!estLignePrimes(d && d.label)) continue;
    const cle = normalizeLabel(d.label);
    const agg = parSousCat.get(cle) || { montant: 0, nb: 0 };

    const declareRembourseHT = Math.round((Number(d.montantInitial) || 0) - (Number(d.restant) || 0));
    const reelTTC = Math.round(agg.montant);
    const reelHT = Math.round(agg.montant / (1 + tauxTva));
    const ecart = reelHT - declareRembourseHT;

    // `sans_reel` prime sur les autres statuts : une ligne sans aucune transaction rattachee
    // n'est jamais qualifiee de `sur_declare`, les deux cas appelant des actions differentes
    // (creer la sous-categorie Qonto, ou chercher le virement manquant).
    let statut;
    if (agg.nb === 0) statut = 'sans_reel';
    else if (Math.abs(ecart) <= tolerance) statut = 'ok';
    else if (ecart > 0) statut = 'sous_declare';
    else statut = 'sur_declare';

    lignes.push({
      label: d.label,
      montantInitial: Math.round(Number(d.montantInitial) || 0),
      restant: Math.round(Number(d.restant) || 0),
      declareRembourseHT,
      reelTTC,
      reelHT,
      nbTransactions: agg.nb,
      ecart,
      statut,
      couvertParExclusion: (primesSubcats || []).includes(cle),
    });
  }

  const totaux = lignes.reduce((acc, l) => ({
    declareRembourseHT: acc.declareRembourseHT + l.declareRembourseHT,
    reelHT: acc.reelHT + l.reelHT,
    ecart: acc.ecart + l.ecart,
  }), { declareRembourseHT: 0, reelHT: 0, ecart: 0 });

  // --- Alertes STRUCTURELLES, distinctes des statuts de ligne ---
  // Elles ne portent pas sur des montants qui divergent, mais sur un cablage incoherent entre le
  // Sheet, Qonto et la liste d'exclusion. Un ecart de montant ne cree jamais d'alerte ici.
  const alertes = [];

  // 1. Ligne de primes absente de la liste d'exclusion : ses debits Qonto retournent dans le reel
  // des charges, alors qu'ils y sont deja par le calcul de prime => double compte silencieux au
  // compte de resultat. C'est le piege ouvert par le nommage libre des sous-categories : il s'est
  // reellement referme le 2026-09-07, quand la sous-categorie Qonto a ete renommee « Primes
  // associes 2025 » sans que PRIMES_QONTO_SUBCATS soit mis a jour.
  for (const l of lignes) {
    if (l.couvertParExclusion) continue;
    alertes.push({
      type: 'sous_categorie_non_exclue',
      label: l.label,
      montant: 0,
      message: 'Ajouter « ' + l.label + ' » a PRIMES_QONTO_SUBCATS puis redemarrer le serveur : '
        + 'sans cela ces virements creent un double compte dans les charges.',
    });
  }

  // 2. Symetrique : des debits classes dans une sous-categorie de primes CONNUE, mais qu'aucune
  // ligne de dette ne reclame. Typiquement un millesime paye sans ligne au carnet, ou une faute
  // de frappe sur le libelle d'un des deux cotes.
  const clesLignes = new Set(lignes.map(l => normalizeLabel(l.label)));
  for (const [cle, agg] of parSousCat.entries()) {
    if (!(primesSubcats || []).includes(cle)) continue;
    if (clesLignes.has(cle)) continue;
    alertes.push({
      type: 'reel_orphelin',
      label: cle,
      montant: Math.round(agg.montant),
      message: agg.nb + ' virement(s) de primes (' + Math.round(agg.montant) + ' EUR TTC) sans ligne '
        + 'de dette correspondante dans le carnet : verifier le libelle des deux cotes.',
    });
  }

  return { lignes, totaux, alertes };
}

// Fenetre de lecture Qonto : du 1er janvier du plus ancien millesime trouve dans les libelles des
// lignes de primes, jusqu'a aujourd'hui. Une prime millesimee N est decaissee en N+1 (voire plus
// tard si le calendrier derive : en 2026, rien n'est parti avant aout alors que le moteur prevoyait
// avril), donc remonter au 1er janvier du millesime est large a dessein.
// Sans millesime detectable, repli sur le debut de l'annee courante.
function fenetreReconciliation(dettes, nowIso) {
  const annees = [];
  for (const d of dettes || []) {
    if (!estLignePrimes(d && d.label)) continue;
    const m = String(d.label).match(/\b(20\d{2})\b/);
    if (m) annees.push(Number(m[1]));
  }
  const anneeCourante = Number(String(nowIso).slice(0, 4));
  const debut = annees.length ? Math.min(...annees) : anneeCourante;
  return { from: debut + '-01-01', to: String(nowIso).slice(0, 10) };
}

module.exports = {
  envNumber,
  estLignePrimes,
  agregerDebitsParSousCategorie,
  reconcilePrimes,
  fenetreReconciliation,
  PRIMES_TVA_TAUX,
  PRIMES_ECART_TOLERANCE,
  PRIMES_SUBCATS,
};
