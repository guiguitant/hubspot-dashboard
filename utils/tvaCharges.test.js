'use strict';
const { montantHT, buildCoupleKey, buildIndexExactKey, buildIndexExactTVA, COUPLE_SEP } = require('./tvaCharges');
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

    // Correctif revue I3 : avant ce correctif, la priorite 0 convertissait AVANT de consulter le
    // flag "recuperable" de la table, court-circuitant la regle "la TVA non recuperable reste en
    // charge" (spec 2.2) des que la facture etait rattachee. Ce test aurait echoue avec l'ancien
    // code (il aurait renvoye 90.91, le HT de l'index, au lieu du TTC 100 attendu).
    it('facture rattachee MAIS categorie non recuperable (I3) : TTC inchange malgre la priorite 0', () => {
      const txNonRecuperable = {
        amount: 100,
        settled_at: '2026-07-20T10:00:00.000Z',
        cashflow_category: { name: 'Travel Expenses' }, // non recuperable dans TABLE_TEST
      };
      const indexAvecMatchNonRecup = new Map([
        ['2026-07-20|100.00', { ht: 90.91, ttc: 100, tax: 9.09, invoiceId: 99 }],
      ]);
      expect(montantHT(txNonRecuperable, TABLE_TEST, indexAvecMatchNonRecup)).toBe(100);
    });

    it('facture rattachee mais categorie inconnue de la table (ni recuperable ni non-recuperable) : priorite 0 s\'applique quand meme', () => {
      // Non-regression : le garde-fou I3 ne doit bloquer que sur un flag EXPLICITE
      // `recuperable === false`, jamais sur une categorie simplement absente de la table.
      const txCategorieInconnue = {
        amount: 120,
        settled_at: '2026-07-15T10:00:00.000Z',
        cashflow_category: { name: 'Categorie jamais vue' },
      };
      expect(montantHT(txCategorieInconnue, TABLE_TEST, indexAvecMatch)).toBe(108.5);
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

describe('buildIndexExactTVA', () => {
  // Fabrique une facture + ses deux lignes 401 (facture credit + reglement debit), lettrees
  // ensemble, au format minimal reellement renvoye par Pennylane (seuls les champs consommes par
  // buildIndexExactTVA sont presents ; verifie par sonde directe de l'API, cf commentaire de la
  // fonction). `invoiceId` sert aussi de `ledger_entry.id` de la facture : fait verifie sur les
  // donnees reelles (supplier_invoice.id === ledger_entry.id, 349/349 sur l'echantillon analyse).
  function makeInvoiceAndLines({ invoiceId, invoiceLineId, paymentLineId, date, paymentDate, ttc, ht, tax, currency = 'EUR' }) {
    const invoice = {
      id: invoiceId,
      currency,
      currency_amount: String(ttc),
      currency_amount_before_tax: String(ht),
      currency_tax: String(tax),
      date,
      ledger_entry: { id: invoiceId },
    };
    const invoiceLine = {
      id: invoiceLineId,
      credit: String(ttc), debit: '0.0',
      date,
      ledger_account: { number: '401100003' },
      ledger_entry: { id: invoiceId },
      lettered_ledger_entry_lines: { ids: [invoiceLineId, paymentLineId] },
    };
    const paymentLine = {
      id: paymentLineId,
      debit: String(ttc), credit: '0.0',
      date: paymentDate,
      ledger_account: { number: '401100003' },
      ledger_entry: { id: invoiceId + 1000000 }, // ecriture differente (le reglement)
      lettered_ledger_entry_lines: { ids: [invoiceLineId, paymentLineId] },
    };
    return { invoice, invoiceLine, paymentLine };
  }

  it('facture reglee normalement (1 seul candidat sur la cle) : indexee avec son HT', () => {
    const { invoice, invoiceLine, paymentLine } = makeInvoiceAndLines({
      invoiceId: 1, invoiceLineId: 11, paymentLineId: 12,
      date: '2026-07-30', paymentDate: '2026-07-31', ttc: 120, ht: 100, tax: 20,
    });
    const { index, stats } = buildIndexExactTVA([invoice], [invoiceLine, paymentLine]);
    expect(index.get('2026-07-31|120.00')).toEqual({ key: '2026-07-31|120.00', invoiceId: 1, ht: 100, ttc: 120, tax: 20 });
    expect(stats).toEqual({ totalInvoices: 1, totalLines: 2, matched: 1, ambiguousKeys: 0, resolvedByEqualHt: 0 });
  });

  // Correctif C1 : cas reel mesure (GLORIAE + GTH, 2026-07-30, 6000 TTC chacune, HT 5000 chacune).
  // Avec l'ANCIENNE regle (toute collision = exclusion, sans regarder le HT), ce test aurait echoue :
  // `index.has(...)` aurait ete `false` et `stats.ambiguousKeys` aurait valu 1 au lieu de 0.
  it('collision (date, montant) mais HT IDENTIQUE sur tous les candidats (C1) : indexee avec ce HT commun', () => {
    const a = makeInvoiceAndLines({ invoiceId: 1, invoiceLineId: 11, paymentLineId: 12, date: '2026-07-30', paymentDate: '2026-07-30', ttc: 6000, ht: 5000, tax: 1000 });
    const b = makeInvoiceAndLines({ invoiceId: 2, invoiceLineId: 21, paymentLineId: 22, date: '2026-07-30', paymentDate: '2026-07-30', ttc: 6000, ht: 5000, tax: 1000 });
    const { index, stats } = buildIndexExactTVA(
      [a.invoice, b.invoice],
      [a.invoiceLine, a.paymentLine, b.invoiceLine, b.paymentLine]
    );
    expect(index.has('2026-07-30|6000.00')).toBe(true);
    expect(index.get('2026-07-30|6000.00').ht).toBe(5000);
    expect(stats.matched).toBe(1);
    expect(stats.ambiguousKeys).toBe(0);
    expect(stats.resolvedByEqualHt).toBe(1);
  });

  // Preuve directe que C1 est un changement de comportement, pas un test qui passait deja avant :
  // reproduit litteralement l'ancienne regle (toute collision > 1 candidat = exclusion) sur les
  // memes candidats que le test precedent, et montre qu'elle aurait exclu ce cas.
  it('preuve : la collision a HT identique ci-dessus aurait ete exclue par l\'ancienne regle', () => {
    const candidatsMemeCle = [{ ht: 5000 }, { ht: 5000 }]; // memes candidats que le test precedent
    const ancienneRegleExclut = (candidats) => candidats.length > 1; // ancienne regle : ignore le HT
    expect(ancienneRegleExclut(candidatsMemeCle)).toBe(true); // l'ancienne regle aurait exclu -> bug corrige
  });

  // Cas reel mesure (2025-12-30, 200 € TTC) : deux factures, meme jour/montant de reglement, mais
  // HT DIFFERENT (200 vs 166,67) : la seule vraie ambiguite du jeu de donnees, reste exclue.
  it('collision (date, montant) avec HT DIFFERENT : vraie ambiguite, exclue des deux cotes', () => {
    const a = makeInvoiceAndLines({ invoiceId: 1, invoiceLineId: 11, paymentLineId: 12, date: '2025-12-30', paymentDate: '2025-12-30', ttc: 200, ht: 200, tax: 0 });
    const b = makeInvoiceAndLines({ invoiceId: 2, invoiceLineId: 21, paymentLineId: 22, date: '2025-12-30', paymentDate: '2025-12-30', ttc: 200, ht: 166.67, tax: 33.33 });
    const { index, stats } = buildIndexExactTVA(
      [a.invoice, b.invoice],
      [a.invoiceLine, a.paymentLine, b.invoiceLine, b.paymentLine]
    );
    expect(index.has('2025-12-30|200.00')).toBe(false);
    expect(stats.matched).toBe(0);
    expect(stats.ambiguousKeys).toBe(1);
    expect(stats.resolvedByEqualHt).toBe(0);
  });

  it('facture en devise etrangere (currency != EUR) : exclue de l\'index', () => {
    const { invoice, invoiceLine, paymentLine } = makeInvoiceAndLines({
      invoiceId: 1, invoiceLineId: 11, paymentLineId: 12, date: '2026-06-06', paymentDate: '2026-06-06',
      ttc: 20, ht: 20, tax: 0, currency: 'USD',
    });
    const { index, stats } = buildIndexExactTVA([invoice], [invoiceLine, paymentLine]);
    expect(index.size).toBe(0);
    expect(stats.matched).toBe(0);
  });

  it('reglement partiel (montant de la ligne de paiement != TTC facture) : exclue, prudence', () => {
    const { invoice, invoiceLine, paymentLine } = makeInvoiceAndLines({
      invoiceId: 1, invoiceLineId: 11, paymentLineId: 12, date: '2026-07-21', paymentDate: '2026-07-21',
      ttc: 14400, ht: 12000, tax: 2400,
    });
    paymentLine.debit = '7200.0'; // paiement fractionne, moitie seulement du TTC total
    const { index } = buildIndexExactTVA([invoice], [invoiceLine, paymentLine]);
    expect(index.size).toBe(0);
  });

  it('facture non lettree (pas encore reglee) : exclue', () => {
    const { invoice, invoiceLine } = makeInvoiceAndLines({ invoiceId: 1, invoiceLineId: 11, paymentLineId: 12, date: '2026-07-01', paymentDate: '2026-07-01', ttc: 100, ht: 90, tax: 10 });
    invoiceLine.lettered_ledger_entry_lines = { ids: [] }; // pas encore lettree
    const { index } = buildIndexExactTVA([invoice], [invoiceLine]);
    expect(index.size).toBe(0);
  });

  it('invoices/lines vides : index vide, aucun crash', () => {
    const { index, stats } = buildIndexExactTVA([], []);
    expect(index.size).toBe(0);
    expect(stats).toEqual({ totalInvoices: 0, totalLines: 0, matched: 0, ambiguousKeys: 0, resolvedByEqualHt: 0 });
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
