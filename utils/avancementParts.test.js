'use strict';
const {
  cumulAuPlusTard,
  ligneExacte,
  partExercice,
  pointDepartImplicite,
  cumulEffectif,
  partAffichee,
  suggestionPart,
  planSaisiePart,
} = require('./avancementParts');
const { caAvancementMission } = require('./caAvancement');

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
  test('mission jamais suivie, aucun mission fourni (retro-compat) : suggestion = 100 %', () => {
    expect(suggestionPart([], 2026)).toBe(100);
  });

  test('Alphapro groupe : 70 % fin 2025 -> suggestion 2026 = 30 % (ancre, sans mission fourni)', () => {
    expect(suggestionPart([{ exercice: 2025, pct: 70 }], 2026)).toBe(30);
  });

  test('deja a 100 % : suggestion = 0, jamais negative', () => {
    expect(suggestionPart([{ exercice: 2025, pct: 100 }], 2026)).toBe(0);
  });

  // Defaut de chiffre corrige (spec 5.1 septies, point e) : cas reel mesure, Café Méo. 18 000 EUR au
  // total, acompte 5 400 EUR facture le 24/11/2025, solde 12 600 EUR facture le 16/07/2026, AUCUNE
  // ancre 2025. Pilot a deja compte les 5 400 EUR en CA 2025 (a la date de facture, anneeAcompte 2025
  // ici puisque le volet est reellement emis). L'ancienne regle (100 % - cumul des ancres = 100 % -
  // 0 % = 100 %) aurait redonne 18 000 EUR en 2026 et recompte les 5 400 EUR une seconde fois. La
  // valeur juste est 70 %, qui redonne exactement les 12 600 EUR restants :
  // 100 % - (5 400 / 18 000 x 100) = 100 % - 30 % = 70 %.
  //
  // `anneeAcompte`/`anneeSolde` sont fournis explicitement dans ces missions de test : ce sont les
  // champs REELLEMENT lus par pctFactureAvant depuis le correctif de ronde de revue 1 (voir ce
  // fichier), calcules cote serveur par utils/avancementMissionInfo.js (missionAvancementInfo) a
  // partir des dates ET du repli "Annee final", et exposes par GET /api/avancement. Les dates brutes
  // (dateFactureAcompte/dateFactureFinale) restent presentes pour realisme (le serveur les envoie
  // aussi, avancementVoletsTexte les affiche), mais ne sont plus lues par pctFactureAvant.
  describe('cas réel Café Méo (défaut de double comptage corrigé)', () => {
    const caféMéo = {
      ca: 18000,
      montantAcompte: 5400,
      dateFactureAcompte: '2025-11-24',
      anneeAcompte: 2025,
      montantSolde: 12600,
      dateFactureFinale: '2026-07-16',
      anneeSolde: 2026,
    };

    test('aucune ancre 2025 : suggestion 2026 = 70 % (pas 100 %), redonne 12 600 EUR', () => {
      const suggestion = suggestionPart([], 2026, caféMéo);
      expect(suggestion).toBe(70);
      expect(Math.round(18000 * (suggestion / 100))).toBe(12600);
    });

    test('sans le troisieme argument (retro-compat), la regression reapparaît : suggestion = 100 %', () => {
      // Documente explicitement que le troisieme argument est necessaire pour le correctif : un
      // appelant qui omettrait `mission` retombe sur l'ancien comportement (repli 0), PAS sur une
      // erreur silencieuse. Sert de garde-fou de lisibilite pour les futurs appelants du module.
      expect(suggestionPart([], 2026)).toBe(100);
    });

    test('le volet solde 2026 (rattache a l\'exercice lui-meme, pas anterieur) n\'est jamais compte', () => {
      // Si la regle comptait par erreur TOUS les volets rattaches (pas seulement ceux strictement
      // anterieurs a l'exercice), le solde 2026 s'ajouterait et la suggestion 2026 tomberait a 0 %.
      const suggestion = suggestionPart([], 2026, caféMéo);
      expect(suggestion).not.toBe(0);
    });

    test('volet non facture ET sans repli "Année final" : jamais compte, meme s\'il porte un montant', () => {
      const missionPartielle = {
        ca: 10000, montantAcompte: 4000, dateFactureAcompte: '2025-03-01', anneeAcompte: 2025,
        montantSolde: 6000, dateFactureFinale: null, anneeSolde: null,
      };
      // Solde non facture ET sans "Annee final" connue (anneeSolde null) : ignore. Seul l'acompte 2025
      // (4 000 / 10 000 = 40 %) est retranche.
      expect(suggestionPart([], 2026, missionPartielle)).toBe(60);
    });

    // Contre-exemple de la ronde de revue 1 (defaut Important) : un volet NON facture (pas de date
    // d'emission) mais dont le champ Notion "Annee final" (repli) est deja passe DOIT compter, car
    // c'est exactement ce que fait deja Pilot pour le CA "hors avancement" d'une mission non suivie
    // (signedAmountForYear/totalCaAnnee, utils/kpiCompute.js, meme regle de rattachement). Mission
    // 20 000 EUR, acompte 8 000 EUR facture en mars 2025, solde 12 000 EUR JAMAIS facture mais
    // "Annee final" = 2025, aucune ancre : Pilot a deja compte les 20 000 EUR en CA 2025 (repli
    // compris). La suggestion 2026 doit donc valoir 0 %, pas 60 % (ce que donnerait, a tort, une
    // regle qui ignore le repli et ne voit que l'acompte facture).
    test('volet non facture MAIS "Année final" (repli) antérieure à l\'exercice : compté quand même', () => {
      const missionFAE = {
        ca: 20000, montantAcompte: 8000, dateFactureAcompte: '2025-03-01', anneeAcompte: 2025,
        montantSolde: 12000, dateFactureFinale: null, anneeSolde: 2025, // repli "Année final" = 2025
      };
      expect(suggestionPart([], 2026, missionFAE)).toBe(0);
    });
  });

  // Cas d'une mission ANCREE (spec 5.1 septies, point e) : l'ancre prime TOUJOURS sur les volets,
  // meme quand les volets fournis donneraient un resultat different. Volets construits ici pour
  // suggérer (a tort) un repli de 10 % si l'ancre n'était pas prioritaire ; le test verifie que le
  // resultat reste bien celui de l'ancre (30 %), preuve que le repli sur les volets n'est jamais
  // consulté des qu'une ancre existe.
  test('mission ancrée : l\'ancre prime sur des volets contradictoires', () => {
    const missionAncreeAvecVoletsContradictoires = {
      ca: 15500,
      montantAcompte: 1550, // 10 % du CA, rattache a 2025 : donnerait 90 % de suggestion sans l'ancre
      dateFactureAcompte: '2025-06-01',
      anneeAcompte: 2025,
      montantSolde: 13950,
      dateFactureFinale: '2026-05-01',
      anneeSolde: 2026,
    };
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }];
    expect(suggestionPart(lignes, 2026, missionAncreeAvecVoletsContradictoires)).toBe(30);
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

