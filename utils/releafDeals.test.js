'use strict';
const {
  normTags, hasTag, statutsDeals, validerCreation, echecCertainHubspot, vueDeal, avecReprise429,
  normEmail, validerContact,
} = require('./releafDeals');

const STAGES = { 'RDV Qualif': 'qualifiedtobuy', 'closedlost': 'closedlost' };

describe('normTags / hasTag', () => {
  test('tableau, chaîne JSON, chaîne simple, vide', () => {
    expect(normTags(['a'])).toEqual(['a']);
    expect(normTags('["a","b"]')).toEqual(['a', 'b']);
    expect(normTags('a')).toEqual(['a']);
    expect(normTags(null)).toEqual([]);
  });
  test('la casse ne compte pas', () => {
    expect(hasTag(['Prospection'], 'prospection')).toBe(true);
    expect(hasTag('["prospection"]', 'Prospection')).toBe(true);
    expect(hasTag(['EPD'], 'prospection')).toBe(false);
  });
});

describe('statutsDeals', () => {
  const actifs = [
    { id: '100', properties: {} },
    { id: '200', properties: { hs_merged_object_ids: '201;202' } },
  ];
  const corbeille = [{ id: '300', properties: {} }];

  test('existe, fusionné, corbeille, inconnu', () => {
    expect(statutsDeals(['100', '201', '300', '999'], actifs, corbeille)).toEqual([
      { id: '100', statut: 'existe', dealId: '100' },
      { id: '201', statut: 'fusionne', dealId: '200' },
      { id: '300', statut: 'corbeille', dealId: null },
      { id: '999', statut: 'inconnu', dealId: null },
    ]);
  });
  test('les ids numériques sont comparés comme des chaînes', () => {
    expect(statutsDeals([100], actifs, [])[0].statut).toBe('existe');
  });
});

describe('validerCreation', () => {
  test('demande complète normalisée', () => {
    const v = validerCreation({
      name: ' FDES - Perin ', stage: 'RDV Qualif', tags: ['Prospection', '', 3],
      assignee: 'Nathan', cle_externe: 'canopy:abc', contactEmail: ' Jean.Dupont@Perin.fr ',
    }, STAGES);
    expect(v).toMatchObject({
      name: 'FDES - Perin', stageId: 'qualifiedtobuy', tags: ['Prospection'],
      assignee: 'Nathan', cleExterne: 'canopy:abc', contactEmail: 'jean.dupont@perin.fr',
    });
  });
  test('sans clé ni responsable : acceptée', () => {
    const v = validerCreation({ name: 'X', stage: 'RDV Qualif', contactEmail: 'a@b.fr' }, STAGES);
    expect(v.cleExterne).toBeNull();
    expect(v.assignee).toBeNull();
  });
  test('refus', () => {
    expect(validerCreation({ stage: 'RDV Qualif' }, STAGES).erreur).toMatch(/requis/);
    expect(validerCreation({ name: 'X', stage: 'Inconnue' }, STAGES).erreur).toMatch(/stage inconnu/);
    expect(validerCreation({ name: 'X', stage: 'RDV Qualif', contactEmail: 'a@b.fr', assignee: 'Léo' }, STAGES).erreur).toMatch(/assignee/);
    expect(validerCreation({ name: 'X', stage: 'RDV Qualif', contactEmail: 'a@b.fr', tags: 'a' }, STAGES).erreur).toMatch(/tags/);
    expect(validerCreation({ name: 'X', stage: 'RDV Qualif', contactEmail: 'a@b.fr', cle_externe: 'x'.repeat(201) }, STAGES).erreur).toMatch(/cle_externe/);
  });
  test('plus de deal sans contact (Consolider, étape 9)', () => {
    expect(validerCreation({ name: 'X', stage: 'RDV Qualif' }, STAGES).erreur).toBe('contactEmail requis');
    expect(validerCreation({ name: 'X', stage: 'RDV Qualif', contactEmail: '' }, STAGES).erreur).toBe('contactEmail requis');
    expect(validerCreation({ name: 'X', stage: 'RDV Qualif', contactEmail: 'jean.perin' }, STAGES).erreur).toMatch(/contactEmail invalide/);
  });
});

