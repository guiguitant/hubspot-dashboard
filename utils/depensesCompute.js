// utils/depensesCompute.js
// Logique pure de l'onglet Depenses (Releaf Pilot).
// Recoit les transactions bancaires Pennylane brutes (12-13 mois) et calcule tous les
// agregats affiches par la page : sorties par mois, ventilation par categorie,
// top fournisseurs, abonnements recurrents detectes et KPIs.
// Module 100% pur : aucun fetch, aucune dependance reseau (regle du repo : la logique
// financiere est extraite dans utils/ et testee par jest).
//
// Forme d'une transaction Pennylane (API externe v2, /transactions) :
//   { amount: '-123.45' (string signee, negatif = debit), date: 'YYYY-MM-DD',
//     label: 'CARTE 12/06 ELEVENLABS.IO', currency: 'EUR',
//     categories: [{ id, label }] (eventuellement vide) }
//
// Conventions de calcul :
// - Seuls les debits (amount < 0) comptent ; les montants retournes sont positifs (sorties).
// - Les "Virements internes" (argent qui bouge entre comptes Releaf) sont exclus de TOUS
//   les agregats ; leur volume est retourne a part dans `internalTransfers` pour transparence.
// - Fenetres : graphe = 13 mois (mois courant + 12 precedents) ; tableaux/KPIs = 12 derniers
//   mois (mois courant inclus) ; moyennes "6 mois" = les 6 mois pleins PRECEDANT le mois
//   courant (comparer un mois partiel a une moyenne qui l'inclut fausserait la derive).

// Categories Pennylane (ids poses par la comptable, cf. plan de categorisation cash_out).
const INTERNAL_TRANSFER_CATEGORY_IDS = new Set([8791763]); // Virements internes
const FIXED_CATEGORY_IDS = new Set([
  8791760,   // Salaires
  30281807,  // Taxe sur la valeur ajoutee (TVA)
  30281790,  // Impots sur les societes
]);

// Seuils de detection
const SUBSCRIPTION_MIN_MONTHS = 4;       // fournisseur present >= 4 mois distincts = recurrent
const DERIVE_RATIO = 1.3;                // mois courant > moyenne 6 mois x 1,3
const DERIVE_MIN_GAP = 200;              // ET au moins 200 EUR d'ecart

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Matching par label en secours du matching par id (robuste aux recategorisations).
function isInternalTransferCategory(cat) {
  if (!cat) return false;
  if (INTERNAL_TRANSFER_CATEGORY_IDS.has(cat.id)) return true;
  return /virements? internes?/i.test(stripAccents(cat.label));
}

function isFixedCategory(cat) {
  if (!cat) return false;
  if (FIXED_CATEGORY_IDS.has(cat.id)) return true;
  const label = stripAccents(cat.label).toLowerCase();
  return (
    label.includes('salaire') ||
    label.includes('taxe sur la valeur ajout') ||
    /(^|\W)tva(\W|$)/.test(label) ||
    label.includes('impot')
  );
}

// Categories exclues des fournisseurs/abonnements : Salaires, TVA, IS, Impots globaux,
// Virements internes (= fixed + internal, cf. spec validee sur les vraies donnees).
function isVendorExcludedCategory(cat) {
  return isFixedCategory(cat) || isInternalTransferCategory(cat);
}

