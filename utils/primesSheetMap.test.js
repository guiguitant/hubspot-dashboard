'use strict';
const { colToLetter, parseMonthHeader, discoverLayout, assertPartners, buildUpdates } = require('./primesSheetMap');

// Grille type : 2 lignes vides en tete (gerees), en-tete mois en ligne 3 (index 2),
// colonne C (index 2) = libelles, colonnes mois espacees de 2.
function grid() {
  return [
    [],
    [],
    ['', '', 'Compte de resultat', '01/2026', '', '02/2026', '', '03/2026', '', '04/2026'],
    ['', '', '.Salaires nets', 12000, '', 12000, '', 12000, '', 12000],
    ['', '', 'Vincent', 0, '', 0, '', 0, '', 0],
    ['', '', '.Primes', '', '', '', '', '', '', ''],
    ['', '', 'Vincent', 0, '', 0, '', 0, '', 0],
    ['', '', 'Guillaume', 0, '', 0, '', 0, '', 0],
    ['', '', 'Nathan', 0, '', 0, '', 0, '', 0],
    ['', '', '.Charges soci. + patr.', 0, '', 0, '', 0, '', 0],
  ];
}

describe('primesSheetMap', () => {
  it('colToLetter', () => {
    expect(colToLetter(0)).toBe('A');
    expect(colToLetter(25)).toBe('Z');
    expect(colToLetter(26)).toBe('AA');
  });

  it('parseMonthHeader gere MM/YYYY et ISO', () => {
    expect(parseMonthHeader('04/2026')).toBe('2026-04');
    expect(parseMonthHeader('2026-04-01')).toBe('2026-04');
    expect(parseMonthHeader('Salaires')).toBeNull();
  });

  it('discoverLayout trouve en-tete, .Primes et les 3 associes malgre les lignes vides', () => {
    const L = discoverLayout(grid(), { partnerNames: ['Vincent', 'Guillaume', 'Nathan'] });
    expect(L.monthCols['2026-04']).toBe(9);
    expect(L.partnerRows.Vincent).toBe(6); // la ligne Vincent SOUS .Primes, pas celle sous .Salaires
    expect(L.partnerRows.Guillaume).toBe(7);
    expect(L.partnerRows.Nathan).toBe(8);
  });

  it('assertPartners throw si un associe manque', () => {
    const L = discoverLayout(grid(), { partnerNames: ['Vincent', 'Guillaume', 'Nathan'] });
    expect(() => assertPartners(L, ['Vincent', 'Inconnu'])).toThrow();
    expect(() => assertPartners(L, ['Vincent', 'Nathan'])).not.toThrow();
  });

  it('discoverLayout throw si .Primes absente', () => {
    const g = grid().filter(row => String(row[2]) !== '.Primes');
    expect(() => discoverLayout(g)).toThrow(/Primes/);
  });

  it('buildUpdates : mois passes figes, mois >= nowKey ecrits (valeur ou 0)', () => {
    const L = discoverLayout(grid(), { partnerNames: ['Vincent', 'Guillaume', 'Nathan'] });
    const byPM = { Vincent: { '2026-04': 3500 } };
    const { updates } = buildUpdates(L, byPM, 'Masse_salariale', '2026-03');
    // Vincent : 03/2026 (colonne H=index7) -> 0, 04/2026 (colonne J=index9) -> 3500 ; 01 et 02 figes
    const vincent04 = updates.find(u => u.range === 'Masse_salariale!J7');
    expect(vincent04.value).toBe(3500);
    const vincent03 = updates.find(u => u.range === 'Masse_salariale!H7');
    expect(vincent03.value).toBe(0);
    expect(updates.some(u => u.range === 'Masse_salariale!D7')).toBe(false); // 01/2026 fige
  });
});
