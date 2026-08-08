'use strict';
const { colToLetter, parseMonthHeader, discoverLayout, assertPartners, buildUpdates, roundPreservingSum, primesFloorKey, roundEntriesPreservingSumByPartner, isPrimesGraceActive, PRIMES_GRACE_JOURS } = require('./primesSheetMap');

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
    // Execution en debut d'annee suivante, APRES la periode de grace (feature D, cf describe dedie
    // plus bas) : le plancher bascule avec l'annee. Pendant la grace (1er-20 janvier), il resterait
    // sur l'exercice precedent : voir 'primesFloorKey + isPrimesGraceActive : cloture souple (D)'.
    expect(primesFloorKey('2027-01-25T08:00:00.000Z')).toBe('2027-01');
    // Cas limite : dernier jour de l'exercice, toujours '2026-01' (heure de midi UTC pour eviter tout
    // effet de fuseau horaire local pres de minuit sur getFullYear()).
    expect(primesFloorKey('2026-12-31T12:00:00.000Z')).toBe('2026-01');
  });

  describe('primesFloorKey + isPrimesGraceActive : cloture souple des primes (feature D)', () => {
    it('PRIMES_GRACE_JOURS vaut 20 par defaut', () => {
      expect(PRIMES_GRACE_JOURS).toBe(20);
    });

    // Les 4 cas demandes par la spec (2026-08-08-produits-et-suivis-design.md §D) : 15 janvier (pendant
    // la grace) -> floor N-1 ; 21 janvier (grace expiree, 21 > 20) -> floor N ; 15 mars (hors janvier)
    // -> floor N ; 31 decembre (hors janvier) -> floor N. Heures de midi UTC (comme les tests existants
    // ci-dessus) pour eviter tout effet de fuseau horaire local sur getMonth()/getDate().
    it('15 janvier (pendant la grace) : le plancher reste sur l\'exercice N-1', () => {
      expect(isPrimesGraceActive('2027-01-15T10:00:00.000Z')).toBe(true);
      expect(primesFloorKey('2027-01-15T10:00:00.000Z')).toBe('2026-01');
    });

    it('21 janvier (grace expiree, 21 > PRIMES_GRACE_JOURS=20) : le plancher bascule sur l\'exercice N', () => {
      expect(isPrimesGraceActive('2027-01-21T10:00:00.000Z')).toBe(false);
      expect(primesFloorKey('2027-01-21T10:00:00.000Z')).toBe('2027-01');
    });

    it('15 mars (hors janvier) : jamais de grace, plancher sur l\'exercice N', () => {
      expect(isPrimesGraceActive('2027-03-15T10:00:00.000Z')).toBe(false);
      expect(primesFloorKey('2027-03-15T10:00:00.000Z')).toBe('2027-01');
    });

    it('31 decembre (hors janvier) : la grace ne joue jamais en avance sur l\'annee suivante', () => {
      expect(isPrimesGraceActive('2026-12-31T10:00:00.000Z')).toBe(false);
      expect(primesFloorKey('2026-12-31T10:00:00.000Z')).toBe('2026-01');
    });

    it('20 janvier (dernier jour INCLUS de la grace) : encore dans la grace', () => {
      expect(isPrimesGraceActive('2027-01-20T10:00:00.000Z')).toBe(true);
      expect(primesFloorKey('2027-01-20T10:00:00.000Z')).toBe('2026-01');
    });

    it('graceJours surchargeable en 2e parametre (sans dependre de process.env, meme pattern que buildPrimesSubcats)', () => {
      // Avec une grace ramenee a 5 jours, le 10 janvier n'est plus dans la fenetre.
      expect(isPrimesGraceActive('2027-01-10T10:00:00.000Z', 5)).toBe(false);
      expect(primesFloorKey('2027-01-10T10:00:00.000Z', 5)).toBe('2027-01');
      // Le 3 janvier, si.
      expect(isPrimesGraceActive('2027-01-03T10:00:00.000Z', 5)).toBe(true);
      expect(primesFloorKey('2027-01-03T10:00:00.000Z', 5)).toBe('2026-01');
    });

    it("surcharge PRIMES_GRACE_JOURS par variable d'environnement, lue au chargement du module (meme pattern que PRIMES_QONTO_SUBCATS)", () => {
      const ORIGINAL = process.env.PRIMES_GRACE_JOURS;
      try {
        jest.resetModules();
        process.env.PRIMES_GRACE_JOURS = '5';
        const reloaded = require('./primesSheetMap');
        expect(reloaded.PRIMES_GRACE_JOURS).toBe(5);
        expect(reloaded.isPrimesGraceActive('2027-01-10T10:00:00.000Z')).toBe(false);
        expect(reloaded.primesFloorKey('2027-01-10T10:00:00.000Z')).toBe('2027-01');
      } finally {
        if (ORIGINAL === undefined) delete process.env.PRIMES_GRACE_JOURS;
        else process.env.PRIMES_GRACE_JOURS = ORIGINAL;
        jest.resetModules();
      }
    });
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

  it('buildUpdates + primesFloorKey PENDANT LA GRACE (D) : decembre N-1 redevient ecrivable, jamais avant', () => {
    // Meme grille que le test precedent (12/2025 = exercice anterieur, 01-02/2026 = exercice courant),
    // mais nowIso simule le 15 janvier 2026 (dans la fenetre de grace, 15 <= PRIMES_GRACE_JOURS=20).
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
    // Une charge T4/2025 saisie tardivement (apres le 31/12), qu'on veut encore pouvoir ecrire.
    const byPM = { Vincent: { '2025-12': 5000, '2026-01': 1000 } };
    const nowIsoGrace = '2026-01-15T09:00:00.000Z';
    const floorKeyGrace = primesFloorKey(nowIsoGrace);
    expect(floorKeyGrace).toBe('2025-01'); // plancher recule sur l'exercice N-1 pendant la grace
    const { updates: updatesGrace } = buildUpdates(L, byPM, 'Masse_salariale', floorKeyGrace);
    // 12/2025 (colonne D=index3) : ECRIT maintenant (grace active), avec la charge tardive.
    const vincent12Grace = updatesGrace.find(u => u.range === 'Masse_salariale!D7');
    expect(vincent12Grace).toBeDefined();
    expect(vincent12Grace.value).toBe(5000);

    // Le meme calcul, APRES la grace (21 janvier), redonne le comportement fige d'origine : 12/2025
    // n'est plus dans les updates, la charge tardive ne peut plus etre ecrite.
    const nowIsoApresGrace = '2026-01-21T09:00:00.000Z';
    const floorKeyApresGrace = primesFloorKey(nowIsoApresGrace);
    expect(floorKeyApresGrace).toBe('2026-01');
    const { updates: updatesApresGrace } = buildUpdates(L, byPM, 'Masse_salariale', floorKeyApresGrace);
    expect(updatesApresGrace.some(u => u.range === 'Masse_salariale!D7')).toBe(false);
  });

  it('roundEntriesPreservingSumByPartner : la somme des lignes arrondies d\'un associe = l\'arrondi de son total flottant (endpoint /api/primes/avancement, "Par deal")', () => {
    const entries = [
      { deal: 'a', partner: 'Vincent', montant: 3194.4 },
      { deal: 'b', partner: 'Vincent', montant: 1656.3 },
      { deal: 'c', partner: 'Vincent', montant: 281.3 },
      { deal: 'd', partner: 'Guillaume', montant: 999.5 },
      { deal: 'e', partner: 'Guillaume', montant: 0.5 },
    ];
    const out = roundEntriesPreservingSumByPartner(entries);
    // Ordre et longueur preserves.
    expect(out.map(e => e.deal)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Assertion centrale (I2) : somme des lignes PAR ASSOCIE == total (arrondi) de cet associe.
    const sumFor = (list, p) => list.filter(e => e.partner === p).reduce((s, e) => s + e.montant, 0);
    expect(sumFor(out, 'Vincent')).toBe(Math.round(sumFor(entries, 'Vincent'))); // round(5132.0) = 5132
    expect(sumFor(out, 'Guillaume')).toBe(Math.round(sumFor(entries, 'Guillaume'))); // round(1000.0) = 1000
    // Chaque montant est bien un entier.
    expect(out.every(e => Number.isInteger(e.montant))).toBe(true);
  });

  it('roundEntriesPreservingSumByPartner : garde-fou reel, echoue si l\'arrondi redevient ligne par ligne (Math.round independant) au lieu de par associe', () => {
    // Reproduit le bug historique documente dans server.js (Guillaume 3323 en detail vs 3322 en total) :
    // un Math.round independant par ligne peut faire diverger la somme des lignes du total attendu.
    const naiveRound = (entries) => entries.map(e => ({ ...e, montant: Math.round(e.montant) }));
    const entries = [
      { deal: 'a', partner: 'Vincent', montant: 100.5 },
      { deal: 'b', partner: 'Vincent', montant: 100.5 },
      { deal: 'c', partner: 'Vincent', montant: 100.5 },
    ]; // total flottant = 301.5 -> round = 302, mais 3x Math.round(100.5) = 3x101 = 303
    const naive = naiveRound(entries);
    const naiveSum = naive.reduce((s, e) => s + e.montant, 0);
    expect(naiveSum).not.toBe(Math.round(301.5)); // le naif diverge (303 != 302) : preuve que le cas est reel
    const fixed = roundEntriesPreservingSumByPartner(entries);
    const fixedSum = fixed.reduce((s, e) => s + e.montant, 0);
    expect(fixedSum).toBe(Math.round(301.5)); // le correctif, lui, preserve le total
  });
});
