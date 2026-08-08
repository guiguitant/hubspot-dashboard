'use strict';
const {
  montantsProches,
  periodeTrimestre,
  nomsSimilaires,
  dealMissionCandidate,
  maximumBipartiteMatching,
  orphanWonDeals,
  motsSignificatifs,
  missionsProches,
} = require('./dealsNotionCoherence');

describe('montantsProches', () => {
  it('montants identiques -> proches', () => {
    expect(montantsProches(10000, 10000)).toBe(true);
  });
  it('ecart de 1% pile -> proches (limite incluse)', () => {
    expect(montantsProches(10000, 10100)).toBe(true);
  });
  it('ecart de 1.5% -> pas proches', () => {
    expect(montantsProches(10000, 10150)).toBe(false);
  });
  it('deux montants nuls -> proches (cas degenere)', () => {
    expect(montantsProches(0, 0)).toBe(true);
  });
});

describe('periodeTrimestre', () => {
  it('janvier -> Q1', () => {
    expect(periodeTrimestre('2026-01-15')).toBe('2026-Q1');
  });
  it('avril -> Q2', () => {
    expect(periodeTrimestre('2026-04-01')).toBe('2026-Q2');
  });
  it('decembre -> Q4', () => {
    expect(periodeTrimestre('2026-12-31')).toBe('2026-Q4');
  });
  it('annees differentes -> trimestres differents meme si meme mois calendaire', () => {
    expect(periodeTrimestre('2025-01-15')).not.toBe(periodeTrimestre('2026-01-15'));
  });
  it('date absente ou invalide -> null', () => {
    expect(periodeTrimestre(null)).toBeNull();
    expect(periodeTrimestre(undefined)).toBeNull();
    expect(periodeTrimestre('pas-une-date')).toBeNull();
  });
});

describe('nomsSimilaires', () => {
  it('noms identiques apres normalisation accents/casse', () => {
    expect(nomsSimilaires({ nom: 'Somarail' }, { nom: 'somarail' })).toBe(true);
  });
  it('nom deal contient le nom mission', () => {
    expect(nomsSimilaires({ nom: 'Somarail - Bilan carbone 2026' }, { nom: 'Somarail' })).toBe(true);
  });
  it('nom deal correspond au client de la mission', () => {
    expect(nomsSimilaires({ nom: 'Éléphant Vert' }, { nom: 'Mission X', client: 'elephant vert' })).toBe(true);
  });
  it('aucune similarite -> false', () => {
    expect(nomsSimilaires({ nom: 'Somarail' }, { nom: 'Autre client', client: 'Autre' })).toBe(false);
  });
  it('nom deal vide -> jamais de match trivial', () => {
    expect(nomsSimilaires({ nom: '' }, { nom: '' })).toBe(false);
    expect(nomsSimilaires({ nom: null }, { nom: 'x', client: '' })).toBe(false);
  });
  it('M3 : nom court (< 4 caracteres normalises) ne matche jamais par containment', () => {
    // "SA" est contenu dans un nombre enorme de noms d'entreprise (Somarail SA, Alpha SA...) :
    // sans garde de longueur minimale, ca produirait des faux positifs massifs.
    expect(nomsSimilaires({ nom: 'Une Entreprise SA' }, { nom: 'SA' })).toBe(false);
    expect(nomsSimilaires({ nom: 'SA' }, { nom: 'Une Entreprise SA' })).toBe(false);
    expect(nomsSimilaires({ nom: 'CO2' }, { nom: 'Bilan CO2 complet' })).toBe(false);
    // Mais un nom de 4 caracteres pile matche toujours (limite non exclue).
    expect(nomsSimilaires({ nom: 'Acme Corp' }, { nom: 'Acme' })).toBe(true);
  });
});

