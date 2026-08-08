'use strict';
const { computeProductionImmobilisee } = require('./productionImmobilisee');

// Fabriques minimales : on ne cree que les champs lus par le module (schema reel des tables
// `immobilisations` / `immobilisation_postes`, cf migrations 32 a 40).
const immo = (id, over = {}) => ({
  id,
  libelle: 'Immo ' + id,
  traitement: 'immobilise',
  date_mise_en_service: '2026-11-02',
  ...over,
});
const poste = (over = {}) => ({
  id: 'p-' + Math.random().toString(36).slice(2),
  libelle: 'Poste',
  source: 'salaire',
  montant: 0,
  quote_part: 100,
  prorata_temporel: true,
  annee: 2026,
  date_debut: null,
  date_fin: null,
  ...over,
});

describe('computeProductionImmobilisee · perimetre', () => {
  it('ignore une immo passee directement en charge (traitement != immobilise)', () => {
    const immos = [immo('a', { traitement: 'charge' })];
    const postes = { a: [poste({ montant: 50000 })] };
    const r = computeProductionImmobilisee(immos, postes, 2026, '2026-12-31');
    expect(r.projete).toBe(0);
    expect(r.factuel).toBe(0);
    expect(r.parImmo).toEqual([]);
  });

  it('renvoie 0 quand l annee demandee n a aucun poste', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 50000, annee: 2025 })] };
    const r = computeProductionImmobilisee(immos, postes, 2026, '2026-12-31');
    expect(r.projete).toBe(0);
    expect(r.parImmo).toEqual([]);
  });

  it('tolere des entrees vides ou absentes (tables Supabase absentes)', () => {
    expect(computeProductionImmobilisee([], {}, 2026, '2026-12-31')).toEqual({ projete: 0, factuel: 0, parImmo: [] });
    expect(computeProductionImmobilisee(null, null, 2026, null)).toEqual({ projete: 0, factuel: 0, parImmo: [] });
  });

  it('utilise le libelle de l immo comme nom (champ reel du schema)', () => {
    const immos = [immo('a', { libelle: 'SaaS Releaf' })];
    const postes = { a: [poste({ montant: 10000, prorata_temporel: false })] };
    const r = computeProductionImmobilisee(immos, postes, 2026, '2026-12-31');
    expect(r.parImmo).toEqual([{ nom: 'SaaS Releaf', projete: 10000, factuel: 10000 }]);
  });
});

describe('computeProductionImmobilisee · projete (retenu annuel)', () => {
  it('applique la quote-part d affectation', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 60000, quote_part: 20 })] };
    expect(computeProductionImmobilisee(immos, postes, 2026, null).projete).toBe(12000);
  });

  it('traite une quote-part absente comme 100 %', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 60000, quote_part: null })] };
    expect(computeProductionImmobilisee(immos, postes, 2026, null).projete).toBe(60000);
  });

  it('proratise un poste continu sur la fenetre x annee (cas reel SaaS 2026)', () => {
    // Fenetre 20/02/2026 -> 20/02/2028 : 315 jours sur les 365 de 2026, soit ~86 %.
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 100000, date_debut: '2026-02-20', date_fin: '2028-02-20' })] };
    expect(computeProductionImmobilisee(immos, postes, 2026, null).projete).toBe(86301);
  });

  it('ne proratise pas un poste ponctuel (prestation, prorata_temporel = false)', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 30000, source: 'prestation', prorata_temporel: false, date_debut: '2026-10-01' })] };
    expect(computeProductionImmobilisee(immos, postes, 2026, null).projete).toBe(30000);
  });

  it('somme plusieurs postes d une meme immo et plusieurs immos', () => {
    const immos = [immo('a'), immo('b')];
    const postes = {
      a: [poste({ montant: 40000, quote_part: 50 }), poste({ montant: 10000 })],
      b: [poste({ montant: 25000 })],
    };
    const r = computeProductionImmobilisee(immos, postes, 2026, null);
    expect(r.projete).toBe(55000);
    expect(r.parImmo.map(x => x.projete)).toEqual([30000, 25000]);
  });
});

