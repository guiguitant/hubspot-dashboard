'use strict';
const { computeCrRetraite, computeEffetCumule, verifierInvariantImmos } = require('./crRetraite');

// Bareme IS local, identique aux valeurs par defaut de computeIS (server.js) : 15 % jusqu'a
// 42 500 EUR, 25 % au-dela. Le module ne duplique jamais ce bareme ; il est toujours passe en
// parametre par l'appelant (isFn), ici reconstitue pour les tests.
const isFn = r => (r <= 0 ? 0 : Math.round(Math.min(r, 42500) * 0.15 + Math.max(0, r - 42500) * 0.25));

describe('computeCrRetraite · I1 invariant vie entiere (resultat d exploitation)', () => {
  // Actif synthetique : production immobilisee 100 000 EUR en 2026 (aPostes), amorti 20 000/an sur
  // 2027-2031 (5 ans). EBE classique arbitraire constant 300 000 EUR chaque annee (non affecte par
  // l'amortissement, qui est sous l'EBE). Pour chaque annee, on derive a la main le resultat
  // d'exploitation COMPTABLE (ebe classique - dotations classiques = neutralisees + conservees, ici
  // 100 % neutralisees puisque l'unique immo a des postes), et on compare a resultatExploitation
  // rendu par computeCrRetraite (vue hors capitalisation).
  const annees = [
    { annee: 2026, prod: 100000, dot: 0 },
    { annee: 2027, prod: 0, dot: 20000 },
    { annee: 2028, prod: 0, dot: 20000 },
    { annee: 2029, prod: 0, dot: 20000 },
    { annee: 2030, prod: 0, dot: 20000 },
    { annee: 2031, prod: 0, dot: 20000 },
  ];
  const EBE_CLASSIQUE = 300000;

  it('la somme des (production immobilisee - dotations neutralisees) sur 2026-2031 vaut 0', () => {
    const serie = annees.map(a => ({ annee: a.annee, productionImmobilisee: a.prod, dotationsNeutralisees: a.dot }));
    const effet = computeEffetCumule(serie, 2031);
    expect(effet.montant).toBe(0);
  });

  it('la somme des ecarts de resultat d exploitation (hors capitalisation - comptable) vaut 0', () => {
    // Ecart_annee = resultatExploitationHorsCapitalisation - resultatExploitationComptable.
    // resultatExploitationComptable_Y = EBE_CLASSIQUE - dotationsClassiques_Y (= dot_Y, une seule immo).
    // resultatExploitationHorsCapitalisation_Y (rendu par le module) = (EBE_CLASSIQUE - prod_Y) - 0
    //   (conservees = 0, l'unique immo est integralement neutralisee).
    // Donc ecart_Y = dot_Y - prod_Y.
    //   2026 : 0 - 100 000      = -100 000
    //   2027 a 2031 : 20 000 - 0 = +20 000 chacune
    // Somme = -100 000 + 5 x 20 000 = 0.
    const ecartsAttendus = { 2026: -100000, 2027: 20000, 2028: 20000, 2029: 20000, 2030: 20000, 2031: 20000 };
    let sommeEcarts = 0;
    for (const a of annees) {
      const r = computeCrRetraite({
        ebe: { factuel: EBE_CLASSIQUE, projete: EBE_CLASSIQUE },
        productionImmobilisee: { factuel: a.prod, projete: a.prod },
        dotationsParImmo: [{ nom: 'Actif I1', dotation: a.dot, aPostes: true, assietteCredit: 'ca_declare' }],
        creditTotal: 0,
        isFn,
      });
      const resultatExploitationComptable = EBE_CLASSIQUE - a.dot;
      const ecart = r.resultatExploitation.factuel - resultatExploitationComptable;
      expect(ecart).toBe(ecartsAttendus[a.annee]);
      sommeEcarts += ecart;
    }
    expect(sommeEcarts).toBe(0);
  });
});

