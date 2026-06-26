'use strict';
const { computeKpi, OPERE_STATES, SIGNE_EXCLUDED_STATES } = require('./kpiCompute');

// Helper : fabrique une mission avec des valeurs par défaut raisonnables.
function mission(over = {}) {
  return {
    id: 'm1', nom: 'Mission', client: 'Client', ca: 10000,
    etat: 'En cours', typeCa: 'Newsale',
    partnerCommercial: ['Vincent'], partnerOperationnel: ['Guillaume'],
    dateCreation: '2026-03-01T10:00:00.000Z',
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

  it('mauvaise année → mission ignorée', () => {
    const r = computeKpi({ missions: [mission({ dateCreation: '2025-12-31T23:00:00.000Z' })], objectives: [], splits: [], year: 2026 });
    expect(r.partners).toEqual([]);
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
    expect(m.splitCommercial).toEqual({ Vincent: 50, Nathan: 50 });
    expect(m.splitOperationnel).toEqual({ Guillaume: 100 });
  });

  it('mission à 1 seul partner par axe → pas listée', () => {
    const r = computeKpi({ missions: [mission()], objectives: [], splits: [], year: 2026 });
    expect(r.missionsForSplit).toEqual([]);
  });
});
