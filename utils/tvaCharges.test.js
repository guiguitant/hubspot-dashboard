'use strict';
const { montantHT, buildCoupleKey, COUPLE_SEP } = require('./tvaCharges');
const { normalizeLabel } = require('./chargesPerimetre');

// Table de taux de test, meme forme que celle produite par fetchAndParseCategoriesTVA (server.js) :
// { parCategorie: { cleNormalisee: {taux, recuperable} }, parCouple: { cleNormalisee: {...} } }
const TABLE_TEST = {
  parCategorie: {
    [normalizeLabel('SaaS')]: { taux: 0.20, recuperable: true },
    [normalizeLabel('Restauration')]: { taux: 0.10, recuperable: true },
    [normalizeLabel('Banque')]: { taux: 0, recuperable: true },
    [normalizeLabel('Travel Expenses')]: { taux: 0.10, recuperable: false },
    [normalizeLabel('Frais de personnel')]: { taux: 0, recuperable: true },
    [normalizeLabel('Rémunération dirigeants')]: { taux: 0.20, recuperable: true },
  },
  parCouple: {
    [buildCoupleKey('Frais de personnel', 'Rémunération dirigeants')]: { taux: 0.20, recuperable: true },
  },
};

describe('montantHT', () => {
  it('taux 20% : 120 devient 100', () => {
    const tx = { amount: 120, cashflow_category: { name: 'SaaS' } };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('taux 10% : 110 devient 100', () => {
    const tx = { amount: 110, cashflow_category: { name: 'Restauration' } };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('taux 0% : montant inchange', () => {
    const tx = { amount: 42, cashflow_category: { name: 'Banque' } };
    expect(montantHT(tx, TABLE_TEST)).toBe(42);
  });

  it('TVA non recuperable : montant TTC inchange (cout reel)', () => {
    const tx = { amount: 100, cashflow_category: { name: 'Travel Expenses' } };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('categorie inconnue de la table : montant inchange (prudence, on ne devine pas)', () => {
    const tx = { amount: 100, cashflow_category: { name: 'Categorie jamais vue' } };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('priorite : taux du couple categorie/sous-categorie prime sur le taux de la categorie seule', () => {
    // Frais de personnel seul = 0%, mais le couple Frais de personnel > Remuneration dirigeants = 20%
    const tx = {
      amount: 120,
      cashflow_category: { name: 'Frais de personnel' },
      cashflow_subcategory: { name: 'Rémunération dirigeants' },
    };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('sans sous-categorie, retombe sur le taux de la categorie seule (Frais de personnel = 0%)', () => {
    const tx = { amount: 100, cashflow_category: { name: 'Frais de personnel' } };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('sous-categorie presente mais absente de parCouple : retombe sur la categorie seule', () => {
    const tx = {
      amount: 100,
      cashflow_category: { name: 'Frais de personnel' },
      cashflow_subcategory: { name: 'Salaires' }, // pas de couple dedie -> fallback categorie (0%)
    };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('correspondance insensible aux accents/casse (categorie)', () => {
    const tx = { amount: 120, cashflow_category: { name: 'remuneration dirigeants' } }; // sans accent, minuscule
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('correspondance insensible aux accents/casse (couple categorie/sous-categorie)', () => {
    const tx = {
      amount: 120,
      cashflow_category: { name: 'FRAIS DE PERSONNEL' },
      cashflow_subcategory: { name: 'remuneration dirigeants' },
    };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('accepte tx.category en repli quand cashflow_category est absent (meme forme que agregParMois)', () => {
    const tx = { amount: 120, category: 'SaaS' };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('tableTaux vide : montant inchange', () => {
    const tx = { amount: 100, cashflow_category: { name: 'SaaS' } };
    expect(montantHT(tx, { parCategorie: {}, parCouple: {} })).toBe(100);
  });

  it('tx sans categorie : montant inchange', () => {
    const tx = { amount: 100 };
    expect(montantHT(tx, TABLE_TEST)).toBe(100);
  });

  it('tx null/undefined : renvoie 0', () => {
    expect(montantHT(null, TABLE_TEST)).toBe(0);
    expect(montantHT(undefined, TABLE_TEST)).toBe(0);
  });

  it('tableTaux null/undefined : montant inchange (pas de crash)', () => {
    const tx = { amount: 100, cashflow_category: { name: 'SaaS' } };
    expect(montantHT(tx, null)).toBe(100);
    expect(montantHT(tx, undefined)).toBe(100);
  });
});

describe('buildCoupleKey', () => {
  it('normalise categorie et sous-categorie et les joint avec COUPLE_SEP', () => {
    expect(buildCoupleKey('Frais de Personnel', 'Rémunération Dirigeants'))
      .toBe(`frais de personnel${COUPLE_SEP}remuneration dirigeants`);
  });

  it('meme cle quelle que soit la casse/les accents en entree', () => {
    expect(buildCoupleKey('FRAIS DE PERSONNEL', 'remuneration dirigeants'))
      .toBe(buildCoupleKey('Frais de personnel', 'Rémunération dirigeants'));
  });
});
