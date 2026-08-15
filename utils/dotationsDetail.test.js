'use strict';

// Tests du detail des dotations par immobilisation (spec B.1, correctif d'annee B.2, perimetre
// « immo a postes » de la precision B.5). C'est le volet testable de l'invariant I8 : les jeux sont
// synthetiques (poste a annee NULL, actif mixte, immo passee en charges) et les helpers de calcul sont
// INJECTES, donc simples et deterministes. On verifie l'orchestration du module, pas les formules
// d'amortissement de server.js (testees ailleurs, et volontairement non dupliquees ici).

const {
  normaliserPostesImmo,
  normaliserPostesByImmo,
  nomImmoAffichage,
  estImmoAPostes,
  buildDotationsDetail,
} = require('./dotationsDetail');

// Helpers injectes, volontairement grossiers mais deterministes :
//   - base amortissable = somme des montants des postes s'il y en a, sinon le montant saisi ;
//   - dotation = montant / duree, uniquement pour une immo 'immobilise' et a partir de son annee de
//     mise en service (permet de verifier que `year` est bien transmis par le module).
const montantAmortissable = (immo, postes) => (postes && postes.length)
  ? postes.reduce((s, p) => s + (Number(p.montant) || 0), 0)
  : (Number(immo.montant) || 0);
const computeDotationForYear = (immo, year) => {
  if (!immo || immo.traitement !== 'immobilise') return 0;
  const y0 = immo.date_mise_en_service ? new Date(immo.date_mise_en_service).getFullYear() : 0;
  if (year < y0) return 0;
  return Math.round((Number(immo.montant) || 0) / (Number(immo.duree_annees) || 1));
};
const helpers = { montantAmortissable, computeDotationForYear };

const immo = (over = {}) => ({
  id: 'i1',
  libelle: 'Immo test',
  traitement: 'immobilise',
  duree_annees: 5,
  date_mise_en_service: '2026-01-01',
  montant: 0,
  ...over,
});
const poste = (over = {}) => ({ id: 'p1', montant: 1000, annee: 2026, ...over });

describe('normaliserPostesImmo · correctif B.2 (annee NULL)', () => {
  test('un poste sans annee est rattache a l annee de mise en service', () => {
    const i = immo({ date_mise_en_service: '2025-07-01' });
    const [p] = normaliserPostesImmo(i, [poste({ annee: null })]);
    expect(p.annee).toBe(2025);
  });

  test('annee absente (undefined) : meme repli', () => {
    const i = immo({ date_mise_en_service: '2024-03-15' });
    const brut = poste();
    delete brut.annee;
    expect(normaliserPostesImmo(i, [brut])[0].annee).toBe(2024);
  });

  test('sans date de mise en service exploitable, repli sur l annee courante (jamais NaN)', () => {
    const attendue = new Date().getFullYear();
    expect(normaliserPostesImmo(immo({ date_mise_en_service: null }), [poste({ annee: null })])[0].annee).toBe(attendue);
    expect(normaliserPostesImmo(immo({ date_mise_en_service: 'pas-une-date' }), [poste({ annee: null })])[0].annee).toBe(attendue);
  });

  test('une annee deja renseignee est conservee telle quelle, et l entree n est jamais mutee', () => {
    const i = immo({ date_mise_en_service: '2026-01-01' });
    const source = poste({ annee: 2024 });
    const [p] = normaliserPostesImmo(i, [source]);
    expect(p.annee).toBe(2024);
    expect(source.annee).toBe(2024);
    expect(p).not.toBe(source); // copie, pas la reference d'origine
  });

  test('actif mixte (un poste date, un poste a annee NULL) : chaque poste garde SA lecture', () => {
    const i = immo({ date_mise_en_service: '2027-05-01' });
    const postes = normaliserPostesImmo(i, [poste({ id: 'a', annee: 2026 }), poste({ id: 'b', annee: null })]);
    expect(postes.map(p => p.annee)).toEqual([2026, 2027]);
  });

  test('liste de postes absente : tableau vide', () => {
    expect(normaliserPostesImmo(immo(), null)).toEqual([]);
    expect(normaliserPostesImmo(immo(), undefined)).toEqual([]);
  });
});

describe('normaliserPostesByImmo · map complete', () => {
  test('une entree par immo, meme sans poste, avec le repli de CHAQUE immo', () => {
    const a = immo({ id: 'a', date_mise_en_service: '2025-01-01' });
    const b = immo({ id: 'b', date_mise_en_service: '2028-01-01' });
    const map = normaliserPostesByImmo([a, b], { a: [poste({ annee: null })] });
    expect(map.a[0].annee).toBe(2025);
    expect(map.b).toEqual([]);
  });

  test('entrees vides ou nulles : ne jette jamais', () => {
    expect(normaliserPostesByImmo([], {})).toEqual({});
    expect(normaliserPostesByImmo(null, null)).toEqual({});
    expect(normaliserPostesByImmo([null, undefined], {})).toEqual({});
  });
});

