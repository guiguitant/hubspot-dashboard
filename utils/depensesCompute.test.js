// Tests de utils/depensesCompute.js (onglet Depenses de Releaf Pilot).
// Fixtures synthetiques inspirees des vraies formes de labels bancaires Pennylane.

const { computeDepenses, normVendorLabel } = require('./depensesCompute');

// Date de reference fixe : 15 juillet 2026 (heure locale).
// Mois courant = 2026-07 ; 6 mois pleins precedents = 2026-01..2026-06 ;
// fenetre 12 mois = 2025-08..2026-07 ; fenetre graphe 13 mois = 2025-07..2026-07.
const NOW = '2026-07-15T12:00:00';

// Ids Pennylane reels (categorisation de la comptable)
const CAT_SALAIRES = { id: 8791760, label: 'Salaires' };
const CAT_LOGICIELS = { id: 8791754, label: 'Logiciels & Services Web' };
const CAT_SOUS_TRAITANCE = { id: 8791761, label: 'Sous-traitance' };
const CAT_RESTAURATION = { id: 8791758, label: 'Restauration' };
const CAT_DEPLACEMENTS = { id: 8791750, label: 'Déplacements' };
const CAT_TVA = { id: 30281807, label: 'Taxe sur la valeur ajoutée (TVA)' };
const CAT_IS = { id: 30281790, label: 'Impôts sur les sociétés' };
const CAT_VIREMENTS_INTERNES = { id: 8791763, label: 'Virements internes' };

function tx(date, amount, label, categories = []) {
  return { date, amount: String(amount), label, currency: 'EUR', categories };
}

describe('normVendorLabel', () => {
  test('retire le mot CARTE, la date jj/mm et les suites de >= 5 chiffres', () => {
    expect(normVendorLabel('CARTE 12/06 ELEVENLABS.IO 4029357733')).toBe('ELEVENLABS.IO');
  });

  test('retire PRLV et SEPA et la reference numerique', () => {
    expect(normVendorLabel('PRLV SEPA PAYFIT FR-INV 0001234567')).toBe('PAYFIT FR-INV');
  });

  test('retire VIREMENT et la date jj/mm/aaaa', () => {
    expect(normVendorLabel('VIREMENT SNCF-VOYAGEURS 05/03/2026')).toBe('SNCF-VOYAGEURS');
  });

  test('retire VIR (sans manger VIREMENT partiel) et tronque a 34 caracteres', () => {
    expect(normVendorLabel('VIR MALAKOFF HUMANIS RETRAITE - MALAKOFF HUMANIS PREVOYANCE'))
      .toBe('MALAKOFF HUMANIS RETRAITE - MALAKO');
  });

  test('reduit les espaces multiples et met en majuscules', () => {
    expect(normVendorLabel('  carte   28/06  GitHub   Inc ')).toBe('GITHUB INC');
  });

  test('label vide ou null -> chaine vide', () => {
    expect(normVendorLabel('')).toBe('');
    expect(normVendorLabel(null)).toBe('');
  });
});