// Spec 5.1 octies point a : le point de depart deduit de la facturation doit etre AFFICHE et compte
// dans le reste/les suggestions, quand aucune ancre n'existe sur l'exercice qui precede la toute
// premiere ligne suivie d'une mission. Cas exact remonte par Nathan, verifie sur les donnees reelles :
// Café Méo, 18 000 EUR au total, acompte 5 400 EUR facture le 24/11/2025, solde 12 600 EUR facture le
// 16/07/2026, AUCUNE ancre 2025 (exercice fige). Nathan saisit 70 % pour 2026 : la ligne stockee
// devient { exercice: 2026, pct: 70 } (cumulAuPlusTard(2025) = 0, donc cumul ecrit = 0 + 70 = 70).
const caféMéoMission = {
  ca: 18000,
  montantAcompte: 5400,
  dateFactureAcompte: '2025-11-24',
  anneeAcompte: 2025,
  montantSolde: 12600,
  dateFactureFinale: '2026-07-16',
  anneeSolde: 2026,
};
const caféMéoLignesApres2026 = [{ exercice: 2026, pct: 70 }];

describe('pointDepartImplicite : combler le trou quand la premiere ligne saute EXERCICE_ANCRE', () => {
  test('aucune ligne du tout : 0 (rien a corriger tant que le suivi n\'a pas commence)', () => {
    expect(pointDepartImplicite([], caféMéoMission)).toBe(0);
    expect(pointDepartImplicite(null, caféMéoMission)).toBe(0);
  });

  test('Café Méo apres saisie 2026 : 30 % (5 400 / 18 000 deja factures avant 2026, sans ancre)', () => {
    expect(pointDepartImplicite(caféMéoLignesApres2026, caféMéoMission)).toBe(30);
  });

  // CORRECTIF (revue ronde 1, point Important) : la fixture precedente de ce test ("Alphapro groupe",
  // acompte de 2025, annee EGALE a l'exercice de l'ancre) ne facturait rien AVANT 2025 : la fonction
  // rendait 0 meme sans la garde `premiere <= EXERCICE_ANCRE`, puisque pctFactureAvant elle-meme
  // n'aurait rien trouve a additionner (anneeAcompte(2025) < exercice(2025) est FAUX). Le relecteur a
  // mute la garde en `if (false) return 0;` et les 47 tests sont restes verts : ce test-la ne
  // l'exercait pas reellement. Preuve par mutation consignee dans le rapport de tache.
  //
  // Nouvelle fixture, qui EXERCE reellement la garde : une mission ancree a 70 % en 2025, avec un
  // ACOMPTE FACTURE EN 2024 (strictement AVANT l'ancre). Sans la garde, pointDepartImplicite
  // calculerait pctFactureAvant(mission, premiere=2025) = 3 100 / 15 500 x 100 = 20 %, et
  // cumulEffectif(2025) passerait de 70 % (l'ancre, deja la verite complete validee par le cabinet) a
  // 90 % : un double comptage sur le point le plus delicat de la fonctionnalite. Avec la garde, le
  // resultat doit rester 0.
  test('premiere ligne DES EXERCICE_ANCRE (2025), MEME avec un volet facture avant elle (2024) : 0, l\'ancre est deja la verite complete (pas de double emploi)', () => {
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }];
    const missionAvecFacturationAvantAncre = { ca: 15500, montantAcompte: 3100, anneeAcompte: 2024, montantSolde: 12400, anneeSolde: 2025 };
    expect(pointDepartImplicite(lignes, missionAvecFacturationAvantAncre)).toBe(0);
  });

  test('premiere ligne apres EXERCICE_ANCRE mais rien facture avant : 0 (pas de bruit)', () => {
    const lignes = [{ exercice: 2026, pct: 40 }];
    const missionSansFacturationAvant2026 = { ca: 10000, montantAcompte: 0, anneeAcompte: null, montantSolde: 10000, anneeSolde: 2026 };
    expect(pointDepartImplicite(lignes, missionSansFacturationAvant2026)).toBe(0);
  });

  // Correctif Minor (revue ronde 1) : avec une donnee Notion incoherente en amont (acompte saisi
  // superieur au prix total de la mission), pctFactureAvant peut depasser 100. Sans plafond, la
  // cellule "exercice precedent" afficherait "150 % (deduit)", absurde a l'ecran, meme si le reste et
  // les suggestions restaient corrects (deja proteges par leur propre Math.max(0, ...)/`reste > 0`).
  test('donnee incoherente (acompte superieur au prix total) : plafonne a 100 %, jamais "150 %"', () => {
    const lignes = [{ exercice: 2026, pct: 40 }];
    const missionAcompteIncoherent = { ca: 10000, montantAcompte: 15000, anneeAcompte: 2025, montantSolde: 0, anneeSolde: null };
    expect(pointDepartImplicite(lignes, missionAcompteIncoherent)).toBe(100);
  });
});