describe('dealMissionCandidate', () => {
  it('montant proche + meme trimestre -> candidat', () => {
    const deal = { nom: 'Deal A', montant: 10000, closedate: '2026-02-10' };
    const mission = { nom: 'Autre nom sans rapport', client: '', ca: 10050, dateSignature: '2026-01-05' };
    expect(dealMissionCandidate(deal, mission)).toBe(true);
  });
  it('montant proche + noms similaires (trimestres differents) -> candidat', () => {
    const deal = { nom: 'Somarail', montant: 10000, closedate: '2026-02-10' };
    const mission = { nom: 'Somarail', client: '', ca: 10000, dateSignature: '2026-09-01' };
    expect(dealMissionCandidate(deal, mission)).toBe(true);
  });
  it('montant trop different -> jamais candidat, meme avec nom identique et meme trimestre', () => {
    const deal = { nom: 'Somarail', montant: 10000, closedate: '2026-02-10' };
    const mission = { nom: 'Somarail', client: '', ca: 4000, dateSignature: '2026-01-15' };
    expect(dealMissionCandidate(deal, mission)).toBe(false);
  });
  it('montant proche mais ni trimestre ni nom -> pas candidat', () => {
    const deal = { nom: 'Deal A', montant: 10000, closedate: '2026-02-10' };
    const mission = { nom: 'Mission sans rapport', client: 'Client X', ca: 10000, dateSignature: '2026-09-01' };
    expect(dealMissionCandidate(deal, mission)).toBe(false);
  });
  it('cas reel Somarail : deal 2026 vs vieille mission homonyme 2025 de montant different -> pas candidat', () => {
    // Reproduction du cas motivant l'alerte : la mission 2025 existe (nom identique) mais son
    // montant ne correspond pas au nouveau deal 2026 -> aucune couverture, l'alerte doit sortir.
    const deal = { nom: 'Somarail', montant: 15000, closedate: '2026-03-20' };
    const missionAncienne = { nom: 'Somarail', client: '', ca: 9000, dateSignature: '2025-03-01' };
    expect(dealMissionCandidate(deal, missionAncienne)).toBe(false);
  });
});