describe('computeDepenses : structure et fenetres temporelles', () => {
  test('byMonth contient toujours 13 mois, avec des zeros pour les mois sans transaction', () => {
    const res = computeDepenses([
      tx('2026-07-02', -100, 'CARTE 02/07 ELEVENLABS.IO', [CAT_LOGICIELS]),
    ], { now: NOW });

    expect(res.byMonth).toHaveLength(13);
    expect(res.byMonth[0].month).toBe('2025-07');
    expect(res.byMonth[12].month).toBe('2026-07');
    // Mois sans transaction -> zeros explicites (pas de trous)
    const empty = res.byMonth.find(m => m.month === '2026-03');
    expect(empty).toEqual({ month: '2026-03', total: 0, fixed: 0, pilotable: 0 });
    expect(res.byMonth[12]).toEqual({ month: '2026-07', total: 100, fixed: 0, pilotable: 100 });
  });

  test('les credits (montant positif) et les transactions hors fenetre sont ignores', () => {
    const res = computeDepenses([
      tx('2026-07-02', '850.00', 'VIR CLIENT ACME', []),          // credit -> ignore
      tx('2024-01-10', -500, 'CARTE VIEILLE DEPENSE', [CAT_LOGICIELS]), // hors 13 mois -> ignore
    ], { now: NOW });

    expect(res.byMonth.every(m => m.total === 0)).toBe(true);
    expect(res.byCategory).toHaveLength(0);
    expect(res.kpis.sortiesMoisCourant).toBe(0);
  });

  test('graphe empile : Salaires/TVA/IS en base fixe, le reste en pilotable', () => {
    const res = computeDepenses([
      tx('2026-07-01', -8000, 'VIR PAYFIT FR-INV 0001234567', [CAT_SALAIRES]),
      tx('2026-07-05', -2000, 'PRLV DGFIP TVA 0612026', [CAT_TVA]),
      tx('2026-07-06', -1500, 'PRLV DGFIP IS ACOMPTE', [CAT_IS]),
      tx('2026-07-10', -300, 'CARTE 10/07 ELEVENLABS.IO', [CAT_LOGICIELS]),
    ], { now: NOW });

    const july = res.byMonth[12];
    expect(july.fixed).toBe(11500);
    expect(july.pilotable).toBe(300);
    expect(july.total).toBe(11800);
  });
});

describe('computeDepenses : exclusions de categories', () => {
  const fixtures = [
    // Salaires sur 5 mois : jamais fournisseur ni abonnement
    tx('2026-03-01', -8000, 'VIR PAYFIT FR-INV 0001111111', [CAT_SALAIRES]),
    tx('2026-04-01', -8000, 'VIR PAYFIT FR-INV 0002222222', [CAT_SALAIRES]),
    tx('2026-05-01', -8000, 'VIR PAYFIT FR-INV 0003333333', [CAT_SALAIRES]),
    tx('2026-06-01', -8000, 'VIR PAYFIT FR-INV 0004444444', [CAT_SALAIRES]),
    tx('2026-07-01', -8000, 'VIR PAYFIT FR-INV 0005555555', [CAT_SALAIRES]),
    // TVA sur 4 mois
    tx('2026-04-15', -3000, 'PRLV DGFIP TVA', [CAT_TVA]),
    tx('2026-05-15', -3000, 'PRLV DGFIP TVA', [CAT_TVA]),
    tx('2026-06-15', -3000, 'PRLV DGFIP TVA', [CAT_TVA]),
    tx('2026-07-15', -3000, 'PRLV DGFIP TVA', [CAT_TVA]),
    // Un vrai fournisseur pour verifier qu'il reste
    tx('2026-07-03', -120, 'CARTE 03/07 ELEVENLABS.IO', [CAT_LOGICIELS]),
  ];

  test('Salaires et TVA n\'apparaissent ni dans topVendors ni dans subscriptions', () => {
    const res = computeDepenses(fixtures, { now: NOW });
    const vendorNames = res.topVendors.map(v => v.vendor);
    expect(vendorNames.some(v => v.includes('PAYFIT'))).toBe(false);
    expect(vendorNames.some(v => v.includes('DGFIP'))).toBe(false);
    expect(res.subscriptions.some(s => s.vendor.includes('PAYFIT'))).toBe(false);
    expect(res.subscriptions.some(s => s.vendor.includes('DGFIP'))).toBe(false);
    expect(vendorNames).toContain('ELEVENLABS.IO');
  });

  test('Salaires et TVA restent visibles dans byCategory et le graphe', () => {
    const res = computeDepenses(fixtures, { now: NOW });
    const labels = res.byCategory.map(c => c.label);
    expect(labels).toContain('Salaires');
    expect(labels).toContain('Taxe sur la valeur ajoutée (TVA)');
    const salaires = res.byCategory.find(c => c.label === 'Salaires');
    expect(salaires.total12m).toBe(40000);
  });

  test('les Virements internes sont exclus de tous les agregats mais comptes a part', () => {
    const res = computeDepenses([
      tx('2026-07-02', -5000, 'VIR COMPTE EPARGNE RELEAF', [CAT_VIREMENTS_INTERNES]),
      tx('2026-06-02', -5000, 'VIR COMPTE EPARGNE RELEAF', [CAT_VIREMENTS_INTERNES]),
      tx('2026-07-03', -100, 'CARTE 03/07 ELEVENLABS.IO', [CAT_LOGICIELS]),
    ], { now: NOW });

    expect(res.kpis.sortiesMoisCourant).toBe(100);
    expect(res.byMonth[12].total).toBe(100);
    expect(res.byCategory.map(c => c.label)).not.toContain('Virements internes');
    expect(res.topVendors.some(v => v.vendor.includes('EPARGNE'))).toBe(false);
    expect(res.internalTransfers).toEqual({ count: 2, total: 10000 });
  });

  test('l\'exclusion fournisseur marche aussi par label seul (id inconnu)', () => {
    const res = computeDepenses([
      tx('2026-07-01', -900, 'PRLV URSSAF IMPOTS GLOBAUX', [{ id: 99999999, label: 'Impôts globaux' }]),
    ], { now: NOW });
    expect(res.topVendors).toHaveLength(0);
    // Mais la categorie reste comptee (base fixe du graphe)
    expect(res.byMonth[12].fixed).toBe(900);
    expect(res.byCategory[0].label).toBe('Impôts globaux');
  });
});

