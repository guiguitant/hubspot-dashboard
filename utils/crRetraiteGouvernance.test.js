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

  // Le FRONT doit respecter I7 au meme titre que le serveur (observation de la revue phase 2a) : le
  // cote serveur avait ses gardes, pas l'interface. public/pilot.html est une SPA d'un seul tenant
  // (~20 000 lignes) ou tous les ecrans cohabitent : rien n'empeche techniquement un graphe du
  // Cockpit, un KPI ou la page Tresorerie d'aller lire `retraite.*` et de faire fuiter le
  // contrefactuel hors du compte de resultat. Ce test l'empeche.
  test('public/pilot.html : toute mention de « retraite » reste dans la zone Compte de resultat', () => {
    const src = lire('public/pilot.html');
    // DEUX zones, car l'application tient dans un fichier unique : le MARKUP de la page Compte de
    // resultat, puis le BLOC JS qui la pilote. Les bornes sont des ancres STABLES (identifiant de
    // page, noms de fonctions), jamais des numeros de ligne : le fichier bouge en permanence.
    // La zone JS demarre a la fonction qui PRECEDE le bloc Compte de resultat (renderTresoDettes) et
    // non a sa premiere fonction : le bloc commence par ses variables d'etat (crData, crViewMode,
    // crDecochageEnAttente...), qui parlent deja de la vue et doivent donc etre dans la zone.
    const zones = [
      ['id="page-compte-resultat"', '<!-- end page-compte-resultat -->'],
      ['function renderTresoDettes(', 'async function refreshImmobilisations('],
    ];
    const intervalles = zones.map(([ancreDebut, ancreFin]) => {
      const debut = src.indexOf(ancreDebut);
      const fin = src.indexOf(ancreFin);
      // Garde-fou du test lui-meme : une ancre renommee ou deplacee doit faire TOMBER le test, jamais
      // le vider de sa substance (une tranche vide laisserait tout passer). Le message d'echec cite
      // l'ancre introuvable.
      expect(`${ancreDebut} @ ${debut > -1}`).toBe(`${ancreDebut} @ true`);
      expect(`${ancreFin} @ ${fin > debut}`).toBe(`${ancreFin} @ true`);
      return [debut, fin + ancreFin.length];
    });

    // Recherche LARGE et insensible a la casse : `retraite`, `Retraite`, `crRetraite`,
    // `dotationsRetraitees`... tout ce qui evoque la vue doit tomber dans une des deux zones.
    const horsZone = [];
    const motif = /retraite/gi;
    let trouve;
    while ((trouve = motif.exec(src)) !== null) {
      const position = trouve.index;
      if (intervalles.some(([d, f]) => position >= d && position < f)) continue;
      const ligne = src.slice(0, position).split('\n').length;
      const debutLigne = src.lastIndexOf('\n', position) + 1;
      let finLigne = src.indexOf('\n', position);
      if (finLigne === -1) finLigne = src.length;
      horsZone.push('ligne ' + ligne + ' : ' + src.slice(debutLigne, finLigne).trim().slice(0, 120));
    }
    // En cas d'echec, le message liste les lignes fautives : la revue sait immediatement quoi regarder.
    expect(horsZone).toEqual([]);
  });
});
