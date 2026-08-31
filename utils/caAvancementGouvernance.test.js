'use strict';
const fs = require('fs');
const path = require('path');

// Gouvernance du lot "CA a l'avancement" (spec docs/superpowers/specs/2026-08-31-ca-avancement-design.md).
// Decisions D7 et D8 : la remuneration (primes, deux etages) et la tresorerie (miroir factuel)
// NE DOIVENT JAMAIS dependre d'un pourcentage saisi au juge. Ce test lit les sources et echoue si
// un symbole de l'avancement apparait dans ces zones.

const RACINE = path.join(__dirname, '..');
// 'ajusterTotal' est le seul symbole ci-dessous sans marqueur de domaine (pas de prefixe/suffixe
// evoquant l'avancement) : une collision future avec un utilitaire sans rapport portant ce nom est
// possible. Aucune collision aujourd'hui (verifie). Si ca arrive, la bonne reponse est de renommer
// l'utilitaire fautif, pas de retirer ce symbole de la liste : la garde D7/D8 doit rester complete.
const SYMBOLES_AVANCEMENT = [
  'caAvancement',
  'computeAvancement',
  'fetchMissionAvancements',
  'mission_avancements',
  'contributionsDepuisVolets',
  'ajusterTotal',
  'contributionsDepuisFonction',
  'caAnneeAvecAvancement',
];

function lire(relatif) {
  return fs.readFileSync(path.join(RACINE, relatif), 'utf8');
}

// Extrait le corps d'une fonction nommee, de sa declaration jusqu'a l'accolade fermante de meme
// niveau. Simpliste mais suffisant : les sources du projet sont formatees classiquement.
function extraireFonction(source, declaration) {
  const debut = source.indexOf(declaration);
  if (debut === -1) throw new Error(`Declaration introuvable : ${declaration}`);
  let profondeur = 0;
  let i = source.indexOf('{', debut);
  const ouverture = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') profondeur++;
    else if (source[i] === '}') {
      profondeur--;
      if (profondeur === 0) return source.slice(ouverture, i + 1);
    }
  }
  throw new Error(`Fin de fonction introuvable : ${declaration}`);
}

describe('gouvernance : la remuneration ne depend jamais de l avancement (D7)', () => {
  test('utils/billing.js ne reference aucun symbole d avancement', () => {
    const src = lire('utils/billing.js');
    for (const s of SYMBOLES_AVANCEMENT) expect(src).not.toContain(s);
  });

  // Scan du fichier ENTIER (comme billing.js), pas seulement des trois fonctions de calcul du CA :
  // un scan borne aux corps de fonctions peut etre contourne par une importation aliasee en tete de
  // fichier (ex. `const { ajusterTotal: miroirCalc } = require('./caAvancement');` puis
  // `miroirCalc(...)` dans le corps) qui echapperait a extraireFonction. kpiCompute.js est un module
  // pur sans raison legitime de connaitre l'avancement : la regle "jamais nulle part dans ce fichier"
  // est a la fois plus simple, plus stricte et plus honnete.
  test('utils/kpiCompute.js ne reference aucun symbole d avancement, nulle part dans le fichier', () => {
    const src = lire('utils/kpiCompute.js');
    for (const s of SYMBOLES_AVANCEMENT) expect(src).not.toContain(s);
  });
});

// Limite assumee : contrairement a kpiCompute.js, le scan ci-dessous reste borne au CORPS de
// computeResultatFactuelForYear (extraireFonction), pas au fichier server.js entier. Un scan global
// serait un faux positif garanti : server.js importe legitimement ces symboles en tete de fichier et
// les utilise ailleurs (ex. app.get('/api/ebe', ...) juste apres cette fonction). Consequence : une
// importation aliasee en tete de server.js (meme contournement que celui corrige pour kpiCompute.js)
// echapperait theoriquement a cette garde si elle etait ensuite appelee depuis le corps de la fonction
// sous un nom different. Ce risque residuel est accepte : mieux vaut une garde qui annonce sa limite
// qu'une garde qui pretend a tort couvrir tout le fichier.
describe('gouvernance : la tresorerie reste a la facture (D8)', () => {
  test('computeResultatFactuelForYear ne reference aucun symbole d avancement', () => {
    const src = lire('server.js');
    const corps = extraireFonction(src, 'async function computeResultatFactuelForYear');
    for (const s of SYMBOLES_AVANCEMENT) expect(corps).not.toContain(s);
  });

  test('le miroir garde sa propre boucle caFacture (aucune mutualisation avec /api/ebe)', () => {
    const src = lire('server.js');
    const corps = extraireFonction(src, 'async function computeResultatFactuelForYear');
    expect(corps).toContain('let caFacture = 0');
  });
});

describe('gouvernance : le module d avancement reste pur', () => {
  test('utils/caAvancement.js ne fait aucune I/O', () => {
    const src = lire('utils/caAvancement.js');
    for (const interdit of ['require(', 'supabase', 'fetch(', 'process.env', 'new Date(']) {
      expect(src).not.toContain(interdit);
    }
  });
});