describe('computeDepenses : abonnements recurrents', () => {
  test('fournisseur present sur >= 4 mois distincts = abonnement, cout mensuel = total / nb mois', () => {
    const res = computeDepenses([
      tx('2026-03-05', -22, 'CARTE 05/03 ELEVENLABS.IO 111111111', [CAT_LOGICIELS]),
      tx('2026-04-05', -22, 'CARTE 05/04 ELEVENLABS.IO 222222222', [CAT_LOGICIELS]),
      tx('2026-05-05', -22, 'CARTE 05/05 ELEVENLABS.IO 333333333', [CAT_LOGICIELS]),
      tx('2026-06-05', -22, 'CARTE 05/06 ELEVENLABS.IO 444444444', [CAT_LOGICIELS]),
      // 3 mois seulement : pas un abonnement
      tx('2026-04-10', -80, 'CARTE 10/04 SNCF-VOYAGEURS', [CAT_DEPLACEMENTS]),
      tx('2026-05-10', -80, 'CARTE 10/05 SNCF-VOYAGEURS', [CAT_DEPLACEMENTS]),
      tx('2026-06-10', -80, 'CARTE 10/06 SNCF-VOYAGEURS', [CAT_DEPLACEMENTS]),
    ], { now: NOW });

    expect(res.subscriptions).toHaveLength(1);
    const abo = res.subscriptions[0];
    expect(abo.vendor).toBe('ELEVENLABS.IO');
    expect(abo.monthsPresent).toBe(4);
    expect(abo.monthlyEstimate).toBe(22);
    expect(abo.category).toBe('Logiciels & Services Web');
    expect(res.kpis.abonnementsMensuels).toBe(22);

    const sncf = res.topVendors.find(v => v.vendor === 'SNCF-VOYAGEURS');
    expect(sncf.recurrent).toBe(false);
    expect(sncf.monthsPresent).toBe(3);
    const eleven = res.topVendors.find(v => v.vendor === 'ELEVENLABS.IO');
    expect(eleven.recurrent).toBe(true);
  });

  test('2 transactions le meme mois = 1 seul mois de presence', () => {
    const res = computeDepenses([
      tx('2026-07-01', -50, 'CARTE 01/07 GITHUB', [CAT_LOGICIELS]),
      tx('2026-07-20', -50, 'CARTE 20/07 GITHUB', [CAT_LOGICIELS]),
      tx('2026-06-01', -50, 'CARTE 01/06 GITHUB', [CAT_LOGICIELS]),
      tx('2026-05-01', -50, 'CARTE 01/05 GITHUB', [CAT_LOGICIELS]),
    ], { now: NOW });

    const github = res.topVendors.find(v => v.vendor === 'GITHUB');
    expect(github.monthsPresent).toBe(3);
    expect(github.txCount).toBe(4);
    expect(res.subscriptions).toHaveLength(0);
  });
});