describe('orphanWonDeals', () => {
  it('deal couvert par une mission au montant proche + meme trimestre', () => {
    const deals = [{ nom: 'Deal A', montant: 10000, closedate: '2026-02-10' }];
    const missions = [{ nom: 'Mission A (nom different)', client: '', ca: 10050, dateSignature: '2026-03-01' }];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(1);
    expect(r.orphelins).toEqual([]);
  });

  it('deal sans aucune mission correspondante -> orphelin', () => {
    const deals = [{ nom: 'Deal Oublié', montant: 8000, closedate: '2026-05-01' }];
    const missions = [{ nom: 'Autre mission', client: 'Autre client', ca: 20000, dateSignature: '2026-05-15' }];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(0);
    expect(r.orphelins).toHaveLength(1);
    expect(r.orphelins[0].nom).toBe('Deal Oublié');
  });

  it('liste de missions vide -> tous les deals orphelins', () => {
    const deals = [{ nom: 'Deal A', montant: 5000, closedate: '2026-01-10' }];
    const r = orphanWonDeals(deals, []);
    expect(r.couverts).toBe(0);
    expect(r.orphelins).toHaveLength(1);
  });

  it('2 deals jumeaux (meme montant, meme trimestre) + 1 SEULE mission candidate -> 1 couvert, 1 orphelin', () => {
    // Une seule mission ne peut couvrir qu'un seul deal : l'appariement maximum en assigne
    // exactement UN (le juste nombre), l'autre reste orphelin faute de mission disponible.
    const deals = [
      { nom: 'Deal Jumeau 1', montant: 10000, closedate: '2026-02-10' },
      { nom: 'Deal Jumeau 2', montant: 10000, closedate: '2026-02-20' },
    ];
    const missions = [{ nom: 'Mission unique', client: '', ca: 10000, dateSignature: '2026-02-01' }];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(1);
    expect(r.orphelins).toHaveLength(1);
  });

  it('2 deals jumeaux + 2 missions jumelles (meme montant, meme trimestre) -> 2 couverts, 0 orphelin', () => {
    // I1 (revue) : cas metier legitime (ex. audits jumeaux d'un meme client). Un appariement
    // complet existe (D1-M1, D2-M2) meme si AUCUN deal n'a de mission "unique" au sens naif :
    // chaque deal a 2 candidats, chaque mission a 2 candidats. L'ancienne heuristique "naked
    // singles" rendait 0 couvert ici (2 fausses alertes) ; l'appariement maximum en trouve 2.
    const deals = [
      { nom: 'Deal Jumeau 1', montant: 10000, closedate: '2026-02-10' },
      { nom: 'Deal Jumeau 2', montant: 10000, closedate: '2026-02-20' },
    ];
    const missions = [
      { nom: 'Mission jumelle 1', client: '', ca: 10000, dateSignature: '2026-02-01' },
      { nom: 'Mission jumelle 2', client: '', ca: 10000, dateSignature: '2026-02-05' },
    ];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(2);
    expect(r.orphelins).toEqual([]);
  });

  it('3 deals jumeaux + 3 missions jumelles -> 3 couverts, 0 orphelin', () => {
    const deals = [
      { nom: 'Deal Jumeau 1', montant: 5000, closedate: '2026-03-01' },
      { nom: 'Deal Jumeau 2', montant: 5000, closedate: '2026-03-10' },
      { nom: 'Deal Jumeau 3', montant: 5000, closedate: '2026-03-20' },
    ];
    const missions = [
      { nom: 'Mission jumelle 1', client: '', ca: 5000, dateSignature: '2026-01-05' },
      { nom: 'Mission jumelle 2', client: '', ca: 5000, dateSignature: '2026-02-05' },
      { nom: 'Mission jumelle 3', client: '', ca: 5000, dateSignature: '2026-03-05' },
    ];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(3);
    expect(r.orphelins).toEqual([]);
  });

  it('chemin augmentant : D1 candidat de M1 et M2, D2 candidat de M1 seulement -> D2-M1, D1-M2, 2 couverts', () => {
    // Cas qui exige un vrai chemin augmentant (pas juste un appariement glouton naif) : si on
    // affecte D1 a M1 en premier (glouton, ordre naturel de parcours), D2 n'a plus de mission
    // disponible. Un appariement maximum correct doit "reloger" D1 sur M2 pour liberer M1 a D2 :
    // c'est precisement ce que fait la recursion de tryAugment (matchMission[mi] deja pris ->
    // on retente d'augmenter le deal qui l'occupe avant d'abandonner).
    const dealCandidats = [[0, 1], [0]]; // D1 (index 0) -> [M1, M2] ; D2 (index 1) -> [M1] seulement
    const match = maximumBipartiteMatching(dealCandidats, 2);
    expect(match).toEqual([1, 0]); // D1 -> M2 (index 1), D2 -> M1 (index 0) : les deux couvrent
    expect(match.every(mi => mi !== -1)).toBe(true);
  });

  it('deals au meme montant mais trimestres distincts, une mission par trimestre -> chacun couvre un deal distinct', () => {
    // Contrairement au cas "jumeaux" ci-dessus, les deux missions ne sont PAS interchangeables :
    // chacune ne matche qu'un seul deal (trimestre different) -> pas d'ambiguite, les deux couvrent.
    const deals = [
      { nom: 'Deal Jumeau 1', montant: 10000, closedate: '2026-02-10' }, // Q1 2026
      { nom: 'Deal Jumeau 2', montant: 10000, closedate: '2026-05-20' }, // Q2 2026
    ];
    const missions = [
      { nom: 'Mission 1', client: '', ca: 10000, dateSignature: '2026-01-15' }, // Q1 2026
      { nom: 'Mission 2', client: '', ca: 10000, dateSignature: '2026-06-15' }, // Q2 2026
    ];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(2);
    expect(r.orphelins).toEqual([]);
  });

  it('une mission ne peut couvrir qu\'un seul deal parmi deux candidats (non-jumeaux) : 1 couvert, 1 orphelin', () => {
    const deals = [
      { nom: 'Deal A', montant: 10000, closedate: '2026-02-10' },
      { nom: 'Deal B', montant: 10050, closedate: '2026-02-15' },
    ];
    // Une seule mission, candidate pour les deux deals (montants proches l'un de l'autre et de la
    // mission, meme trimestre) : l'appariement maximum en couvre UN (le juste nombre disponible).
    const missions = [{ nom: 'Mission partagee', client: '', ca: 10025, dateSignature: '2026-01-01' }];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(1);
    expect(r.orphelins).toHaveLength(1);
  });

  it('couverture par similarite de nom quand les trimestres different (missions signees en avance/retard)', () => {
    const deals = [{ nom: 'Client Alpha - mission carbone', montant: 12000, closedate: '2026-06-15' }];
    const missions = [{ nom: 'Client Alpha', client: '', ca: 12000, dateSignature: '2026-11-01' }];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(1);
    expect(r.orphelins).toEqual([]);
  });

  it('entrees vides/non-array -> ne plante pas', () => {
    expect(orphanWonDeals([], [])).toEqual({ couverts: 0, orphelins: [] });
    expect(orphanWonDeals(undefined, undefined)).toEqual({ couverts: 0, orphelins: [] });
  });
});

describe('motsSignificatifs', () => {
  it('normalise, decoupe sur la ponctuation et retire les mots trop courts', () => {
    expect(motsSignificatifs('EPD - Écoforest')).toEqual(['ecoforest']);
    expect(motsSignificatifs('Minoterie / Moulin')).toEqual(['minoterie', 'moulin']);
  });
  it('retire les mots outils et les termes metier trop generiques', () => {
    // "bilan carbone" seul ne doit JAMAIS rapprocher deux clients differents.
    expect(motsSignificatifs('Bilan carbone pour la societe')).toEqual([]);
  });
  it('entree vide/nulle -> liste vide', () => {
    expect(motsSignificatifs('')).toEqual([]);
    expect(motsSignificatifs(null)).toEqual([]);
    expect(motsSignificatifs(undefined)).toEqual([]);
  });
});

