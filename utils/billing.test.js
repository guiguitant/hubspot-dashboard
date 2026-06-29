'use strict';
const { computeBillingForYear, derivedStatus, normFact } = require('./billing');

describe('normFact', () => {
  test('minuscule + sans accents', () => {
    expect(normFact('Acompte Envoyé')).toBe('acompte envoye');
    expect(normFact(null)).toBe('');
  });
});

describe('derivedStatus', () => {
  test('acompte', () => {
    expect(derivedStatus('Acompte', normFact('Acompte à envoyer'))).toBe('A envoyer');
    expect(derivedStatus('Acompte', normFact('Acompte envoyé'))).toBe('Envoye');
    expect(derivedStatus('Acompte', normFact('Acompte payé'))).toBe('Paye');
  });
  test('solde', () => {
    expect(derivedStatus('Solde', normFact('Acompte envoyé'))).toBe('En attente');
    expect(derivedStatus('Solde', normFact('Solde à envoyer'))).toBe('A envoyer');
    expect(derivedStatus('Solde', normFact('Solde envoyé'))).toBe('Envoye');
    expect(derivedStatus('Solde', normFact('Solde payé'))).toBe('Paye');
  });
});

describe('computeBillingForYear', () => {
  test('facturé (daté année) + à facturer (en attente non daté)', () => {
    const missions = [
      { nom: 'A', facturation: 'Acompte envoyé', montantAcompte: 10000, montantFinal: 10000, dateFactureAcompte: '2026-03-01', dateFactureFinale: null },
      { nom: 'B', facturation: 'Acompte payé', montantAcompte: 5000, montantFinal: 7000, dateFactureAcompte: '2026-01-10', dateFactureFinale: null },
      { nom: 'C', facturation: 'Solde envoyé', montantAcompte: 0, montantFinal: 8000, dateFactureFinale: '2025-12-01' },
    ];
    expect(computeBillingForYear(missions, [], 2026)).toEqual({ facture: 15000, aFacturer: 17000, total: 32000 });
  });

  test('exclut les lignes datées d\'une autre année', () => {
    const missions = [
      { nom: 'D', facturation: 'Solde envoyé', montantFinal: 9000, dateFactureFinale: '2025-06-01' },
    ];
    expect(computeBillingForYear(missions, [], 2026)).toEqual({ facture: 0, aFacturer: 0, total: 0 });
  });

  test('ignore les montants sous le seuil (< 5)', () => {
    const missions = [
      { nom: 'E', facturation: 'Acompte à envoyer', montantAcompte: 1, montantFinal: 0 },
    ];
    expect(computeBillingForYear(missions, [], 2026)).toEqual({ facture: 0, aFacturer: 0, total: 0 });
  });

  test('override de statut force "à facturer"', () => {
    const missions = [
      { nom: 'F', facturation: 'Solde payé', montantAcompte: 0, montantFinal: 6000, dateFactureFinale: null },
    ];
    // sans override : statut "Paye", non daté → ni facturé ni à facturer
    expect(computeBillingForYear(missions, [], 2026)).toEqual({ facture: 0, aFacturer: 0, total: 0 });
    // override "A envoyer" → passe en à facturer
    expect(computeBillingForYear(missions, [{ mission: 'F', type: 'Solde', status: 'A envoyer' }], 2026))
      .toEqual({ facture: 0, aFacturer: 6000, total: 6000 });
  });
});