describe('computeDepenses : derive par categorie', () => {
  // Moyenne 6 mois = 2026-01..2026-06 (mois courant exclu)
  function monthlySeries(category, labelBase, amounts) {
    // amounts = [jan, fev, mar, avr, mai, juin, juil]
    const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
    return months.map((m, i) => tx(m + '-10', -amounts[i], labelBase + ' ' + m, [category]));
  }

  test('derive si mois courant > moyenne x 1,3 ET ecart >= 200', () => {
    const res = computeDepenses(
      monthlySeries(CAT_LOGICIELS, 'CARTE OPENAI', [100, 100, 100, 100, 100, 100, 400]),
      { now: NOW }
    );
    const cat = res.byCategory.find(c => c.label === 'Logiciels & Services Web');
    expect(cat.avg6m).toBe(100);
    expect(cat.currentMonth).toBe(400);
    expect(cat.derive).toBe(true);
    expect(cat.deriveAmount).toBe(300);
  });

  test('pas de derive si le ratio 1,3 n\'est pas depasse (meme avec >= 200 EUR d\'ecart)', () => {
    const res = computeDepenses(
      monthlySeries(CAT_RESTAURATION, 'CARTE RESTAU', [1000, 1000, 1000, 1000, 1000, 1000, 1250]),
      { now: NOW }
    );
    const cat = res.byCategory.find(c => c.label === 'Restauration');
    expect(cat.derive).toBe(false); // 1250 < 1000 x 1,3
    expect(cat.deriveAmount).toBe(0);
  });

  test('pas de derive si l\'ecart absolu est < 200 EUR (meme avec ratio depasse)', () => {
    const res = computeDepenses(
      monthlySeries(CAT_DEPLACEMENTS, 'CARTE SNCF', [100, 100, 100, 100, 100, 100, 250]),
      { now: NOW }
    );
    const cat = res.byCategory.find(c => c.label === 'Déplacements');
    expect(cat.derive).toBe(false); // 250 > 130 mais ecart 150 < 200
  });

  test('categorie nouvelle (moyenne 0) avec >= 200 EUR ce mois = derive', () => {
    const res = computeDepenses([
      tx('2026-07-08', -450, 'CARTE 08/07 NOUVEAU SAAS', [CAT_SOUS_TRAITANCE]),
    ], { now: NOW });
    const cat = res.byCategory.find(c => c.label === 'Sous-traitance');
    expect(cat.avg6m).toBe(0);
    expect(cat.derive).toBe(true);
    expect(cat.deriveAmount).toBe(450);
  });
});

