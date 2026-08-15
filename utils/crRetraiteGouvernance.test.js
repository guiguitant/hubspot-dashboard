'use strict';

// Invariant I7 · GOUVERNANCE de la vue "CR hors capitalisation" (spec
// docs/superpowers/specs/2026-08-13-cr-retraite-design.md, section D).
//
// La vue hors capitalisation est un CONTREFACTUEL de pilotage : selon l'annee elle est plus flatteuse
// ou plus severe que le compte de resultat comptable. Une decision de gestion (prime commerciale, IS
// reellement du, remboursement de credit d'impot N+1, dividendes, trajectoire de tresorerie) ne doit
// JAMAIS se prendre sur celle des deux bases qui arrange, ni deriver d'un champ `retraite.*`.
//
// Ces tests ne verifient pas un calcul : ils verrouillent une FRONTIERE de code, en lisant les
// SOURCES sur disque (fs.readFileSync). Aucun reseau, aucune base, aucun require de server.js (qui
// demarrerait un serveur Express). Le jour ou quelqu'un branche la vue sur un consommateur hors
// compte de resultat, un de ces tests tombe et la revue a lieu avant le merge.

const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const lire = (rel) => fs.readFileSync(path.join(RACINE, rel), 'utf8');

describe('I7 · gouvernance : la vue hors capitalisation reste locale au compte de resultat', () => {
  test('utils/kpiCompute.js ignore totalement la vue (aucune prime calculee dessus)', () => {
    const src = lire('utils/kpiCompute.js');
    // Recherche insensible a la casse et volontairement LARGE (le mot entier, pas seulement le champ) :
    // le calcul des primes doit rester aveugle a l'existence meme de cette vue.
    const occurrences = src.match(/retraite/gi) || [];
    expect(occurrences).toEqual([]);
  });

  test('le miroir tresorerie computeResultatFactuelForYear ignore la vue', () => {
    const src = lire('server.js');
    const debut = src.indexOf('async function computeResultatFactuelForYear');
    const fin = src.indexOf("app.get('/api/ebe'");
    // Garde-fou du test lui-meme : sans ces deux reperes, la tranche serait vide et le test passerait
    // pour de mauvaises raisons (fonction renommee, endpoint deplace).
    expect(debut).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(debut);

    const miroir = src.slice(debut, fin);
    // 'etraite' (sans initiale) attrape aussi bien `retraite` que `Retraite` ou `crRetraite`.
    expect(miroir).not.toMatch(/etraite/);
    expect(miroir).not.toMatch(/crRetraite/);
  });

  test('server.js ne branche le module qu a un seul endroit', () => {
    const src = lire('server.js');
    // Un unique point d'entree : tout nouvel appelant passe forcement par une modification visible de
    // cette ligne (et donc par une revue), au lieu d'un require discret ailleurs dans le monolithe.
    const occurrences = src.match(/require\('\.\/utils\/crRetraite'\)/g) || [];
    expect(occurrences).toHaveLength(1);
  });
});
