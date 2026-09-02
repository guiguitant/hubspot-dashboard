'use strict';
const {
  cumulAuPlusTard,
  ligneExacte,
  partExercice,
  suggestionPart,
  planSaisiePart,
} = require('./avancementParts');

describe('cumulAuPlusTard : alias de pctFin (report en avant)', () => {
  test('aucune ligne : 0', () => {
    expect(cumulAuPlusTard([], 2026)).toBe(0);
    expect(cumulAuPlusTard(null, 2026)).toBe(0);
  });

  test('report en avant multi-annees', () => {
    const lignes = [{ exercice: 2025, pct: 70 }];
    expect(cumulAuPlusTard(lignes, 2026)).toBe(70);
    expect(cumulAuPlusTard(lignes, 2027)).toBe(70);
  });
});

describe('ligneExacte', () => {
  test('trouve la ligne du bon exercice, ignore les autres', () => {
    const lignes = [{ exercice: 2025, pct: 70 }, { exercice: 2026, pct: 100 }];
    expect(ligneExacte(lignes, 2026)).toEqual({ exercice: 2026, pct: 100 });
  });

  test('null si aucune ligne pour cet exercice precis (pas de report en avant)', () => {
    const lignes = [{ exercice: 2025, pct: 70 }];
    expect(ligneExacte(lignes, 2026)).toBeNull();
  });
});

describe('partExercice : cumul(E) - cumul(E-1)', () => {
  test('null si rien de saisi pour cet exercice', () => {
    expect(partExercice([{ exercice: 2025, pct: 70 }], 2026)).toBeNull();
  });

  test('Alphapro groupe : 70 % fin 2025, 100 % fin 2026 -> part 2026 = 30 %', () => {
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }, { exercice: 2026, pct: 100 }];
    expect(partExercice(lignes, 2026)).toBe(30);
    expect(partExercice(lignes, 2025)).toBe(70); // anchor : cumul(2024) = 0
  });

  test('Wienerberger : cumul 50 % en 2026, 100 % en 2027 -> parts 50 % / 50 %', () => {
    const lignes = [{ exercice: 2026, pct: 50 }, { exercice: 2027, pct: 100 }];
    expect(partExercice(lignes, 2026)).toBe(50);
    expect(partExercice(lignes, 2027)).toBe(50);
  });

  test('revision a la baisse : part negative acceptee', () => {
    const lignes = [{ exercice: 2026, pct: 70 }, { exercice: 2027, pct: 60 }];
    expect(partExercice(lignes, 2027)).toBe(-10);
  });
});

describe('suggestionPart : reste theorique a realiser', () => {
  test('mission jamais suivie : suggestion = 100 %', () => {
    expect(suggestionPart([], 2026)).toBe(100);
  });

  test('Café Méo (0 % en 2026, rien avant) : suggestion 2026 = 100 %', () => {
    expect(suggestionPart([], 2026)).toBe(100);
  });

  test('Alphapro groupe : 70 % fin 2025 -> suggestion 2026 = 30 %', () => {
    expect(suggestionPart([{ exercice: 2025, pct: 70 }], 2026)).toBe(30);
  });

  test('deja a 100 % : suggestion = 0, jamais negative', () => {
    expect(suggestionPart([{ exercice: 2025, pct: 100 }], 2026)).toBe(0);
  });
});

describe('planSaisiePart : cas simple, aucune cascade (exercice suivant vide)', () => {
  test('Ferme des Arches : part 2026 = 90 % depuis 10 % fin 2025 -> un seul ecriture, cumul 100', () => {
    const lignes = [{ exercice: 2025, pct: 10, fige_le: '2026-01-05T00:00:00Z' }];
    const plan = planSaisiePart(lignes, 2026, 90);
    expect(plan.ok).toBe(true);
    expect(plan.cascade).toBe(false);
    expect(plan.ecritures).toEqual([{ exercice: 2026, pctCumule: 100 }]);
  });

  test('Alphapro groupe : part 2026 = 30 % depuis 70 % fin 2025 -> cumul 2026 = 100, pas de cascade (2027 vide)', () => {
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }];
    const plan = planSaisiePart(lignes, 2026, 30);
    expect(plan.ok).toBe(true);
    expect(plan.cascade).toBe(false);
    expect(plan.ecritures).toEqual([{ exercice: 2026, pctCumule: 100 }]);
  });

  test('premiere saisie sans aucun historique : part 2026 = 50 % -> cumul 50', () => {
    const plan = planSaisiePart([], 2026, 50);
    expect(plan.ok).toBe(true);
    expect(plan.ecritures).toEqual([{ exercice: 2026, pctCumule: 50 }]);
  });

  test('part hors bornes (cumul resultant > 100) refusee sans cascade possible', () => {
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }];
    const plan = planSaisiePart(lignes, 2026, 40); // 70 + 40 = 110
    expect(plan.ok).toBe(false);
    expect(plan.message).toMatch(/110/);
    expect(plan.message).toMatch(/30 %/); // part maximale possible
  });
});

