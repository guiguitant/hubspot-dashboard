'use strict';
const fs = require('fs');
const path = require('path');

// Gouvernance du lot "CA a l'avancement" (spec docs/superpowers/specs/2026-08-31-ca-avancement-design.md).
// Decisions D7 et D8 : la remuneration (primes, deux etages) et la tresorerie (miroir factuel)
// NE DOIVENT JAMAIS dependre d'un pourcentage saisi au juge. Ce test lit les sources et echoue si
// un symbole de l'avancement apparait dans ces zones.

const RACINE = path.join(__dirname, '..');
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

  test('utils/kpiCompute.js : ni signedAmountForYear ni totalCaAnnee ni signedByQuarter ne referencent l avancement', () => {
    const src = lire('utils/kpiCompute.js');
    for (const nom of ['function signedAmountForYear', 'function totalCaAnnee', 'function signedByQuarter']) {
      const corps = extraireFonction(src, nom);
      for (const s of SYMBOLES_AVANCEMENT) expect(corps).not.toContain(s);
    }
  });
});

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
