'use strict';
const { colToLetter, parseMonthHeader, discoverLayout, assertPartners, buildUpdates, roundPreservingSum, primesFloorKey } = require('./primesSheetMap');

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

  it('roundPreservingSum : arrondit les cellules en preservant le total', () => {
    const r = roundPreservingSum({ a: 3194.4, b: 1656.3, c: 281.3 });
    expect(Object.values(r).reduce((s, v) => s + v, 0)).toBe(5132); // total round(5132.0)
    expect(r.a).toBe(3195); // le plus grand reste (.4) recoit l'unite
  });

  it('primesFloorKey : renvoie le debut de l\'exercice de nowIso, jamais le mois courant', () => {
    // Execution en cours d'annee (octobre, T4) : le plancher doit rester janvier, pas octobre.
    expect(primesFloorKey('2026-10-15T08:00:00.000Z')).toBe('2026-01');
    // Execution en debut d'annee suivante : le plancher bascule avec l'annee.
    expect(primesFloorKey('2027-01-03T08:00:00.000Z')).toBe('2027-01');
    // Cas limite : dernier jour de l'exercice, toujours '2026-01' (heure de midi UTC pour eviter tout
    // effet de fuseau horaire local pres de minuit sur getFullYear()).
    expect(primesFloorKey('2026-12-31T12:00:00.000Z')).toBe('2026-01');
  });

  it('buildUpdates : floorKey = debut d\'exercice, tous les mois de l\'exercice courant reecrits (valeur ou 0), exercices anterieurs figes', () => {
    const L = discoverLayout(grid(), { partnerNames: ['Vincent', 'Guillaume', 'Nathan'] });
    const byPM = { Vincent: { '2026-04': 3500 } };
    // floorKey = '2026-01' (debut d'exercice) : tous les mois 2026 de la grille sont reecrits, meme
    // 01/2026, 02/2026, 03/2026 qui sont "passes" par rapport au mois courant simule (avril).
    const { updates } = buildUpdates(L, byPM, 'Masse_salariale', '2026-01');
    // Vincent : 04/2026 (colonne J=index9) -> 3500 (valeur presente)
    const vincent04 = updates.find(u => u.range === 'Masse_salariale!J7');
    expect(vincent04.value).toBe(3500);
    // Vincent : 01, 02, 03/2026 -> 0 (pas de charge pour ces mois dans byPM, mais reecrits quand meme,
    // car ils appartiennent a l'exercice courant)
    const vincent01 = updates.find(u => u.range === 'Masse_salariale!D7');
    expect(vincent01.value).toBe(0);
    const vincent03 = updates.find(u => u.range === 'Masse_salariale!H7');
    expect(vincent03.value).toBe(0);
  });

  it('buildUpdates + primesFloorKey : regression C1 (double compte au changement de trimestre) - garde-fou reel, echoue si le plancher redevient le mois courant', () => {
    const L = discoverLayout(grid(), { partnerNames: ['Vincent', 'Guillaume', 'Nathan'] });
    // Simule le glissement du plancher de charge (floorChargeKey) d'un trimestre a l'autre : la charge
    // de Vincent, ecrite en 03/2026 au trimestre precedent (18000), a migre en 04/2026 (18000).
    // byPartnerMonth ne contient PLUS 03/2026 : la cellule doit etre remise a 0 pour eviter le double
    // compte dans CR_Prev (formule qui somme les colonnes mensuelles).
    const nowIso = '2026-04-15T09:00:00.000Z'; // execution du cron en avril (2e mois du trimestre 2)
    const byPM = { Vincent: { '2026-04': 18000 } };
    const col03 = 'Masse_salariale!H7'; // 03/2026, ligne Vincent sous .Primes

    // Floor REEL calcule par la fonction de production (celle appelee par server.js). Si quelqu'un
    // remet primesFloorKey a "renvoyer le mois courant" au lieu du debut d'exercice, cette assertion
    // echoue en premier (fixedFloor vaudrait '2026-04' au lieu de '2026-01').
    const fixedFloor = primesFloorKey(nowIso);
    expect(fixedFloor).toBe('2026-01');
    const fixed = buildUpdates(L, byPM, 'Masse_salariale', fixedFloor);
    const fixedCell = fixed.updates.find(u => u.range === col03);
    // Garde-fou : si fixedFloor redevenait le mois courant ('2026-04'), 03/2026 serait fige (mk <
    // floorKey) et fixedCell serait undefined -> ce test echouerait ici, pas seulement sur un
    // litteral recopie.
    expect(fixedCell).toBeDefined();
    expect(fixedCell.value).toBe(0); // remis a 0 : plus de charge fantome, plus de double compte

    // Comparaison explicite avec l'ANCIEN comportement (avant le correctif) : floorKey = mois courant
    // d'execution du cron, derive independamment de primesFloorKey pour representer fidelement ce que
    // syncPrimesToSheet passait a buildUpdates avant ce correctif.
    const buggyFloor = nowIso.slice(0, 7); // '2026-04'
    const buggy = buildUpdates(L, byPM, 'Masse_salariale', buggyFloor);
    // Symptome du bug : 03/2026 (mk < buggyFloor) est fige, jamais reecrit -> garde sa vieille valeur
    // non nulle dans le vrai Sheet (ici la grille de test demarre a 0, mais en prod la cellule aurait
    // deja contenu 18000 issus du run precedent) : charge fantome, double compte.
    expect(buggy.updates.some(u => u.range === col03)).toBe(false);
  });

  it('buildUpdates : les mois d\'un exercice anterieur restent figes (decembre N-1 protege)', () => {
    // Grille etendue avec un mois de decembre 2025 (exercice anterieur) avant les mois 2026.
    const g = [
      [],
      [],
      ['', '', 'Compte de resultat', '12/2025', '', '01/2026', '', '02/2026'],
      ['', '', '.Salaires nets', 12000, '', 12000, '', 12000],
      ['', '', 'Vincent', 0, '', 0, '', 0],
      ['', '', '.Primes', '', '', '', '', ''],
      ['', '', 'Vincent', 0, '', 0, '', 0],
      ['', '', 'Guillaume', 0, '', 0, '', 0],
      ['', '', 'Nathan', 0, '', 0, '', 0],
      ['', '', '.Charges soci. + patr.', 0, '', 0, '', 0],
    ];
    const L = discoverLayout(g, { partnerNames: ['Vincent', 'Guillaume', 'Nathan'] });
    const byPM = { Vincent: { '2025-12': 5000, '2026-01': 1000 } };
    // floorKey derive de primesFloorKey (comme dans server.js), execution simulee debut fevrier 2026 :
    // garde le non-franchissement d'exercice de bout en bout, pas seulement sur un litteral recopie.
    const nowIso = '2026-02-10T09:00:00.000Z';
    const floorKey = primesFloorKey(nowIso);
    expect(floorKey).toBe('2026-01');
    const { updates } = buildUpdates(L, byPM, 'Masse_salariale', floorKey);
    // 12/2025 (exercice anterieur, colonne D=index3) : fige, jamais dans les updates.
    expect(updates.some(u => u.range === 'Masse_salariale!D7')).toBe(false);
    // 01/2026 (exercice courant, colonne F=index5) : reecrit avec la valeur.
    const vincent01 = updates.find(u => u.range === 'Masse_salariale!F7');
    expect(vincent01.value).toBe(1000);
  });
});
