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
