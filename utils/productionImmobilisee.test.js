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

describe('computeProductionImmobilisee · fenetre (une seule date invalide)', () => {
  it('ne retombe sur le defaut annee QUE pour la date invalide, garde la date valide en face', () => {
    // Montant choisi pour un calcul rond : 36 500 / 365 = 100 EUR/jour.
    // Cas 1 : date_debut invalide -> repli sur le 01/01/2026 seul, date_fin (30/06 inclus, donc
    //   01/07 exclu) reste la borne haute. Jours : 01/01 -> 01/07 = 31+28+31+30+31+30 = 181.
    //   projete = 100 x 181 = 18 100 EUR (et non 36 500, qui serait l annee pleine si le bug
    //   "toute la fenetre efface par une seule date invalide" etait encore present).
    const immosA = [immo('a')];
    const postesA = { a: [poste({ montant: 36500, date_debut: 'pas-une-date', date_fin: '2026-06-30' })] };
    expect(computeProductionImmobilisee(immosA, postesA, 2026, null).projete).toBe(18100);

    // Cas 2 (symetrique) : date_fin invalide -> repli sur le 31/12/2026 (exclu 01/01/2027) seul,
    //   date_debut (02/07) reste la borne basse. Jours : 02/07 -> 01/01/2027 =
    //   30(juil)+31(aout)+30(sep)+31(oct)+30(nov)+31(dec) = 183. projete = 100 x 183 = 18 300 EUR.
    const immosB = [immo('b')];
    const postesB = { b: [poste({ montant: 36500, date_debut: '2026-07-02', date_fin: 'pas-une-date' })] };
    expect(computeProductionImmobilisee(immosB, postesB, 2026, null).projete).toBe(18300);
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

  it('deux immos avec quote-parts et fenetres : total = somme des retenus arrondis par immo', () => {
    // Calcul a la main, INDEPENDANT de la formule du module (pas de chiffre de recette vivante) :
    //
    // Immo A (poste continu, prorata calendaire) :
    //   assiette = montant 200 000 EUR x quote-part 25 % = 50 000 EUR
    //   fenetre du poste = 01/03/2026 -> 31/08/2026 inclus, soit 01/03 -> 01/09 exclu =
    //     mars(31) + avril(30) + mai(31) + juin(30) + juillet(31) + aout(31) = 184 jours, sur les
    //     365 jours de 2026 (non bissextile).
    //   projete = 50 000 x 184/365 = 25 205,4794... -> arrondi 25 205 EUR
    //   borne du reel = 30/06/2026 inclus, donc jusqu'au 01/07/2026 exclu. Jours ecoules dans LA
    //     fenetre du poste (01/03 -> 01/07) = mars(31) + avril(30) + mai(31) + juin(30) = 122 jours,
    //     sur les 184 jours de la fenetre.
    //   factuel = 25 205,4794... x 122/184 = 16 712,3287... -> arrondi 16 712 EUR
    //
    // Immo B (poste ponctuel, prorata_temporel = false -> pas de prorata calendaire) :
    //   montant 45 000 EUR x quote-part 100 % (par defaut) = 45 000 EUR, montant plein.
    //   date de debut 15/05/2026 < borne du reel (01/07/2026 exclu) -> deja engage, compte en entier.
    //   projete = factuel = 45 000 EUR
    //
    // Total projete = 25 205 + 45 000 = 70 205 EUR
    // Total factuel = 16 712 + 45 000 = 61 712 EUR
    const immos = [immo('a', { libelle: 'Immo A' }), immo('b', { libelle: 'Immo B' })];
    const postes = {
      a: [poste({ montant: 200000, quote_part: 25, date_debut: '2026-03-01', date_fin: '2026-08-31' })],
      b: [poste({ montant: 45000, prorata_temporel: false, date_debut: '2026-05-15' })],
    };
    const r = computeProductionImmobilisee(immos, postes, 2026, '2026-06-30');
    expect(r.projete).toBe(70205);
    expect(r.factuel).toBe(61712);
    // Immo B avant Immo A : tri par projete decroissant.
    expect(r.parImmo).toEqual([
      { nom: 'Immo B', projete: 45000, factuel: 45000 },
      { nom: 'Immo A', projete: 25205, factuel: 16712 },
    ]);
    expect(r.projete).toBe(r.parImmo.reduce((s, x) => s + x.projete, 0));
    expect(r.factuel).toBe(r.parImmo.reduce((s, x) => s + x.factuel, 0));
  });
});
