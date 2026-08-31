'use strict';
const {
  PREMIER_EXERCICE_AVANCEMENT,
  pctFin,
  caAvancementMission,
  computeAvancement,
  ajusterTotal,
  verifierInvariantAvancement,
  validerSaisieAvancement,
  exerciceFige,
  contributionsDepuisVolets,
  contributionsDepuisFonction,
} = require('./caAvancement');
// Vraie fonction de base "CA signe" (Cockpit/Analytics/KPI), utilisee en production par
// caAnneeAvecAvancement (server.js) au meme titre que contributionsDepuisVolets l'est par /api/ebe.
// La reutiliser ici (et non un mock local) reproduit fidelement le scenario de divergence des deux
// bases que la ronde de revue a demande de couvrir. utils/kpiCompute.js n'est pas modifie : on le
// lit seulement, comme server.js le fait deja.
const { signedAmountForYear } = require('./kpiCompute');

describe('pctFin : avancement au 31/12 avec report en avant', () => {
  test('aucune ligne : 0 %', () => {
    expect(pctFin([], 2026)).toBe(0);
    expect(pctFin(null, 2026)).toBe(0);
  });

  test('ligne de l exercice exact : sa valeur', () => {
    expect(pctFin([{ exercice: 2026, pct: 40 }], 2026)).toBe(40);
  });

  test('report en avant : une mission finie en 2025 reste a 100 en 2026 et 2027', () => {
    const lignes = [{ exercice: 2025, pct: 100 }];
    expect(pctFin(lignes, 2026)).toBe(100);
    expect(pctFin(lignes, 2027)).toBe(100);
  });

  test('aucune ligne anterieure ou egale : 0 (une ligne 2026 ne vaut pas pour 2025)', () => {
    expect(pctFin([{ exercice: 2026, pct: 60 }], 2025)).toBe(0);
  });

  test('plusieurs lignes : la plus recente <= exercice gagne, ordre d entree indifferent', () => {
    const lignes = [{ exercice: 2027, pct: 100 }, { exercice: 2025, pct: 30 }, { exercice: 2026, pct: 70 }];
    expect(pctFin(lignes, 2026)).toBe(70);
    expect(pctFin(lignes, 2025)).toBe(30);
    expect(pctFin(lignes, 2028)).toBe(100);
  });
});

