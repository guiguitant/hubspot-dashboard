# Calculateur d'allocation (v1 autonome) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fournir un calculateur autonome qui, selon le type de deal (newsale/upsale) et qui a assuré chaque composante, affiche la répartition en % suggérée, sans toucher au calcul des KPI ni des primes.

**Architecture:** Une fonction pure `computeAllocation` + les deux grilles vivent dans un nouveau module `utils/allocationGrid.js` (source de vérité, testée par Jest). Le front `public/pilot.html` embarque un miroir de cette logique (comme le miroir de dormance existant) et une petite modale de saisie. Aucune écriture en base, aucun appel serveur, aucune modification de `utils/kpiCompute.js`, `server.js` ou de la table `kpi_ca_split`.

**Tech Stack:** Node.js CommonJS (util), Jest (tests), vanilla JS + HTML/CSS inline (front, dans pilot.html).

## Global Constraints

- Backend et utils en CommonJS (`require` / `module.exports`), pas d'`import/export`.
- `public/pilot.html` et `dist/pilot.html` doivent rester **identiques** : après toute édition de `public/pilot.html`, copier vers `dist/pilot.html`.
- `utils/allocationGrid.js` est la **source de vérité** des poids ; le miroir dans `pilot.html` doit rester synchronisé (commentaire de rappel obligatoire).
- Aucun tiret cadratin (« — ») dans le code ni les commentaires.
- Textes et commentaires en français.
- Poids des grilles (verbatim de la spec `docs/superpowers/specs/2026-07-30-allocation-copartner-commercial-design.md`) :
  - Newsale : sourcing 30, rdv_nego 30, prez 20, relance 20.
  - Upsale : sourcing 30, operationnel 35, rdv_nego 20, prez 15.

---

### Task 1: Logique d'allocation (module testé)

**Files:**
- Create: `utils/allocationGrid.js`
- Test: `utils/allocationGrid.test.js`

**Interfaces:**
- Produces:
  - `GRIDS` : `{ newsale: [{key,label,weight}], upsale: [{key,label,weight}] }`.
  - `computeAllocation(type: 'newsale'|'upsale', assignments: {[compKey:string]: string[]}) : {[person:string]: number}` — entiers dont la somme vaut 100, ou `{}` si aucune composante assurée. Lève une erreur si `type` inconnu.
  - `roundTo100(weightsByPerson: {[person:string]: number}) : {[person:string]: number}`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `utils/allocationGrid.test.js` :

```js
'use strict';
const { GRIDS, computeAllocation } = require('./allocationGrid');

describe('GRIDS', () => {
  it('chaque grille somme a 100', () => {
    for (const type of ['newsale', 'upsale']) {
      const total = GRIDS[type].reduce((s, c) => s + c.weight, 0);
      expect(total).toBe(100);
    }
  });
});

describe('computeAllocation', () => {
  it('newsale, une seule personne sur tout -> 100 %', () => {
    const a = { sourcing: ['A'], rdv_nego: ['A'], prez: ['A'], relance: ['A'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 100 });
  });

  it('newsale, A source / B gere le reste -> 30 / 70', () => {
    const a = { sourcing: ['A'], rdv_nego: ['B'], prez: ['B'], relance: ['B'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 30, B: 70 });
  });

  it('newsale, A sourcing+relance / B rdv+prez -> 50 / 50', () => {
    const a = { sourcing: ['A'], relance: ['A'], rdv_nego: ['B'], prez: ['B'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 50, B: 50 });
  });

  it('upsale, A apporteur / C operationnel / B rdv+prez -> 30 / 35 / 35', () => {
    const a = { sourcing: ['A'], operationnel: ['C'], rdv_nego: ['B'], prez: ['B'] };
    expect(computeAllocation('upsale', a)).toEqual({ A: 30, C: 35, B: 35 });
  });

  it('composante partagee -> poids reparti a parts egales', () => {
    const a = { sourcing: ['A', 'B'], rdv_nego: ['A'], prez: ['A'], relance: ['A'] };
    expect(computeAllocation('newsale', a)).toEqual({ A: 85, B: 15 });
  });

  it('composante non assuree -> poids redistribue (normalisation)', () => {
    const a = { sourcing: ['A'], rdv_nego: ['B'], prez: ['B'] };
    expect(computeAllocation('upsale', a)).toEqual({ A: 46, B: 54 });
  });

  it('somme toujours exactement 100', () => {
    const a = { sourcing: ['A'], rdv_nego: ['B'], prez: ['C'], relance: ['C'] };
    const r = computeAllocation('newsale', a);
    expect(r).toEqual({ A: 30, B: 30, C: 40 });
    expect(Object.values(r).reduce((s, v) => s + v, 0)).toBe(100);
  });

  it('aucune composante assuree -> {}', () => {
    expect(computeAllocation('newsale', {})).toEqual({});
  });

  it('type inconnu -> leve une erreur', () => {
    expect(() => computeAllocation('autre', {})).toThrow();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `npx jest utils/allocationGrid.test.js`
Expected: FAIL avec « Cannot find module './allocationGrid' ».

- [ ] **Step 3: Écrire l'implémentation minimale**

Créer `utils/allocationGrid.js` :

```js
'use strict';

