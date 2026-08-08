'use strict';
const { computeKpi, totalCaAnnee, signedByQuarter, clawbackCandidates, quarterOfDate, OPERE_STATES, SIGNE_EXCLUDED_STATES, computePrimePool, primeDefaultRates, computePrimePayments, selectChargeEntriesForExercice, computePrimesChargeForExercice, endOfYearIso } = require('./kpiCompute');
const { lastMonthOfQuarter } = require('./kpiCompute');

describe('lastMonthOfQuarter : dernier mois du trimestre (date de charge)', () => {
  it('T1->03, T2->06, T3->09, T4->12', () => {
    expect(lastMonthOfQuarter(2026, 1)).toBe('2026-03');
    expect(lastMonthOfQuarter(2026, 2)).toBe('2026-06');
    expect(lastMonthOfQuarter(2026, 3)).toBe('2026-09');
    expect(lastMonthOfQuarter(2026, 4)).toBe('2026-12');
  });
});

// Helper : fabrique une mission avec des valeurs par défaut raisonnables.
// Par défaut : signée le 2026-03-01 (via dateCreation, faute de dateSignature) → tout le CA est
// rattaché au signé 2026 (daté à la signature). L'opéré, lui, est daté par dateCreation (2026).
// anneeFinal/dates de facture ne servent qu'à caAnnee (le total facturé), pas au réalisé signé.
function mission(over = {}) {
  return {
    id: 'm1', nom: 'Mission', client: 'Client', ca: 10000,
    etat: 'En cours', typeCa: 'Newsale',
    partnerCommercial: ['Vincent'], partnerOperationnel: ['Guillaume'],
    dateCreation: '2026-03-01T10:00:00.000Z',
    montantAcompte: 0, dateFactureAcompte: null, dateFactureFinale: null,
    anneeFinal: '2026',
    ...over,
  };
}

describe('constantes', () => {
  it('opéré = En cours + Terminé', () => {
    expect(OPERE_STATES).toEqual(['En cours', 'Terminé']);
  });
  it('signé exclut Annulé', () => {
    expect(SIGNE_EXCLUDED_STATES).toEqual(['Annulé']);
  });
});