describe('caAvancementMission : CA de l exercice = ca x (pct fin N - pct fin N-1)', () => {
  test('Groupe Elise : 90 % fin 2025, 100 % fin 2026, mission 10 000 -> 1 000 en 2026', () => {
    const m = { ca: 10000 };
    const lignes = [{ exercice: 2025, pct: 90 }, { exercice: 2026, pct: 100 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(1000);
  });

  test('Ferme des Arches : 10 % fin 2025, 100 % fin 2026, mission 10 000 -> 9 000 en 2026', () => {
    const m = { ca: 10000 };
    const lignes = [{ exercice: 2025, pct: 10 }, { exercice: 2026, pct: 100 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(9000);
  });

  test('FAE 100 % : finie en 2025, facturee en 2026 -> 0 de CA 2026 sans ligne 2026', () => {
    const m = { ca: 8000 };
    const lignes = [{ exercice: 2025, pct: 100 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(0);
  });

  test('revision a la baisse : resultat negatif accepte (correction)', () => {
    const m = { ca: 10000 };
    const lignes = [{ exercice: 2025, pct: 80 }, { exercice: 2026, pct: 60 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(-2000);
  });

  test('arrondi a l euro : le brut a une decimale non nulle', () => {
    // ca 15500, delta 29,7 % -> brut 4603,5 : sans Math.round, le test echouerait (4603.5 !== 4604).
    const m = { ca: 15500 };
    const lignes = [{ exercice: 2025, pct: 70 }, { exercice: 2026, pct: 99.7 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(4604);
  });

  test('ca absent ou non numerique : 0, jamais NaN', () => {
    expect(caAvancementMission({ ca: null }, [{ exercice: 2026, pct: 50 }], 2026)).toBe(0);
    expect(caAvancementMission({}, [{ exercice: 2026, pct: 50 }], 2026)).toBe(0);
  });
});

describe('computeAvancement : selection des missions suivies', () => {
  const missions = [
    { id: 'm1', nom: 'Groupe Elise', ca: 10000, etat: 'En cours' },
    { id: 'm2', nom: 'Ferme des Arches', ca: 10000, etat: 'En cours' },
    { id: 'm3', nom: 'Non suivie', ca: 5000, etat: 'En cours' },
    { id: 'm4', nom: 'Annulee suivie', ca: 7000, etat: 'Annulé' },
    { id: 'm5', nom: 'Ferme des Arches terminee', ca: 10000, etat: 'En cours' },
  ];
  const lignes = [
    { mission_id: 'm1', exercice: 2025, pct: 90 },
    { mission_id: 'm1', exercice: 2026, pct: 100 },
    { mission_id: 'm2', exercice: 2025, pct: 10 },
    { mission_id: 'm4', exercice: 2025, pct: 50 },
    { mission_id: 'm4', exercice: 2026, pct: 100 },
    { mission_id: 'm5', exercice: 2025, pct: 10 },
    { mission_id: 'm5', exercice: 2026, pct: 100 },
  ];

  test('lignes null ou vides : inactif, aucune mission suivie', () => {
    expect(computeAvancement(missions, null, 2026).actif).toBe(false);
    expect(computeAvancement(missions, [], 2026).actif).toBe(false);
    expect(computeAvancement(missions, [], 2026).suivies).toEqual([]);
  });

  test('exercice anterieur a 2026 : jamais actif', () => {
    const r = computeAvancement(missions, lignes, 2025);
    expect(r.actif).toBe(false);
    expect(r.parMission.size).toBe(0);
  });

  test('exercice 2026 : les missions suivies non annulees sont remplacees', () => {
    const r = computeAvancement(missions, lignes, 2026);
    expect(r.actif).toBe(true);
    expect(r.parMission.get('m1')).toBe(1000);
    expect(r.parMission.get('m2')).toBe(0); // 10 % en 2025, aucune ligne 2026 : le report en avant donne un delta nul
    expect(r.parMission.get('m5')).toBe(9000);
    expect(r.parMission.has('m3')).toBe(false); // non suivie
  });

  test('mission annulee : jamais suivie, meme avec des lignes', () => {
    const r = computeAvancement(missions, lignes, 2026);
    expect(r.parMission.has('m4')).toBe(false);
    expect(r.suivies.find(s => s.missionId === 'm4')).toBeUndefined();
  });

  test('suivies porte le detail lisible par le front', () => {
    const r = computeAvancement(missions, lignes, 2026);
    const s = r.suivies.find(x => x.missionId === 'm1');
    expect(s).toEqual({ missionId: 'm1', nom: 'Groupe Elise', ca: 10000, pctPrecedent: 90, pctCourant: 100, caAvancement: 1000 });
  });

  test('une ligne dont le mission_id est inconnu des missions est ignoree', () => {
    const r = computeAvancement(missions, [{ mission_id: 'fantome', exercice: 2026, pct: 50 }], 2026);
    expect(r.actif).toBe(false);
    expect(r.suivies).toEqual([]);
    expect(r.parMission.size).toBe(0);
  });

  test('PREMIER_EXERCICE_AVANCEMENT vaut 2026', () => {
    expect(PREMIER_EXERCICE_AVANCEMENT).toBe(2026);
  });
});

describe('ajusterTotal : remplacement de la contribution des missions suivies', () => {
  test('remplace la base mission par mission', () => {
    const contributions = new Map([['m1', 5000], ['m2', 0]]);
    const parMission = new Map([['m1', 1000], ['m2', 9000]]);
    // base 100 000 dont 5 000 de m1 et 0 de m2 -> 100 000 - 5 000 - 0 + 1 000 + 9 000
    expect(ajusterTotal(100000, contributions, parMission)).toBe(105000);
  });

  test('une mission suivie absente de la base compte pour 0 en retrait', () => {
    const contributions = new Map();
    const parMission = new Map([['m1', 1000]]);
    expect(ajusterTotal(100000, contributions, parMission)).toBe(101000);
  });

  test('parMission vide : base inchangee', () => {
    expect(ajusterTotal(100000, new Map([['m1', 5000]]), new Map())).toBe(100000);
  });
});

describe('verifierInvariantAvancement : l avancement deplace du CA, il n en cree pas', () => {
  test('mission terminee a 100 % : somme des exercices = ca', () => {
    const missions = [{ id: 'm1', nom: 'Groupe Elise', ca: 10000, etat: 'En cours' }];
    const lignes = [{ mission_id: 'm1', exercice: 2025, pct: 90 }, { mission_id: 'm1', exercice: 2026, pct: 100 }];
    expect(verifierInvariantAvancement(missions, lignes)).toEqual([]);
  });

  test('mission non terminee : pas d anomalie (l invariant ne vaut qu a 100 %)', () => {
    const missions = [{ id: 'm1', nom: 'En cours', ca: 10000, etat: 'En cours' }];
    const lignes = [{ mission_id: 'm1', exercice: 2026, pct: 40 }];
    expect(verifierInvariantAvancement(missions, lignes)).toEqual([]);
  });

  // L'invariant telescope : somme = ca x (pct final - 0) / 100. Il ne peut donc echouer que par
  // derive d'ARRONDI (chaque exercice est arrondi a l'euro separement). Ce cas est artificiel a
  // dessein : il prouve que la branche d'anomalie fonctionne, et il verrouille la formule (si
  // quelqu'un change la base de calcul de caAvancementMission, l'invariant tombe).
  test('anomalie quand la derive d arrondi cumulee depasse la tolerance de 1 EUR', () => {
    const missions = [{ id: 'm1', nom: 'Derive d arrondi', ca: 1000, etat: 'En cours' }];
    const lignes = [
      { mission_id: 'm1', exercice: 2021, pct: 0.06 },
      { mission_id: 'm1', exercice: 2022, pct: 0.12 },
      { mission_id: 'm1', exercice: 2023, pct: 0.18 },
      { mission_id: 'm1', exercice: 2024, pct: 0.24 },
      { mission_id: 'm1', exercice: 2025, pct: 0.30 },
      { mission_id: 'm1', exercice: 2026, pct: 100 },
    ];
    // 5 exercices a +0,06 % = 0,60 EUR chacun, arrondis a 1 EUR : +2 EUR de derive.
    // Dernier exercice : 99,70 % = 997 EUR. Somme 1 002 contre 1 000 attendus.
    const anomalies = verifierInvariantAvancement(missions, lignes);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].missionId).toBe('m1');
    expect(anomalies[0].nom).toBe('Derive d arrondi');
    expect(anomalies[0].attendu).toBe(1000);
    expect(anomalies[0].obtenu).toBe(1002);
    expect(anomalies[0].ecart).toBe(2);
  });
});

describe('validerSaisieAvancement : gardes de saisie', () => {
  const ANNEE = 2026;

  test('saisie valide', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 40 }, ANNEE)).toEqual({ ok: true });
  });

  test('missionId manquant', () => {
    const r = validerSaisieAvancement({ exercice: 2026, pct: 40 }, ANNEE);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/mission/i);
  });

  test('pct hors bornes', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: -1 }, ANNEE).ok).toBe(false);
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 101 }, ANNEE).ok).toBe(false);
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 'quarante' }, ANNEE).ok).toBe(false);
  });

  test('pct aux bornes : accepte', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 0 }, ANNEE).ok).toBe(true);
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 100 }, ANNEE).ok).toBe(true);
  });

  test('exercice hors bornes : avant 2025 ou apres annee courante + 1', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2024, pct: 50 }, ANNEE).ok).toBe(false);
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2028, pct: 50 }, ANNEE).ok).toBe(false);
  });

  test('exercice 2025 accepte : c est l ancre du fichier cut-off', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2025, pct: 90 }, ANNEE).ok).toBe(true);
  });
});