describe('computeDepenses : sans categorie et KPIs', () => {
  test('transaction sans categorie : comptee dans uncategorized, les KPIs et byCategory', () => {
    const res = computeDepenses([
      tx('2026-07-04', -75.5, 'CARTE 04/07 AMAZON MKTP', []),
      tx('2026-07-06', -24.5, 'CARTE 06/07 FNAC', []),
      tx('2026-07-08', -100, 'CARTE 08/07 ELEVENLABS.IO', [CAT_LOGICIELS]),
    ], { now: NOW });

    expect(res.uncategorized.count).toBe(2);
    expect(res.uncategorized.total).toBe(100);
    expect(res.kpis.sansCategorieCount).toBe(2);
    expect(res.kpis.sansCategorieTotal).toBe(100);
    // Triees par montant decroissant, avec label et date pour investiguer
    expect(res.uncategorized.transactions[0].label).toBe('CARTE 04/07 AMAZON MKTP');
    // Visibles aussi dans le tableau par categorie
    const sansCat = res.byCategory.find(c => c.label === 'Sans categorie');
    expect(sansCat.total12m).toBe(100);
    // Et dans les fournisseurs (pas de categorie exclue)
    expect(res.topVendors.some(v => v.vendor === 'AMAZON MKTP')).toBe(true);
  });

  test('KPIs : sorties du mois, moyenne 6 mois et % de variation', () => {
    const txs = [];
    // 6 mois pleins (2026-01..2026-06) a 1000 EUR/mois
    for (const m of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      txs.push(tx(m + '-05', -1000, 'CARTE LOYER BUREAUX ' + m, [{ id: 8791749, label: 'Bureaux' }]));
    }
    // Mois courant : 1500 EUR
    txs.push(tx('2026-07-05', -1500, 'CARTE LOYER BUREAUX 2026-07', [{ id: 8791749, label: 'Bureaux' }]));

    const res = computeDepenses(txs, { now: NOW });
    expect(res.kpis.sortiesMoisCourant).toBe(1500);
    expect(res.kpis.moyenne6m).toBe(1000);
    expect(res.kpis.pctVsMoyenne6m).toBe(50);
    expect(res.kpis.currentMonth).toBe('2026-07');
  });

  test('aucune transaction : zeros partout, pas de NaN, pct null', () => {
    const res = computeDepenses([], { now: NOW });
    expect(res.byMonth).toHaveLength(13);
    expect(res.kpis.sortiesMoisCourant).toBe(0);
    expect(res.kpis.moyenne6m).toBe(0);
    expect(res.kpis.pctVsMoyenne6m).toBeNull();
    expect(res.kpis.abonnementsMensuels).toBe(0);
    expect(res.byCategory).toEqual([]);
    expect(res.topVendors).toEqual([]);
    expect(res.subscriptions).toEqual([]);
    expect(res.uncategorized).toEqual({ count: 0, total: 0, transactions: [] });
  });

  test('topVendors est limite a 15 fournisseurs, tries par total decroissant', () => {
    const txs = [];
    for (let i = 1; i <= 20; i++) {
      txs.push(tx('2026-07-0' + ((i % 9) + 1), -(i * 10), 'CARTE FOURNISSEUR' + String.fromCharCode(64 + i), [CAT_LOGICIELS]));
    }
    const res = computeDepenses(txs, { now: NOW });
    expect(res.topVendors).toHaveLength(15);
    expect(res.topVendors[0].total12m).toBe(200);
    const totals = res.topVendors.map(v => v.total12m);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  });
});

describe('computeDepenses : mode periode explicite (start/end)', () => {
  const CAT = { id: 8791754, label: 'Logiciels & Services Web' };

  test('byMonth couvre exactement les mois de la periode', () => {
    const res = computeDepenses([
      tx('2025-03-10', -100, 'CARTE 10/03 ELEVENLABS.IO', [CAT]),
    ], { start: '2025-01-01', end: '2025-12-31' });
    expect(res.byMonth).toHaveLength(12);
    expect(res.byMonth[0].month).toBe('2025-01');
    expect(res.byMonth[11].month).toBe('2025-12');
    expect(res.byMonth.find(m => m.month === '2025-03').total).toBe(100);
  });

  test('les transactions hors periode sont ignorees', () => {
    const res = computeDepenses([
      tx('2025-06-10', -200, 'CARTE 10/06 ELEVENLABS.IO', [CAT]),
      tx('2026-01-10', -999, 'CARTE 10/01 ELEVENLABS.IO', [CAT]), // hors periode
    ], { start: '2025-01-01', end: '2025-12-31' });
    expect(res.byCategory.find(c => c.label === 'Logiciels & Services Web').total12m).toBe(200);
    expect(res.byMonth.find(m => m.month === '2026-01')).toBeUndefined();
  });

  test('pas de derive en mode periode meme si une categorie pique le dernier mois', () => {
    const res = computeDepenses([
      tx('2025-11-10', -100, 'CARTE OPENAI 2025-11', [CAT]),
      tx('2025-12-10', -900, 'CARTE OPENAI 2025-12', [CAT]),
    ], { start: '2025-01-01', end: '2025-12-31' });
    const cat = res.byCategory.find(c => c.label === 'Logiciels & Services Web');
    expect(cat.derive).toBe(false);
    expect(cat.total12m).toBe(1000);
  });
});