describe('computeCrRetraite · I1 non-convergence au resultat net', () => {
  // Meme actif que ci-dessus, mais EBE classique 50 000 EUR (au lieu de 300 000) : en 2026, la base
  // hors capitalisation devient negative (50 000 - 100 000 = -50 000, sous 42 500 y compris en
  // valeur absolue) tandis que la base comptable (50 000) et les bases 2027-2031 (30 000 comptable,
  // 50 000 hors capitalisation) traversent differemment le seuil de 42 500 EUR : le bareme progressif
  // applique par annee casse la convergence qui tient au resultat d'exploitation.
  //
  // Calcul a la main (creditTotal = 0, donc impotNet = IS, resultatNet = resultatExploitation - IS) :
  //
  // Comptable (calcule dans le test, PAS par le module, qui n'implemente pas le CR classique) :
  //   2026 : resultatExploitation = 50 000 - 0      = 50 000 ; IS = 42500x0,15 + 7500x0,25 = 6375+1875 = 8250
  //          resultatNet = 50 000 - 8 250 = 41 750
  //   2027-2031 : resultatExploitation = 50 000 - 20 000 = 30 000 ; IS = 30000x0,15 = 4 500
  //          resultatNet = 30 000 - 4 500 = 25 500 (chacune des 5 annees)
  //
  // Hors capitalisation (rendu par computeCrRetraite) :
  //   2026 : resultatExploitation = 50 000 - 100 000 = -50 000 ; IS = 0 (r <= 0) ; resultatNet = -50 000
  //   2027-2031 : resultatExploitation = 50 000 - 0 = 50 000 ; IS = 42500x0,15 + 7500x0,25 = 8 250
  //          resultatNet = 50 000 - 8 250 = 41 750 (chacune des 5 annees)
  //
  // Ecarts (hors capitalisation - comptable) de resultatNet :
  //   2026 : -50 000 - 41 750 = -91 750
  //   2027-2031 : 41 750 - 25 500 = 16 250, x 5 = 81 250
  //   Somme = -91 750 + 81 250 = -10 500 (non nul, contrairement au resultat d'exploitation).
  it('la somme des ecarts de resultat net (hors capitalisation - comptable) n est PAS nulle', () => {
    const annees = [
      { annee: 2026, prod: 100000, dot: 0 },
      { annee: 2027, prod: 0, dot: 20000 },
      { annee: 2028, prod: 0, dot: 20000 },
      { annee: 2029, prod: 0, dot: 20000 },
      { annee: 2030, prod: 0, dot: 20000 },
      { annee: 2031, prod: 0, dot: 20000 },
    ];
    const EBE_CLASSIQUE = 50000;
    let sommeEcarts = 0;
    for (const a of annees) {
      const r = computeCrRetraite({
        ebe: { factuel: EBE_CLASSIQUE, projete: EBE_CLASSIQUE },
        productionImmobilisee: { factuel: a.prod, projete: a.prod },
        dotationsParImmo: [{ nom: 'Actif I1', dotation: a.dot, aPostes: true, assietteCredit: 'ca_declare' }],
        creditTotal: 0,
        isFn,
      });
      const resultatExploitationComptable = EBE_CLASSIQUE - a.dot;
      const isComptable = isFn(resultatExploitationComptable);
      const resultatNetComptable = resultatExploitationComptable - isComptable;
      sommeEcarts += r.resultatNet.factuel - resultatNetComptable;
    }
    expect(sommeEcarts).toBe(-10500);
    expect(sommeEcarts).not.toBe(0);
  });
});

describe('computeCrRetraite · I2 neutralisees + conservees = total des dotations', () => {
  it('dotationsNeutralisees.montant + amortissements (conservees) = somme de toutes les dotations passees, et parImmo somme exactement a dotationsNeutralisees.montant', () => {
    const dotationsParImmo = [
      { nom: 'A', dotation: 5000, aPostes: true, assietteCredit: 'ca_declare' },
      { nom: 'B', dotation: 3000, aPostes: false },
      { nom: 'C', dotation: 2000, aPostes: true, assietteCredit: 'ca_declare' },
    ];
    const totalDotationsPassees = 5000 + 3000 + 2000; // 10 000
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo,
      creditTotal: 0,
      isFn,
    });
    expect(r.dotationsNeutralisees.montant).toBe(7000); // 5000 + 2000
    expect(r.amortissements).toBe(3000);
    expect(r.dotationsNeutralisees.montant + r.amortissements).toBe(totalDotationsPassees);
    expect(r.dotationsNeutralisees.parImmo.reduce((s, x) => s + x.dotation, 0)).toBe(r.dotationsNeutralisees.montant);
    expect(r.dotationsNeutralisees.parImmo).toEqual([
      { nom: 'A', dotation: 5000 },
      { nom: 'C', dotation: 2000 },
    ]);
  });
});

