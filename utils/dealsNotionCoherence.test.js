'use strict';
const {
  montantsProches,
  periodeTrimestre,
  nomsSimilaires,
  dealMissionCandidate,
  orphanWonDeals,
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

  it('deals jumeaux (meme montant, meme trimestre) candidats pour UNE SEULE mission -> aucun couvert (prudence)', () => {
    // Cas cite par la spec : deux deals "jumeaux" ne doivent pas etre tous les deux consideres
    // couverts par la meme ligne Notion. En cas de doute, aucun n'est marque couvert : mieux vaut
    // une alerte de trop qu'une couverture silencieuse erronee sur l'un des deux.
    const deals = [
      { nom: 'Deal Jumeau 1', montant: 10000, closedate: '2026-02-10' },
      { nom: 'Deal Jumeau 2', montant: 10000, closedate: '2026-02-20' },
    ];
    const missions = [{ nom: 'Mission unique', client: '', ca: 10000, dateSignature: '2026-02-01' }];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(0);
    expect(r.orphelins).toHaveLength(2);
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

  it('une mission ne peut pas couvrir deux deals differents (non-jumeaux) : le second reste orphelin', () => {
    const deals = [
      { nom: 'Deal A', montant: 10000, closedate: '2026-02-10' },
      { nom: 'Deal B', montant: 10050, closedate: '2026-02-15' },
    ];
    // Une seule mission, candidate pour les deux deals (montants proches l'un de l'autre et de la
    // mission, meme trimestre) : ambigu -> aucun des deux n'est assigne (voir test jumeaux ci-dessus).
    const missions = [{ nom: 'Mission partagee', client: '', ca: 10025, dateSignature: '2026-01-01' }];
    const r = orphanWonDeals(deals, missions);
    expect(r.couverts).toBe(0);
    expect(r.orphelins).toHaveLength(2);
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