describe('cumulEffectif : cumulAuPlusTard + pointDepartImplicite, applique a TOUT exercice suivant', () => {
  test('Café Méo : 30 % en 2025, 100 % en 2026 (30 implicite + 70 stocke), 100 % en 2027 (report)', () => {
    expect(cumulEffectif(caféMéoLignesApres2026, 2025, caféMéoMission)).toBe(30);
    expect(cumulEffectif(caféMéoLignesApres2026, 2026, caféMéoMission)).toBe(100);
    expect(cumulEffectif(caféMéoLignesApres2026, 2027, caféMéoMission)).toBe(100);
  });

  test('mission ancree normalement (Alphapro) : identique a cumulAuPlusTard, aucune regression', () => {
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }, { exercice: 2026, pct: 100 }];
    expect(cumulEffectif(lignes, 2025, undefined)).toBe(cumulAuPlusTard(lignes, 2025));
    expect(cumulEffectif(lignes, 2026, undefined)).toBe(cumulAuPlusTard(lignes, 2026));
  });

  // Meme scenario que la garde ci-dessus, vu depuis cumulEffectif (celui reellement consomme par la
  // grille et par suggestionPart) : sans la garde, ce test attendrait 90 (double comptage) ; avec elle,
  // le cumul effectif de 2025 reste exactement l'ancre (70), jamais majore par de la facturation
  // anterieure a l'ancre.
  test('mission ancree AVEC facturation avant l\'ancre : cumul effectif 2025 reste 70 (pas 90, pas de double emploi)', () => {
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }];
    const missionAvecFacturationAvantAncre = { ca: 15500, montantAcompte: 3100, anneeAcompte: 2024, montantSolde: 12400, anneeSolde: 2025 };
    expect(cumulEffectif(lignes, 2025, missionAvecFacturationAvantAncre)).toBe(70);
  });
});

