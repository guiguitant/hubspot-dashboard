'use strict';

// Liasses fiscales des exercices clos (spec docs/superpowers/specs/2026-08-15-liasse-exercice-clos-design.md).
//
// Le module sous test est PUR au sens ou il ne fait que lire des fichiers deja versionnes : aucun
// reseau, aucune base, aucun require de server.js. Les chiffres utilises ici sont ceux de la liasse
// 2025 REELLE (SARL BDM Expertise & Audit) : les valeurs derivees (73 939, 70 092...) ont ete
// calculees a la main depuis cette liasse, jamais depuis le code.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { chargerLiasses, verifierLiasse, CHAMPS_REQUIS } = require('./liasses');

const RACINE = path.join(__dirname, '..');
const DOSSIER_REEL = path.join(RACINE, 'data', 'liasses');

// Copie de travail de la liasse 2025 : chaque test qui degrade un chiffre part d'une copie profonde,
// pour qu'un test ne pollue jamais le suivant.
const LIASSE_2025 = () => ({
  exercice: 2025,
  cloture: '2025-12-31',
  depot: '2026-04-16',
  source: 'Liasse fiscale 2033/2065, SARL BDM Expertise & Audit',
  chiffres: {
    productionVendue: 409064,
    subventionsExploitation: 11667,
    autresProduits: 3,
    totalProduitsExploitation: 420733,
    chargesExploitation: 346794,
    dontDotationsAmortissements: 1046,
    dontAutresCharges: 13559,
    productionImmobilisee: 0,
    resultatExploitation: 73940,
    impotSurBenefices: 3848,
    cir: 10739,
    resultatNet: 70092,
    resultatFiscal: 75347,
  },
});

// Dossier temporaire jetable : les tests de tolerance ecrivent de vrais fichiers, jamais dans data/.
function dossierTemporaire(fichiers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liasses-test-'));
  for (const [nom, contenu] of Object.entries(fichiers)) {
    fs.writeFileSync(path.join(dir, nom), typeof contenu === 'string' ? contenu : JSON.stringify(contenu), 'utf8');
  }
  return dir;
}