describe('estImmoAPostes · perimetre (precision B.5)', () => {
  test('immobilise + au moins un poste = true (booleen STRICT)', () => {
    expect(estImmoAPostes(immo(), [poste()])).toBe(true);
  });

  test('immobilise sans poste = false', () => {
    expect(estImmoAPostes(immo(), [])).toBe(false);
  });

  test('immo passee en CHARGES avec des postes = false (hors perimetre)', () => {
    expect(estImmoAPostes(immo({ traitement: 'charge' }), [poste()])).toBe(false);
  });

  test('entrees degradees : false, jamais d exception', () => {
    expect(estImmoAPostes(null, [poste()])).toBe(false);
    expect(estImmoAPostes(immo(), null)).toBe(false);
  });
});

describe('buildDotationsDetail · structure de sortie', () => {
  test('total = somme des dotations, une ligne par immo, `year` bien transmis aux helpers', () => {
    const a = immo({ id: 'a', libelle: 'SaaS', montant: 0, duree_annees: 5, date_mise_en_service: '2026-01-01' });
    const b = immo({ id: 'b', libelle: 'Serveur', montant: 50000, duree_annees: 5, date_mise_en_service: '2026-01-01' });
    const map = normaliserPostesByImmo([a, b], { a: [poste({ montant: 100000, annee: null })] });

    const r2026 = buildDotationsDetail([a, b], map, 2026, helpers);
    expect(r2026.total).toBe(30000); // 100000/5 (base = postes) + 50000/5 (base = montant saisi)
    expect(r2026.parImmo).toEqual([
      { nom: 'SaaS', dotation: 20000, aPostes: true, assietteCredit: 'depenses' },
      { nom: 'Serveur', dotation: 10000, aPostes: false, assietteCredit: 'depenses' },
    ]);

    // Annee anterieure a la mise en service : le helper injecte renvoie 0, donc total 0 et lignes a 0.
    const r2025 = buildDotationsDetail([a, b], map, 2025, helpers);
    expect(r2025.total).toBe(0);
    expect(r2025.parImmo.map(l => l.dotation)).toEqual([0, 0]);
  });

  test('aPostes suit le perimetre : une immo en charges avec postes reste CONSERVEE', () => {
    const i = immo({ id: 'c', traitement: 'charge', montant: 9000 });
    const map = normaliserPostesByImmo([i], { c: [poste()] });
    const { parImmo, total } = buildDotationsDetail([i], map, 2026, helpers);
    expect(parImmo[0].aPostes).toBe(false);
    expect(total).toBe(0); // aucune dotation : le helper ignore les immos non immobilisees
  });

  test('repli du nom : libelle, puis nom, puis titre, puis defaut', () => {
    const immos = [
      immo({ id: '1', libelle: 'Avec libelle' }),
      immo({ id: '2', libelle: null, nom: 'Avec nom' }),
      immo({ id: '3', libelle: null, nom: null, titre: 'Avec titre' }),
      immo({ id: '4', libelle: '   ' }),
    ];
    const noms = buildDotationsDetail(immos, {}, 2026, helpers).parImmo.map(l => l.nom);
    expect(noms).toEqual(['Avec libelle', 'Avec nom', 'Avec titre', 'Immobilisation sans libelle']);
    expect(nomImmoAffichage(null)).toBe('Immobilisation sans libelle');
  });

  test('assiette_credit remonte telle quelle, defaut methode A (`depenses`)', () => {
    const i = immo({ id: 'b', assiette_credit: 'amortissement' });
    const map = normaliserPostesByImmo([i], { b: [poste()] });
    expect(buildDotationsDetail([i], map, 2026, helpers).parImmo[0].assietteCredit).toBe('amortissement');
    expect(buildDotationsDetail([immo()], {}, 2026, helpers).parImmo[0].assietteCredit).toBe('depenses');
  });
});

describe('buildDotationsDetail · tolerance et contrat d injection', () => {
  test('listes vides ou absentes : { total: 0, parImmo: [] }', () => {
    expect(buildDotationsDetail([], {}, 2026, helpers)).toEqual({ total: 0, parImmo: [] });
    expect(buildDotationsDetail(null, null, 2026, helpers)).toEqual({ total: 0, parImmo: [] });
    expect(buildDotationsDetail([null], {}, 2026, helpers)).toEqual({ total: 0, parImmo: [] });
  });

  test('map de postes absente : les immos sont traitees sans poste (base = montant saisi)', () => {
    const r = buildDotationsDetail([immo({ montant: 50000 })], undefined, 2026, helpers);
    expect(r.total).toBe(10000);
    expect(r.parImmo[0].aPostes).toBe(false);
  });

  test('helper manquant : erreur bruyante (cablage), jamais un total de 0 € silencieux', () => {
    expect(() => buildDotationsDetail([immo()], {}, 2026, {})).toThrow(TypeError);
    expect(() => buildDotationsDetail([immo()], {}, 2026, { montantAmortissable })).toThrow(/helpers/);
    expect(() => buildDotationsDetail([immo()], {}, 2026)).toThrow(/montantAmortissable/);
  });
});