describe('computeKpi — attribution de base', () => {
  it('1 partner commercial → 100% en newsale ; 1 partner opérationnel → 100% en opéré', () => {
    const r = computeKpi({ missions: [mission()], objectives: [], splits: [], year: 2026 });
    const vincent = r.partners.find(p => p.partner === 'Vincent');
    const guillaume = r.partners.find(p => p.partner === 'Guillaume');
    expect(vincent.newsale.realise).toBe(10000);
    expect(vincent.opere.realise).toBe(0);
    expect(guillaume.opere.realise).toBe(10000);
    expect(guillaume.newsale.realise).toBe(0);
  });

  it('Upsale range le CA en upsale', () => {
    const r = computeKpi({ missions: [mission({ typeCa: 'Upsale' })], objectives: [], splits: [], year: 2026 });
    const v = r.partners.find(p => p.partner === 'Vincent');
    expect(v.upsale.realise).toBe(10000);
    expect(v.newsale.realise).toBe(0);
  });

  it('2 partners commerciaux sans override → 50/50', () => {
    const r = computeKpi({
      missions: [mission({ partnerCommercial: ['Vincent', 'Nathan'] })],
      objectives: [], splits: [], year: 2026,
    });
    expect(r.partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(5000);
    expect(r.partners.find(p => p.partner === 'Nathan').newsale.realise).toBe(5000);
  });

  it('2 partners commerciaux avec override 70/30', () => {
    const r = computeKpi({
      missions: [mission({ id: 'mX', partnerCommercial: ['Vincent', 'Nathan'] })],
      objectives: [],
      splits: [
        { mission_id: 'mX', axis: 'commercial', partner: 'Vincent', pct: 70 },
        { mission_id: 'mX', axis: 'commercial', partner: 'Nathan', pct: 30 },
      ],
      year: 2026,
    });
    expect(r.partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(7000);
    expect(r.partners.find(p => p.partner === 'Nathan').newsale.realise).toBe(3000);
  });
});

describe('computeKpi — filtres états & année', () => {
  it('Annulé → exclu du signé ET de l\'opéré', () => {
    const r = computeKpi({ missions: [mission({ etat: 'Annulé' })], objectives: [], splits: [], year: 2026 });
    expect(r.partners).toEqual([]);
  });

  it('Planning → compté en signé mais PAS en opéré', () => {
    const r = computeKpi({ missions: [mission({ etat: 'Planning' })], objectives: [], splits: [], year: 2026 });
    expect(r.partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(10000);
    expect(r.partners.find(p => p.partner === 'Guillaume')).toBeUndefined();
  });

  it('mauvaise année → mission ignorée (signé via "Année final" 2025, opéré via création 2025)', () => {
    const r = computeKpi({
      missions: [mission({ dateCreation: '2025-12-31T23:00:00.000Z', anneeFinal: '2025' })],
      objectives: [], splits: [], year: 2026,
    });
    expect(r.partners).toEqual([]);
  });
});

describe('computeKpi — CA signé : datage à la signature (comme les primes)', () => {
  it('le CA entier tombe sur l\'année de signature, quelles que soient les dates de facture', () => {
    const m = mission({
      ca: 10000, dateSignature: '2026-03-01', montantAcompte: 4000,
      dateFactureAcompte: '2025-12-15', dateFactureFinale: '2027-01-20', anneeFinal: '2027',
    });
    // Signé en 2026 (signature) : tout le CA, pas de découpage acompte/solde ni de rattachement facture.
    expect(computeKpi({ missions: [m], objectives: [], splits: [], year: 2026 }).partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(10000);
    expect(computeKpi({ missions: [m], objectives: [], splits: [], year: 2025 }).partners.find(p => p.partner === 'Vincent')).toBeUndefined();
    expect(computeKpi({ missions: [m], objectives: [], splits: [], year: 2027 }).partners.find(p => p.partner === 'Vincent')).toBeUndefined();
  });

  it('"Date de signature" prime sur la date de création', () => {
    const m = mission({ ca: 8000, dateSignature: '2025-11-01', dateCreation: '2026-03-01T10:00:00.000Z' });
    expect(computeKpi({ missions: [m], objectives: [], splits: [], year: 2025 }).partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(8000);
    expect(computeKpi({ missions: [m], objectives: [], splits: [], year: 2026 }).partners.find(p => p.partner === 'Vincent')).toBeUndefined();
  });

  it('sans "Date de signature", repli sur la date de création', () => {
    const m = mission({ ca: 5000, dateSignature: null, dateCreation: '2026-06-10T10:00:00.000Z' });
    expect(computeKpi({ missions: [m], objectives: [], splits: [], year: 2026 }).partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(5000);
  });

  it('les dates de facture ne touchent PAS le réalisé signé (uniquement caAnnee)', () => {
    // Signé en 2026 mais facturé intégralement en 2027 : le signé reste sur 2026.
    const m = mission({ ca: 10000, dateSignature: '2026-05-01', montantAcompte: 10000, dateFactureAcompte: '2027-01-01', dateFactureFinale: null, anneeFinal: '2027' });
    expect(computeKpi({ missions: [m], objectives: [], splits: [], year: 2026 }).partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(10000);
  });

  it('type non classé → pas en newsale/upsale, mais opéré OK (signé daté à la création)', () => {
    const m = mission({ ca: 5000, dateSignature: null, dateCreation: '2026-04-01T10:00:00.000Z', typeCa: 'Non défini' });
    const r = computeKpi({ missions: [m], objectives: [], splits: [], year: 2026 });
    expect(r.partners.find(p => p.partner === 'Vincent')).toBeUndefined();          // non classé → pas en newsale
    expect(r.partners.find(p => p.partner === 'Guillaume').opere.realise).toBe(5000); // opéré via création 2026
  });
});

describe('computeKpi — non classées', () => {
  it('type_ca vide → unclassified, pas en newsale/upsale, mais opéré OK', () => {
    const r = computeKpi({ missions: [mission({ typeCa: 'Non défini' })], objectives: [], splits: [], year: 2026 });
    expect(r.unclassified).toEqual([{ id: 'm1', nom: 'Mission', client: 'Client', ca: 10000 }]);
    expect(r.partners.find(p => p.partner === 'Vincent')).toBeUndefined();
    expect(r.partners.find(p => p.partner === 'Guillaume').opere.realise).toBe(10000);
  });
});

describe('computeKpi — objectifs, tx, all', () => {
  it('tx = realise/objectif ; objectif 0 → tx null', () => {
    const r = computeKpi({
      missions: [mission({ ca: 16150 })],
      objectives: [{ partner: 'Vincent', year: 2026, type: 'newsale', montant: 100000 }],
      splits: [], year: 2026,
    });
    const v = r.partners.find(p => p.partner === 'Vincent');
    expect(v.newsale.objectif).toBe(100000);
    expect(v.newsale.tx).toBeCloseTo(0.1615, 4);
    expect(v.upsale.tx).toBeNull(); // objectif 0
  });

  it('all = somme des partners', () => {
    const r = computeKpi({
      missions: [
        mission({ id: 'a', partnerCommercial: ['Vincent'], ca: 30000 }),
        mission({ id: 'b', partnerCommercial: ['Nathan'], ca: 20000 }),
      ],
      objectives: [
        { partner: 'Vincent', year: 2026, type: 'newsale', montant: 100000 },
        { partner: 'Nathan', year: 2026, type: 'newsale', montant: 50000 },
      ],
      splits: [], year: 2026,
    });
    expect(r.all.newsale.realise).toBe(50000);
    expect(r.all.newsale.objectif).toBe(150000);
  });

  it('partner présent via objectif seul (aucune mission) apparaît avec realise 0', () => {
    const r = computeKpi({
      missions: [],
      objectives: [{ partner: 'Solo', year: 2026, type: 'opere', montant: 5000 }],
      splits: [], year: 2026,
    });
    const solo = r.partners.find(p => p.partner === 'Solo');
    expect(solo.opere.objectif).toBe(5000);
    expect(solo.opere.realise).toBe(0);
    expect(solo.opere.tx).toBe(0);
  });
});

describe('computeKpi — missionsForSplit', () => {
  it('liste les missions de l\'année à 2+ partners avec split par défaut égal', () => {
    const r = computeKpi({
      missions: [mission({ id: 'mY', partnerCommercial: ['Vincent', 'Nathan'], partnerOperationnel: ['Guillaume'] })],
      objectives: [], splits: [], year: 2026,
    });
    expect(r.missionsForSplit).toHaveLength(1);
    const m = r.missionsForSplit[0];
    expect(m.id).toBe('mY');
    expect(m.client).toBe('Client');
    expect(m.type).toBe('newsale');
    expect(m.splitCommercial).toEqual({ Vincent: 50, Nathan: 50 });
    expect(m.splitOperationnel).toEqual({ Guillaume: 100 });
  });

  it('mission à 1 seul partner par axe → pas listée', () => {
    const r = computeKpi({ missions: [mission()], objectives: [], splits: [], year: 2026 });
    expect(r.missionsForSplit).toEqual([]);
  });

  it('commercialSaved = true si un split commercial existe, false sinon', () => {
    const missions = [mission({ id: 'mS', partnerCommercial: ['Vincent', 'Nathan'] })];
    const withSplit = computeKpi({
      missions, objectives: [], year: 2026,
      splits: [{ mission_id: 'mS', axis: 'commercial', partner: 'Vincent', pct: 60 }],
    });
    expect(withSplit.missionsForSplit[0].commercialSaved).toBe(true);
    const without = computeKpi({ missions, objectives: [], splits: [], year: 2026 });
    expect(without.missionsForSplit[0].commercialSaved).toBe(false);
  });

  it('type = upsale pour une mission Upsale', () => {
    const r = computeKpi({
      missions: [mission({ id: 'mU', typeCa: 'Upsale', partnerCommercial: ['Vincent', 'Nathan'] })],
      objectives: [], splits: [], year: 2026,
    });
    expect(r.missionsForSplit[0].type).toBe('upsale');
  });

  it('type = null pour une mission sans type_ca défini', () => {
    const r = computeKpi({
      missions: [mission({ id: 'mN', typeCa: 'Non défini', partnerCommercial: ['Vincent', 'Nathan'] })],
      objectives: [], splits: [], year: 2026,
    });
    expect(r.missionsForSplit[0].type).toBeNull();
  });
});

describe('splitAmount — crédite aussi les partners ajoutés via un override (moteur v2)', () => {
  it('computeKpi : un partner hors partnerCommercial mais présent dans le split est crédité', () => {
    const missions = [mission({ id: 'mX', typeCa: 'Upsale', ca: 10000, partnerCommercial: ['Vincent', 'Nathan'], partnerOperationnel: ['Guillaume'] })];
    const splits = [
      { mission_id: 'mX', axis: 'commercial', partner: 'Vincent', pct: 40 },
      { mission_id: 'mX', axis: 'commercial', partner: 'Nathan', pct: 25 },
      { mission_id: 'mX', axis: 'commercial', partner: 'Guillaume', pct: 35 },
    ];
    const r = computeKpi({ missions, objectives: [], splits, year: 2026 });
    const byName = Object.fromEntries(r.partners.map((p) => [p.partner, p]));
    expect(byName.Vincent.upsale.realise).toBe(4000);
    expect(byName.Nathan.upsale.realise).toBe(2500);
    expect(byName.Guillaume.upsale.realise).toBe(3500); // opérationnel crédité via le split commercial
  });

  it('signedByQuarter : le partner ajouté touche sa part de prime', () => {
    const missions = [mission({ id: 'mX', typeCa: 'Upsale', ca: 10000, dateSignature: '2026-02-10', partnerCommercial: ['Vincent', 'Nathan'], partnerOperationnel: ['Guillaume'] })];
    const splits = [
      { mission_id: 'mX', axis: 'commercial', partner: 'Vincent', pct: 40 },
      { mission_id: 'mX', axis: 'commercial', partner: 'Nathan', pct: 25 },
      { mission_id: 'mX', axis: 'commercial', partner: 'Guillaume', pct: 35 },
    ];
    const r = signedByQuarter(missions, 2026, splits);
    expect(r.byPartner.Guillaume.repeat[0]).toBe(3500); // Q1, upsale = repeat
  });

  it('sans override, comportement inchangé (parts égales sur le socle Notion)', () => {
    const r = computeKpi({
      missions: [mission({ id: 'mE', typeCa: 'Newsale', ca: 10000, partnerCommercial: ['Vincent', 'Nathan'] })],
      objectives: [], splits: [], year: 2026,
    });
    const byName = Object.fromEntries(r.partners.map((p) => [p.partner, p]));
    expect(byName.Vincent.newsale.realise).toBe(5000);
    expect(byName.Nathan.newsale.realise).toBe(5000);
  });
});

describe('CA de l\'année (caAnnee) : total « CA 2026 HT » partagé', () => {
  it('caAnnee = CA rattaché à l\'année, toutes missions non « Annulé »', () => {
    const r = computeKpi({ missions: [mission()], objectives: [], splits: [], year: 2026 });
    // 1 mission par défaut : solde 10000 rattaché à 2026 via « Année final »
    expect(r.caAnnee).toBe(10000);
  });

  it('caAnnee inclut les missions non classées (type_ca vide), contrairement à newsale+upsale', () => {
    const missions = [
      mission({ id: 'a', typeCa: 'Newsale', ca: 10000 }),
      mission({ id: 'b', typeCa: 'Non défini', ca: 5000 }),
    ];
    const r = computeKpi({ missions, objectives: [], splits: [], year: 2026 });
    // newsale + upsale ne comptent QUE la mission classée...
    expect(r.all.newsale.realise + r.all.upsale.realise).toBe(10000);
    // ...alors que caAnnee compte les deux (total financier de l'année)
    expect(r.caAnnee).toBe(15000);
  });

  it('caAnnee exclut « Annulé »', () => {
    const missions = [
      mission({ id: 'a', ca: 10000 }),
      mission({ id: 'b', ca: 4000, etat: 'Annulé' }),
    ];
    expect(computeKpi({ missions, objectives: [], splits: [], year: 2026 }).caAnnee).toBe(10000);
  });

  it('caAnnee répartit une mission à cheval par date de facture', () => {
    const m = mission({
      ca: 10000, montantAcompte: 4000,
      dateFactureAcompte: '2025-12-15', dateFactureFinale: '2026-01-20', anneeFinal: '2026',
    });
    expect(computeKpi({ missions: [m], objectives: [], splits: [], year: 2025 }).caAnnee).toBe(4000);
    expect(computeKpi({ missions: [m], objectives: [], splits: [], year: 2026 }).caAnnee).toBe(6000);
  });

  it('totalCaAnnee est exporté et donne le même total que le champ caAnnee', () => {
    const missions = [mission({ id: 'a', ca: 10000 }), mission({ id: 'b', ca: 5000, typeCa: 'Non défini' })];
    expect(totalCaAnnee(missions, 2026)).toBe(15000);
  });
});

describe('signedByQuarter — CA signé par trimestre (datage signature)', () => {
  it('mission par défaut (Newsale, création 2026-03-01 = Q1)', () => {
    const r = signedByQuarter([mission()], 2026, []);
    expect(r.byPartner.Vincent.new).toEqual([10000, 0, 0, 0]);
    expect(r.byPartner.Vincent.repeat).toEqual([0, 0, 0, 0]);
    expect(r.quarterTotals).toEqual([10000, 0, 0, 0]);
    expect(r.total).toBe(10000);
  });

  it('"Date de signature" prime sur la date de création pour le trimestre', () => {
    const r = signedByQuarter([mission({ dateSignature: '2026-07-15', dateCreation: '2026-03-01T10:00:00.000Z' })], 2026, []);
    expect(r.byPartner.Vincent.new).toEqual([0, 0, 10000, 0]); // Q3 (juillet)
    expect(r.quarterTotals).toEqual([0, 0, 10000, 0]);
  });

  it('Upsale → bucket repeat', () => {
    const r = signedByQuarter([mission({ typeCa: 'Upsale' })], 2026, []);
    expect(r.byPartner.Vincent.repeat).toEqual([10000, 0, 0, 0]);
    expect(r.byPartner.Vincent.new).toEqual([0, 0, 0, 0]);
  });

  it('2 partners → réparti 50/50 dans le trimestre, total non dédoublé', () => {
    const r = signedByQuarter([mission({ partnerCommercial: ['Vincent', 'Nathan'] })], 2026, []);
    expect(r.byPartner.Vincent.new).toEqual([5000, 0, 0, 0]);
    expect(r.byPartner.Nathan.new).toEqual([5000, 0, 0, 0]);
    expect(r.quarterTotals).toEqual([10000, 0, 0, 0]);
  });

  it('override 70/30 respecté', () => {
    const r = signedByQuarter(
      [mission({ id: 'mX', partnerCommercial: ['Vincent', 'Nathan'] })],
      2026,
      [
        { mission_id: 'mX', axis: 'commercial', partner: 'Vincent', pct: 70 },
        { mission_id: 'mX', axis: 'commercial', partner: 'Nathan', pct: 30 },
      ],
    );
    expect(r.byPartner.Vincent.new[0]).toBe(7000);
    expect(r.byPartner.Nathan.new[0]).toBe(3000);
  });

  it('non classée : compte dans quarterTotals (seuil) mais dans aucune prime perso', () => {
    const r = signedByQuarter([mission({ typeCa: 'Non défini', ca: 5000 })], 2026, []);
    expect(r.quarterTotals).toEqual([5000, 0, 0, 0]);
    expect(r.partners).toEqual([]);
    expect(r.byPartner).toEqual({});
  });

  it('Annulé exclu du total et des primes', () => {
    const r = signedByQuarter([mission({ etat: 'Annulé' })], 2026, []);
    expect(r.quarterTotals).toEqual([0, 0, 0, 0]);
    expect(r.partners).toEqual([]);
  });

  it('missions sur des trimestres différents (Q1 et Q4)', () => {
    const r = signedByQuarter([
      mission({ id: 'a', dateSignature: '2026-02-10', ca: 8000, partnerCommercial: ['Vincent'] }),
      mission({ id: 'b', dateSignature: '2026-11-20', ca: 12000, partnerCommercial: ['Vincent'] }),
    ], 2026, []);
    expect(r.byPartner.Vincent.new).toEqual([8000, 0, 0, 12000]);
    expect(r.quarterTotals).toEqual([8000, 0, 0, 12000]);
    expect(r.total).toBe(20000);
  });

  it('mauvaise année exclue', () => {
    const r = signedByQuarter([mission({ dateSignature: '2025-05-01' })], 2026, []);
    expect(r.quarterTotals).toEqual([0, 0, 0, 0]);
    expect(r.total).toBe(0);
  });

  it('quarterOfDate mappe le mois vers le trimestre', () => {
    expect(quarterOfDate('2026-01-15')).toBe(1);
    expect(quarterOfDate('2026-04-01')).toBe(2);
    expect(quarterOfDate('2026-09-30')).toBe(3);
    expect(quarterOfDate('2026-12-31')).toBe(4);
    expect(quarterOfDate(null)).toBeNull();
  });

  it('detailByPartner garde le détail des deals (traçabilité prime -> deal)', () => {
    const r = signedByQuarter([mission({ id: 'm1', nom: 'Projet X', client: 'ClientX' })], 2026, []);
    expect(r.detailByPartner.Vincent[0]).toEqual([{ id: 'm1', nom: 'Projet X', client: 'ClientX', montant: 10000, pct: 100, type: 'new' }]);
    expect(r.detailByPartner.Vincent[1]).toEqual([]); // Q2 vide
  });

  it('split 2 partners : détail avec le bon montant et %', () => {
    const r = signedByQuarter([mission({ id: 'mX', partnerCommercial: ['Vincent', 'Nathan'] })], 2026, []);
    expect(r.detailByPartner.Vincent[0][0]).toMatchObject({ montant: 5000, pct: 50 });
    expect(r.detailByPartner.Nathan[0][0]).toMatchObject({ montant: 5000, pct: 50 });
  });

  it('mission signée SANS partner : non attribuée (comptée dans quarterTotals, pas dans byPartner)', () => {
    const r = signedByQuarter([mission({ partnerCommercial: [] })], 2026, []);
    expect(r.quarterTotals).toEqual([10000, 0, 0, 0]);
    expect(r.partners).toEqual([]);
    expect(r.unattributed.total).toBe(10000);
    expect(r.unattributed.missions[0]).toMatchObject({ reason: 'sans partner', ca: 10000 });
  });

  it('mission signée SANS type : non attribuée (reason "sans type")', () => {
    const r = signedByQuarter([mission({ typeCa: 'Non défini' })], 2026, []);
    expect(r.unattributed.total).toBe(10000);
    expect(r.unattributed.missions[0].reason).toBe('sans type');
  });

  it('unattributed.total = somme des CA signés non rattachés', () => {
    const r = signedByQuarter([
      mission({ id: 'a', partnerCommercial: ['Vincent'], ca: 10000 }),
      mission({ id: 'b', partnerCommercial: [], ca: 4000 }),
      mission({ id: 'c', typeCa: 'Non défini', ca: 3000 }),
    ], 2026, []);
    expect(r.total).toBe(17000);
    expect(r.unattributed.total).toBe(7000);
  });
});

describe('clawbackCandidates : reprises sur deals annulés après paiement', () => {
  it('mission Annulé signée sur un trimestre payé (T1, paidThrough=2) : candidat', () => {
    const r = clawbackCandidates([mission({ id: 'a', etat: 'Annulé', dateSignature: '2026-02-10', partnerCommercial: ['Vincent'], ca: 8000 })], 2026, [], 2);
    expect(r).toEqual([{ id: 'a', nom: 'Mission', client: 'Client', quarter: 1, partner: 'Vincent', montant: 8000, type: 'new' }]);
  });

  it('mission Annulé signée sur le trimestre courant (T3 > paidThrough 2) : PAS un candidat', () => {
    const r = clawbackCandidates([mission({ etat: 'Annulé', dateSignature: '2026-08-10' })], 2026, [], 2);
    expect(r).toEqual([]);
  });

  it('mission NON annulée : pas de clawback', () => {
    const r = clawbackCandidates([mission({ dateSignature: '2026-02-10' })], 2026, [], 2);
    expect(r).toEqual([]);
  });

  it('mission Annulé sans partner : ignorée (pas de prime générée)', () => {
    const r = clawbackCandidates([mission({ etat: 'Annulé', dateSignature: '2026-02-10', partnerCommercial: [] })], 2026, [], 2);
    expect(r).toEqual([]);
  });

  it('split respecté sur un clawback', () => {
    const r = clawbackCandidates([mission({ id: 'x', etat: 'Annulé', dateSignature: '2026-02-10', partnerCommercial: ['Vincent', 'Nathan'], ca: 10000 })], 2026, [], 2);
    expect(r.map(c => c.montant)).toEqual([5000, 5000]);
  });
});

describe('computePrimePool : pool de primes pour le compte de resultat', () => {
  // Config minimale explicite (pas de defauts a deviner dans les asserts).
  const cfg = {
    rates: { Vincent: { txNew: 4.5, txRepeat: 2.5 } },
    tiers: [{ seuil: 650000, taux: 7 }, { seuil: 600000, taux: 5 }, { seuil: 550000, taux: 3 }],
    resultatAnnuel: 150000,
    gateTrimestriel: 120000,
  };

  it('taux par defaut : Guillaume a la moitie', () => {
    expect(primeDefaultRates('Guillaume Dupont')).toEqual({ txNew: 2.25, txRepeat: 1.25 });
    expect(primeDefaultRates('Vincent')).toEqual({ txNew: 4.5, txRepeat: 2.5 });
  });

  it('etage 1 : un trimestre au-dessus du seuil verse la prime perso', () => {
    // Vincent signe 200000 de Newsale en T1 (>= seuil 120000).
    const m = mission({ id: 'a', typeCa: 'Newsale', dateSignature: '2026-02-01', partnerCommercial: ['Vincent'], ca: 200000, etat: 'Signé' });
    const r = computePrimePool({ missions: [m], splits: [], config: cfg, year: 2026, caFacture: 0 });
    expect(r.etage1).toBe(9000);   // 200000 * 4.5%
    expect(r.etage2).toBe(0);      // caFacture 0 < premier palier
    expect(r.pool).toBe(9000);
  });

  it('portillon : un trimestre sous le seuil ne verse rien', () => {
    const m = mission({ id: 'b', typeCa: 'Newsale', dateSignature: '2026-02-01', partnerCommercial: ['Vincent'], ca: 100000, etat: 'Signé' });
    const r = computePrimePool({ missions: [m], splits: [], config: cfg, year: 2026, caFacture: 0 });
    expect(r.etage1).toBe(0);      // 100000 < 120000 -> gele
    expect(r.pool).toBe(0);
  });

  it('etage 2 : palier selon caFacture', () => {
    const r = computePrimePool({ missions: [], splits: [], config: cfg, year: 2026, caFacture: 620000 });
    expect(r.tauxColl).toBe(5);          // 620000 >= 600000
    expect(r.etage2).toBe(7500);         // 5% * 150000
    expect(r.pool).toBe(7500);
  });

  it('config absente : applique les defauts (memes que le panneau KPI)', () => {
    const m = mission({ id: 'c', typeCa: 'Newsale', dateSignature: '2026-02-01', partnerCommercial: ['Vincent'], ca: 200000, etat: 'Signé' });
    const r = computePrimePool({ missions: [m], splits: [], config: null, year: 2026, caFacture: 660000 });
    // etage1 : 200000 * 4.5% (defaut) = 9000 ; etage2 : palier 660000 -> 7% * 150000 = 10500.
    expect(r.pool).toBe(19500);
  });
});

describe('computePrimePayments : echeancier des versements de primes', () => {
  const cfg = {
    rates: { Vincent: { txNew: 4.5, txRepeat: 2.5 } },
    tiers: [{ seuil: 650000, taux: 7 }, { seuil: 600000, taux: 5 }, { seuil: 550000, taux: 3 }],
    resultatAnnuel: 150000,
    gateTrimestriel: 120000,
  };
  // Deal T1 (signe fevrier), Newsale, Vincent, 200000, acompte facture le 15/03/2026.
  const dealT1 = (over = {}) => mission({
    id: 'a', typeCa: 'Newsale', dateSignature: '2026-02-01', partnerCommercial: ['Vincent'],
    ca: 200000, etat: 'Signé', dateFactureAcompte: '2026-03-15', ...over,
  });

  it('deal facture a temps : versement planifie au mois suivant la cloture (avril)', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.byMonth['2026-04']).toBe(9000); // 200000 * 4.5%
    expect(r.enAttente).toBe(0);
  });

  it('deal facture au trimestre suivant (T3) : versement a M+1 de la cloture du T3 (octobre)', () => {
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: '2026-08-20' })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.byMonth['2026-10']).toBe(9000);
    expect(r.byMonth['2026-04']).toBeUndefined();
    expect(r.byMonth['2026-09']).toBeUndefined();
  });

  it('deal signe T1 facture au T2 : versement en juillet (M+1 cloture T2)', () => {
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: '2026-05-15' })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.byMonth['2026-07']).toBe(9000);
    expect(r.byMonth['2026-04']).toBeUndefined();
  });

  it('mois de versement deja passe : rattrapage sur le mois courant', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-07-15' });
    expect(r.byMonth['2026-07']).toBe(9000);
    expect(r.detail['2026-07'][0].rattrapage).toBe(true);
  });

  it('acompte non facture : en attente, aucun versement', () => {
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: null })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.enAttente).toBe(9000);
    expect(Object.keys(r.byMonth).length).toBe(0);
  });

  it('trimestre sous le seuil (gele) : rien', () => {
    const r = computePrimePayments({ missions: [dealT1({ ca: 100000 })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(Object.keys(r.byMonth).length).toBe(0);
    expect(r.enAttente).toBe(0);
  });

  it('etage 2 : verse au mois configure en N+1 (defaut mars)', () => {
    const r = computePrimePayments({ missions: [], splits: [], config: cfg, year: 2026, caFacture: 660000, versements: [], now: '2026-07-15' });
    expect(r.byMonth['2027-03']).toBe(10500); // 7% * 150000
  });

  it('versement deja valide : exclu du byMonth, compte dans verse', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [{ etage: 1, mission_id: 'a', partner: 'Vincent' }], now: '2026-02-10' });
    expect(Object.keys(r.byMonth).length).toBe(0);
    expect(r.verse).toBe(9000);
  });

  it('pastPolicy "drop" : un versement passe est omis (pas de rattrapage)', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-07-15', pastPolicy: 'drop' });
    expect(Object.keys(r.byMonth).length).toBe(0);
  });

  it('deal T4 : versement en janvier N+1', () => {
    const dealT4 = mission({ id: 'd4', typeCa: 'Newsale', dateSignature: '2026-11-05', partnerCommercial: ['Vincent'], ca: 200000, etat: 'Signé', dateFactureAcompte: '2026-12-10' });
    const r = computePrimePayments({ missions: [dealT4], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-12-15' });
    expect(r.byMonth['2027-01']).toBe(9000);
  });

  it('etage 2 : mois de versement configurable via la config', () => {
    const r = computePrimePayments({ missions: [], splits: [], config: { ...cfg, versementEtage2Mois: '06' }, year: 2026, caFacture: 660000, versements: [], now: '2026-07-15' });
    expect(r.byMonth['2027-06']).toBe(10500);
  });

  it('etage 2 en N+1 deja passe : rattrapage sur le mois courant', () => {
    const r = computePrimePayments({ missions: [], splits: [], config: cfg, year: 2025, caFacture: 660000, versements: [], now: '2026-07-15' });
    expect(r.byMonth['2026-07']).toBe(10500);
  });

  it('byPartnerMonth : etage 1 ventile par associe au bon mois', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10', participants: ['Vincent', 'Guillaume', 'Nathan'] });
    expect(r.byPartnerMonth.Vincent['2026-04']).toBe(9000);
    expect(r.byPartnerMonth.Guillaume).toBeUndefined();
  });

  it('byPartnerMonth : etage 2 reparti a parts egales en N+1, byMonth garde le total', () => {
    const r = computePrimePayments({ missions: [], splits: [], config: cfg, year: 2026, caFacture: 660000, versements: [], now: '2026-02-10', participants: ['Vincent', 'Guillaume', 'Nathan'] });
    expect(r.byPartnerMonth.Vincent['2027-03']).toBe(3500);
    expect(r.byPartnerMonth.Guillaume['2027-03']).toBe(3500);
    expect(r.byPartnerMonth.Nathan['2027-03']).toBe(3500);
    expect(r.byMonth['2027-03']).toBe(10500);
  });

  it('enAttenteByPartner : ventile les primes en attente (acompte non facture) par associe', () => {
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: null })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.enAttente).toBe(9000);
    expect(r.enAttenteByPartner.Vincent).toBe(9000);
  });

  it('charge etage 1 : datee au dernier mois du trimestre de facturation (mars), decaissement en avril', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10', participants: ['Vincent'] });
    expect(r.byPartnerMonthCharge.Vincent['2026-03']).toBe(9000); // charge = cloture T1
    expect(r.byPartnerMonth.Vincent['2026-04']).toBe(9000);       // decaissement inchange
    expect(r.byMonthCharge['2026-03']).toBe(9000);
  });

  it('charge etage 1 : statut a_venir quand le decaissement est futur', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10', participants: ['Vincent'] });
    const e = r.detailCharge.find(d => d.deal === 'a');
    expect(e.dateCharge).toBe('2026-03');
    expect(e.dateDecaissement).toBe('2026-04');
    expect(e.statut).toBe('a_venir');
  });

  it('charge a payer (R4) : charge ET decaissement clos -> report au plancher du trimestre courant (T3), statut "du", charge due ECRITE (jamais null/absente)', () => {
    // dealT1() : charge theorique 2026-03, decaissement 2026-04. now = juillet -> les deux sont clos.
    // Decision 2026-08-02 : une prime facturee non versee est une charge a payer, toujours ecrite au
    // previsionnel ; ici report au dernier mois du T3 courant (septembre), jamais mise a null.
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-07-15', participants: ['Vincent'] });
    const e = r.detailCharge.find(d => d.deal === 'a');
    expect(e.dateCharge).toBe('2026-09');
    expect(e.statut).toBe('du');
    expect(e.dateDecaissement).toBe('2026-04');
    expect(r.byPartnerMonthCharge.Vincent['2026-09']).toBe(9000);
    expect(r.byMonthCharge['2026-09']).toBe(9000);
  });

  it('charge a payer (R4) : charge close mais decaissement au mois courant -> report au plancher du trimestre courant (T2), statut a_venir', () => {
    // dealT1() : charge theorique 2026-03 (close), decaissement 2026-04 = mois courant (pas encore clos).
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-04-10', participants: ['Vincent'] });
    const e = r.detailCharge.find(d => d.deal === 'a');
    expect(e.dateCharge).toBe('2026-06');
    expect(e.dateDecaissement).toBe('2026-04');
    expect(e.statut).toBe('a_venir');
    expect(r.byPartnerMonthCharge.Vincent['2026-06']).toBe(9000);
    expect(r.byMonthCharge['2026-06']).toBe(9000);
  });

  it('charge a payer (R4) : garde-fou exercice, une charge d\'un exercice antérieur clos n\'est PAS reportée dans l\'exercice courant', () => {
    // Deal facture au T3 2026 (charge theorique = dernier mois du T3 = septembre, decaissement = octobre).
    // now = 2027-02-15 : on calcule encore l'exercice 2026 (year: 2026, comme le fait le multi-exercice
    // de server.js) mais "aujourd'hui" est deja dans l'exercice 2027. Le report au plancher (floorChargeKey)
    // ne doit jamais faire franchir la frontiere d'exercice : dateCharge doit rester dans l'annee de la
    // charge theorique (2026), pas glisser vers le plancher de l'exercice courant reel (2027-03).
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: '2026-08-20' })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2027-02-15', participants: ['Vincent'] });
    const e = r.detailCharge.find(d => d.deal === 'a');
    expect(e.dateCharge).toBe('2026-09'); // pas '2027-03' (floorChargeKey de l'exercice 2027) : pas de report
    expect(e.statut).toBe('du');
    expect(e.dateDecaissement).toBe('2026-10');
    expect(r.byPartnerMonthCharge.Vincent['2026-09']).toBe(9000);
    expect(r.byMonthCharge['2026-09']).toBe(9000);
    // Aucune cle 2027 : le report ne franchit jamais la frontiere d'exercice.
    expect(Object.keys(r.byPartnerMonthCharge.Vincent).some(mk => mk.startsWith('2027-'))).toBe(false);
  });

  it('provision : deal non facture pose une charge au trimestre courant ouvert (statut provisoire)', () => {
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: null })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-08-10', participants: ['Vincent'] });
    expect(r.byPartnerMonthCharge.Vincent['2026-09']).toBe(9000); // T3 courant -> sept
    expect(r.enAttente).toBe(9000);                                 // conserve
    const e = r.detailCharge.find(d => d.deal === 'a');
    expect(e.statut).toBe('provisoire');
    expect(e.dateDecaissement).toBeNull();
    expect(r.byMonth['2026-09']).toBeUndefined();                   // aucun decaissement
  });

  it('provision : la meme provision (deal jamais facture) glisse avec `now`, quelle que soit l\'annee de signature -> l\'appelant DOIT filtrer par exercice courant', () => {
    // Deal signe en 2025, jamais facture. computePrimePayments EST appele avec year: 2025 (l'annee de
    // signature, comme le fait la boucle multi-exercice de server.js::computePrimesChargeSchedule), mais
    // le plancher de charge (floorChargeKey) est calcule depuis `now`, pas depuis `year`. Consequence :
    // si on rejoue ce meme calcul chaque annee (exercice 2026 puis 2027) sans filtrer sur l'annee de
    // signature, la MEME provision retombe a chaque fois dans le prefixe de l'exercice courant -> elle
    // serait chargee plusieurs fois. C'est exactement pourquoi server.js ne retient les entrees
    // 'provisoire' que pour y === currentYear (les millesimes N-2/N-1 sont ecartes).
    const deal = dealT1({ dateSignature: '2025-02-01', dateFactureAcompte: null });
    const rExercice2026 = computePrimePayments({ missions: [deal], splits: [], config: cfg, year: 2025, caFacture: 0, versements: [], now: '2026-08-10', participants: ['Vincent'] });
    const eExercice2026 = rExercice2026.detailCharge.find(d => d.deal === 'a');
    expect(eExercice2026.statut).toBe('provisoire');
    expect(eExercice2026.dateCharge).toBe('2026-09'); // plancher T3 de l'exercice 2026 (now)

    const rExercice2027 = computePrimePayments({ missions: [deal], splits: [], config: cfg, year: 2025, caFacture: 0, versements: [], now: '2027-08-10', participants: ['Vincent'] });
    const eExercice2027 = rExercice2027.detailCharge.find(d => d.deal === 'a');
    expect(eExercice2027.statut).toBe('provisoire');
    expect(eExercice2027.dateCharge).toBe('2027-09'); // plancher T3 de l'exercice 2027 (now) : re-provisionnee

    // La meme provision (meme deal, jamais facture) est donc "chargee" dans les deux exercices si rien
    // ne filtre sur l'annee de signature : preuve que le filtre vit forcement chez l'appelant.
    expect(rExercice2026.byPartnerMonthCharge.Vincent['2026-09']).toBe(9000);
    expect(rExercice2027.byPartnerMonthCharge.Vincent['2027-09']).toBe(9000);
  });

  it('charge etage 2 : datee en decembre N (provisoire), decaissement en mars N+1', () => {
    const r = computePrimePayments({ missions: [], splits: [], config: cfg, year: 2026, caFacture: 660000, versements: [], now: '2026-07-15', participants: ['Vincent', 'Guillaume', 'Nathan'] });
    expect(r.byMonthCharge['2026-12']).toBe(10500);              // charge dec N
    expect(r.byMonth['2027-03']).toBe(10500);                    // decaissement inchange (N+1)
    expect(r.byPartnerMonthCharge.Vincent['2026-12']).toBe(3500);
    const e2 = r.detailCharge.find(d => d.etage === 2 && d.partner === 'Vincent');
    expect(e2.dateCharge).toBe('2026-12');
    expect(e2.statut).toBe('provisoire');
  });

  it('R5 : pastPolicy "drop" abandonne le decaissement etage 2 mais la charge decembre N reste posee', () => {
    // Decaissement theorique 2026-03 (annee+1 par defaut) < now 2026-07 -> passe -> drop l'abandonne.
    // La charge (rattachee a l'exercice N=2025, donc 2025-12) ne doit pas dependre de ce drop.
    const r = computePrimePayments({ missions: [], splits: [], config: cfg, year: 2025, caFacture: 660000, versements: [], now: '2026-07-15', pastPolicy: 'drop', participants: ['Vincent', 'Guillaume', 'Nathan'] });
    expect(r.byMonthCharge['2025-12']).toBe(10500);               // charge dec N toujours posee
    expect(Object.keys(r.byMonth).length).toBe(0);                // decaissement abandonne (drop)
    expect(r.byPartnerMonthCharge.Vincent['2025-12']).toBe(3500);
    const e2 = r.detailCharge.find(d => d.etage === 2 && d.partner === 'Vincent');
    expect(e2.statut).toBe('provisoire');
    expect(e2.dateDecaissement).toBe('2026-03');                  // decaissement theorique (avant rattrapage/drop)
  });
});

