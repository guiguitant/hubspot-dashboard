'use strict';

const {
  envNumber,
  estLignePrimes,
  agregerDebitsParSousCategorie,
  PRIMES_TVA_TAUX,
  PRIMES_ECART_TOLERANCE,
} = require('./primesReconciliation');

describe('envNumber', () => {
  it('renvoie le defaut si la variable est absente ou vide', () => {
    expect(envNumber(undefined, 0.2)).toBe(0.2);
    expect(envNumber('', 0.2)).toBe(0.2);
  });
  it('accepte la valeur zero, qui ne doit pas retomber sur le defaut', () => {
    expect(envNumber('0', 1)).toBe(0);
  });
  it('renvoie le defaut si la valeur est non numerique', () => {
    expect(envNumber('abc', 1)).toBe(1);
  });
});

describe('estLignePrimes', () => {
  it('reconnait une ligne de primes quelle que soit la casse', () => {
    expect(estLignePrimes('Primes associes 2025')).toBe(true);
    expect(estLignePrimes('PRIME exceptionnelle')).toBe(true);
  });
  it('ignore les autres lignes de dette', () => {
    expect(estLignePrimes('Avance remboursable BPI')).toBe(false);
    expect(estLignePrimes('Emprunt bancaire')).toBe(false);
    expect(estLignePrimes('')).toBe(false);
    expect(estLignePrimes(null)).toBe(false);
  });
});

describe('agregerDebitsParSousCategorie', () => {
  const tx = (side, amount, nom) => ({ side, amount, cashflow_subcategory: nom ? { name: nom } : null });

  it('agrege plusieurs debits sur la meme sous-categorie (une prime, plusieurs decaissements)', () => {
    const m = agregerDebitsParSousCategorie([
      tx('debit', 1200, 'Primes associes 2025'),
      tx('debit', 2400, 'Primes associes 2025'),
    ]);
    expect(m.get('primes associes 2025')).toEqual({ montant: 3600, nb: 2 });
  });

  it('normalise accents, casse et espaces multiples pour la cle', () => {
    const m = agregerDebitsParSousCategorie([
      tx('debit', 100, 'Primes  ASSOCIÉS   2025 '),
    ]);
    expect(m.get('primes associes 2025')).toEqual({ montant: 100, nb: 1 });
  });

  it('ignore les credits : un virement entrant n eteint jamais une dette', () => {
    const m = agregerDebitsParSousCategorie([
      tx('credit', 5000, 'Primes associes 2025'),
    ]);
    expect(m.has('primes associes 2025')).toBe(false);
  });

  it('ignore les transactions sans sous-categorie', () => {
    const m = agregerDebitsParSousCategorie([tx('debit', 100, null)]);
    expect(m.size).toBe(0);
  });

  it('renvoie une map vide pour une entree vide ou absente', () => {
    expect(agregerDebitsParSousCategorie([]).size).toBe(0);
    expect(agregerDebitsParSousCategorie(undefined).size).toBe(0);
  });
});

describe('constantes par defaut', () => {
  it('expose un taux de TVA de 20 % et une tolerance de 1 euro', () => {
    expect(PRIMES_TVA_TAUX).toBe(0.20);
    expect(PRIMES_ECART_TOLERANCE).toBe(1);
  });
});

const { reconcilePrimes } = require('./primesReconciliation');

// Jeu de donnees de reference : 3600 TTC verses = 3000 HT.
const SUBCATS = ['primes associes 2025', 'primes associes 2026'];
const dette = (label, montantInitial, restant) => ({ label, montantInitial, restant, controle: true });
const debit = (amount, nom) => ({ side: 'debit', amount, cashflow_subcategory: { name: nom } });

describe('reconcilePrimes . rattachement et conversion', () => {
  it('rattache par libelle normalise et convertit le TTC en HT', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [debit(3600, 'Primes ASSOCIES 2025')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes).toHaveLength(1);
    expect(r.lignes[0].declareRembourseHT).toBe(3000);
    expect(r.lignes[0].reelTTC).toBe(3600);
    expect(r.lignes[0].reelHT).toBe(3000);
    expect(r.lignes[0].ecart).toBe(0);
    expect(r.lignes[0].statut).toBe('ok');
    expect(r.lignes[0].nbTransactions).toBe(1);
  });

  it('agrege plusieurs decaissements sur une meme ligne', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [debit(1200, 'Primes associes 2025'), debit(2400, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].nbTransactions).toBe(2);
    expect(r.lignes[0].reelHT).toBe(3000);
  });

  it('ne rattache PAS deux libelles proches mais distincts', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [debit(3600, 'Primes associees 2025'), debit(1200, 'Primes associes 2026')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].nbTransactions).toBe(0);
    expect(r.lignes[0].statut).toBe('sans_reel');
  });

  it('accepte un taux de TVA surcharge', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 10000)],
      transactions: [debit(1100, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
      tauxTva: 0.10,
    });
    expect(r.lignes[0].reelHT).toBe(1000);
  });

  it('ignore les lignes de dette qui ne sont pas des primes', () => {
    const r = reconcilePrimes({
      dettes: [dette('Avance remboursable BPI', 58800, 40000), dette('Primes associes 2025', 10000, 10000)],
      transactions: [],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes.map(l => l.label)).toEqual(['Primes associes 2025']);
  });
});