describe('computeCrRetraite · I3 perimetre', () => {
  it('une immo sans postes reste dans les conservees et jamais dans parImmo ; une immo a postes est neutralisee meme si sa production immobilisee de l annee est 0', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 100000, projete: 100000 },
      // Production immobilisee nulle cette annee (tranche entierement capitalisee les annees
      // precedentes) : l'immo a postes doit malgre tout etre neutralisee via ses dotations.
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo: [
        { nom: 'Brevet externe', dotation: 5000, aPostes: false },
        { nom: 'SaaS interne', dotation: 8000, aPostes: true, assietteCredit: 'ca_declare' },
      ],
      creditTotal: 0,
      isFn,
    });
    expect(r.amortissements).toBe(5000);
    expect(r.dotationsNeutralisees.montant).toBe(8000);
    expect(r.dotationsNeutralisees.parImmo).toEqual([{ nom: 'SaaS interne', dotation: 8000 }]);
    expect(r.dotationsNeutralisees.parImmo.find(x => x.nom === 'Brevet externe')).toBeUndefined();
    // resultatExploitation = ebe hors capitalisation (100 000 - prod immo 0 = 100 000) moins les
    // dotations CONSERVEES uniquement (5 000, Brevet externe) : les 8 000 neutralisees (SaaS interne)
    // ont deja disparu avec la production immobilisee, elles ne se retranchent pas une seconde fois.
    // 100 000 - 5 000 = 95 000.
    expect(r.resultatExploitation).toEqual({ factuel: 95000, projete: 95000 });
  });
});

describe('computeCrRetraite · I4 colonnes (chiffres de controle recette 2026)', () => {
  // Chiffres de la spec section D : productionImmobilisee {factuel:110333, projete:158247},
  // ebe {factuel:165097, projete:399111}. Aucune dotation neutralisee/conservee ici (dotationsParImmo
  // vide) : resultatExploitation = ebe hors capitalisation directement.
  //   ebe.factuel = 165097 - 110333 = 54764
  //   ebe.projete = 399111 - 158247 = 240864
  //   is.factuel = 42500x0,15 + (54764-42500)x0,25 = 6375 + 3066 = 9441
  //   is.projete = 42500x0,15 + (240864-42500)x0,25 = 6375 + 49591 = 55966 (chiffre de la spec)
  it('ebe et IS sont recalcules colonne par colonne, factuel et projete separement', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 165097, projete: 399111 },
      productionImmobilisee: { factuel: 110333, projete: 158247 },
      dotationsParImmo: [],
      creditTotal: 0,
      isFn,
    });
    expect(r.ebe).toEqual({ factuel: 54764, projete: 240864 });
    expect(r.resultatExploitation).toEqual({ factuel: 54764, projete: 240864 });
    expect(r.is).toEqual({ factuel: 9441, projete: 55966 });
  });
});

describe('computeCrRetraite · I5 cascade', () => {
  it('resultatNet = resultatExploitation - (is - creditTotal), sur les deux colonnes', () => {
    // Reprend les chiffres I4 avec un credit d'impot non nul cette fois (2000 EUR) pour distinguer
    // impotNet de is :
    //   impotNet.factuel = 9441 - 2000 = 7441 ; resultatNet.factuel = 54764 - 7441 = 47323
    //   impotNet.projete = 55966 - 2000 = 53966 ; resultatNet.projete = 240864 - 53966 = 186898
    const r = computeCrRetraite({
      ebe: { factuel: 165097, projete: 399111 },
      productionImmobilisee: { factuel: 110333, projete: 158247 },
      dotationsParImmo: [],
      creditTotal: 2000,
      isFn,
    });
    expect(r.impotNet).toEqual({ factuel: 7441, projete: 53966 });
    expect(r.resultatNet).toEqual({ factuel: 47323, projete: 186898 });
  });
});