describe('missionsProches', () => {
  it('cas reel Ecoforest : deal splitte en deux missions, le prefixe "EPD - " ne bloque pas', () => {
    // Le deal 39 000 EUR est decoupe en deux missions Notion : aucune ne matche a +/-1 %, donc
    // orphanWonDeals le sort en orphelin. missionsProches doit quand meme proposer les deux parts
    // pour que l'utilisateur puisse valider a la main.
    const deal = { nom: 'EPD - Ecoforest', montant: 39000, closedate: '2026-06-18' };
    const missions = [
      { nom: 'Ecoforest Part1', client: 'Ecoforest', ca: 28000, dateSignature: '2026-06-18' },
      { nom: 'Ecoforest Part2', client: '', ca: 11000, dateSignature: '2026-07-01' },
      { nom: 'Autre dossier', client: 'Sans rapport', ca: 39000, dateSignature: '2026-06-18' },
    ];
    const r = missionsProches(deal, missions);
    expect(r.map(m => m.nom)).toEqual(['Ecoforest Part1', 'Ecoforest Part2']);
    expect(r[0]).toEqual({ nom: 'Ecoforest Part1', montant: 28000, dateSignature: '2026-06-18' });
    expect(r[1]).toEqual({ nom: 'Ecoforest Part2', montant: 11000, dateSignature: '2026-07-01' });
  });

  it('cas reel Minoterie : match sur le client au pluriel, hors de portee du containment', () => {
    // "moulin du nord" n'est PAS une sous-chaine de "la minoterie & moulins du nord" (le "s" de
    // "moulins" casse le containment) : seul le rapprochement par mot significatif y arrive.
    const deal = { nom: 'Moulin du nord', montant: 2500, closedate: '2026-03-10' };
    const missions = [
      { nom: 'Minoterie / Moulin', client: 'La Minoterie & Moulins du Nord', ca: 5000, dateSignature: '2026-03-01' },
      { nom: 'Toiture solaire', client: 'Helios', ca: 2500, dateSignature: '2026-03-05' },
    ];
    const r = missionsProches(deal, missions);
    expect(r.map(m => m.nom)).toEqual(['Minoterie / Moulin']);
    expect(r[0].montant).toBe(5000);
  });

  it('aucune mission au nom/client similaire -> liste vide (meme au bon montant)', () => {
    const deal = { nom: 'Client Zeta', montant: 1000, closedate: '2026-01-05' };
    const missions = [{ nom: 'Alpha Beta', client: 'Gamma', ca: 1000, dateSignature: '2026-01-05' }];
    expect(missionsProches(deal, missions)).toEqual([]);
  });

  it('tri par ecart de montant croissant et troncature au max (5 par defaut)', () => {
    const deal = { nom: 'Ecoforest', montant: 10000, closedate: '2026-01-01' };
    const missions = [
      { nom: 'Ecoforest F', client: '', ca: 100000, dateSignature: null }, // ecart 90 000
      { nom: 'Ecoforest E', client: '', ca: 50000, dateSignature: null },  // ecart 40 000
      { nom: 'Ecoforest D', client: '', ca: 30000, dateSignature: null },  // ecart 20 000
      { nom: 'Ecoforest C', client: '', ca: 20000, dateSignature: null },  // ecart 10 000
      { nom: 'Ecoforest B', client: '', ca: 12000, dateSignature: null },  // ecart  2 000
      { nom: 'Ecoforest A', client: '', ca: 10500, dateSignature: null },  // ecart    500
    ];
    const r = missionsProches(deal, missions);
    expect(r.map(m => m.nom)).toEqual(['Ecoforest A', 'Ecoforest B', 'Ecoforest C', 'Ecoforest D', 'Ecoforest E']);
    expect(missionsProches(deal, missions, 2).map(m => m.nom)).toEqual(['Ecoforest A', 'Ecoforest B']);
  });

  it('entrees vides/non-array/deal sans nom -> liste vide, ne plante pas', () => {
    expect(missionsProches({ nom: '', montant: 0 }, [{ nom: 'Mission X', client: '', ca: 0 }])).toEqual([]);
    expect(missionsProches(undefined, undefined)).toEqual([]);
    expect(missionsProches({ nom: 'Ecoforest', montant: 1 }, [])).toEqual([]);
  });
});