describe('selectChargeEntriesForExercice : filtre exercice + provision, garde-fou anti-double-compte (R3/R8)', () => {
  // Un extrait realiste de detailCharge : une charge 'du' dans l'exercice courant, une charge 'a_venir'
  // hors exercice (annee suivante), et une provision dans l'exercice courant.
  const entries = [
    { deal: 'a', partner: 'Vincent', dateCharge: '2026-03', statut: 'du', montant: 100 },
    { deal: 'b', partner: 'Vincent', dateCharge: '2027-01', statut: 'a_venir', montant: 50 },
    { deal: 'c', partner: 'Vincent', dateCharge: '2026-09', statut: 'provisoire', montant: 30 },
  ];

  it('ecarte les entrees dont la dateCharge tombe hors de l\'exercice courant', () => {
    const r = selectChargeEntriesForExercice(entries, 2026, 2026);
    expect(r.map(e => e.deal).sort()).toEqual(['a', 'c']); // 'b' (2027) exclu
  });

  it('ecarte une provision dont l\'annee de SIGNATURE differe de l\'exercice courant, meme si sa dateCharge tombe dedans (R3)', () => {
    // signatureYear = 2025 (deal signe l'an dernier, jamais facture, provision glissante) ; currentYear = 2026.
    const r = selectChargeEntriesForExercice(entries, 2025, 2026);
    // 'a' (statut 'du', pas une provision) reste retenu ; 'c' (provisoire, signatureYear != currentYear) est ecarte.
    expect(r.map(e => e.deal)).toEqual(['a']);
  });

  it('conserve la provision quand l\'annee de signature EST l\'exercice courant', () => {
    const r = selectChargeEntriesForExercice(entries, 2026, 2026);
    expect(r.some(e => e.deal === 'c')).toBe(true);
  });

  it('garde-fou anti-double-compte : sans le filtre de provision, la meme provision glissante serait retenue pour CHAQUE exercice de signature -> le filtre doit la reserver au seul exercice courant', () => {
    const provision = [{ deal: 'p', partner: 'Vincent', dateCharge: '2026-09', statut: 'provisoire', montant: 500 }];
    // Enumeration multi-exercice (comme server.js::computePrimesChargeSchedule) : signatureYear parcourt
    // currentYear-2 .. currentYear. Un seul de ces appels doit retenir la provision.
    const retenues = [2024, 2025, 2026].filter(signatureYear => selectChargeEntriesForExercice(provision, signatureYear, 2026).length > 0);
    expect(retenues).toEqual([2026]);
  });
});