describe('planSaisiePart : le piege Wienerberger (exercice suivant deja renseigne)', () => {
  const wienerberger = () => ([
    { exercice: 2026, pct: 50 },
    { exercice: 2027, pct: 100 },
  ]);

  test('baisser la part 2026 (50 -> 40) : cascade valide, 2027 reecrit pour garder sa part de 50 %', () => {
    const plan = planSaisiePart(wienerberger(), 2026, 40);
    expect(plan.ok).toBe(true);
    expect(plan.cascade).toBe(true);
    expect(plan.ecritures).toEqual([
      { exercice: 2026, pctCumule: 40 },
      { exercice: 2027, pctCumule: 90 }, // 40 + 50 (part 2027 preservee)
    ]);
    // Invariant : apres application, partExercice(2027) doit toujours valoir 50 %.
    const nouvellesLignes = [{ exercice: 2026, pct: 40 }, { exercice: 2027, pct: 90 }];
    expect(partExercice(nouvellesLignes, 2027)).toBe(50);
  });

  test('monter la part 2026 a 60 % : cascade invalide (110 % > 100), saisie refusee EN ENTIER', () => {
    const plan = planSaisiePart(wienerberger(), 2026, 60);
    expect(plan.ok).toBe(false);
    expect(plan.ecritures).toBeUndefined();
    expect(plan.message).toMatch(/110/);
    expect(plan.message).toMatch(/2027/);
    // Message actionnable : dit explicitement que 50 % est le maximum possible pour 2026 tant que
    // 2027 n'est pas d'abord reduit (50 % de part deja engagee sur 2027).
    expect(plan.message).toMatch(/50 %/);
  });

  test('re-saisir exactement la meme part 2026 (50 -> 50) : cascade neutre, 2027 inchange', () => {
    const plan = planSaisiePart(wienerberger(), 2026, 50);
    expect(plan.ok).toBe(true);
    expect(plan.ecritures).toEqual([
      { exercice: 2026, pctCumule: 50 },
      { exercice: 2027, pctCumule: 100 },
    ]);
  });

  test('exercice suivant FIGE : aucune cascade, un seul ecriture (le serveur refuserait de toute facon)', () => {
    const lignes = [{ exercice: 2026, pct: 50 }, { exercice: 2027, pct: 100, fige_le: '2028-01-10T00:00:00Z' }];
    const plan = planSaisiePart(lignes, 2026, 60);
    expect(plan.ok).toBe(true);
    expect(plan.cascade).toBe(false);
    expect(plan.ecritures).toEqual([{ exercice: 2026, pctCumule: 60 }]);
  });
});

describe('planSaisiePart : bornes basses (cascade qui descendrait sous 0)', () => {
  test('part suivante negative deja + forte baisse -> cascade sous 0 refusee', () => {
    // Exercice suivant a deja une part negative (correction), et l'utilisateur baisse fortement N :
    // le cumul N+1 recalcule tomberait sous 0.
    const lignes = [{ exercice: 2026, pct: 30 }, { exercice: 2027, pct: 20 }]; // part 2027 = -10
    const plan = planSaisiePart(lignes, 2026, 5); // cumul 2026 -> 5, cumul 2027 -> 5 + (-10) = -5
    expect(plan.ok).toBe(false);
    expect(plan.message).toMatch(/-5/);
  });
});

describe('planSaisiePart : donnees reelles en base (simulation du rapport de tache)', () => {
  test('Wienerberger, scenario complet tel que decrit par le dirigeant', () => {
    const lignes = [{ exercice: 2026, pct: 50 }, { exercice: 2027, pct: 100 }];
    // Avant saisie : part 2026 = 50 %, part 2027 = 50 %.
    expect(partExercice(lignes, 2026)).toBe(50);
    expect(partExercice(lignes, 2027)).toBe(50);
    // L'utilisateur porte la part 2026 a 60 % : refuse, message explicite, aucune ecriture.
    const plan = planSaisiePart(lignes, 2026, 60);
    expect(plan.ok).toBe(false);
  });

  test('Alphapro groupe, scenario complet tel que decrit par le dirigeant', () => {
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }, { exercice: 2026, pct: 100 }];
    expect(partExercice(lignes, 2026)).toBe(30); // part 2026 = 30 %, CA 2026 = 15500 * 0.30 = 4650
    expect(Math.round(15500 * (partExercice(lignes, 2026) / 100))).toBe(4650);
  });
});
