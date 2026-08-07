'use strict';
const { montantHT, buildCoupleKey, buildIndexExactKey, COUPLE_SEP } = require('./tvaCharges');
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

  // --- Priorite 0 : TVA exacte via indexExact (Tache 6, hybride Pennylane + table) ---
  describe('priorite 0 : indexExact (TVA exacte facture Pennylane)', () => {
    // tx SaaS 120 TTC/20% -> la table donnerait 100 HT ; l'index exact donne une autre valeur pour
    // prouver lequel des deux chemins a ete emprunte.
    const txAvecMatch = {
      amount: 120,
      settled_at: '2026-07-15T10:00:00.000Z',
      cashflow_category: { name: 'SaaS' },
    };
    const indexAvecMatch = new Map([
      ['2026-07-15|120.00', { ht: 108.5, ttc: 120, tax: 11.5, invoiceId: 42 }],
    ]);

    it('priorite 0 gagne sur la table : renvoie le HT exact de la facture rattachee', () => {
      expect(montantHT(txAvecMatch, TABLE_TEST, indexAvecMatch)).toBe(108.5);
    });

    it('transaction absente de l\'index (cle date+montant sans correspondance) : repli sur la table', () => {
      const txSansMatch = {
        amount: 120,
        settled_at: '2026-07-16T10:00:00.000Z', // date differente -> pas de cle en commun
        cashflow_category: { name: 'SaaS' },
      };
      expect(montantHT(txSansMatch, TABLE_TEST, indexAvecMatch)).toBe(100); // repli table (20%)
    });

    it('index vide : comportement identique a la hierarchie table seule (avant la Tache 6)', () => {
      expect(montantHT(txAvecMatch, TABLE_TEST, new Map())).toBe(100); // 120 -> 100 via la table (20%)
    });

    it('index absent (3e argument omis) : comportement identique a avant la Tache 6', () => {
      expect(montantHT(txAvecMatch, TABLE_TEST)).toBe(100);
    });

    it('index fourni mais tx sans settled_at : priorite 0 ignoree, repli table (pas de crash)', () => {
      const txSansDate = { amount: 120, cashflow_category: { name: 'SaaS' } };
      expect(montantHT(txSansDate, TABLE_TEST, indexAvecMatch)).toBe(100);
    });

    it('priorite 0 s\'applique meme sans tableTaux (tableTaux null) : ne depend pas de la table', () => {
      expect(montantHT(txAvecMatch, null, indexAvecMatch)).toBe(108.5);
    });

    it('accepte un objet brut en plus d\'un Map (duck-typing)', () => {
      const indexObjet = { '2026-07-15|120.00': { ht: 108.5, ttc: 120, tax: 11.5 } };
      expect(montantHT(txAvecMatch, TABLE_TEST, indexObjet)).toBe(108.5);
    });
  });
});

describe('buildIndexExactKey', () => {
  it('construit "date|montant" a partir de settled_at et amount (montant toujours positif, 2 decimales)', () => {
    const tx = { amount: 142.5, settled_at: '2026-08-01T14:24:36.000Z' };
    expect(buildIndexExactKey(tx)).toBe('2026-08-01|142.50');
  });

  it('valeur absolue du montant (au cas ou amount serait signe)', () => {
    const tx = { amount: -34.43, settled_at: '2026-07-31T00:00:00.000Z' };
    expect(buildIndexExactKey(tx)).toBe('2026-07-31|34.43');
  });

  it('tx sans settled_at : renvoie null (pas de cle exploitable)', () => {
    expect(buildIndexExactKey({ amount: 100 })).toBeNull();
  });

  it('tx null/undefined : renvoie null', () => {
    expect(buildIndexExactKey(null)).toBeNull();
    expect(buildIndexExactKey(undefined)).toBeNull();
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
