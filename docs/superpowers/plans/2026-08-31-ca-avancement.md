# CA à l'avancement (FAE/PCA) · plan d'implémentation

> **Pour les agents implémenteurs :** SOUS-SKILL REQUIS : utiliser superpowers:subagent-driven-development pour exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**Goal :** répartir le CA des missions à cheval sur deux exercices selon un pourcentage d'avancement saisi par Nathan, au lieu des seules dates de facturation.

**Architecture :** couche ADDITIVE. Un module pur (`utils/caAvancement.js`) calcule, pour une mission et un exercice, le CA à l'avancement `ca × (pctFin(N) − pctFin(N−1))`. Une table Supabase (`mission_avancements`) stocke les pourcentages par mission et par exercice, avec figeage horodaté à la clôture. Chaque agrégat de CA concerné applique un REMPLACEMENT mission par mission sur SA propre base, sans que les fonctions existantes changent de signature. Les exercices ≤ 2025 et tous les circuits de rémunération/trésorerie restent strictement inchangés.

**Tech Stack :** Node.js/Express CommonJS (`server.js` monolithe), Jest (`npx jest`), Supabase (`supabaseAdmin`, service-role), front vanilla JS dans `public/pilot.html` avec copie bit-à-bit dans `dist/pilot.html`.

**Spec :** `docs/superpowers/specs/2026-08-31-ca-avancement-design.md` (à lire avant toute tâche)

## Global Constraints