describe('exerciceFige : un exercice est fige des qu une ligne au moins porte un fige_le', () => {
  test('aucune ligne pour cet exercice : non fige', () => {
    expect(exerciceFige([], 2026)).toBe(false);
    expect(exerciceFige([{ mission_id: 'm1', exercice: 2025, fige_le: '2026-01-01T00:00:00Z' }], 2026)).toBe(false);
  });

  test('lignes toutes non figees : non fige', () => {
    const lignes = [
      { mission_id: 'm1', exercice: 2026, fige_le: null },
      { mission_id: 'm2', exercice: 2026, fige_le: null },
    ];
    expect(exerciceFige(lignes, 2026)).toBe(false);
  });

  test('lignes toutes figees : fige', () => {
    const lignes = [
      { mission_id: 'm1', exercice: 2026, fige_le: '2026-01-01T00:00:00Z' },
      { mission_id: 'm2', exercice: 2026, fige_le: '2026-01-02T00:00:00Z' },
    ];
    expect(exerciceFige(lignes, 2026)).toBe(true);
  });

  test('melange d une ligne figee et d une non figee : fige quand meme (some, pas every)', () => {
    const lignes = [
      { mission_id: 'm1', exercice: 2026, fige_le: '2026-01-01T00:00:00Z' },
      { mission_id: 'm2', exercice: 2026, fige_le: null },
    ];
    expect(exerciceFige(lignes, 2026)).toBe(true);
  });

  test('lignes figees d un autre exercice : ne contamine pas l exercice demande', () => {
    const lignes = [{ mission_id: 'm1', exercice: 2025, fige_le: '2026-01-01T00:00:00Z' }];
    expect(exerciceFige(lignes, 2026)).toBe(false);
  });

  test('entree null, undefined ou vide : non fige', () => {
    expect(exerciceFige(null, 2026)).toBe(false);
    expect(exerciceFige(undefined, 2026)).toBe(false);
    expect(exerciceFige([], 2026)).toBe(false);
  });
});