describe('computeCrRetraite · I6 credit d impot', () => {
  it('creditAdosseAuxDotations est vrai seulement si une immo NEUTRALISEE (aPostes true) est en assiette amortissement', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo: [{ nom: 'A', dotation: 1000, aPostes: true, assietteCredit: 'amortissement' }],
      creditTotal: 500,
      isFn,
    });
    expect(r.creditAdosseAuxDotations).toBe(true);
  });

  it('une immo SANS postes en assiette amortissement ne declenche pas le drapeau', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo: [{ nom: 'B', dotation: 1000, aPostes: false, assietteCredit: 'amortissement' }],
      creditTotal: 500,
      isFn,
    });
    expect(r.creditAdosseAuxDotations).toBe(false);
  });

  it('creditTotal ressort inchange dans impotNet quel que soit le drapeau (pas de recalcul en phase 1)', () => {
    const base = {
      ebe: { factuel: 40000, projete: 40000 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      creditTotal: 500,
      isFn,
    };
    const avecFlag = computeCrRetraite({ ...base, dotationsParImmo: [{ nom: 'A', dotation: 1000, aPostes: true, assietteCredit: 'amortissement' }] });
    const sansFlag = computeCrRetraite({ ...base, dotationsParImmo: [{ nom: 'A', dotation: 1000, aPostes: true, assietteCredit: 'ca_declare' }] });
    // Meme resultatExploitation (memes dotations neutralisees dans les deux cas, aPostes true), donc
    // meme IS ; impotNet doit deduire EXACTEMENT le meme creditTotal des deux cotes.
    expect(avecFlag.is).toEqual(sansFlag.is);
    expect(avecFlag.impotNet).toEqual(sansFlag.impotNet);
    expect(avecFlag.impotNet.factuel).toBe(avecFlag.is.factuel - 500);
    expect(avecFlag.creditAdosseAuxDotations).toBe(true);
    expect(sansFlag.creditAdosseAuxDotations).toBe(false);
  });

  it('le drapeau se declenche meme si la dotation de l annee est 0 : immo neutralisee en assiette amortissement, incoherence structurelle (pas annuelle)', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo: [{ nom: 'A', dotation: 0, aPostes: true, assietteCredit: 'amortissement' }],
      creditTotal: 500,
      isFn,
    });
    expect(r.creditAdosseAuxDotations).toBe(true);
  });
});

describe('computeCrRetraite · aPostes strict (=== true uniquement)', () => {
  it('aPostes: 1 (nombre truthy, pas booleen strict) ne neutralise pas l immo : elle reste dans les CONSERVEES', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo: [{ nom: 'X', dotation: 4000, aPostes: 1, assietteCredit: 'ca_declare' }],
      creditTotal: 0,
      isFn,
    });
    expect(r.amortissements).toBe(4000);
    expect(r.dotationsNeutralisees.montant).toBe(0);
    expect(r.dotationsNeutralisees.parImmo).toEqual([]);
  });
});

describe('computeCrRetraite · garde ecartDotations', () => {
  // Champ de sortie optionnel : compare le total des dotations affiche par le CR classique
  // (input.amortissements, source independante fournie par l'appelant) a la reconstitution issue du
  // detail par immo (dotationsNeutralisees.montant + amortissements conservees). Un ecart non nul
  // signale que les deux sources divergent (garde de coherence produit, pas une correction).
  const dotationsParImmo = [
    { nom: 'A', dotation: 5000, aPostes: true, assietteCredit: 'ca_declare' },
    { nom: 'B', dotation: 3000, aPostes: false },
    { nom: 'C', dotation: 2000, aPostes: true, assietteCredit: 'ca_declare' },
  ];
  // dotationsNeutralisees.montant = 5000 + 2000 = 7000 ; amortissements (conservees) = 3000 ; total reconstitue = 10000.

  it('amortissements passe coherent avec le detail par immo -> ecart 0', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo,
      amortissements: 10000,
      creditTotal: 0,
      isFn,
    });
    expect(r.ecartDotations).toBe(0);
  });

  it('amortissements passe avec 7 EUR de plus que le detail par immo -> ecart 7', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo,
      amortissements: 10007,
      creditTotal: 0,
      isFn,
    });
    expect(r.ecartDotations).toBe(7);
  });

  it('champ amortissements absent (non fourni par l appelant) -> ecart force a 0, rien a comparer', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo,
      creditTotal: 0,
      isFn,
    });
    expect(r.ecartDotations).toBe(0);
  });

  it('amortissements passe avec 10 EUR de moins que le detail par immo -> ecart -10 (le signe dit quelle source est trop haute)', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo,
      amortissements: 9990,
      creditTotal: 0,
      isFn,
    });
    expect(r.ecartDotations).toBe(-10);
  });

  it('amortissements passe explicitement a 0 avec un detail par immo non vide -> ecart -10000 (0 est une vraie valeur, jamais traite comme une absence)', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 0, projete: 0 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo,
      amortissements: 0,
      creditTotal: 0,
      isFn,
    });
    expect(r.ecartDotations).toBe(-10000);
  });
});

