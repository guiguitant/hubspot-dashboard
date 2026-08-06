'use strict';
const {
  normalizeLabel,
  isPrimeSubcategory,
  isHorsExploitation,
  monthEndDate,
  PRIMES_SUBCATS,
  HORS_EXPLOITATION,
  buildPrimesSubcats,
} = require('./chargesPerimetre');

describe('normalizeLabel', () => {
  it('minuscules, accents retires, espaces compactes', () => {
    expect(normalizeLabel('Primes associées ')).toBe('primes associees');
  });

  it('gere les majuscules accentuees composees (I majuscule)', () => {
    expect(normalizeLabel('Impôt sur les sociétés')).toBe('impot sur les societes');
  });

  it('compacte les espaces multiples', () => {
    expect(normalizeLabel('Paiements   de la   TVA')).toBe('paiements de la tva');
  });

  it("renvoie '' pour null, undefined ou chaine vide", () => {
    expect(normalizeLabel(null)).toBe('');
    expect(normalizeLabel(undefined)).toBe('');
    expect(normalizeLabel('')).toBe('');
  });
});

describe('isPrimeSubcategory', () => {
  it('matche insensible a la casse et aux accents', () => {
    expect(isPrimeSubcategory('PRIMES ASSOCIÉES')).toBe(true);
  });

  it("matche 'Primes commerciales'", () => {
    expect(isPrimeSubcategory('Primes commerciales')).toBe(true);
  });

  it('rejette une sous-categorie hors liste', () => {
    expect(isPrimeSubcategory('Salaires')).toBe(false);
  });

  it('rejette null', () => {
    expect(isPrimeSubcategory(null)).toBe(false);
  });

  it('accepte une liste optionnelle en second parametre (surcharge pour les tests)', () => {
    const listeCustom = ['prime exceptionnelle'];
    expect(isPrimeSubcategory('Prime exceptionnelle', listeCustom)).toBe(true);
    // La liste par defaut (module) ne contient pas cette sous-categorie.
    expect(isPrimeSubcategory('Prime exceptionnelle')).toBe(false);
  });
});

describe('PRIMES_SUBCATS (liste par defaut, chargee au demarrage du module)', () => {
  it('contient les deux sous-categories par defaut, normalisees', () => {
    expect(PRIMES_SUBCATS).toEqual(['primes associees', 'primes commerciales']);
  });
});

describe('buildPrimesSubcats (fabrique testable, sans dependre de process.env)', () => {
  it('reprend la valeur par defaut si raw est vide/absent', () => {
    expect(buildPrimesSubcats(undefined)).toEqual(['primes associees', 'primes commerciales']);
    expect(buildPrimesSubcats('')).toEqual(['primes associees', 'primes commerciales']);
  });

  it('parse une liste custom separee par des virgules, normalisee', () => {
    expect(buildPrimesSubcats('Prime A, Primé B')).toEqual(['prime a', 'prime b']);
  });

  it('filtre les entrees vides (virgules superflues)', () => {
    expect(buildPrimesSubcats('Prime A,,Prime B,')).toEqual(['prime a', 'prime b']);
  });
});

describe("PRIMES_QONTO_SUBCATS (surcharge par variable d'environnement, lue au chargement du module)", () => {
  const ORIGINAL_ENV = process.env.PRIMES_QONTO_SUBCATS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.PRIMES_QONTO_SUBCATS;
    else process.env.PRIMES_QONTO_SUBCATS = ORIGINAL_ENV;
    jest.resetModules();
  });

  it("surcharge PRIMES_SUBCATS quand la variable d'env est definie avant le chargement du module", () => {
    jest.resetModules();
    process.env.PRIMES_QONTO_SUBCATS = 'Prime speciale,Autre prime';
    const rechargeChargesPerimetre = require('./chargesPerimetre');
    expect(rechargeChargesPerimetre.PRIMES_SUBCATS).toEqual(['prime speciale', 'autre prime']);
    expect(rechargeChargesPerimetre.isPrimeSubcategory('PRIME SPECIALE')).toBe(true);
    expect(rechargeChargesPerimetre.isPrimeSubcategory('Primes associées')).toBe(false);
  });
});

describe('isHorsExploitation', () => {
  it('TVA reversee = compte de tiers, jamais une charge', () => {
    expect(isHorsExploitation('Impôts et taxes', 'Paiements de la TVA')).toBe(true);
  });

  it('IS = charge hors exploitation (deja recalculee par computeIS), avec accents', () => {
    expect(isHorsExploitation('Impôts et taxes', 'Impôt sur les sociétés')).toBe(true);
  });

  it("n'exclut pas le reste de la categorie 'Impots et taxes' (prelevement a la source reste en charges)", () => {
    expect(isHorsExploitation('Impôts et taxes', 'Autres impôts et taxes')).toBe(false);
  });

  it('rejette une sous-categorie non concernee', () => {
    expect(isHorsExploitation('Charges externes', 'Loyers')).toBe(false);
  });

  it('rejette null', () => {
    expect(isHorsExploitation(null, null)).toBe(false);
  });
});

describe('HORS_EXPLOITATION (liste exportee)', () => {
  it('contient les deux libelles normalises', () => {
    expect(HORS_EXPLOITATION).toEqual(['paiements de la tva', 'impot sur les societes']);
  });
});

describe('monthEndDate', () => {
  it("mois de 31 jours : '2026-07' -> 31 juillet 23:59:59.999 (heure locale)", () => {
    const d = monthEndDate('2026-07');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // juillet = index 6
    expect(d.getDate()).toBe(31);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });

  it("fevrier non bissextile : '2026-02' -> 28", () => {
    const d = monthEndDate('2026-02');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(1); // fevrier = index 1
    expect(d.getDate()).toBe(28);
  });

  it("fevrier bissextile : '2024-02' -> 29", () => {
    const d = monthEndDate('2024-02');
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(29);
  });

  it("mois de 30 jours : '2026-04' -> 30", () => {
    const d = monthEndDate('2026-04');
    expect(d.getDate()).toBe(30);
  });
});