describe('computePrimesChargeForExercice : cloture souple des primes (grace, feature D)', () => {
  const cfg = {
    rates: { Vincent: { txNew: 4.5, txRepeat: 2.5 } },
    tiers: [{ seuil: 650000, taux: 7 }, { seuil: 600000, taux: 5 }, { seuil: 550000, taux: 3 }],
    resultatAnnuel: 150000,
    gateTrimestriel: 120000,
  };
  // Deal signe ET facture (acompte) au T4 2025 : le scenario documente par la spec D ("une charge de
  // prime du T4 saisie apres le 31/12"). Charge theorique = dernier mois du T4 2025 = decembre 2025.
  const dealT4N1 = (over = {}) => mission({
    id: 'q4n1', typeCa: 'Newsale', dateSignature: '2025-11-05', partnerCommercial: ['Vincent'],
    ca: 200000, etat: 'Signé', dateFactureAcompte: '2025-12-20', ...over,
  });
  const base = { splits: [], config: cfg, factOverrides: [], participants: ['Vincent'] };

  it('endOfYearIso : 31 decembre 23:59:59.999 UTC de l\'annee donnee', () => {
    expect(endOfYearIso(2025)).toBe('2025-12-31T23:59:59.999Z');
  });

  it('SANS le 2e passage (comme le fait computePrimesChargeSchedule hors grace, now = 10 janvier 2026) : la charge T4/2025 est perdue', () => {
    // Reproduit exactement l'appel "exercice courant" que fait computePrimesChargeSchedule (targetYear
    // = annee reelle, asOfIso = maintenant reel) : c'est le bug documente par la spec D, reproduit ici
    // AVANT le correctif (le 2e passage grace n'est pas encore ajoute a cet appel).
    const r = computePrimesChargeForExercice({ ...base, missions: [dealT4N1()], targetYear: 2026, asOfIso: '2026-01-10T09:00:00.000Z' });
    expect(r.detailCharge.find((e) => e.deal === 'q4n1')).toBeUndefined();
    expect(r.floatByPartnerMonth.Vincent).toBeUndefined();
  });

  it('meme cas au 25 janvier (hors grace, PRIMES_GRACE_JOURS=20 par defaut) : comportement actuel inchange, toujours perdue par ce seul passage', () => {
    const r = computePrimesChargeForExercice({ ...base, missions: [dealT4N1()], targetYear: 2026, asOfIso: '2026-01-25T09:00:00.000Z' });
    expect(r.detailCharge.find((e) => e.deal === 'q4n1')).toBeUndefined();
  });

  it('AVEC le 2e passage grace (targetYear=2025, asOfIso=fin d\'exercice 2025) : la charge T4/2025 est retenue, ECRITE EN DECEMBRE 2025 (jamais reportee vers 2026, jamais perdue)', () => {
    // C'est exactement l'appel supplementaire que server.js::computePrimesChargeSchedule ajoute PENDANT
    // LA GRACE (primesMap.isPrimesGraceActive), en PLUS de l'appel normal ci-dessus (qui reste vide pour
    // ce deal).
    const r = computePrimesChargeForExercice({ ...base, missions: [dealT4N1()], targetYear: 2025, asOfIso: endOfYearIso(2025) });
    const e = r.detailCharge.find((x) => x.deal === 'q4n1');
    expect(e).toBeDefined();
    expect(e.dateCharge).toBe('2025-12');
    expect(r.floatByPartnerMonth.Vincent['2025-12']).toBe(9000); // 200000 * 4.5%
  });

  it('fusion des deux passages (comme le fait computePrimesChargeSchedule pendant la grace) : exactement UNE entree pour ce deal, aucun double compte', () => {
    const passNormal = computePrimesChargeForExercice({ ...base, missions: [dealT4N1()], targetYear: 2026, asOfIso: '2026-01-10T09:00:00.000Z' });
    const passGrace = computePrimesChargeForExercice({ ...base, missions: [dealT4N1()], targetYear: 2025, asOfIso: endOfYearIso(2025) });
    const merged = [...passNormal.detailCharge, ...passGrace.detailCharge].filter((e) => e.deal === 'q4n1');
    expect(merged.length).toBe(1);
    expect(merged[0].dateCharge).toBe('2025-12');
  });

  it('deal signe T4/2025 mais JAMAIS facture (provision) : la grace le garde provisoire en decembre 2025, pas perdu, pas retenu par le passage normal (R3)', () => {
    const dealNonFacture = dealT4N1({ id: 'q4n1-prov', dateFactureAcompte: null });
    const passNormal = computePrimesChargeForExercice({ ...base, missions: [dealNonFacture], targetYear: 2026, asOfIso: '2026-01-10T09:00:00.000Z' });
    expect(passNormal.detailCharge.find((e) => e.deal === 'q4n1-prov')).toBeUndefined(); // signatureYear(2025) != targetYear(2026), R3

    const passGrace = computePrimesChargeForExercice({ ...base, missions: [dealNonFacture], targetYear: 2025, asOfIso: endOfYearIso(2025) });
    const e = passGrace.detailCharge.find((x) => x.deal === 'q4n1-prov');
    expect(e).toBeDefined();
    expect(e.statut).toBe('provisoire');
    expect(e.dateCharge).toBe('2025-12'); // plancher T4 de l'exercice REJOUE (asOfIso = fin 2025)
  });

  it('deal signe en 2025 mais dont l\'acompte est REELLEMENT facture en 2026 : reste rattache a l\'exercice 2026, jamais aspire par le passage grace (R8, pas de double compte)', () => {
    const dealFactureEnN = mission({
      id: 'facture-en-n', typeCa: 'Newsale', dateSignature: '2025-11-05', partnerCommercial: ['Vincent'],
      ca: 200000, etat: 'Signé', dateFactureAcompte: '2026-01-15',
    });
    const passNormal = computePrimesChargeForExercice({ ...base, missions: [dealFactureEnN], targetYear: 2026, asOfIso: '2026-01-20T09:00:00.000Z' });
    const eN = passNormal.detailCharge.find((e) => e.deal === 'facture-en-n');
    expect(eN).toBeDefined();
    expect(eN.dateCharge).toBe('2026-03'); // T1 2026 (facture reelle le 15/01/2026)

    const passGrace = computePrimesChargeForExercice({ ...base, missions: [dealFactureEnN], targetYear: 2025, asOfIso: endOfYearIso(2025) });
    expect(passGrace.detailCharge.find((e) => e.deal === 'facture-en-n')).toBeUndefined();
  });
});