describe('computeProductionImmobilisee · factuel (avancement au dernier mois clos)', () => {
  it('vaut 0 sans borne reelle (aucun mois clos)', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 120000 })] };
    expect(computeProductionImmobilisee(immos, postes, 2026, null).factuel).toBe(0);
  });

  it('vaut 0 quand la borne reelle precede l annee (exercice futur)', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 120000, annee: 2027 })] };
    expect(computeProductionImmobilisee(immos, postes, 2027, '2026-07-31').factuel).toBe(0);
  });

  it('vaut 0 pour un poste ponctuel d un exercice futur, meme si sa date de debut est passee', () => {
    // Cas reel : une prestation commandee en 2026 mais dont la tranche est imputee a 2027. Aucun jour
    // de 2027 n est clos, la part factuelle de 2027 doit donc rester nulle.
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 30000, annee: 2027, prorata_temporel: false, date_debut: '2026-02-20' })] };
    const r = computeProductionImmobilisee(immos, postes, 2027, '2026-07-31');
    expect(r.projete).toBe(30000);
    expect(r.factuel).toBe(0);
  });

  it('vaut 0 quand la borne reelle s arrete au 31 decembre de l annee precedente', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 120000 })] };
    expect(computeProductionImmobilisee(immos, postes, 2026, '2025-12-31').factuel).toBe(0);
  });

  it('egale le projete quand la borne reelle depasse l annee (exercice passe)', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 120000, annee: 2025, date_debut: '2025-03-01' })] };
    const r = computeProductionImmobilisee(immos, postes, 2025, '2026-07-31');
    expect(r.factuel).toBe(r.projete);
    expect(r.factuel).toBeGreaterThan(0);
  });

  it('avance lineairement un poste sans dates jusqu a la fin du dernier mois clos', () => {
    // 181 jours ecoulés (1er janvier -> 30 juin inclus) sur 365.
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 120000 })] };
    const r = computeProductionImmobilisee(immos, postes, 2026, '2026-06-30');
    expect(r.projete).toBe(120000);
    expect(r.factuel).toBe(59507);
  });

  it('avance un poste a fenetre au prorata des jours ecoulés de SA fenetre', () => {
    // Fenetre 20/02/2026 -> 20/02/2028, borne reelle 30/06/2026 : 131 jours ecoulés sur 315.
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 100000, date_debut: '2026-02-20', date_fin: '2028-02-20' })] };
    const r = computeProductionImmobilisee(immos, postes, 2026, '2026-06-30');
    expect(r.projete).toBe(86301);
    expect(r.factuel).toBe(35890);
  });

  it('compte un poste ponctuel en plein des que sa date de debut est passee', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 30000, prorata_temporel: false, date_debut: '2026-06-30' })] };
    expect(computeProductionImmobilisee(immos, postes, 2026, '2026-06-30').factuel).toBe(30000);
  });

  it('ne compte pas un poste ponctuel dont la date de debut est future', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 30000, prorata_temporel: false, date_debut: '2026-10-01' })] };
    const r = computeProductionImmobilisee(immos, postes, 2026, '2026-06-30');
    expect(r.projete).toBe(30000);
    expect(r.factuel).toBe(0);
  });

  it('compte un poste ponctuel sans date de debut en plein (deja engage)', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 30000, prorata_temporel: false, date_debut: null })] };
    expect(computeProductionImmobilisee(immos, postes, 2026, '2026-06-30').factuel).toBe(30000);
  });

  it('ne depasse jamais le projete', () => {
    const immos = [immo('a')];
    const postes = { a: [poste({ montant: 100000, date_debut: '2026-02-20', date_fin: '2026-05-31' })] };
    const r = computeProductionImmobilisee(immos, postes, 2026, '2026-11-30');
    expect(r.factuel).toBe(r.projete);
  });
});

describe('computeProductionImmobilisee · invariants', () => {
  it('le total est exactement la somme des lignes par immo (a l euro)', () => {
    // Montants choisis pour produire des demi-euros : l arrondi se fait par immo, jamais deux fois.
    const immos = [immo('a'), immo('b'), immo('c')];
    const postes = {
      a: [poste({ montant: 1000.5 })],
      b: [poste({ montant: 2000.5 })],
      c: [poste({ montant: 3000.5 })],
    };
    const r = computeProductionImmobilisee(immos, postes, 2026, '2026-06-30');
    expect(r.projete).toBe(r.parImmo.reduce((s, x) => s + x.projete, 0));
    expect(r.factuel).toBe(r.parImmo.reduce((s, x) => s + x.factuel, 0));
  });

  it('rattache un poste sans annee a l annee de mise en service de son immo', () => {
    const immos = [immo('a', { date_mise_en_service: '2026-09-01' })];
    const postes = { a: [poste({ montant: 20000, annee: null, prorata_temporel: false })] };
    expect(computeProductionImmobilisee(immos, postes, 2026, null).projete).toBe(20000);
    expect(computeProductionImmobilisee(immos, postes, 2025, null).projete).toBe(0);
  });

  it('controle de recette : projete 2026 = SaaS + Simapro = 158 238 EUR', () => {
    // Reproduction simplifiee des deux immos reelles (montants retenus deja connus) : le module
    // doit rendre le total attendu par la spec et le detail par immo.
    const immos = [immo('saas', { libelle: 'SaaS' }), immo('simapro', { libelle: 'Simapro' })];
    const postes = {
      saas: [poste({ montant: 124653, prorata_temporel: false })],
      simapro: [poste({ montant: 33585, prorata_temporel: false })],
    };
    const r = computeProductionImmobilisee(immos, postes, 2026, null);
    expect(r.projete).toBe(158238);
    expect(r.parImmo).toEqual([
      { nom: 'SaaS', projete: 124653, factuel: 0 },
      { nom: 'Simapro', projete: 33585, factuel: 0 },
    ]);
  });
});