// Grilles d'allocation du CA entre co-partners commerciaux (SOURCE DE VERITE).
// Spec : docs/superpowers/specs/2026-07-30-allocation-copartner-commercial-design.md
// Un MIROIR de GRIDS + computeAllocation existe dans public/pilot.html (calculateur front) :
// toute modification des poids ou de la logique ici DOIT y etre repercutee.

const GRIDS = {
  newsale: [
    { key: 'sourcing', label: 'Sourcing du prospect', weight: 30 },
    { key: 'rdv_nego', label: 'RDV + negociation', weight: 30 },
    { key: 'prez', label: 'Redaction prez / proposition', weight: 20 },
    { key: 'relance', label: 'Relance + closing', weight: 20 },
  ],
  upsale: [
    { key: 'sourcing', label: "Sourcing / apporteur d'origine", weight: 30 },
    { key: 'operationnel', label: 'Aspect operationnel (retention)', weight: 35 },
    { key: 'rdv_nego', label: 'RDV + negociation', weight: 20 },
    { key: 'prez', label: 'Redaction prez / proposition', weight: 15 },
  ],
};

// Convertit des poids reels en pourcentages ENTIERS dont la somme vaut exactement 100
// (methode des plus forts restes). {} si le total est nul.
function roundTo100(weightsByPerson) {
  const persons = Object.keys(weightsByPerson);
  const total = persons.reduce((s, p) => s + weightsByPerson[p], 0);
  if (total <= 0) return {};
  const exact = {};
  const floored = {};
  let sumFloor = 0;
  for (const p of persons) {
    exact[p] = (weightsByPerson[p] / total) * 100;
    floored[p] = Math.floor(exact[p]);
    sumFloor += floored[p];
  }
  const remainder = 100 - sumFloor;
  const byFrac = persons.slice().sort((a, b) => (exact[b] - floored[b]) - (exact[a] - floored[a]));
  const out = Object.assign({}, floored);
  for (let i = 0; i < remainder; i++) out[byFrac[i % byFrac.length]] += 1;
  return out;
}

// type : 'newsale' | 'upsale'
// assignments : { composanteKey: [prenoms] }. Une composante partagee repartit son poids
// a parts egales entre ses personnes. Une composante sans personne est ignoree : son poids
// est redistribue au prorata des composantes assurees (via la normalisation finale).
function computeAllocation(type, assignments) {
  const grid = GRIDS[type];
  if (!grid) throw new Error(`Type d'allocation inconnu : ${type}`);
  const weightsByPerson = {};
  for (const comp of grid) {
    const raw = assignments && assignments[comp.key];
    const people = Array.isArray(raw) ? raw.filter(Boolean) : [];
    if (people.length === 0) continue;
    const share = comp.weight / people.length;
    for (const person of people) {
      weightsByPerson[person] = (weightsByPerson[person] || 0) + share;
    }
  }
  return roundTo100(weightsByPerson);
}