describe('partAffichee : valeur pour la colonne "exercice precedent" de la grille', () => {
  test('Café Méo : 2025 affiche 30 %, marque implicite (deduit de la facturation, pas saisi)', () => {
    expect(partAffichee(caféMéoLignesApres2026, 2025, caféMéoMission)).toEqual({ part: 30, implicite: true });
  });

  test('une vraie ancre existe pour cet exercice : sa vraie part, jamais marquee implicite', () => {
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }];
    expect(partAffichee(lignes, 2025, caféMéoMission)).toEqual({ part: 70, implicite: false });
  });

  test('mission jamais suivie (aucune ligne) : rien a afficher, comportement inchange', () => {
    expect(partAffichee([], 2025, caféMéoMission)).toEqual({ part: null, implicite: false });
  });

  test('exercice demande different du "trou" (premiere - 1) : rien a afficher', () => {
    // La premiere ligne de Café Méo est 2026, le trou est donc exactement 2025 ; interroger un autre
    // exercice (2024, jamais affiche par la grille) ne doit rien inventer.
    expect(partAffichee(caféMéoLignesApres2026, 2024, caféMéoMission)).toEqual({ part: null, implicite: false });
  });

  test('rien de facture avant la premiere ligne : rien a afficher (pas de "0 %" parasite)', () => {
    const lignes = [{ exercice: 2026, pct: 40 }];
    const missionSansFacturationAvant2026 = { ca: 10000, montantAcompte: 0, anneeAcompte: null, montantSolde: 10000, anneeSolde: 2026 };
    expect(partAffichee(lignes, 2025, missionSansFacturationAvant2026)).toEqual({ part: null, implicite: false });
  });
});

describe('suggestionPart : defaut de cohorence corrige (spec 5.1 octies point a)', () => {
  test('Café Méo, apres saisie 70 % pour 2026 : suggestion 2027 = 0 % (et non 30 %)', () => {
    // Avant correctif : aAncreAvant=true (une ligne 2026 < 2027 existe), pointDepart =
    // cumulAuPlusTard(2026) = 70 (brut, sans le point de depart implicite), reste = 30 -- FAUX, la
    // mission est facturee a 100 % fin 2026 (5 400 + 12 600 = 18 000), il ne reste rien a realiser.
    expect(suggestionPart(caféMéoLignesApres2026, 2027, caféMéoMission)).toBe(0);
  });

  test('Alphapro groupe (ancre normale) : suggestion 2026 = 30 %, toujours inchangee', () => {
    const lignes = [{ exercice: 2025, pct: 70, fige_le: '2026-01-05T00:00:00Z' }];
    expect(suggestionPart(lignes, 2026)).toBe(30);
  });
});

// Simulation ecrite complete du cas Café Méo (rapport de tache) : les cinq valeurs attendues par la
// spec, obtenues via les fonctions publiques de ce module, plus le verrou sur le CA 2026 (module
// utils/caAvancement.js, NON MODIFIE par ce correctif : contrainte absolue de la spec).
describe('Café Méo : simulation complete des cinq valeurs attendues (5.1 octies point a)', () => {
  const lignes = caféMéoLignesApres2026; // { exercice: 2026, pct: 70 }, tel qu'ecrit par planSaisiePart

  test('1. Part 2025 (implicite, deduite de la facturation) = 30 %', () => {
    expect(partAffichee(lignes, 2025, caféMéoMission)).toEqual({ part: 30, implicite: true });
  });

  test('2. Part 2026 (saisie, stockage inchange) = 70 %', () => {
    expect(partExercice(lignes, 2026)).toBe(70);
  });

  test('3. Suggestion 2027 = 0 %', () => {
    expect(suggestionPart(lignes, 2027, caféMéoMission)).toBe(0);
  });

  test('4. Reste apres 2027 = 0 % (colonne "Reste apres N+1" de la grille)', () => {
    const reste = Math.max(0, 100 - cumulEffectif(lignes, 2027, caféMéoMission));
    expect(reste).toBe(0);
  });

  test('5. Les parts de la ligne se lisent en faisant 100 % (30 + 70 + 0)', () => {
    const part2025 = partAffichee(lignes, 2025, caféMéoMission).part;
    const part2026 = partExercice(lignes, 2026);
    const suggestion2027 = suggestionPart(lignes, 2027, caféMéoMission);
    expect(part2025 + part2026 + suggestion2027).toBe(100);
  });

  // Verrou (contrainte absolue de la spec) : le CA 2026 a l'avancement de Café Méo reste 12 600 EUR
  // apres ce correctif purement d'affichage. Utilise directement caAvancementMission de
  // utils/caAvancement.js (module NON TOUCHE par ce lot), avec les MEMES lignes stockees (pct=70 pour
  // 2026, cumul brut inchange) : si ce test echoue, la regression a touche le calcul du CA, ce qui est
  // exactement ce que la spec interdit.
  test('verrou : le CA 2026 a l\'avancement (caAvancementMission, module intouche) reste 12 600 EUR', () => {
    expect(caAvancementMission(caféMéoMission, lignes, 2026)).toBe(12600);
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