describe('computeCrRetraite · robustesse', () => {
  it('objet totalement vide : ne jette pas, renvoie des zeros coherents', () => {
    expect(computeCrRetraite({})).toEqual({
      ebe: { factuel: 0, projete: 0 },
      dotationsNeutralisees: { montant: 0, parImmo: [] },
      amortissements: 0,
      ecartDotations: 0,
      resultatExploitation: { factuel: 0, projete: 0 },
      is: { factuel: 0, projete: 0 },
      impotNet: { factuel: 0, projete: 0 },
      resultatNet: { factuel: 0, projete: 0 },
      creditAdosseAuxDotations: false,
    });
  });

  it('aucun argument du tout : ne jette pas', () => {
    expect(() => computeCrRetraite()).not.toThrow();
    expect(computeCrRetraite().ebe).toEqual({ factuel: 0, projete: 0 });
  });

  it('isFn absent : IS retombe a 0 sans planter, meme avec un resultat d exploitation positif', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 100000, projete: 100000 },
      productionImmobilisee: { factuel: 0, projete: 0 },
      dotationsParImmo: [],
      creditTotal: 0,
    });
    expect(r.is).toEqual({ factuel: 0, projete: 0 });
    expect(r.resultatNet).toEqual({ factuel: 100000, projete: 100000 });
  });

  it('montants non numeriques dans les entrees : traites comme 0, jamais NaN', () => {
    const r = computeCrRetraite({
      ebe: { factuel: 'oops', projete: undefined },
      productionImmobilisee: { factuel: null, projete: 'nope' },
      dotationsParImmo: [{ nom: 'X', dotation: 'abc', aPostes: true }],
      creditTotal: 'nope',
      amortissements: 'oops',
      isFn,
    });
    expect(r.ebe).toEqual({ factuel: 0, projete: 0 });
    expect(r.dotationsNeutralisees.montant).toBe(0);
    expect(Number.isNaN(r.resultatNet.factuel)).toBe(false);
    expect(Number.isNaN(r.resultatNet.projete)).toBe(false);
    // amortissements non numerique (chaine invalide) : passe par _n(), jamais Number() brut, donc
    // ecartDotations tombe a 0 (garde eteinte) plutot que de se propager en NaN (-> null en JSON).
    expect(r.ecartDotations).toBe(0);
    expect(Number.isNaN(r.ecartDotations)).toBe(false);
  });

  it('dotationsParImmo absent : traite comme tableau vide', () => {
    const r = computeCrRetraite({ ebe: { factuel: 1000, projete: 1000 }, productionImmobilisee: { factuel: 0, projete: 0 }, creditTotal: 0, isFn });
    expect(r.dotationsNeutralisees).toEqual({ montant: 0, parImmo: [] });
    expect(r.amortissements).toBe(0);
  });
});