module.exports = { GRIDS, computeAllocation, roundTo100 };
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

Run: `npx jest utils/allocationGrid.test.js`
Expected: PASS (10 tests verts).

- [ ] **Step 5: Commit**

```bash
git add utils/allocationGrid.js utils/allocationGrid.test.js
git commit -m "feat(pilot) allocation : grilles newsale/upsale + calcul des parts (teste)"
```

---

### Task 2: Calculateur (UI front dans pilot.html)

**Files:**
- Modify: `public/pilot.html` (bloc `<style>` du `<head>`, bouton près de « Réglages » à ~`4247`, markup de modale près de la modale Réglages à ~`4388`, fonctions JS près de `toggleKpiReglages`/`closeKpiReglages` à ~`10982-10986`)
- Sync: `dist/pilot.html` (copie de `public/pilot.html`)

**Interfaces:**
- Consumes: la logique de Task 1, recopiee en miroir (`ALLOC_GRIDS`, `allocRoundTo100`, `allocComputeShares`).
- Produces: fonctions globales `openAllocCalc()`, `closeAllocCalc()`, `allocSetType(type)`, `allocRenderComponents()`, `allocRun()`, `allocCopy()` appelables depuis des handlers `onclick` inline (meme mecanisme que `toggleKpiReglages`).

- [ ] **Step 1: Ajouter le CSS**

Dans le bloc `<style>` principal du `<head>` de `public/pilot.html`, ajouter :

```css
.alloc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;}
.alloc-modal{background:#fff;color:#111;max-width:520px;width:92%;max-height:88vh;overflow:auto;border-radius:12px;padding:20px;}
.alloc-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.alloc-close{background:none;border:none;font-size:22px;cursor:pointer;line-height:1;}
.alloc-type{display:flex;gap:8px;margin-bottom:12px;}
.alloc-type-btn{flex:1;padding:8px;border:1px solid #ccc;border-radius:8px;background:#f5f5f5;color:#111;cursor:pointer;}
.alloc-type-btn.active{background:#003d2e;color:#fff;border-color:#003d2e;}
.alloc-label{display:block;font-size:13px;margin:8px 0 4px;}
.alloc-input{width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box;}
.alloc-components{margin:12px 0;}
.alloc-comp{padding:8px 0;border-bottom:1px solid #eee;}
.alloc-comp-title{font-size:13px;font-weight:600;margin-bottom:4px;}
.alloc-comp-people{display:flex;flex-wrap:wrap;gap:12px;}
.alloc-comp-people label{font-size:13px;display:flex;align-items:center;gap:4px;cursor:pointer;}
.alloc-calc-btn{width:100%;padding:10px;background:#003d2e;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;}
.alloc-result{margin-top:14px;}
.alloc-result-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;font-size:14px;}
```

- [ ] **Step 2: Ajouter le bouton + la modale (HTML)**

Juste après le bouton « Réglages » (`public/pilot.html:4247`), ajouter le bouton d'ouverture :

```html
<button type="button" id="allocCalcBtn" onclick="openAllocCalc()">Calculateur d'allocation</button>
```

Après la modale Réglages (`public/pilot.html:4388`), ajouter le markup de la modale :

```html
<!-- Calculateur d'allocation (v1 autonome, aucun impact KPI/primes) -->
<div id="allocCalcModal" class="alloc-overlay" style="display:none;">
  <div class="alloc-modal">
    <div class="alloc-head">
      <strong>Calculateur d'allocation</strong>
      <button type="button" class="alloc-close" onclick="closeAllocCalc()">&times;</button>
    </div>
    <div class="alloc-type">
      <button type="button" id="allocTypeNewsale" class="alloc-type-btn active" onclick="allocSetType('newsale')">Nouveau client (newsale)</button>
      <button type="button" id="allocTypeUpsale" class="alloc-type-btn" onclick="allocSetType('upsale')">Client qui revient (upsale)</button>
    </div>
    <label class="alloc-label" for="allocPeople">Personnes impliquees (separees par des virgules)</label>
    <input id="allocPeople" class="alloc-input" type="text" placeholder="ex. Nathan, Guillaume" oninput="allocRenderComponents()">
    <div id="allocComponents" class="alloc-components"></div>
    <button type="button" class="alloc-calc-btn" onclick="allocRun()">Calculer la repartition</button>
    <div id="allocResult" class="alloc-result"></div>
  </div>
</div>
```