describe('reconcilePrimes . statuts et seuil', () => {
  // Declare rembourse = 3000 HT. Le reel HT varie autour, tolerance par defaut = 1 euro.
  const cas = (reelTTC) => reconcilePrimes({
    dettes: [dette('Primes associes 2025', 10000, 7000)],
    transactions: [debit(reelTTC, 'Primes associes 2025')],
    primesSubcats: SUBCATS,
  }).lignes[0];

  it('ok quand l ecart est juste SOUS le seuil', () => {
    expect(cas(3601.2).ecart).toBe(1);
    expect(cas(3601.2).statut).toBe('ok');
  });

  it('sous_declare quand l ecart depasse le seuil vers le haut', () => {
    const l = cas(3603.6);
    expect(l.ecart).toBe(3);
    expect(l.statut).toBe('sous_declare');
  });

  it('ok quand l ecart negatif est juste SOUS le seuil', () => {
    expect(cas(3598.8).ecart).toBe(-1);
    expect(cas(3598.8).statut).toBe('ok');
  });

  it('sur_declare quand l ecart depasse le seuil vers le bas', () => {
    const l = cas(3596.4);
    expect(l.ecart).toBe(-3);
    expect(l.statut).toBe('sur_declare');
  });

  it('sans_reel prime sur sur_declare quand aucune transaction n est rattachee', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].statut).toBe('sans_reel');
    expect(r.lignes[0].ecart).toBe(-3000);
  });

  it('rapproche aussi les lignes dont la case de controle est decochee', () => {
    const r = reconcilePrimes({
      dettes: [{ label: 'Primes associes 2025', montantInitial: 10000, restant: 7000, controle: false }],
      transactions: [debit(3600, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes).toHaveLength(1);
    expect(r.lignes[0].statut).toBe('ok');
  });
});

describe('reconcilePrimes . totaux', () => {
  it('les totaux sont la somme exacte des valeurs de ligne deja arrondies', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000), dette('Primes associes 2026', 5000, 5000)],
      transactions: [debit(3603.6, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
    });
    const sommeEcarts = r.lignes.reduce((s, l) => s + l.ecart, 0);
    expect(r.totaux.ecart).toBe(sommeEcarts);
    expect(r.totaux.declareRembourseHT).toBe(3000);
    expect(r.totaux.reelHT).toBe(3003);
  });
});

describe('reconcilePrimes . alertes structurelles', () => {
  it('alerte quand une ligne de primes n est pas couverte par la liste d exclusion', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2027', 4000, 4000)],
      transactions: [],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].couvertParExclusion).toBe(false);
    const a = r.alertes.find(x => x.type === 'sous_categorie_non_exclue');
    expect(a).toBeDefined();
    expect(a.label).toBe('Primes associes 2027');
    expect(a.message).toMatch(/double compte/i);
    // Une alerte structurelle ne doit modifier AUCUN statut de ligne (spec section 4.1).
    expect(r.lignes[0].statut).toBe('sans_reel');
  });

  it('n alerte pas quand la ligne est bien couverte', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 10000)],
      transactions: [],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].couvertParExclusion).toBe(true);
    expect(r.alertes.filter(a => a.type === 'sous_categorie_non_exclue')).toHaveLength(0);
  });

  it('alerte sur des debits de primes sans ligne de dette homonyme', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 10000)],
      transactions: [debit(1200, 'Primes associes 2026')],
      primesSubcats: SUBCATS,
    });
    const a = r.alertes.find(x => x.type === 'reel_orphelin');
    expect(a).toBeDefined();
    expect(a.montant).toBe(1200);
  });

  it('n alerte pas orphelin pour une sous-categorie hors perimetre primes', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 10000)],
      transactions: [debit(900, 'Fournitures de bureau')],
      primesSubcats: SUBCATS,
    });
    expect(r.alertes.filter(a => a.type === 'reel_orphelin')).toHaveLength(0);
  });

  it('un ecart de montant ne cree aucune alerte', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [debit(9999, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].statut).toBe('sous_declare');
    expect(r.alertes).toHaveLength(0);
  });
});

const { fenetreReconciliation } = require('./primesReconciliation');

describe('fenetreReconciliation', () => {
  it('part du 1er janvier du plus ancien millesime trouve dans les libelles', () => {
    const f = fenetreReconciliation(
      [dette('Primes associes 2026', 0, 0), dette('Primes associes 2025', 0, 0)],
      '2026-08-31T10:00:00.000Z'
    );
    expect(f).toEqual({ from: '2025-01-01', to: '2026-08-31' });
  });

  it('ignore les millesimes des lignes qui ne sont pas des primes', () => {
    const f = fenetreReconciliation(
      [dette('Avance remboursable BPI 2021', 0, 0), dette('Primes associes 2026', 0, 0)],
      '2026-08-31T10:00:00.000Z'
    );
    expect(f.from).toBe('2026-01-01');
  });

  it('replie sur l annee courante si aucun millesime n est detectable', () => {
    const f = fenetreReconciliation([dette('Primes associes', 0, 0)], '2026-08-31T10:00:00.000Z');
    expect(f.from).toBe('2026-01-01');
  });

  it('replie sur l annee courante si aucune ligne de primes n existe', () => {
    const f = fenetreReconciliation([dette('Emprunt bancaire', 0, 0)], '2026-08-31T10:00:00.000Z');
    expect(f.from).toBe('2026-01-01');
  });
});