describe('computeEffetCumule', () => {
  const serieI1 = [
    { annee: 2026, productionImmobilisee: 100000, dotationsNeutralisees: 0 },
    { annee: 2027, productionImmobilisee: 0, dotationsNeutralisees: 20000 },
    { annee: 2028, productionImmobilisee: 0, dotationsNeutralisees: 20000 },
    { annee: 2029, productionImmobilisee: 0, dotationsNeutralisees: 20000 },
    { annee: 2030, productionImmobilisee: 0, dotationsNeutralisees: 20000 },
    { annee: 2031, productionImmobilisee: 0, dotationsNeutralisees: 20000 },
  ];

  it('serie de l actif I1 : montant a fin 2026 = +100 000, a fin 2031 = 0, annee de bascule = 2027', () => {
    expect(computeEffetCumule(serieI1, 2026)).toEqual({ montant: 100000, anneeBascule: 2027 });
    expect(computeEffetCumule(serieI1, 2031)).toEqual({ montant: 0, anneeBascule: 2027 });
  });

  it('serie sans aucune annee negative : annee de bascule null', () => {
    const serie = [
      { annee: 2026, productionImmobilisee: 50, dotationsNeutralisees: 10 },
      { annee: 2027, productionImmobilisee: 30, dotationsNeutralisees: 5 },
    ];
    expect(computeEffetCumule(serie, 2027)).toEqual({ montant: 65, anneeBascule: null });
  });

  it('une annee a ecart exactement 0 suivie d une annee negative : la bascule est l annee negative, pas l annee a 0 (regle stricte < 0)', () => {
    const serie = [
      { annee: 2026, productionImmobilisee: 100, dotationsNeutralisees: 100 }, // ecart 0
      { annee: 2027, productionImmobilisee: 40, dotationsNeutralisees: 50 }, // ecart -10
    ];
    // montant cumule = 0 (2026) + (-10) (2027) = -10.
    expect(computeEffetCumule(serie, 2027)).toEqual({ montant: -10, anneeBascule: 2027 });
  });

  it('serie vide : montant 0, annee de bascule null', () => {
    expect(computeEffetCumule([], 2026)).toEqual({ montant: 0, anneeBascule: null });
  });

  it('serie absente (undefined) : ne jette pas, meme resultat qu une serie vide', () => {
    expect(computeEffetCumule(undefined, 2026)).toEqual({ montant: 0, anneeBascule: null });
  });

  it('serie desordonnee : meme resultat qu une serie triee (le module trie en interne)', () => {
    const desordonnee = [serieI1[3], serieI1[0], serieI1[5], serieI1[1], serieI1[4], serieI1[2]];
    expect(computeEffetCumule(desordonnee, 2031)).toEqual(computeEffetCumule(serieI1, 2031));
    expect(computeEffetCumule(desordonnee, 2026)).toEqual({ montant: 100000, anneeBascule: 2027 });
  });
});

describe('verifierInvariantImmos', () => {
  it('ecart de 0 EUR : pas signale', () => {
    const r = verifierInvariantImmos([{ nom: 'A', sommeProductionImmobilisee: 1000, montantAmortissable: 1000 }]);
    expect(r).toEqual([]);
  });

  it('ecart de 2 EUR (arrondi) : tolere, pas signale', () => {
    const r = verifierInvariantImmos([{ nom: 'B', sommeProductionImmobilisee: 1002, montantAmortissable: 1000 }]);
    expect(r).toEqual([]);
  });

  it('ecart de 3 EUR : signale', () => {
    const r = verifierInvariantImmos([{ nom: 'C', sommeProductionImmobilisee: 1003, montantAmortissable: 1000 }]);
    expect(r).toEqual([{ nom: 'C', ecart: 3 }]);
  });

  it('ecart de -10 EUR : signale avec un ecart negatif', () => {
    const r = verifierInvariantImmos([{ nom: 'D', sommeProductionImmobilisee: 990, montantAmortissable: 1000 }]);
    expect(r).toEqual([{ nom: 'D', ecart: -10 }]);
  });

  it('robustesse : tableau absent ou vide, entrees vides -> aucune exception', () => {
    expect(verifierInvariantImmos(undefined)).toEqual([]);
    expect(verifierInvariantImmos([])).toEqual([]);
    expect(() => verifierInvariantImmos([null, undefined])).not.toThrow();
    expect(verifierInvariantImmos([null, undefined])).toEqual([]);
  });
});