describe('normEmail', () => {
  test('normalise une adresse valide', () => {
    expect(normEmail('  Jean.Dupont@Perin.FR ')).toBe('jean.dupont@perin.fr');
  });
  test('refuse les fautes de frappe évidentes', () => {
    for (const e of ['jean.perin', 'jean@perin', '@perin.fr', 'jean @perin.fr', 'a@b@c.fr', '', null, 42]) {
      expect(normEmail(e)).toBeNull();
    }
  });
});

describe('validerContact', () => {
  test('email normalisé, remplacement explicite seulement', () => {
    expect(validerContact({ contactEmail: 'A@B.fr' })).toEqual({
      contactEmail: 'a@b.fr', contactName: null, company: null, remplacer: false,
    });
    expect(validerContact({ contactEmail: 'a@b.fr', remplacer: 'true' }).remplacer).toBe(false);
    expect(validerContact({ contactEmail: 'a@b.fr', remplacer: true }).remplacer).toBe(true);
  });
  test('refus', () => {
    expect(validerContact({}).erreur).toBe('contactEmail requis');
    expect(validerContact({ contactEmail: 'x' }).erreur).toMatch(/invalide/);
  });
});

describe('echecCertainHubspot', () => {
  test('une réponse HTTP de HubSpot prouve que rien n\'a été créé', () => {
    expect(echecCertainHubspot(new Error('HubSpot POST 400: {"message":"bad"}'))).toBe(true);
    expect(echecCertainHubspot(new Error('HubSpot POST 503: down'))).toBe(true);
  });
  test('une coupure réseau ne prouve rien', () => {
    expect(echecCertainHubspot(new Error('socket hang up'))).toBe(false);
    expect(echecCertainHubspot(new Error('ECONNRESET'))).toBe(false);
    expect(echecCertainHubspot(null)).toBe(false);
  });
});

describe('vueDeal', () => {
  test('propriétés HubSpot + compléments Pilot', () => {
    const v = vueDeal('42', {
      dealname: 'EPD - X', dealstage: 'closedlost', amount: '1200', hs_is_closed: 'true',
      hs_is_closed_won: 'false', hs_merged_object_ids: '7;8',
    }, {
      tags: '["Prospection"]', assignee: 'Vincent', contact_email: 'jean@x.fr',
      relances: [{ at: 't1' }, { at: 't2' }], tasks: [{ status: 'todo' }, { status: 'done' }],
    }, { closedlost: 'Perdu' }, {});
    expect(v).toMatchObject({
      dealId: '42', name: 'EPD - X', stage: 'Perdu', amount: 1200, isClosed: true, isWon: false,
      mergedIds: ['7', '8'], relanceCount: 2, lastRelanceAt: 't2', openTasks: 1,
      tags: ['Prospection'], assignee: 'Vincent', contactEmail: 'jean@x.fr',
    });
  });
  test('sans compléments Pilot', () => {
    const v = vueDeal('1', { dealname: 'Y', dealstage: 'qualifiedtobuy' }, undefined, {}, {});
    expect(v).toMatchObject({ tags: [], assignee: null, contactEmail: null, relanceCount: 0, mergedIds: [] });
  });
});

describe('avecReprise429', () => {
  const sansAttente = { attendre: async () => {} };
  const limite = () => new Error('HubSpot Search API 429: {"message":"You have reached your secondly limit."}');

  test('rejoue après un 429 et rend le résultat', async () => {
    let appels = 0;
    const r = await avecReprise429(async () => { appels++; if (appels < 3) throw limite(); return 'ok'; }, sansAttente);
    expect(r).toBe('ok');
    expect(appels).toBe(3);
  });

  test("abandonne après le nombre d'essais prévu", async () => {
    let appels = 0;
    await expect(avecReprise429(async () => { appels++; throw limite(); }, sansAttente)).rejects.toThrow('429');
    expect(appels).toBe(3);
  });

  test('ne rejoue pas une autre erreur', async () => {
    let appels = 0;
    await expect(avecReprise429(async () => { appels++; throw new Error('HubSpot POST 400: bad'); }, sansAttente)).rejects.toThrow('400');
    expect(appels).toBe(1);
  });

  test('reconnaît aussi un 429 des écritures batch', async () => {
    let appels = 0;
    const r = await avecReprise429(async () => { appels++; if (appels === 1) throw new Error('HubSpot POST 429: x'); return 1; }, sansAttente);
    expect(r).toBe(1);
  });
});