- Backend en **CommonJS** (`require` / `module.exports`), jamais `import`/`export`.
- **JAMAIS de tiret cadratin** « — » nulle part (code, commentaires, textes UI, messages de commit). Remplacer par « · », « : », « , » ou « ; ».
- `public/pilot.html` et `dist/pilot.html` doivent rester **bit-identiques** : toute modification de l'un est copiée à l'identique dans l'autre, vérifiée par `cmp public/pilot.html dist/pilot.html` (sortie vide = OK).
- **NE JAMAIS modifier** `public/js/prospector.js` (utilisé par des automatisations Dispatch).
- **NE JAMAIS modifier** `computeResultatFactuelForYear` (server.js:9512-9575, miroir trésorerie). Sa boucle `caFacture` (server.js:9539) ressemble à celle de `/api/ebe` : ne pas les confondre.
- **NE JAMAIS modifier** `utils/billing.js`, `signedByQuarter`, `signedAmountForYear`, `totalCaAnnee` (signatures et comportements existants figés).
- Réponses d'API **strictement additives** : on ajoute des champs, on n'en retire ni n'en renomme aucun.
- **Aucun appel HTTP** dans les tests (le serveur du port 3000 appartient à l'utilisateur, ne jamais le lancer, ne jamais le tuer).
- **Aucune écriture Supabase** par les agents implémenteurs : le SQL de migration est écrit dans un fichier, c'est Nathan qui l'exécute.
- Tests : `npx jest` doit rester 100 % vert. Baseline avant ce plan : **477 tests**.
- Commits **en français**, terminés par `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Ne jamais toucher à `kpi_prime_config` entre le 1er et le 20 janvier.
- Premier exercice concerné : **2026**. Les exercices ≤ 2025 ne sont jamais ajustés.

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `utils/caAvancement.js` (créer) | Module pur : `pctFin`, `caAvancementMission`, `computeAvancement`, `ajusterTotal`, `verifierInvariantAvancement`, constante `PREMIER_EXERCICE_AVANCEMENT`. Zéro I/O, zéro dépendance. |
| `utils/caAvancement.test.js` (créer) | Tests unitaires du module pur. |
| `migrations/44_mission_avancements.sql` (créer) | DDL de la table, exécutée manuellement par Nathan dans Supabase. |
| `server.js` (modifier) | Accès données (`fetchMissionAvancements`), 4 endpoints `/api/avancement*`, intégration dans `/api/ebe`, `/api/ca-annee`, `/api/analytics`, `/api/kpi`. |
| `utils/caAvancementGouvernance.test.js` (créer) | Test de gouvernance : le miroir trésorerie et `billing.js` ne référencent jamais le module d'avancement. |
| `public/pilot.html` + `dist/pilot.html` (modifier) | Modale de saisie dans l'onglet Facturation, badges « à l'avancement », note de convention de la réconciliation liasse. |

---

### Task 1 : module pur `utils/caAvancement.js`

**Files:**
- Create: `utils/caAvancement.js`
- Test: `utils/caAvancement.test.js`

**Interfaces:**
- Consomme : rien (module pur, aucune dépendance).
- Produit :
  - `PREMIER_EXERCICE_AVANCEMENT = 2026` (number)
  - `pctFin(lignesMission, exercice)` → number. `lignesMission` = tableau `[{ exercice: number, pct: number }]` d'UNE mission.
  - `caAvancementMission(mission, lignesMission, exercice)` → number arrondi à l'euro. `mission` = `{ ca: number }`.
  - `computeAvancement(missions, lignes, exercice)` → `{ actif: boolean, parMission: Map<string, number>, suivies: Array<{ missionId, nom, ca, pctPrecedent, pctCourant, caAvancement }> }`. `missions` = tableau d'objets mission Notion (`{ id, nom, ca, etat }`), `lignes` = tableau plat `[{ mission_id, exercice, pct }]` ou `null`.
  - `ajusterTotal(base, contributionsBase, parMission)` → number. `contributionsBase` = `Map<missionId, number>` (ce que chaque mission suivie apporte à la base actuelle).
  - `verifierInvariantAvancement(missions, lignes)` → `Array<{ missionId, nom, attendu, obtenu, ecart }>` (vide si tout va bien).

- [ ] **Step 1 : écrire les tests qui échouent**

Créer `utils/caAvancement.test.js` :

```javascript
'use strict';
const {
  PREMIER_EXERCICE_AVANCEMENT,
  pctFin,
  caAvancementMission,
  computeAvancement,
  ajusterTotal,
  verifierInvariantAvancement,
} = require('./caAvancement');

describe('pctFin : avancement au 31/12 avec report en avant', () => {
  test('aucune ligne : 0 %', () => {
    expect(pctFin([], 2026)).toBe(0);
    expect(pctFin(null, 2026)).toBe(0);
  });

  test('ligne de l exercice exact : sa valeur', () => {
    expect(pctFin([{ exercice: 2026, pct: 40 }], 2026)).toBe(40);
  });

  test('report en avant : une mission finie en 2025 reste a 100 en 2026 et 2027', () => {
    const lignes = [{ exercice: 2025, pct: 100 }];
    expect(pctFin(lignes, 2026)).toBe(100);
    expect(pctFin(lignes, 2027)).toBe(100);
  });

  test('aucune ligne anterieure ou egale : 0 (une ligne 2026 ne vaut pas pour 2025)', () => {
    expect(pctFin([{ exercice: 2026, pct: 60 }], 2025)).toBe(0);
  });

  test('plusieurs lignes : la plus recente <= exercice gagne, ordre d entree indifferent', () => {
    const lignes = [{ exercice: 2027, pct: 100 }, { exercice: 2025, pct: 30 }, { exercice: 2026, pct: 70 }];
    expect(pctFin(lignes, 2026)).toBe(70);
    expect(pctFin(lignes, 2025)).toBe(30);
    expect(pctFin(lignes, 2028)).toBe(100);
  });
});

describe('caAvancementMission : CA de l exercice = ca x (pct fin N - pct fin N-1)', () => {
  test('Groupe Elise : 90 % fin 2025, 100 % fin 2026, mission 10 000 -> 1 000 en 2026', () => {
    const m = { ca: 10000 };
    const lignes = [{ exercice: 2025, pct: 90 }, { exercice: 2026, pct: 100 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(1000);
  });

  test('Ferme des Arches : 10 % fin 2025, 100 % fin 2026, mission 10 000 -> 9 000 en 2026', () => {
    const m = { ca: 10000 };
    const lignes = [{ exercice: 2025, pct: 10 }, { exercice: 2026, pct: 100 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(9000);
  });

  test('FAE 100 % : finie en 2025, facturee en 2026 -> 0 de CA 2026 sans ligne 2026', () => {
    const m = { ca: 8000 };
    const lignes = [{ exercice: 2025, pct: 100 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(0);
  });

  test('revision a la baisse : resultat negatif accepte (correction)', () => {
    const m = { ca: 10000 };
    const lignes = [{ exercice: 2025, pct: 80 }, { exercice: 2026, pct: 60 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(-2000);
  });

  test('arrondi a l euro', () => {
    const m = { ca: 15500 };
    const lignes = [{ exercice: 2025, pct: 70 }, { exercice: 2026, pct: 100 }];
    expect(caAvancementMission(m, lignes, 2026)).toBe(4650);
  });

  test('ca absent ou non numerique : 0, jamais NaN', () => {
    expect(caAvancementMission({ ca: null }, [{ exercice: 2026, pct: 50 }], 2026)).toBe(0);
    expect(caAvancementMission({}, [{ exercice: 2026, pct: 50 }], 2026)).toBe(0);
  });
});

describe('computeAvancement : selection des missions suivies', () => {
  const missions = [
    { id: 'm1', nom: 'Groupe Elise', ca: 10000, etat: 'En cours' },
    { id: 'm2', nom: 'Ferme des Arches', ca: 10000, etat: 'En cours' },
    { id: 'm3', nom: 'Non suivie', ca: 5000, etat: 'En cours' },
    { id: 'm4', nom: 'Annulee suivie', ca: 7000, etat: 'Annulé' },
  ];
  const lignes = [
    { mission_id: 'm1', exercice: 2025, pct: 90 },
    { mission_id: 'm1', exercice: 2026, pct: 100 },
    { mission_id: 'm2', exercice: 2025, pct: 10 },
    { mission_id: 'm4', exercice: 2025, pct: 50 },
    { mission_id: 'm4', exercice: 2026, pct: 100 },
  ];

  test('lignes null ou vides : inactif, aucune mission suivie', () => {
    expect(computeAvancement(missions, null, 2026).actif).toBe(false);
    expect(computeAvancement(missions, [], 2026).actif).toBe(false);
    expect(computeAvancement(missions, [], 2026).suivies).toEqual([]);
  });

  test('exercice anterieur a 2026 : jamais actif', () => {
    const r = computeAvancement(missions, lignes, 2025);
    expect(r.actif).toBe(false);
    expect(r.parMission.size).toBe(0);
  });

  test('exercice 2026 : les missions suivies non annulees sont remplacees', () => {
    const r = computeAvancement(missions, lignes, 2026);
    expect(r.actif).toBe(true);
    expect(r.parMission.get('m1')).toBe(1000);
    expect(r.parMission.get('m2')).toBe(9000); // 10 % -> report a 10 %, pas de ligne 2026 : 0
    expect(r.parMission.has('m3')).toBe(false); // non suivie
  });

  test('mission annulee : jamais suivie, meme avec des lignes', () => {
    const r = computeAvancement(missions, lignes, 2026);
    expect(r.parMission.has('m4')).toBe(false);
    expect(r.suivies.find(s => s.missionId === 'm4')).toBeUndefined();
  });

  test('suivies porte le detail lisible par le front', () => {
    const r = computeAvancement(missions, lignes, 2026);
    const s = r.suivies.find(x => x.missionId === 'm1');
    expect(s).toEqual({ missionId: 'm1', nom: 'Groupe Elise', ca: 10000, pctPrecedent: 90, pctCourant: 100, caAvancement: 1000 });
  });

  test('une ligne dont le mission_id est inconnu des missions est ignoree', () => {
    const r = computeAvancement(missions, [{ mission_id: 'fantome', exercice: 2026, pct: 50 }], 2026);
    expect(r.suivies).toEqual([]);
    expect(r.parMission.size).toBe(0);
  });

  test('PREMIER_EXERCICE_AVANCEMENT vaut 2026', () => {
    expect(PREMIER_EXERCICE_AVANCEMENT).toBe(2026);
  });
});

describe('ajusterTotal : remplacement de la contribution des missions suivies', () => {
  test('remplace la base mission par mission', () => {
    const contributions = new Map([['m1', 5000], ['m2', 0]]);
    const parMission = new Map([['m1', 1000], ['m2', 9000]]);
    // base 100 000 dont 5 000 de m1 et 0 de m2 -> 100 000 - 5 000 - 0 + 1 000 + 9 000
    expect(ajusterTotal(100000, contributions, parMission)).toBe(105000);
  });

  test('une mission suivie absente de la base compte pour 0 en retrait', () => {
    const contributions = new Map();
    const parMission = new Map([['m1', 1000]]);
    expect(ajusterTotal(100000, contributions, parMission)).toBe(101000);
  });

  test('parMission vide : base inchangee', () => {
    expect(ajusterTotal(100000, new Map([['m1', 5000]]), new Map())).toBe(100000);
  });
});

describe('verifierInvariantAvancement : l avancement deplace du CA, il n en cree pas', () => {
  test('mission terminee a 100 % : somme des exercices = ca', () => {
    const missions = [{ id: 'm1', nom: 'Groupe Elise', ca: 10000, etat: 'En cours' }];
    const lignes = [{ mission_id: 'm1', exercice: 2025, pct: 90 }, { mission_id: 'm1', exercice: 2026, pct: 100 }];
    expect(verifierInvariantAvancement(missions, lignes)).toEqual([]);
  });

  test('mission non terminee : pas d anomalie (l invariant ne vaut qu a 100 %)', () => {
    const missions = [{ id: 'm1', nom: 'En cours', ca: 10000, etat: 'En cours' }];
    const lignes = [{ mission_id: 'm1', exercice: 2026, pct: 40 }];
    expect(verifierInvariantAvancement(missions, lignes)).toEqual([]);
  });

  test('anomalie si la somme des exercices s ecarte du ca de plus de 1 EUR', () => {
    // pct decroissant puis 100 : la somme telescope quand meme ; on force une incoherence
    // en fabriquant une mission dont le ca a change apres saisie.
    const missions = [{ id: 'm1', nom: 'Incoherente', ca: 10000, etat: 'En cours' }];
    const lignes = [{ mission_id: 'm1', exercice: 2025, pct: 90 }, { mission_id: 'm1', exercice: 2026, pct: 100 }];
    const anomalies = verifierInvariantAvancement(missions, lignes);
    expect(anomalies).toEqual([]);
    // meme mission, ca different : la somme des parts ne fait plus le ca courant
    const anomalies2 = verifierInvariantAvancement([{ id: 'm1', nom: 'Incoherente', ca: 12000, etat: 'En cours' }], [
      { mission_id: 'm1', exercice: 2025, pct: 90 },
      { mission_id: 'm1', exercice: 2026, pct: 95 },
    ]);
    expect(anomalies2).toEqual([]); // pas a 100 % : hors invariant
  });
});
```

- [ ] **Step 2 : lancer les tests, vérifier qu'ils échouent**

Run: `npx jest utils/caAvancement.test.js`
Expected: FAIL avec `Cannot find module './caAvancement'`

- [ ] **Step 3 : écrire le module**

Créer `utils/caAvancement.js` :

```javascript
'use strict';

// CA a l'avancement (FAE/PCA) : voir docs/superpowers/specs/2026-08-31-ca-avancement-design.md
//
// Principe comptable : pour une prestation a cheval sur deux exercices, le CA d'un exercice ne
// depend pas des dates de facturation mais du pourcentage d'avancement au 31/12. L'ecart entre le
// facture et l'avancement est une facture a etablir (FAE, realise non facture) ou un produit
// constate d'avance (PCA, facture non realise).
//
// Module PUR : aucune I/O, aucune dependance. Toute la lecture Supabase est dans server.js.

// Premier exercice ou l'avancement s'applique. Les exercices anterieurs sont figes par la liasse
// fiscale (doctrine "exercice clos" du lot liasse) : on ne rejoue jamais leur CA.
const PREMIER_EXERCICE_AVANCEMENT = 2026;

// Tolerance de l'invariant vie-entiere, en euros (arrondis a l'euro sur chaque exercice).
const TOLERANCE_INVARIANT = 1;

// Avancement (%) d'une mission au 31/12/exercice, avec REPORT EN AVANT : on prend la ligne de
// l'exercice le plus recent <= exercice. 0 si aucune. Le report est ce qui fait qu'une mission
// terminee a 100 % en 2025 et facturee en 2026 apporte 0 de CA 2026 sans aucune saisie 2026.
function pctFin(lignesMission, exercice) {
  let meilleur = null;
  for (const l of lignesMission || []) {
    const ex = Number(l.exercice);
    if (!Number.isFinite(ex) || ex > exercice) continue;
    if (meilleur === null || ex > Number(meilleur.exercice)) meilleur = l;
  }
  return meilleur ? (Number(meilleur.pct) || 0) : 0;
}

// CA a l'avancement d'une mission pour un exercice : ca x (avancement fin N - avancement fin N-1).
// Peut etre negatif si l'avancement a ete revu a la baisse : c'est une correction volontaire.
function caAvancementMission(mission, lignesMission, exercice) {
  const ca = Number(mission && mission.ca) || 0;
  const delta = pctFin(lignesMission, exercice) - pctFin(lignesMission, exercice - 1);
  return Math.round((ca * delta) / 100);
}

// Regroupe les lignes plates (telles que stockees) par mission_id.
function grouperParMission(lignes) {
  const parMission = new Map();
  for (const l of lignes || []) {
    const id = l && l.mission_id != null ? String(l.mission_id) : null;
    if (!id) continue;
    if (!parMission.has(id)) parMission.set(id, []);
    parMission.get(id).push(l);
  }
  return parMission;
}

// Etats exclus du CA : aligne sur SIGNE_EXCLUDED_STATES de utils/kpiCompute.js. Une mission annulee
// n'est jamais remplacee, meme si elle porte des lignes d'avancement (saisie devenue caduque).
const ETATS_EXCLUS = ['Annulé'];

// Calcule le remplacement a appliquer pour un exercice.
// Retourne { actif, parMission: Map<missionId, caAvancement>, suivies: [detail lisible] }.
// actif = false (et parMission vide) si les lignes sont absentes (table Supabase non creee :
// degradation douce) ou si l'exercice est anterieur a PREMIER_EXERCICE_AVANCEMENT.
function computeAvancement(missions, lignes, exercice) {
  const vide = { actif: false, parMission: new Map(), suivies: [] };
  if (!lignes || !lignes.length) return vide;
  if (!Number.isFinite(Number(exercice)) || Number(exercice) < PREMIER_EXERCICE_AVANCEMENT) return vide;

  const ex = Number(exercice);
  const lignesParMission = grouperParMission(lignes);
  const parMission = new Map();
  const suivies = [];

  for (const m of missions || []) {
    const id = m && m.id != null ? String(m.id) : null;
    if (!id || !lignesParMission.has(id)) continue;      // mission non suivie : comportement inchange
    if (ETATS_EXCLUS.includes(m.etat)) continue;          // annulee : hors CA de bout en bout
    const lignesMission = lignesParMission.get(id);
    const montant = caAvancementMission(m, lignesMission, ex);
    parMission.set(id, montant);
    suivies.push({
      missionId: id,
      nom: m.nom || '',
      ca: Number(m.ca) || 0,
      pctPrecedent: pctFin(lignesMission, ex - 1),
      pctCourant: pctFin(lignesMission, ex),
      caAvancement: montant,
    });
  }

  return { actif: suivies.length > 0, parMission, suivies };
}

// Applique le remplacement a un total deja calcule : on retire ce que chaque mission suivie
// apportait a CETTE base, on ajoute son CA a l'avancement. contributionsBase = Map<missionId,
// montant apporte a la base>. Chaque consommateur fournit SA base (les deux definitions existantes
// du CA ne rattachent pas pareil : un delta global unique serait faux pour l'une des deux).
function ajusterTotal(base, contributionsBase, parMission) {
  let total = Number(base) || 0;
  for (const [id, montant] of parMission || new Map()) {
    const contribution = (contributionsBase && contributionsBase.get(id)) || 0;
    total = total - contribution + montant;
  }
  return Math.round(total);
}

// Invariant vie-entiere : pour une mission arrivee a 100 %, la somme de ses CA a l'avancement sur
// tous les exercices ou elle a une ligne doit valoir son ca (telescopage). Verifie que l'avancement
// DEPLACE du CA entre exercices sans en creer ni en detruire. Missions non terminees : hors scope.
function verifierInvariantAvancement(missions, lignes) {
  const anomalies = [];
  const lignesParMission = grouperParMission(lignes);
  for (const m of missions || []) {
    const id = m && m.id != null ? String(m.id) : null;
    if (!id || !lignesParMission.has(id)) continue;
    if (ETATS_EXCLUS.includes(m.etat)) continue;
    const lignesMission = lignesParMission.get(id);
    const exercices = lignesMission.map(l => Number(l.exercice)).filter(Number.isFinite);
    if (!exercices.length) continue;
    const dernier = Math.max(...exercices);
    if (pctFin(lignesMission, dernier) !== 100) continue; // invariant valable a 100 % seulement
    const premier = Math.min(...exercices);
    let somme = 0;
    for (let ex = premier; ex <= dernier; ex++) somme += caAvancementMission(m, lignesMission, ex);
    const attendu = Number(m.ca) || 0;
    const ecart = somme - attendu;
    if (Math.abs(ecart) > TOLERANCE_INVARIANT) {
      anomalies.push({ missionId: id, nom: m.nom || '', attendu, obtenu: somme, ecart });
    }
  }
  return anomalies;
}

module.exports = {
  PREMIER_EXERCICE_AVANCEMENT,
  TOLERANCE_INVARIANT,
  pctFin,
  caAvancementMission,
  computeAvancement,
  ajusterTotal,
  verifierInvariantAvancement,
};
```

- [ ] **Step 4 : lancer les tests, vérifier qu'ils passent**

Run: `npx jest utils/caAvancement.test.js`
Expected: PASS, tous les tests verts.

Puis la suite complète : `npx jest`
Expected: PASS, 477 tests d'origine + les nouveaux, 0 échec.

- [ ] **Step 5 : commit**

```bash
git add utils/caAvancement.js utils/caAvancement.test.js
git commit -m "feat(pilot) ca a l'avancement : module pur (report en avant, remplacement, invariant)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2 : migration SQL + accès données + endpoints `/api/avancement`

**Files:**
- Create: `migrations/44_mission_avancements.sql`
- Modify: `server.js` (ajouter un bloc juste AVANT la ligne `app.get('/api/coherence/deals-notion'`, actuellement server.js:9249)
- Test: `utils/caAvancement.test.js` (compléter avec les tests de validation d'entrée)

**Interfaces:**
- Consomme : `utils/caAvancement.js` (Task 1) : `computeAvancement`, `verifierInvariantAvancement`, `PREMIER_EXERCICE_AVANCEMENT`.
- Produit :
  - `fetchMissionAvancements()` → `Promise<{ lignes: Array<{ mission_id, exercice, pct, nom, fige_le }>, disponible: boolean }>` (jamais d'exception si la table est absente).
  - `GET /api/avancement?year=YYYY` → `{ disponible, exercice, lignes, suivies, anomalies, figee }`
  - `POST /api/avancement` `{ missionId, exercice, pct, nom }` → `{ ok: true }` ou 400/409
  - `DELETE /api/avancement` `{ missionId, exercice }` → `{ ok: true }` ou 409
  - `POST /api/avancement/figer` `{ exercice }` → `{ ok: true, lignesFigees: number }`
  - `validerSaisieAvancement({ missionId, exercice, pct }, anneeCourante)` → `{ ok: boolean, message?: string }` (exporté depuis `utils/caAvancement.js` pour être testable sans HTTP).

- [ ] **Step 1 : écrire le test de validation d'entrée (échoue)**

Ajouter à la fin de `utils/caAvancement.test.js` :

```javascript
const { validerSaisieAvancement } = require('./caAvancement');

describe('validerSaisieAvancement : gardes de saisie', () => {
  const ANNEE = 2026;

  test('saisie valide', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 40 }, ANNEE)).toEqual({ ok: true });
  });

  test('missionId manquant', () => {
    const r = validerSaisieAvancement({ exercice: 2026, pct: 40 }, ANNEE);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/mission/i);
  });

  test('pct hors bornes', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: -1 }, ANNEE).ok).toBe(false);
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 101 }, ANNEE).ok).toBe(false);
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 'quarante' }, ANNEE).ok).toBe(false);
  });

  test('pct aux bornes : accepte', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 0 }, ANNEE).ok).toBe(true);
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2026, pct: 100 }, ANNEE).ok).toBe(true);
  });

  test('exercice hors bornes : avant 2025 ou apres annee courante + 1', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2024, pct: 50 }, ANNEE).ok).toBe(false);
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2028, pct: 50 }, ANNEE).ok).toBe(false);
  });

  test('exercice 2025 accepte : c est l ancre du fichier cut-off', () => {
    expect(validerSaisieAvancement({ missionId: 'm1', exercice: 2025, pct: 90 }, ANNEE).ok).toBe(true);
  });
});
```

- [ ] **Step 2 : lancer, vérifier l'échec**

Run: `npx jest utils/caAvancement.test.js -t "validerSaisieAvancement"`
Expected: FAIL avec `validerSaisieAvancement is not a function`

- [ ] **Step 3 : ajouter la fonction au module pur**

Dans `utils/caAvancement.js`, avant `module.exports`, ajouter :

```javascript
// Exercice le plus ancien saisissable : 2025 est l'ANCRE (avancement au 31/12/2025 des missions du
// fichier de cut-off transmis a l'expert-comptable), meme si aucun CA 2025 n'est jamais ajuste.
const EXERCICE_ANCRE = 2025;

// Validation d'une saisie, hors HTTP pour rester testable. anneeCourante = new Date().getFullYear()
// cote appelant (le module reste pur : il ne lit jamais l'horloge).
function validerSaisieAvancement(saisie, anneeCourante) {
  const s = saisie || {};
  const id = s.missionId != null ? String(s.missionId).trim() : '';
  if (!id) return { ok: false, message: 'missionId requis' };
  const ex = Number(s.exercice);
  if (!Number.isInteger(ex) || ex < EXERCICE_ANCRE || ex > Number(anneeCourante) + 1) {
    return { ok: false, message: `exercice hors bornes (${EXERCICE_ANCRE} a ${Number(anneeCourante) + 1})` };
  }
  const pct = Number(s.pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, message: 'pct doit etre compris entre 0 et 100' };
  return { ok: true };
}
```

Et ajouter `EXERCICE_ANCRE` et `validerSaisieAvancement` à `module.exports`.

- [ ] **Step 4 : lancer, vérifier que ça passe**

Run: `npx jest utils/caAvancement.test.js`
Expected: PASS

- [ ] **Step 5 : écrire la migration SQL**

Créer `migrations/44_mission_avancements.sql` :

```sql
-- Migration 44 : avancement des missions pour le CA a l'avancement (FAE/PCA),
-- design docs/superpowers/specs/2026-08-31-ca-avancement-design.md
--
-- A EXECUTER UNE FOIS dans l'editeur SQL Supabase (SQL Editor > New query > coller > Run).
-- Tant que ce script n'a pas ete passe, l'application fonctionne normalement : GET /api/avancement
-- renvoie disponible: false, aucun CA n'est ajuste, et la saisie est desactivee cote front.
--
-- A quoi sert cette table : Releaf facture de la prestation. Quand une mission est a cheval sur
-- deux exercices (acompte en N, solde en N+1), le CA de chaque exercice depend du pourcentage
-- d'avancement au 31/12, pas des dates de facturation. Une ligne = "au 31/12/{exercice}, cette
-- mission etait avancee a {pct} %". Le CA de l'exercice vaut alors ca x (pct fin N - pct fin N-1).
--
-- exercice 2025 = ancre : reprise du fichier de cut-off transmis a l'expert-comptable. Aucun CA
-- 2025 n'est modifie par Pilot (exercice clos, la liasse fait foi) : ces lignes servent uniquement
-- de point de depart au calcul 2026.
--
-- fige_le : horodatage pose a la cloture d'un exercice (bouton "Figer" de la modale). Une ligne
-- figee n'est plus modifiable ni supprimable par l'API (HTTP 409). Patron du gel de deal
-- (migrations/43_deal_freeze.sql) : une date, pas un booleen sec.

create table if not exists mission_avancements (
  mission_id text not null,
  exercice integer not null,
  pct numeric not null check (pct >= 0 and pct <= 100),
  nom text,
  fige_le timestamptz,
  updated_at timestamptz not null default now(),
  primary key (mission_id, exercice)
);

-- RLS activee SANS AUCUNE POLICY : patron de migrations/42_deals_notion_validations.sql. La table
-- est inaccessible aux cles anon/authenticated et n'est lisible/ecrivable que par la cle
-- service-role du serveur (supabaseAdmin), qui contourne RLS par construction.
alter table mission_avancements enable row level security;
```

- [ ] **Step 6 : implémenter l'accès données et les endpoints**

Dans `server.js`, insérer le bloc suivant JUSTE AVANT la ligne `// POST /api/coherence/deals-notion/valider` (repérer avec `grep -n "POST /api/coherence/deals-notion/valider" server.js`).

Ajouter aussi l'import en tête de fichier, à côté des autres `require('./utils/...')` :

```javascript
const {
  computeAvancement,
  verifierInvariantAvancement,
  validerSaisieAvancement,
  PREMIER_EXERCICE_AVANCEMENT,
} = require('./utils/caAvancement');
```

Le bloc à insérer :

```javascript
// --- CA a l'avancement (FAE/PCA) : spec docs/superpowers/specs/2026-08-31-ca-avancement-design.md ---
const MISSION_AVANCEMENTS_TABLE = 'mission_avancements';
const MISSION_AVANCEMENTS_SQL_PATH = 'migrations/44_mission_avancements.sql';
let missionAvancementsTableAbsenteWarned = false;

// Meme detection que isDealsNotionTableAbsente : 42P01 (Postgres) / PGRST205 (PostgREST), plus un
// repli sur le libelle d'une RELATION absente. Ne masque jamais une colonne manquante.
function isMissionAvancementsTableAbsente(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42P01' || code === 'PGRST205') return true;
  return /relation .* does not exist|find the table .* in the schema cache/i.test(String(error.message || ''));
}

// Lignes d'avancement. Degradation douce si la table n'existe pas encore ; toute autre erreur
// Supabase remonte (une panne reelle doit rester visible).
async function fetchMissionAvancements() {
  const { data, error } = await supabaseAdmin
    .from(MISSION_AVANCEMENTS_TABLE)
    .select('mission_id, exercice, pct, nom, fige_le');
  if (error) {
    if (!isMissionAvancementsTableAbsente(error)) throw new Error(error.message);
    if (!missionAvancementsTableAbsenteWarned) {
      missionAvancementsTableAbsenteWarned = true;
      console.warn(`[avancement] Table ${MISSION_AVANCEMENTS_TABLE} absente : exécuter le SQL ${MISSION_AVANCEMENTS_SQL_PATH} (CA à l'avancement désactivé)`);
    }
    return { lignes: [], disponible: false };
  }
  const lignes = (data || []).map(r => ({
    mission_id: String(r.mission_id),
    exercice: Number(r.exercice),
    pct: Number(r.pct),
    nom: r.nom || '',
    fige_le: r.fige_le || null,
  }));
  return { lignes, disponible: true };
}

// Etat d'avancement pour la modale de saisie : lignes brutes, detail calcule de l'exercice demande,
// anomalies d'invariant, et si l'exercice est deja fige.
app.get('/api/avancement', async (req, res) => {
  try {
    const exercice = parseInt(req.query.year, 10) || new Date().getFullYear();
    if (exercice < 2000 || exercice > 2100) return res.status(400).json({ error: 'Paramètre year hors bornes (2000 à 2100)' });
    const [missions, { lignes, disponible }] = await Promise.all([
      fetchAllNotionMissions(),
      fetchMissionAvancements(),
    ]);
    const calcul = computeAvancement(missions, lignes, exercice);
    const lignesExercice = lignes.filter(l => l.exercice === exercice);
    res.json({
      disponible,
      exercice,
      premierExercice: PREMIER_EXERCICE_AVANCEMENT,
      lignes,
      suivies: calcul.suivies,
      anomalies: verifierInvariantAvancement(missions, lignes),
      figee: lignesExercice.length > 0 && lignesExercice.every(l => !!l.fige_le),
      missions: missions
        .filter(m => m.etat !== 'Annulé')
        .map(m => ({ id: m.id, nom: m.nom, client: m.client, ca: m.ca })),
    });
  } catch (e) {
    console.error('GET /api/avancement error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Saisie ou mise a jour d'un pourcentage d'avancement (upsert idempotent).
app.post('/api/avancement', async (req, res) => {
  try {
    const { missionId, exercice, pct, nom } = req.body || {};
    const v = validerSaisieAvancement({ missionId, exercice, pct }, new Date().getFullYear());
    if (!v.ok) return res.status(400).json({ error: v.message });

    const { lignes, disponible } = await fetchMissionAvancements();
    if (!disponible) return res.status(503).json({ error: `Table ${MISSION_AVANCEMENTS_TABLE} absente : exécuter ${MISSION_AVANCEMENTS_SQL_PATH}` });
    const existante = lignes.find(l => l.mission_id === String(missionId) && l.exercice === Number(exercice));
    if (existante && existante.fige_le) {
      return res.status(409).json({ error: `Exercice ${exercice} figé : cette saisie n'est plus modifiable` });
    }

    // Le missionId doit correspondre a une mission Notion connue : une saisie orpheline
    // n'ajusterait rien et resterait invisible dans la modale.
    const missions = await fetchAllNotionMissions();
    const mission = missions.find(m => String(m.id) === String(missionId));
    if (!mission) return res.status(400).json({ error: 'Mission Notion introuvable' });

    const { error } = await supabaseAdmin
      .from(MISSION_AVANCEMENTS_TABLE)
      .upsert({
        mission_id: String(missionId),
        exercice: Number(exercice),
        pct: Number(pct),
        nom: nom || mission.nom || '',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'mission_id,exercice' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/avancement error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Retrait d'une mission du suivi pour un exercice (idempotent : supprimer l'absent renvoie ok).
app.delete('/api/avancement', async (req, res) => {
  try {
    const { missionId, exercice } = req.body || {};
    if (!missionId) return res.status(400).json({ error: 'missionId requis' });
    const ex = Number(exercice);
    if (!Number.isInteger(ex)) return res.status(400).json({ error: 'exercice requis' });

    const { lignes, disponible } = await fetchMissionAvancements();
    if (!disponible) return res.status(503).json({ error: `Table ${MISSION_AVANCEMENTS_TABLE} absente : exécuter ${MISSION_AVANCEMENTS_SQL_PATH}` });
    const existante = lignes.find(l => l.mission_id === String(missionId) && l.exercice === ex);
    if (existante && existante.fige_le) {
      return res.status(409).json({ error: `Exercice ${ex} figé : cette saisie n'est plus supprimable` });
    }

    const { error } = await supabaseAdmin
      .from(MISSION_AVANCEMENTS_TABLE)
      .delete()
      .eq('mission_id', String(missionId))
      .eq('exercice', ex);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/avancement error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Figeage d'un exercice a la cloture : toutes ses lignes deviennent non modifiables. Action
// volontaire (aucun couplage automatique a la liasse). Pas de defigeage par l'API : cas
// exceptionnel, a traiter en SQL.
app.post('/api/avancement/figer', async (req, res) => {
  try {
    const ex = Number((req.body || {}).exercice);
    if (!Number.isInteger(ex) || ex < 2000 || ex > 2100) return res.status(400).json({ error: 'exercice hors bornes (2000 à 2100)' });
    const { disponible } = await fetchMissionAvancements();
    if (!disponible) return res.status(503).json({ error: `Table ${MISSION_AVANCEMENTS_TABLE} absente : exécuter ${MISSION_AVANCEMENTS_SQL_PATH}` });
    const { data, error } = await supabaseAdmin
      .from(MISSION_AVANCEMENTS_TABLE)
      .update({ fige_le: new Date().toISOString() })
      .eq('exercice', ex)
      .is('fige_le', null)
      .select('mission_id');
    if (error) throw new Error(error.message);
    res.json({ ok: true, lignesFigees: (data || []).length });
  } catch (e) {
    console.error('POST /api/avancement/figer error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 7 : vérifier la syntaxe et les tests**

Run: `node --check server.js`
Expected: aucune sortie (syntaxe valide)

Run: `npx jest`
Expected: PASS, 0 échec.

- [ ] **Step 8 : commit**

```bash
git add migrations/44_mission_avancements.sql server.js utils/caAvancement.js utils/caAvancement.test.js
git commit -m "feat(pilot) ca a l'avancement : table mission_avancements, endpoints de saisie et figeage

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3 : intégration dans les agrégats de CA (serveur)

**Files:**
- Modify: `server.js` : `/api/ebe` (boucle `caFacture` à server.js:9590, **PAS** celle de 9539), `/api/ca-annee` (server.js:8180-8189), `/api/analytics` (server.js:8113), `/api/kpi` (server.js:6954-6984)
- Test: `utils/caAvancement.test.js` (tests du helper de contributions)

**Interfaces:**
- Consomme : `computeAvancement`, `ajusterTotal` (Task 1) ; `fetchMissionAvancements` (Task 2).
- Produit :
  - `contributionsFacturees(missions, parMissionIds, start, end)` → `Map<missionId, number>` (dans `server.js`, base « volets facturés datés dans l'année »).
  - `contributionsSignees(missions, parMissionIds, year)` → `Map<missionId, number>` (base `signedAmountForYear`).
  - Champ additif `avancement` dans les réponses de `/api/ebe`, `/api/ca-annee`, `/api/analytics`, `/api/kpi` : `{ actif: boolean, delta: number, suivies: Array }`.

**ATTENTION (piège identifié) :** il existe DEUX boucles `caFacture` presque identiques dans `server.js`. Celle de la ligne **9539** est dans `computeResultatFactuelForYear` (miroir trésorerie) : **NE PAS Y TOUCHER**. Celle à modifier est dans `app.get('/api/ebe', ...)`, ligne **9590**. Vérifier avant d'éditer : `grep -n "let caFacture = 0" server.js` doit renvoyer deux lignes ; la bonne est la SECONDE (celle qui suit `app.get('/api/ebe'`).

- [ ] **Step 1 : écrire le test du helper de contributions (échoue)**

Ajouter à `utils/caAvancement.test.js` :

```javascript
const { contributionsDepuisVolets } = require('./caAvancement');

describe('contributionsDepuisVolets : ce qu une mission apporte a la base "factures emises datees dans l annee"', () => {
  test('acompte et solde dans l annee : les deux comptent', () => {
    const m = { id: 'm1', ca: 10000, montantAcompte: 5000, dateFactureAcompte: '2026-03-01', dateFactureFinale: '2026-09-01' };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).get('m1')).toBe(10000);
  });

  test('acompte en 2025, solde en 2026 : seul le solde compte pour 2026', () => {
    const m = { id: 'm1', ca: 10000, montantAcompte: 5000, dateFactureAcompte: '2025-12-22', dateFactureFinale: '2026-02-10' };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).get('m1')).toBe(5000);
  });

  test('aucune facture emise : contribution nulle', () => {
    const m = { id: 'm1', ca: 10000, montantAcompte: 5000, dateFactureAcompte: null, dateFactureFinale: null };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).get('m1')).toBe(0);
  });

  test('mission hors de la selection : absente de la Map', () => {
    const m = { id: 'm2', ca: 10000, montantAcompte: 5000, dateFactureAcompte: '2026-03-01' };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).has('m2')).toBe(false);
  });

  test('solde negatif ou nul ignore (acompte >= ca)', () => {
    const m = { id: 'm1', ca: 5000, montantAcompte: 5000, dateFactureAcompte: '2026-03-01', dateFactureFinale: '2026-09-01' };
    expect(contributionsDepuisVolets([m], new Set(['m1']), 2026).get('m1')).toBe(5000);
  });
});
```

- [ ] **Step 2 : lancer, vérifier l'échec**

Run: `npx jest utils/caAvancement.test.js -t "contributionsDepuisVolets"`
Expected: FAIL avec `contributionsDepuisVolets is not a function`

- [ ] **Step 3 : implémenter le helper dans le module pur**

Dans `utils/caAvancement.js`, avant `module.exports` :

```javascript
// Ce qu'une mission suivie apporte a la base "factures emises datees dans l'annee" (celle du CR).
// Sert a retirer exactement sa contribution avant d'ajouter son CA a l'avancement. On compare des
// annees sur la chaine de date (slice) et non des objets Date, pour rester insensible au fuseau.
function contributionsDepuisVolets(missions, missionIds, exercice) {
  const contributions = new Map();
  const ex = Number(exercice);
  const anneeDe = (d) => (d ? Number(String(d).slice(0, 4)) : null);
  for (const m of missions || []) {
    const id = m && m.id != null ? String(m.id) : null;
    if (!id || !missionIds || !missionIds.has(id)) continue;
    const ca = Number(m.ca) || 0;
    const acompte = Number(m.montantAcompte) || 0;
    const solde = Math.max(0, ca - acompte);
    let total = 0;
    if (acompte > 0 && anneeDe(m.dateFactureAcompte) === ex) total += acompte;
    if (solde > 0 && anneeDe(m.dateFactureFinale) === ex) total += solde;
    contributions.set(id, Math.round(total));
  }
  return contributions;
}
```

Ajouter `contributionsDepuisVolets` à `module.exports`.

- [ ] **Step 4 : lancer, vérifier que ça passe**

Run: `npx jest utils/caAvancement.test.js`
Expected: PASS

- [ ] **Step 5 : brancher `/api/ebe` (le CR)**

Dans `server.js`, dans `app.get('/api/ebe', ...)`, après `caFacture = Math.round(caFacture);` (la ligne qui suit la SECONDE boucle `caFacture`, celle de l'endpoint, pas celle du miroir) :

```javascript
    // CA a l'avancement (FAE/PCA) : pour les missions suivies, la contribution "factures emises
    // dans l'annee" est REMPLACEE par ca x (avancement fin N - avancement fin N-1). Missions non
    // suivies et exercices < 2026 : strictement inchange. Le miroir trésorerie
    // (computeResultatFactuelForYear) reste volontairement a la facture : l'avancement deplace du
    // CA comptable, pas des encaissements.
    const { lignes: lignesAvancement } = await fetchMissionAvancements();
    const calculAvancement = computeAvancement(missions, lignesAvancement, yearParam);
    const caFactureAvantAvancement = caFacture;
    if (calculAvancement.actif) {
      const contributions = contributionsDepuisVolets(missions, new Set(calculAvancement.parMission.keys()), yearParam);
      caFacture = ajusterTotal(caFacture, contributions, calculAvancement.parMission);
    }
```

Puis, dans l'objet passé à `res.json(...)` de `/api/ebe` (celui qui contient déjà `quotePartsValidees`, server.js:9742), ajouter un champ ADDITIF :

```javascript
      avancement: {
        actif: calculAvancement.actif,
        delta: caFacture - caFactureAvantAvancement,
        base: caFactureAvantAvancement,
        suivies: calculAvancement.suivies,
      },
```

Importer `ajusterTotal` et `contributionsDepuisVolets` en complétant le `require('./utils/caAvancement')` ajouté en Task 2.

- [ ] **Step 6 : brancher `/api/ca-annee`, `/api/analytics` et `/api/kpi`**

Ajouter d'abord un helper partagé dans `server.js`, juste après `fetchMissionAvancements` :

```javascript
// CA de l'annee (base totalCaAnnee : facture + non facture rattache par "Annee final") ajuste de
// l'avancement. Retourne { caAnnee, avancement } pour que les trois pages (Cockpit, Analytics,
// KPI) affichent exactement le meme chiffre, comme c'etait deja le cas avant l'avancement.
async function caAnneeAvecAvancement(missions, year) {
  const base = totalCaAnnee(missions, year);
  const { lignes } = await fetchMissionAvancements();
  const calcul = computeAvancement(missions, lignes, year);
  if (!calcul.actif) {
    return { caAnnee: base, avancement: { actif: false, delta: 0, base, suivies: [] } };
  }
  // Contribution a CETTE base : signedAmountForYear (qui replie sur "Annee final" quand la facture
  // n'est pas emise), et non les seules factures emises du CR.
  const contributions = new Map();
  for (const m of missions || []) {
    const id = m && m.id != null ? String(m.id) : null;
    if (!id || !calcul.parMission.has(id)) continue;
    contributions.set(id, signedAmountForYear(m, year));
  }
  const caAnnee = ajusterTotal(base, contributions, calcul.parMission);
  return { caAnnee, avancement: { actif: true, delta: caAnnee - base, base, suivies: calcul.suivies } };
}
```

`signedAmountForYear` doit être importé depuis `utils/kpiCompute.js` : vérifier qu'il est bien exporté (`grep -n "signedAmountForYear" utils/kpiCompute.js` ; il est défini ligne 24). S'il n'est pas dans `module.exports`, l'y ajouter (ajout purement additif, aucun comportement modifié).

Puis :

1. `/api/ca-annee` (server.js:8180-8189) : remplacer
   `res.json({ year, caAnnee: totalCaAnnee(missions, year) });`
   par
   ```javascript
    const { caAnnee, avancement } = await caAnneeAvecAvancement(missions, year);
    res.json({ year, caAnnee, avancement });
   ```

2. `/api/analytics` (server.js:8113) : remplacer
   `caAnnee: totalCaAnnee(missions, parseInt(String(start).slice(0, 4), 10)),`
   par une valeur pré-calculée avant le `res.json` :
   ```javascript
    const _anneeAnalytics = parseInt(String(start).slice(0, 4), 10);
    const { caAnnee: _caAnneeAjuste, avancement: _avancementAnalytics } = await caAnneeAvecAvancement(missions, _anneeAnalytics);
   ```
   puis dans l'objet de réponse : `caAnnee: _caAnneeAjuste,` et ajouter `avancement: _avancementAnalytics,`.

3. `/api/kpi` (server.js:6954-6984) : après `const result = computeKpi({ ... });`, ajouter :
   ```javascript
    // Tuile "CA {annee} HT" et avancement collectif : meme chiffre que le Cockpit et Analytics.
    const { caAnnee: _caAnneeKpi, avancement: _avancementKpi } = await caAnneeAvecAvancement(missions, year);
    result.caAnnee = _caAnneeKpi;
    result.avancement = _avancementKpi;
   ```

- [ ] **Step 7 : vérifier syntaxe et suite complète**

Run: `node --check server.js`
Expected: aucune sortie.

Run: `npx jest`
Expected: PASS, 0 échec. En particulier `utils/kpiCompute.test.js` doit rester vert : `totalCaAnnee` et `signedAmountForYear` n'ont pas changé de comportement.

- [ ] **Step 8 : commit**

```bash
git add server.js utils/caAvancement.js utils/caAvancement.test.js
git commit -m "feat(pilot) ca a l'avancement : integration CR, Cockpit, Analytics et KPI (remplacement par consommateur)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4 : test de gouvernance (non-régression des zones intouchables)

**Files:**
- Create: `utils/caAvancementGouvernance.test.js`

**Interfaces:**
- Consomme : rien du code applicatif (le test lit les fichiers sources en texte).
- Produit : une garde automatisée contre la contamination des circuits rémunération et trésorerie.

Ce test suit le patron du test I7 du lot « CR hors capitalisation » (`utils/crRetraiteGouvernance.test.js`) : il lit les sources et vérifie que certaines zones ne référencent jamais les symboles de l'avancement. Il doit avoir du mordant : si quelqu'un branche l'avancement sur les primes ou sur le miroir trésorerie, le test tombe.

- [ ] **Step 1 : écrire le test**

Créer `utils/caAvancementGouvernance.test.js` :

```javascript
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
```

- [ ] **Step 2 : lancer le test, vérifier qu'il passe**

Run: `npx jest utils/caAvancementGouvernance.test.js`
Expected: PASS. S'il échoue sur `utils/caAvancement.js ne fait aucune I/O`, c'est que le module contient un `require` ou un `new Date(` : les retirer (le module doit recevoir l'année courante en paramètre, cf. `validerSaisieAvancement`).

- [ ] **Step 3 : prouver le mordant du test (mutation)**

Copier temporairement `server.js` vers `/tmp/server-mutant.js`, y insérer `const x = fetchMissionAvancements;` dans le corps de `computeResultatFactuelForYear`, adapter le chemin du test à la copie et vérifier qu'il ÉCHOUE. Puis supprimer la copie. Documenter le résultat dans le rapport de tâche (ne rien committer de la mutation).

- [ ] **Step 4 : lancer la suite complète**

Run: `npx jest`
Expected: PASS, 0 échec.

- [ ] **Step 5 : commit**

```bash
git add utils/caAvancementGouvernance.test.js
git commit -m "test(pilot) ca a l'avancement : gouvernance (primes et miroir tresorerie hors perimetre)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5 : front · modale de saisie de l'avancement

**Files:**
- Modify: `public/pilot.html` (onglet Facturation : entête vers la ligne 4115-4140 ; nouvelle modale à ajouter près des autres modales, vers la ligne 20966 où se trouve `ponderationModal` ; fonctions JS à ajouter près des fonctions de l'onglet Facturation, vers la ligne 14056)
- Modify: `dist/pilot.html` (copie bit-à-bit)

**Interfaces:**
- Consomme : `GET /api/avancement?year=YYYY`, `POST /api/avancement`, `DELETE /api/avancement`, `POST /api/avancement/figer` (Task 2).
- Produit : `openAvancementModal()`, `closeAvancementModal()`, `renderAvancementModal()`, `saveAvancementLigne(missionId, exercice)`, `removeAvancementLigne(missionId, exercice)`, `figerAvancement(exercice)`, variable d'état `avancementData`.

- [ ] **Step 1 : ajouter le bouton d'ouverture dans l'onglet Facturation**

Dans `public/pilot.html`, juste après `<p class="page-desc">Suivi de la facturation des missions Notion.</p>` (vers la ligne 4116), insérer :

```html
    <div style="margin-bottom:1rem">
      <button onclick="openAvancementModal()" style="padding:0.4rem 0.8rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:0.82rem;cursor:pointer">
        Avancement des missions
      </button>
      <span style="font-size:0.75rem;color:var(--text-secondary);margin-left:0.5rem">Repartition du CA des missions a cheval sur deux exercices (factures a etablir et produits constates d'avance).</span>
    </div>
```

- [ ] **Step 2 : ajouter la modale**

Dans `public/pilot.html`, juste avant la ligne `<div class="modal-overlay" id="ponderationModal"` (vers 20966), insérer :

```html
  <div class="modal-overlay" id="avancementModal" onclick="if(event.target===this) closeAvancementModal()">
    <div class="modal-box" style="max-width:920px">
      <div class="modal-header">
        <div>
          <div class="modal-title">Avancement des missions</div>
          <div class="modal-subtitle" id="avancementSubtitle"></div>
        </div>
        <button class="modal-close" onclick="closeAvancementModal()">&times;</button>
      </div>
      <div class="modal-body" id="avancementBody"></div>
    </div>
  </div>
```

Note : reprendre les classes exactes utilisées par `ponderationModal` dans ce fichier (`modal-overlay`, `modal-box`, `modal-header`, `modal-title`, `modal-close`, `modal-body`) ; si leurs noms diffèrent, s'aligner sur ceux réellement présents plutôt que d'en inventer.

- [ ] **Step 3 : ajouter les fonctions JS**

Dans `public/pilot.html`, dans le bloc `<script>` de l'onglet Facturation (près de `let factPeriodStart = null;`, vers 14056), insérer :

```javascript
    // --- CA a l'avancement (FAE/PCA) : spec 2026-08-31-ca-avancement-design.md ---
    // Le CA d'une mission a cheval sur deux exercices est reparti selon son avancement au 31/12,
    // pas selon les dates de facturation. Cette modale est le seul point de saisie.
    let avancementData = null;

    async function openAvancementModal() {
      document.getElementById('avancementModal').classList.add('active');
      document.getElementById('avancementBody').innerHTML = '<p style="color:var(--text-secondary)">Chargement...</p>';
      await loadAvancement();
    }

    function closeAvancementModal() {
      document.getElementById('avancementModal').classList.remove('active');
    }

    async function loadAvancement() {
      try {
        const res = await fetch('/api/avancement?year=' + CURRENT_YEAR);
        avancementData = await res.json();
        renderAvancementModal();
      } catch (e) {
        document.getElementById('avancementBody').innerHTML = '<p style="color:var(--danger)">Erreur de chargement : ' + e.message + '</p>';
      }
    }

    function renderAvancementModal() {
      const d = avancementData;
      if (!d) return;
      const ex = d.exercice;
      const exPrec = ex - 1;
      document.getElementById('avancementSubtitle').textContent =
        'Exercice ' + ex + ' : CA reconnu = CA mission x (avancement au 31/12/' + ex + ' moins avancement au 31/12/' + exPrec + ').';

      let html = '';

      if (!d.disponible) {
        html += '<div class="cr-alerte">Table mission_avancements absente : executer migrations/44_mission_avancements.sql dans Supabase. La saisie est desactivee, aucun CA n\'est ajuste.</div>';
        document.getElementById('avancementBody').innerHTML = html;
        return;
      }

      if (d.anomalies && d.anomalies.length) {
        html += '<div class="cr-alerte">Incoherence detectee sur ' + d.anomalies.length + ' mission(s) terminee(s) : la somme des CA par exercice ne retombe pas sur le CA de la mission. Verifier les pourcentages saisis.</div>';
      }

      // Tableau des missions suivies
      html += '<table style="width:100%;border-collapse:collapse;font-size:0.82rem;margin-bottom:1rem">';
      html += '<thead><tr style="text-align:left;border-bottom:1px solid var(--border)">'
        + '<th style="padding:0.4rem">Mission</th><th style="padding:0.4rem;text-align:right">CA HT</th>'
        + '<th style="padding:0.4rem;text-align:right">Av. 31/12/' + exPrec + '</th>'
        + '<th style="padding:0.4rem;text-align:right">Av. 31/12/' + ex + '</th>'
        + '<th style="padding:0.4rem;text-align:right">CA ' + ex + '</th>'
        + '<th style="padding:0.4rem"></th></tr></thead><tbody>';

      const figeePrec = (d.lignes || []).some(l => l.exercice === exPrec && l.fige_le);
      for (const s of (d.suivies || [])) {
        const ligneEx = (d.lignes || []).find(l => l.mission_id === s.missionId && l.exercice === ex);
        const figee = !!(ligneEx && ligneEx.fige_le);
        html += '<tr style="border-bottom:1px solid var(--border)">'
          + '<td style="padding:0.4rem">' + s.nom + '</td>'
          + '<td style="padding:0.4rem;text-align:right">' + formatEuro(s.ca) + '</td>'
          + '<td style="padding:0.4rem;text-align:right;color:var(--text-secondary)">' + s.pctPrecedent + ' %' + (figeePrec ? ' <span title="exercice fige">·</span>' : '') + '</td>'
          + '<td style="padding:0.4rem;text-align:right">'
          + (figee
              ? s.pctCourant + ' % <span style="font-size:0.7rem;color:var(--text-secondary)">fige</span>'
              : '<input type="number" min="0" max="100" step="1" value="' + s.pctCourant + '" id="av-' + s.missionId + '" style="width:64px;padding:0.2rem;text-align:right;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text)">')
          + '</td>'
          + '<td style="padding:0.4rem;text-align:right;font-weight:600">' + formatEuro(s.caAvancement) + '</td>'
          + '<td style="padding:0.4rem;text-align:right">'
          + (figee ? '' : '<button onclick="saveAvancementLigne(\'' + s.missionId + '\',' + ex + ')" style="padding:0.2rem 0.5rem;font-size:0.75rem;cursor:pointer">OK</button>'
             + ' <button onclick="removeAvancementLigne(\'' + s.missionId + '\',' + ex + ')" style="padding:0.2rem 0.5rem;font-size:0.75rem;cursor:pointer">Retirer</button>')
          + '</td></tr>';
      }
      if (!(d.suivies || []).length) {
        html += '<tr><td colspan="6" style="padding:0.6rem;color:var(--text-secondary)">Aucune mission suivie a l\'avancement pour ' + ex + '.</td></tr>';
      }
      html += '</tbody></table>';

      // Ajout d'une mission au suivi
      const suiviesIds = new Set((d.suivies || []).map(s => s.missionId));
      const dispo = (d.missions || []).filter(m => !suiviesIds.has(String(m.id)));
      html += '<div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:1rem">'
        + '<select id="avancementNouvelle" style="flex:1;padding:0.35rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:0.8rem">'
        + '<option value="">Ajouter une mission au suivi...</option>'
        + dispo.map(m => '<option value="' + m.id + '">' + (m.nom || '') + ' · ' + (m.client || '') + ' · ' + formatEuro(m.ca || 0) + '</option>').join('')
        + '</select>'
        + '<input type="number" min="0" max="100" step="1" id="avancementNouveauPct" placeholder="%" style="width:70px;padding:0.35rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text)">'
        + '<button onclick="addAvancementLigne(' + ex + ')" style="padding:0.35rem 0.7rem;cursor:pointer">Ajouter</button>'
        + '</div>';

      // Figeage
      html += '<div style="border-top:1px solid var(--border);padding-top:0.75rem;font-size:0.78rem;color:var(--text-secondary)">'
        + 'A la cloture d\'un exercice, figer ses pourcentages : ils deviennent l\'avancement officiel au 31/12 et ne sont plus modifiables.'
        + ' <button onclick="figerAvancement(' + exPrec + ')" style="padding:0.25rem 0.6rem;font-size:0.75rem;cursor:pointer;margin-left:0.5rem">Figer ' + exPrec + '</button>'
        + ' <button onclick="figerAvancement(' + ex + ')" style="padding:0.25rem 0.6rem;font-size:0.75rem;cursor:pointer">Figer ' + ex + '</button>'
        + '</div>';

      document.getElementById('avancementBody').innerHTML = html;
    }

    async function postAvancement(url, method, body) {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    async function saveAvancementLigne(missionId, exercice) {
      const input = document.getElementById('av-' + missionId);
      if (!input) return;
      try {
        await postAvancement('/api/avancement', 'POST', { missionId, exercice, pct: Number(input.value) });
        await loadAvancement();
      } catch (e) { alert('Enregistrement impossible : ' + e.message); }
    }

    async function addAvancementLigne(exercice) {
      const sel = document.getElementById('avancementNouvelle');
      const pct = document.getElementById('avancementNouveauPct');
      if (!sel || !sel.value) return;
      try {
        await postAvancement('/api/avancement', 'POST', { missionId: sel.value, exercice, pct: Number(pct.value) || 0 });
        await loadAvancement();
      } catch (e) { alert('Ajout impossible : ' + e.message); }
    }

    async function removeAvancementLigne(missionId, exercice) {
      if (!confirm('Retirer cette mission du suivi a l\'avancement pour ' + exercice + ' ?')) return;
      try {
        await postAvancement('/api/avancement', 'DELETE', { missionId, exercice });
        await loadAvancement();
      } catch (e) { alert('Suppression impossible : ' + e.message); }
    }

    async function figerAvancement(exercice) {
      if (!confirm('Figer definitivement les pourcentages de ' + exercice + ' ? Ils ne seront plus modifiables depuis Pilot.')) return;
      try {
        const r = await postAvancement('/api/avancement/figer', 'POST', { exercice });
        alert(r.lignesFigees + ' ligne(s) figee(s) pour ' + exercice + '.');
        await loadAvancement();
      } catch (e) { alert('Figeage impossible : ' + e.message); }
    }
```

Vérifier avant d'écrire : la classe utilisée pour ouvrir une modale dans ce fichier (`classList.add('active')` ou autre) doit être celle réellement employée par `openPonderationModal` (`grep -n "function openPonderationModal" -A 8 public/pilot.html`). S'aligner dessus. De même pour `cr-alerte` : reprendre la classe d'alerte réellement définie dans le CSS du fichier.

- [ ] **Step 4 : synchroniser dist et vérifier**

```bash
cp public/pilot.html dist/pilot.html
cmp public/pilot.html dist/pilot.html
node --check server.js
npx jest
```

Expected: `cmp` sans sortie, `node --check` sans sortie, jest 0 échec.

- [ ] **Step 5 : commit**

```bash
git add public/pilot.html dist/pilot.html
git commit -m "feat(pilot) ca a l'avancement : modale de saisie dans l'onglet Facturation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6 : front · badges « à l'avancement » et note de convention

**Files:**
- Modify: `public/pilot.html` (ligne CA du CR vers 15898 ; card Cockpit vers 20297-20300 ; card Analytics vers 12114 ; modale de réconciliation liasse, chercher la note de convention CA)
- Modify: `dist/pilot.html` (copie bit-à-bit)

**Interfaces:**
- Consomme : champ `avancement` des réponses `/api/ebe`, `/api/ca-annee`, `/api/analytics` (Task 3).
- Produit : rien pour d'autres tâches (feuille finale du plan).

- [ ] **Step 1 : badge sur la ligne CA du CR**

Dans `public/pilot.html`, repérer la ligne (`grep -n "Chiffre d'affaires\" + (projete" public/pilot.html`) :

```javascript
      html += row("Chiffre d'affaires" + (projete ? ' (facture + pipeline)' : ' facture'), ca, { onclick: "openCrDetailModal('ca')" });
```

La remplacer par :

```javascript
      // Badge "a l'avancement" : le CA des missions a cheval est reparti selon leur avancement au
      // 31/12, pas selon leurs dates de facturation (FAE/PCA). Silencieux si aucun ajustement.
      const _av = d.avancement || null;
      const _avActif = !!(_av && _av.actif && _av.delta !== 0);
      const _avBadge = _avActif
        ? ' <span style="font-size:0.68rem;padding:0.05rem 0.35rem;border:1px solid var(--border);border-radius:10px;color:var(--text-secondary)">a l\'avancement</span>'
        : '';
      const _avTitre = _avActif
        ? "CA a l'avancement : " + _av.suivies.length + ' mission(s) a cheval, ajustement de ' + formatEuro(_av.delta) + ' par rapport aux dates de facturation.'
        : '';
      html += row("Chiffre d'affaires" + (projete ? ' (facture + pipeline)' : ' facture'), ca, { onclick: "openCrDetailModal('ca')", badge: _avBadge, title: _avTitre });
      if (_avActif) {
        html += subRow("dont ajustement d'avancement (FAE/PCA)", formatEuro(_av.delta));
      }
```

(La fabrique `row` accepte déjà `badge` et `title` dans ses options : vérifier sa signature dans le fichier, elle est documentée `opts : {neg, plus, total, sep, onclick, badge, title}`.)

- [ ] **Step 2 : badge sur les cards Cockpit et Analytics**

Cockpit (vers 20297) : remplacer

```javascript
        .then(d => { document.getElementById('ckCaAnnee').textContent = formatEuro(d.caAnnee || 0); })
```

par

```javascript
        .then(d => {
          document.getElementById('ckCaAnnee').textContent = formatEuro(d.caAnnee || 0);
          // Infobulle si le CA integre un ajustement d'avancement (missions a cheval, FAE/PCA).
          const _el = document.getElementById('ckCaAnnee');
          if (d.avancement && d.avancement.actif && d.avancement.delta !== 0) {
            _el.title = "CA a l'avancement : ajustement de " + formatEuro(d.avancement.delta) + ' sur ' + d.avancement.suivies.length + ' mission(s) a cheval sur deux exercices.';
          } else {
            _el.title = '';
          }
        })
```

Analytics (vers 12114) : après

```javascript
      document.getElementById('analyticsCa').textContent = formatEuro(data.caAnnee != null ? data.caAnnee : data.ca);
```

ajouter

```javascript
      // Meme infobulle que le Cockpit : le CA affiche integre l'avancement des missions a cheval.
      // Le graphe mensuel ci-dessous reste date a la facture (un pourcentage d'avancement n'a pas
      // de mois d'atterrissage) : les deux peuvent donc differer, c'est voulu.
      const _elAnalyticsCa = document.getElementById('analyticsCa');
      if (data.avancement && data.avancement.actif && data.avancement.delta !== 0) {
        _elAnalyticsCa.title = "CA a l'avancement : ajustement de " + formatEuro(data.avancement.delta) + " sur " + data.avancement.suivies.length + " mission(s) a cheval. Le graphe mensuel reste date a la facture.";
      } else {
        _elAnalyticsCa.title = '';
      }
```

- [ ] **Step 3 : réécrire la note de convention de la réconciliation liasse**

Repérer la note actuelle : `grep -n "a la facture Notion\|compte à la facture" public/pilot.html`. Remplacer le texte de convention concernant le CA par :

```
Pilot compte le CA a l'avancement depuis 2026 (missions a cheval reparties selon leur avancement au 31/12) ; les exercices 2025 et anterieurs restent comptes a la date de facture, la liasse faisant foi.
```

Conserver la structure HTML environnante à l'identique (seul le texte change).

- [ ] **Step 4 : synchroniser dist et vérifier**

```bash
cp public/pilot.html dist/pilot.html
cmp public/pilot.html dist/pilot.html
node --check server.js
npx jest
```

Expected: `cmp` sans sortie, jest 0 échec.

Vérifier aussi l'absence de tiret cadratin dans le diff :

```bash
git diff | grep -c "—"
```

Expected: `0`

- [ ] **Step 5 : commit**

```bash
git add public/pilot.html dist/pilot.html
git commit -m "feat(pilot) ca a l'avancement : badges CR/Cockpit/Analytics et note de convention de la reconciliation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Auto-revue du plan (faite)

**1. Couverture de la spec**

| Exigence spec | Tâche |
|---|---|
| §2.1 table `mission_avancements` | Task 2 (migration 44) |
| §3.1 `pctFin` report en avant | Task 1 |
| §3.2 formule du CA à l'avancement | Task 1 |
| §3.3 remplacement par consommateur | Task 1 (`ajusterTotal`, `contributionsDepuisVolets`) + Task 3 |
| §3.4 ancre 2025 | Task 2 (`EXERCICE_ANCRE` accepté à la saisie) + Task 5 (saisie via la modale) |
| §3.5 invariant vie-entière | Task 1 (`verifierInvariantAvancement`) + Task 5 (bandeau d'anomalies) |
| §4.1 module pur | Task 1 |
| §4.2 accès données + 4 endpoints | Task 2 |
| §4.3 intégration des 4 agrégats | Task 3 |
| §4.4 zones intouchées | Task 4 (test de gouvernance) |
| §5.1 modale de saisie | Task 5 |
| §5.2 badges et note de convention | Task 6 |
| §6.1 tests unitaires | Tasks 1, 2, 3 (TDD) et 4 (gouvernance) |
| §6.2 recette live | Hors plan : faite par le contrôleur après implémentation, sur un port dédié en lecture seule |

**2. Placeholders** : aucun « TBD », aucune étape sans code. Les trois points où l'implémenteur doit vérifier une convention existante (classes de modale, classe d'alerte, signature de `row`) sont explicitement accompagnés de la commande `grep` qui donne la réponse.

**3. Cohérence des types** : `parMission` est une `Map<string, number>` partout ; `contributionsDepuisVolets` et `contributionsBase` ont la même forme ; le champ de réponse s'appelle `avancement` dans les quatre endpoints ; `suivies` porte les mêmes clés (`missionId`, `nom`, `ca`, `pctPrecedent`, `pctCourant`, `caAvancement`) du module au front.