describe('chargerLiasses · lecture tolerante du dossier', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  test('lecture nominale : le fichier versionne data/liasses/2025.json est charge sous la cle 2025', () => {
    const liasses = chargerLiasses(DOSSIER_REEL);
    expect(liasses[2025]).toBeTruthy();
    expect(liasses[2025].exercice).toBe(2025);
    expect(liasses[2025].cloture).toBe('2025-12-31');
    expect(liasses[2025].depot).toBe('2026-04-16');
    expect(liasses[2025].source).toBe('Liasse fiscale 2033/2065, SARL BDM Expertise & Audit');
  });

  test('les chiffres officiels de la liasse 2025 sont servis a l identique (aucune alteration)', () => {
    const c = chargerLiasses(DOSSIER_REEL)[2025].chiffres;
    expect(c).toEqual(LIASSE_2025().chiffres);
  });

  test('dossier absent : objet vide, aucune exception', () => {
    expect(chargerLiasses(path.join(os.tmpdir(), 'dossier-liasses-qui-n-existe-pas-12345'))).toEqual({});
  });

  test('dossier non fourni : objet vide, aucune exception', () => {
    expect(chargerLiasses()).toEqual({});
    expect(chargerLiasses(null)).toEqual({});
  });

  test('JSON casse : fichier ignore avec console.warn, les autres exercices restent charges', () => {
    const dir = dossierTemporaire({ '2024.json': '{ ceci n est pas du JSON', '2025.json': LIASSE_2025() });
    const liasses = chargerLiasses(dir);
    expect(Object.keys(liasses)).toEqual(['2025']);
    expect(warn).toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('annee sans fichier : la cle est simplement absente (jamais un objet vide)', () => {
    const dir = dossierTemporaire({ '2025.json': LIASSE_2025() });
    const liasses = chargerLiasses(dir);
    expect(liasses[2026]).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('seuls les fichiers NNNN.json sont lus (README, brouillons et sous-dossiers ignores)', () => {
    const dir = dossierTemporaire({
      '2025.json': LIASSE_2025(),
      'README.md': 'notes de saisie',
      '2025-brouillon.json': LIASSE_2025(),
      'liasse.json': LIASSE_2025(),
    });
    expect(Object.keys(chargerLiasses(dir))).toEqual(['2025']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('exercice absent du contenu : repli sur l annee du nom de fichier', () => {
    const sansExercice = LIASSE_2025();
    delete sansExercice.exercice;
    const dir = dossierTemporaire({ '2025.json': sansExercice });
    expect(Object.keys(chargerLiasses(dir))).toEqual(['2025']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('contenu qui n est pas un objet : ignore avec console.warn', () => {
    const dir = dossierTemporaire({ '2025.json': '"une chaine"' });
    expect(chargerLiasses(dir)).toEqual({});
    expect(warn).toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('verifierLiasse · gardes d integrite de saisie', () => {
  test('la liasse 2025 reelle ne presente aucune anomalie', () => {
    // 420 733 − 346 794 = 73 939 vs 73 940 declare : 1 € d arrondi, dans la tolerance.
    // 73 940 − 3 848 = 70 092 = resultat net declare : exact.
    expect(verifierLiasse(chargerLiasses(DOSSIER_REEL)[2025])).toEqual([]);
  });

  test('ecart de 2 € sur le resultat d exploitation : tolere (arrondis de la liasse)', () => {
    const l = LIASSE_2025();
    l.chiffres.resultatExploitation = 73941; // attendu 73 939, ecart 2
    expect(verifierLiasse(l)).toEqual([]);
  });

  test('ecart de 3 € sur le resultat d exploitation : anomalie signalee', () => {
    const l = LIASSE_2025();
    l.chiffres.resultatExploitation = 73942; // attendu 73 939, ecart 3
    const anomalies = verifierLiasse(l);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].code).toBe('coherenceResultatExploitation');
    expect(anomalies[0].message).toEqual(expect.any(String));
  });

  test('resultat net incoherent avec resultat d exploitation moins IS : anomalie signalee', () => {
    const l = LIASSE_2025();
    l.chiffres.resultatNet = 70000; // attendu 70 092, ecart 92
    const anomalies = verifierLiasse(l);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].code).toBe('coherenceResultatNet');
  });

  test('champ requis manquant : anomalie, et la coherence qui en depend n est pas evaluee', () => {
    const l = LIASSE_2025();
    delete l.chiffres.chargesExploitation;
    const anomalies = verifierLiasse(l);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].code).toBe('champManquant');
    expect(anomalies[0].champ).toBe('chargesExploitation');
  });

  test('champ requis non numerique (saisie en chaine) : meme anomalie', () => {
    const l = LIASSE_2025();
    l.chiffres.chargesExploitation = '346794';
    const anomalies = verifierLiasse(l);
    expect(anomalies.map(a => a.champ)).toContain('chargesExploitation');
  });

  test('tous les champs requis de la spec sont couverts', () => {
    expect(CHAMPS_REQUIS).toEqual(expect.arrayContaining([
      'productionVendue', 'subventionsExploitation', 'totalProduitsExploitation', 'chargesExploitation',
      'productionImmobilisee', 'resultatExploitation', 'impotSurBenefices', 'cir', 'resultatNet',
    ]));
  });

  test('liasse nulle ou sans bloc chiffres : anomalie, jamais d exception', () => {
    expect(verifierLiasse(null)).toHaveLength(1);
    expect(verifierLiasse(undefined)[0].code).toBe('liasseIllisible');
    expect(verifierLiasse({ exercice: 2025 })[0].code).toBe('chiffresManquants');
  });

  test('une liasse en anomalie reste exploitable : ses chiffres ne sont ni effaces ni corriges', () => {
    const l = LIASSE_2025();
    l.chiffres.resultatNet = 70000;
    expect(verifierLiasse(l)).toHaveLength(1);
    expect(l.chiffres.resultatNet).toBe(70000); // aucune mutation de l entree
  });
});

// --- Gouvernance (meme esprit que crRetraiteGouvernance.test.js, invariant I7) ------------------
// La liasse est un ANCRAGE d affichage du compte de resultat : elle ne doit alimenter ni les primes,
// ni la tresorerie, ni un KPI. Ces tests verrouillent la frontiere en lisant les sources sur disque.
describe('gouvernance : la liasse reste locale au compte de resultat', () => {
  const lire = (rel) => fs.readFileSync(path.join(RACINE, rel), 'utf8');

  test('server.js ne branche le module qu a un seul endroit', () => {
    const occurrences = lire('server.js').match(/require\('\.\/utils\/liasses'\)/g) || [];
    expect(occurrences).toHaveLength(1);
  });

  test('le miroir tresorerie computeResultatFactuelForYear ignore la liasse', () => {
    const src = lire('server.js');
    const debut = src.indexOf('async function computeResultatFactuelForYear');
    const fin = src.indexOf("app.get('/api/ebe'");
    expect(debut).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(debut);
    expect(src.slice(debut, fin)).not.toMatch(/iasse/);
  });

  test('utils/kpiCompute.js ignore totalement la liasse (aucune prime calculee dessus)', () => {
    expect(lire('utils/kpiCompute.js').match(/liasse/gi) || []).toEqual([]);
  });

  test('public/pilot.html : toute mention de « liasse » reste dans la zone Compte de resultat', () => {
    const src = lire('public/pilot.html');
    // Memes ancres STABLES que le test de gouvernance de la vue hors capitalisation : le markup de la
    // page, puis le bloc JS qui la pilote.
    const zones = [
      ['id="page-compte-resultat"', '<!-- end page-compte-resultat -->'],
      ['function renderTresoDettes(', 'async function refreshImmobilisations('],
    ];
    const intervalles = zones.map(([ancreDebut, ancreFin]) => {
      const debut = src.indexOf(ancreDebut);
      const fin = src.indexOf(ancreFin);
      expect(`${ancreDebut} @ ${debut > -1}`).toBe(`${ancreDebut} @ true`);
      expect(`${ancreFin} @ ${fin > debut}`).toBe(`${ancreFin} @ true`);
      return [debut, fin + ancreFin.length];
    });
    const horsZone = [];
    const motif = /liasse/gi;
    let trouve;
    while ((trouve = motif.exec(src)) !== null) {
      if (intervalles.some(([d, f]) => trouve.index >= d && trouve.index < f)) continue;
      horsZone.push('ligne ' + src.slice(0, trouve.index).split('\n').length);
    }
    expect(horsZone).toEqual([]);
  });

  test('parite dist : le rendu publie porte les memes ancres de liasse que la source', () => {
    // Verification CIBLEE sur cette tache (le fichier entier est compare par `cmp` a la main) : les
    // ancres de la fonctionnalite liasse doivent exister a l identique des deux cotes.
    const ancres = ['crLiasseBadge', 'exercice clos · liasse du', 'Chiffres fiscaux réels · liasse du', "openCrDetailModal('liasse')"];
    const pub = lire('public/pilot.html');
    const dist = lire('dist/pilot.html');
    for (const a of ancres) {
      expect(`${a} @ public:${pub.includes(a)} dist:${dist.includes(a)}`).toBe(`${a} @ public:true dist:true`);
    }
  });
});