- [ ] **Step 3: Ajouter le JavaScript**

Juste après la fonction `closeKpiReglages()` (`public/pilot.html:~10986`), ajouter :

```js
// --- Calculateur d'allocation (v1 autonome) ---
// MIROIR de utils/allocationGrid.js (source de verite, testee par Jest). Garder synchronise.
const ALLOC_GRIDS = {
  newsale: [
    { key: 'sourcing', label: 'Sourcing du prospect', weight: 30 },
    { key: 'rdv_nego', label: 'RDV + negociation', weight: 30 },
    { key: 'prez', label: 'Redaction prez / proposition', weight: 20 },
    { key: 'relance', label: 'Relance + closing', weight: 20 },
  ],
  upsale: [
    { key: 'sourcing', label: "Sourcing / apporteur d'origine", weight: 30 },
    { key: 'operationnel', label: 'Aspect operationnel (retention)', weight: 35 },
    { key: 'rdv_nego', label: 'RDV + negociation', weight: 20 },
    { key: 'prez', label: 'Redaction prez / proposition', weight: 15 },
  ],
};
let allocType = 'newsale';

function allocEsc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function allocGetPeople() {
  const raw = (document.getElementById('allocPeople').value || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return Array.from(new Set(raw));
}
function allocRoundTo100(w) {
  const persons = Object.keys(w);
  const total = persons.reduce(function (s, p) { return s + w[p]; }, 0);
  if (total <= 0) return {};
  const exact = {}, floored = {};
  let sumFloor = 0;
  for (const p of persons) { exact[p] = (w[p] / total) * 100; floored[p] = Math.floor(exact[p]); sumFloor += floored[p]; }
  const rem = 100 - sumFloor;
  const byFrac = persons.slice().sort(function (a, b) { return (exact[b] - floored[b]) - (exact[a] - floored[a]); });
  const out = Object.assign({}, floored);
  for (let i = 0; i < rem; i++) out[byFrac[i % byFrac.length]] += 1;
  return out;
}
function allocComputeShares(type, assignments) {
  const grid = ALLOC_GRIDS[type];
  if (!grid) return {};
  const w = {};
  for (const comp of grid) {
    const raw = assignments[comp.key];
    const people = Array.isArray(raw) ? raw.filter(Boolean) : [];
    if (people.length === 0) continue;
    const share = comp.weight / people.length;
    for (const p of people) w[p] = (w[p] || 0) + share;
  }
  return allocRoundTo100(w);
}
function openAllocCalc() {
  document.getElementById('allocCalcModal').style.display = 'flex';
  allocSetType('newsale');
}
function closeAllocCalc() {
  document.getElementById('allocCalcModal').style.display = 'none';
}
function allocSetType(t) {
  allocType = t;
  document.getElementById('allocTypeNewsale').classList.toggle('active', t === 'newsale');
  document.getElementById('allocTypeUpsale').classList.toggle('active', t === 'upsale');
  document.getElementById('allocResult').innerHTML = '';
  allocRenderComponents();
}
function allocRenderComponents() {
  const people = allocGetPeople();
  const wrap = document.getElementById('allocComponents');
  if (!people.length) { wrap.innerHTML = '<p style="font-size:13px;color:#666;">Entre au moins une personne ci-dessus.</p>'; return; }
  const grid = ALLOC_GRIDS[allocType];
  wrap.innerHTML = grid.map(function (c) {
    const boxes = people.map(function (p) {
      return '<label><input type="checkbox" data-comp="' + c.key + '" value="' + allocEsc(p) + '"> ' + allocEsc(p) + '</label>';
    }).join('');
    return '<div class="alloc-comp"><div class="alloc-comp-title">' + allocEsc(c.label) +
      ' <span style="color:#888;">(' + c.weight + '%)</span></div><div class="alloc-comp-people">' + boxes + '</div></div>';
  }).join('');
}
function allocRun() {
  const grid = ALLOC_GRIDS[allocType];
  const assignments = {};
  for (const c of grid) {
    const boxes = document.querySelectorAll('#allocComponents input[data-comp="' + c.key + '"]:checked');
    assignments[c.key] = Array.prototype.slice.call(boxes).map(function (b) { return b.value; });
  }
  const shares = allocComputeShares(allocType, assignments);
  const res = document.getElementById('allocResult');
  const entries = Object.entries(shares).sort(function (a, b) { return b[1] - a[1]; });
  if (!entries.length) { res.innerHTML = '<p style="font-size:13px;color:#666;">Coche au moins une composante.</p>'; return; }
  res.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">Repartition suggeree</div>' +
    entries.map(function (e) { return '<div class="alloc-result-row"><span>' + allocEsc(e[0]) + '</span><strong>' + e[1] + '%</strong></div>'; }).join('') +
    '<button type="button" class="alloc-calc-btn" style="margin-top:10px;background:#555;" onclick="allocCopy()">Copier</button>';
  res.dataset.copy = entries.map(function (e) { return e[0] + ': ' + e[1] + '%'; }).join('\n');
}
function allocCopy() {
  const txt = (document.getElementById('allocResult').dataset.copy) || '';
  if (navigator.clipboard) navigator.clipboard.writeText(txt);
}
```