describe('contributionsDepuisVolets : ce qu une mission apporte a la base "factures emises datees dans l annee"', () => {
  test('acompte et solde dans l annee : les deux comptent', () => {
    const m = { id: 'm1', ca: 10000, montantAcompte: 5000, dateFactureAcompte: '2026-03-01', dateFactureFinale: '2026-09-01' };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).get('m1')).toBe(10000);
  });

  test('acompte en 2025, solde en 2026 : seul le solde compte pour 2026', () => {
    const m = { id: 'm1', ca: 10000, montantAcompte: 5000, dateFactureAcompte: '2025-12-22', dateFactureFinale: '2026-02-10' };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).get('m1')).toBe(5000);
  });

  test('aucune facture emise : contribution nulle', () => {
    const m = { id: 'm1', ca: 10000, montantAcompte: 5000, dateFactureAcompte: null, dateFactureFinale: null };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).get('m1')).toBe(0);
  });

  test('mission hors de la selection : absente de la Map', () => {
    const m = { id: 'm2', ca: 10000, montantAcompte: 5000, dateFactureAcompte: '2026-03-01' };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).has('m2')).toBe(false);
  });

  test('solde negatif ou nul ignore (acompte >= ca)', () => {
    const m = { id: 'm1', ca: 5000, montantAcompte: 5000, dateFactureAcompte: '2026-03-01', dateFactureFinale: '2026-09-01' };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).get('m1')).toBe(5000);
  });
});

describe('contributionsDepuisFonction : generalisation parametree par la fonction de base (filet de securite server.js)', () => {
  test('somme ce que renvoie fnMontant pour chaque mission suivie', () => {
    const m1 = { id: 'm1', ca: 1000 };
    const m2 = { id: 'm2', ca: 2000 };
    const fnMontant = (m) => m.ca / 2;
    const res = contributionsDepuisFonction([m1, m2], new Set(['m1', 'm2']), 2026, fnMontant);
    expect(res.get('m1')).toBe(500);
    expect(res.get('m2')).toBe(1000);
  });

  test('mission hors de la selection : absente de la Map', () => {
    const m = { id: 'm2', ca: 10000 };
    expect(contributionsDepuisFonction([m], new Set(['m1']), 2026, () => 999).has('m2')).toBe(false);
  });

  // Les deux tests suivants prouvent, avec la VRAIE base signee (signedAmountForYear, celle que
  // server.js injecte reellement dans caAnneeAvecAvancement), que contributionsDepuisFonction ne
  // se comporte PAS comme contributionsDepuisVolets (base du compte de resultat). C'est exactement
  // la divergence que la ronde de revue a demande de couvrir : avant l'extraction en fonction pure,
  // rien ne detectait un echange accidentel des deux bases (les 518 tests restaient verts). Voir
  // le rapport de tache pour la preuve par mutation.
  test('mission jamais facturee mais rattachee par "Annee final" : la base signee la compte en entier, la base facturee compte zero', () => {
    const m = { id: 'm1', ca: 8000, montantAcompte: 0, dateFactureAcompte: null, dateFactureFinale: null, anneeFinal: 2026 };
    const baseSignee = contributionsDepuisFonction([m], new Set(['m1']), 2026, signedAmountForYear);
    expect(baseSignee.get('m1')).toBe(8000);
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).get('m1')).toBe(0);
  });

  test('acompte et solde a cheval sur deux exercices : la base signee ne compte que la part de l exercice demande', () => {
    const m = { id: 'm1', ca: 10000, montantAcompte: 4000, dateFactureAcompte: '2025-11-01', dateFactureFinale: '2026-05-01' };
    const base2026 = contributionsDepuisFonction([m], new Set(['m1']), 2026, signedAmountForYear);
    expect(base2026.get('m1')).toBe(6000); // solde seul : l acompte est rattache a 2025
    const base2025 = contributionsDepuisFonction([m], new Set(['m1']), 2025, signedAmountForYear);
    expect(base2025.get('m1')).toBe(4000); // acompte seul
  });
});
