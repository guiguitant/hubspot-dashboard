'use strict';
const { computeKpi, totalCaAnnee, signedByQuarter, clawbackCandidates, quarterOfDate, OPERE_STATES, SIGNE_EXCLUDED_STATES } = require('./kpiCompute');

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