Note: si `toggleKpiReglages` est exposee via `window.` plutot qu'en declaration globale, exposer de meme `window.openAllocCalc = openAllocCalc;` etc. Verifier le motif exact du voisinage a l'implementation.

- [ ] **Step 4: Synchroniser dist**

```bash
cp public/pilot.html dist/pilot.html
```

- [ ] **Step 5: Vérifier la syntaxe des scripts inline**

Créer `scratchpad-alloc-check.js` (dossier scratchpad de session) puis le lancer :

```js
'use strict';
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('public/pilot.html', 'utf8');
const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, errors = 0;
while ((m = re.exec(html))) {
  const src = m[1];
  if (!src.trim()) continue;
  i++;
  try { new vm.Script(src); } catch (e) { errors++; console.log('Bloc script #' + i + ' : ' + e.message); }
}
console.log(errors === 0 ? ('OK, ' + i + ' blocs script valides') : (errors + ' bloc(s) en erreur'));
```

Run: `node <scratchpad>/scratchpad-alloc-check.js`
Expected: `OK, <n> blocs script valides` (0 erreur).

- [ ] **Step 6: Vérification manuelle dans le navigateur**

Démarrer le serveur (`npm start`) puis ouvrir `http://localhost:3000`, page KPI, cliquer « Calculateur d'allocation ». Vérifier les 3 scénarios :

1. Type = Nouveau client. Personnes : `A, B`. Cocher : sourcing -> A ; RDV+négo -> B ; prez -> B ; relance -> B. Calculer.
   Attendu : `A 30%`, `B 70%`.
2. Type = Client qui revient. Personnes : `A, B, C`. Cocher : sourcing -> A ; opérationnel -> C ; RDV+négo -> B ; prez -> B. Calculer.
   Attendu : `C 35%`, `B 35%`, `A 30%`.
3. Type = Nouveau client. Personnes : `A`. Cocher les 4 composantes -> A. Calculer.
   Attendu : `A 100%`.

- [ ] **Step 7: Commit**

```bash
git add public/pilot.html dist/pilot.html
git commit -m "feat(pilot) KPI : calculateur d'allocation newsale/upsale (v1 autonome)"
```

---

## Hors périmètre (v2, plus tard)

- Remplissage automatique des champs `%` de la modale Réglages depuis le calculateur.
- Modification du moteur (`splitAmount`) pour qu'un partner hors `Partner_commercial` (ex. l'opé sur un upsale) touche sa part sans devoir etre liste dans Notion.
- Mémorisation des composantes cochées par mission (persistance).
- Récupération automatique de l'apporteur d'origine depuis la mission d'origine.