// Normalisation fournisseur validee sur les vraies formes de labels bancaires :
// upper, retrait des mots de type d'operation, des dates jj/mm(/aaaa) et des suites
// de >= 5 chiffres (references), espaces reduits, tronque a 34 caracteres.
function normVendorLabel(label) {
  let s = stripAccents(label).toUpperCase();
  s = s.replace(/\b(CARTE|VIR|VIREMENT|PRLV|PRELEVEMENT|SEPA)\b/g, ' ');
  s = s.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ');
  s = s.replace(/\d{5,}/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 34).trim();
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function monthKeyFromOffset(now, offset) {
  const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

const UNCATEGORIZED_LABEL = 'Sans categorie';

function computeDepenses(transactions, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const txs = Array.isArray(transactions) ? transactions : [];

  // Echelles de temps (cles 'YYYY-MM')
  const months13 = [];
  for (let off = 12; off >= 0; off--) months13.push(monthKeyFromOffset(now, off));
  const currentMonthKey = months13[months13.length - 1];
  const months12 = months13.slice(1);                 // 12 derniers mois, mois courant inclus
  const prev6 = months13.slice(6, 12);                // 6 mois pleins precedant le mois courant
  const months13Set = new Set(months13);
  const months12Set = new Set(months12);

  // Accumulateurs
  const byMonthMap = new Map();      // month -> { total, fixed, pilotable }
  const byCategoryMap = new Map();   // label -> Map(month -> montant)
  const vendorsMap = new Map();      // vendor norm -> { total, count, months:Set, catTotals:Map }
  const uncategorizedTxs = [];
  let internalCount = 0;
  let internalTotal = 0;

  for (const tx of txs) {
    const amount = parseFloat(tx && tx.amount);
    if (!(amount < 0)) continue; // seuls les debits (sorties) comptent
    const spend = -amount;

    const monthKey = String((tx && tx.date) || '').slice(0, 7);
    if (!months13Set.has(monthKey)) continue;

    const cats = Array.isArray(tx.categories) ? tx.categories.filter(Boolean) : [];

    // Virements internes : pas une vraie sortie, exclus de tout (comptes a part)
    if (cats.some(isInternalTransferCategory)) {
      if (months12Set.has(monthKey)) {
        internalCount++;
        internalTotal += spend;
      }
      continue;
    }

    const isFixed = cats.some(isFixedCategory);

    // Graphe 13 mois : Salaires + impots (base) vs charges pilotables (le reste)
    let m = byMonthMap.get(monthKey);
    if (!m) { m = { total: 0, fixed: 0, pilotable: 0 }; byMonthMap.set(monthKey, m); }
    m.total += spend;
    if (isFixed) m.fixed += spend; else m.pilotable += spend;

    // Le reste (tableaux, KPIs) travaille sur les 12 derniers mois
    if (!months12Set.has(monthKey)) continue;

    const catLabel = cats.length ? String(cats[0].label || UNCATEGORIZED_LABEL) : UNCATEGORIZED_LABEL;
    let catMonths = byCategoryMap.get(catLabel);
    if (!catMonths) { catMonths = new Map(); byCategoryMap.set(catLabel, catMonths); }
    catMonths.set(monthKey, (catMonths.get(monthKey) || 0) + spend);

    if (!cats.length) {
      uncategorizedTxs.push({ date: tx.date, label: String(tx.label || ''), amount: round2(spend) });
    }

    // Fournisseurs : hors Salaires/TVA/IS/Impots/Virements internes
    if (!cats.some(isVendorExcludedCategory)) {
      const vendor = normVendorLabel(tx.label);
      if (vendor) {
        let v = vendorsMap.get(vendor);
        if (!v) { v = { total: 0, count: 0, months: new Set(), catTotals: new Map() }; vendorsMap.set(vendor, v); }
        v.total += spend;
        v.count++;
        v.months.add(monthKey);
        v.catTotals.set(catLabel, (v.catTotals.get(catLabel) || 0) + spend);
      }
    }
  }

  // --- byMonth (13 mois, zeros pour les mois sans transaction) ---
  const byMonth = months13.map((month) => {
    const e = byMonthMap.get(month) || { total: 0, fixed: 0, pilotable: 0 };
    return { month, total: round2(e.total), fixed: round2(e.fixed), pilotable: round2(e.pilotable) };
  });

  // --- byCategory (12 mois + derive vs moyenne 6 mois) ---
  const byCategory = [];
  for (const [label, catMonths] of byCategoryMap) {
    let total12m = 0;
    for (const mk of months12) total12m += catMonths.get(mk) || 0;
    const currentMonth = catMonths.get(currentMonthKey) || 0;
    let prev6Sum = 0;
    for (const mk of prev6) prev6Sum += catMonths.get(mk) || 0;
    const avg6m = prev6Sum / 6;
    const gap = currentMonth - avg6m;
    const derive = currentMonth > avg6m * DERIVE_RATIO && gap >= DERIVE_MIN_GAP;
    byCategory.push({
      label,
      total12m: round2(total12m),
      currentMonth: round2(currentMonth),
      avg6m: round2(avg6m),
      derive,
      deriveAmount: derive ? round2(gap) : 0,
    });
  }
  byCategory.sort((a, b) => b.total12m - a.total12m);

  // --- Fournisseurs ---
  const allVendors = [];
  for (const [vendor, v] of vendorsMap) {
    let topCat = UNCATEGORIZED_LABEL;
    let topCatTotal = -1;
    for (const [cl, t] of v.catTotals) {
      if (t > topCatTotal) { topCatTotal = t; topCat = cl; }
    }
    allVendors.push({
      vendor,
      category: topCat,
      total12m: round2(v.total),
      txCount: v.count,
      monthsPresent: v.months.size,
      recurrent: v.months.size >= SUBSCRIPTION_MIN_MONTHS,
    });
  }
  allVendors.sort((a, b) => b.total12m - a.total12m);
  const topVendors = allVendors.slice(0, 15);

  // --- Abonnements detectes (>= 4 mois distincts, cout mensuel = total / nb mois) ---
  const subscriptions = allVendors
    .filter((v) => v.recurrent)
    .map((v) => ({
      vendor: v.vendor,
      category: v.category,
      monthsPresent: v.monthsPresent,
      total12m: v.total12m,
      monthlyEstimate: round2(v.total12m / v.monthsPresent),
    }))
    .sort((a, b) => b.monthlyEstimate - a.monthlyEstimate);

  const abonnementsMensuels = round2(subscriptions.reduce((s, x) => s + x.monthlyEstimate, 0));

  // --- KPIs ---
  const sortiesMoisCourant = byMonth[byMonth.length - 1].total;
  let prev6TotalSum = 0;
  for (const mk of prev6) prev6TotalSum += (byMonthMap.get(mk) || { total: 0 }).total;
  const moyenne6m = round2(prev6TotalSum / 6);
  const pctVsMoyenne6m = moyenne6m > 0
    ? Math.round(((sortiesMoisCourant - moyenne6m) / moyenne6m) * 1000) / 10
    : null;

  const sansCategorieTotal = round2(uncategorizedTxs.reduce((s, t) => s + t.amount, 0));
  uncategorizedTxs.sort((a, b) => b.amount - a.amount);

  return {
    byMonth,
    byCategory,
    topVendors,
    subscriptions,
    kpis: {
      sortiesMoisCourant,
      pctVsMoyenne6m,
      moyenne6m,
      abonnementsMensuels,
      sansCategorieCount: uncategorizedTxs.length,
      sansCategorieTotal,
      currentMonth: currentMonthKey,
    },
    uncategorized: {
      count: uncategorizedTxs.length,
      total: sansCategorieTotal,
      transactions: uncategorizedTxs.slice(0, 20),
    },
    internalTransfers: { count: internalCount, total: round2(internalTotal) },
  };
}

module.exports = { computeDepenses, normVendorLabel };
