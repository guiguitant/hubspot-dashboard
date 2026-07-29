# Suggestion de pondération du pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Afficher, dans le modal « Réglages pondération », une suggestion de % par étape calculée sur l'historique HubSpot réel, avec effectif et fiabilité, applicable d'un clic.

**Architecture:** Un module de calcul pur et testable (`utils/stageWinRates.js`), un endpoint backend `GET /api/pipeline-conversion` qui lit l'historique `dealstage` et met le résultat en cache, et un enrichissement du modal frontend qui consomme cet endpoint. L'utilisateur garde la main (aucune application automatique).

**Tech Stack:** Node.js/Express (CommonJS), Jest, vanilla JS (frontend IIFE dans `public/pilot.html`), API HubSpot CRM v3.

## Global Constraints

- Backend en **CommonJS** (`require` / `module.exports`), jamais `import`/`export`.
- Ne **JAMAIS** utiliser de tiret cadratin `—` dans le code ou les textes.
- Étapes du funnel (ordre, ids internes HubSpot) : `qualifiedtobuy` (RDV Qualif), `presentationscheduled` (RDV Propale), `decisionmakerboughtin` (Négociation), `contractsent` (Contrat envoyé). Ce sont exactement les 4 étapes `forecast` de `KANBAN_STAGES`.
- Calcul : `P(gagné | a atteint X)` = gagnés / **résolus** (gagnés + perdus) ayant `reached >= index(X)`. Les deals ouverts sont exclus.
- `suggested` = `Math.round(p * 100)`, ou `null` si `resolved` = 0.
- Intervalle de confiance : **Wilson à 95 %** (z = 1.96).
- Seuil de fiabilité : `confidence = 'ok'` si `resolved >= 30`, `'low'` si `0 < resolved < 30`, `'none'` si `resolved = 0`.
- Fenêtre temporelle : **tout l'historique** (aucun filtre de date, aucun sélecteur UI).
- Batch history HubSpot : **maximum 50 ids par appel** `batch/read`.
- `public/pilot.html` est la source de vérité (la route `/` la sert directement) ; ne pas éditer `dist/pilot.html` (resynchronisé au démarrage du serveur).
- Le nouvel endpoint suit le modèle de `/api/pipeline-ponderation` : pas de `accountContext` (endpoint dashboard, protégé par l'auth dashboard globale existante).

---

### Task 1: Fonction `wilson()` (intervalle de confiance)

**Files:**
- Create: `utils/stageWinRates.js`
- Test: `utils/stageWinRates.test.js`

**Interfaces:**
- Consumes: rien.
- Produces: `wilson(x, n)` → `{ low, high }` où `low`/`high` sont des proportions dans `[0, 1]`, ou `{ low: null, high: null }` si `n = 0`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `utils/stageWinRates.test.js` :

```js
'use strict';
const { wilson } = require('./stageWinRates');

describe('wilson — intervalle de confiance à 95 %', () => {
  it('n = 0 → bornes nulles', () => {
    expect(wilson(0, 0)).toEqual({ low: null, high: null });
  });
  it('50/100 → environ [0.40, 0.60]', () => {
    const ci = wilson(50, 100);
    expect(ci.low).toBeCloseTo(0.404, 2);
    expect(ci.high).toBeCloseTo(0.596, 2);
  });
  it('bornes toujours dans [0, 1]', () => {
    const a = wilson(0, 10);
    const b = wilson(10, 10);
    expect(a.low).toBeGreaterThanOrEqual(0);
    expect(b.high).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest utils/stageWinRates.test.js`
Expected: FAIL (« Cannot find module './stageWinRates' » ou `wilson is not a function`).

- [ ] **Step 3: Écrire l'implémentation minimale**

Créer `utils/stageWinRates.js` :

```js
'use strict';

// Intervalle de confiance de Wilson à 95 % pour une proportion x/n.
// Renvoie des proportions dans [0, 1] (converties en % par computeStageWinRates).
function wilson(x, n) {
  if (!n) return { low: null, high: null };
  const z = 1.96;
  const phat = x / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

module.exports = { wilson };
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `npx jest utils/stageWinRates.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add utils/stageWinRates.js utils/stageWinRates.test.js
git commit -m "feat(pilot) stageWinRates : intervalle de confiance de Wilson

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Fonction `analyzeDeal()` (reconstruction du parcours)

**Files:**
- Modify: `utils/stageWinRates.js`
- Test: `utils/stageWinRates.test.js`

**Interfaces:**
- Consumes: rien.
- Produces: `analyzeDeal({ historyValues, isClosedWon, isClosed })` → `{ won, lost, open, reached }`. `historyValues` = tableau de valeurs de `dealstage` (strings). `reached` = index (0-3) de l'étape du funnel la plus avancée présente, `-1` si aucune.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à `utils/stageWinRates.test.js` :

```js
const { analyzeDeal } = require('./stageWinRates');

describe('analyzeDeal — reconstruction du parcours', () => {
  it('gagné passé par Qualif puis Propale → reached = 1', () => {
    const d = analyzeDeal({ historyValues: ['qualifiedtobuy', 'presentationscheduled', 'closedwon'], isClosedWon: true, isClosed: true });
    expect(d).toEqual({ won: true, lost: false, open: false, reached: 1 });
  });
  it('perdu monté jusqu\'à Contrat → lost, reached = 3', () => {
    const d = analyzeDeal({ historyValues: ['decisionmakerboughtin', 'contractsent', 'closedlost'], isClosedWon: false, isClosed: true });
    expect(d).toEqual({ won: false, lost: true, open: false, reached: 3 });
  });
  it('importé direct à gagné (aucune étape funnel) → reached = -1', () => {
    const d = analyzeDeal({ historyValues: ['closedwon'], isClosedWon: true, isClosed: true });
    expect(d.reached).toBe(-1);
    expect(d.won).toBe(true);
  });
  it('deal ouvert en Négociation → open, reached = 2', () => {
    const d = analyzeDeal({ historyValues: ['qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin'], isClosedWon: false, isClosed: false });
    expect(d).toEqual({ won: false, lost: false, open: true, reached: 2 });
  });
  it('saut d\'étape (Qualif puis Contrat) → reached = 3', () => {
    const d = analyzeDeal({ historyValues: ['qualifiedtobuy', 'contractsent'], isClosedWon: false, isClosed: false });
    expect(d.reached).toBe(3);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest utils/stageWinRates.test.js`
Expected: FAIL (`analyzeDeal is not a function`).

- [ ] **Step 3: Écrire l'implémentation minimale**

Dans `utils/stageWinRates.js`, ajouter au-dessus de `module.exports` :

```js
// Étapes du funnel dans l'ordre commercial (ids internes HubSpot).
const FUNNEL = [
  { id: 'qualifiedtobuy',        label: 'RDV Qualif' },
  { id: 'presentationscheduled', label: 'RDV Propale' },
  { id: 'decisionmakerboughtin', label: 'Négociation' },
  { id: 'contractsent',          label: 'Contrat envoyé' },
];
const IDX = Object.fromEntries(FUNNEL.map((s, i) => [s.id, i]));

// Reconstruit le statut et l'étape max atteinte d'un deal à partir de l'historique dealstage.
// historyValues : liste des valeurs successives de dealstage (l'ordre n'importe pas ici).
function analyzeDeal({ historyValues, isClosedWon, isClosed }) {
  const won = isClosedWon === true;
  const closed = isClosed === true;
  const lost = closed && !won;
  const open = !closed;
  let reached = -1;
  for (const v of historyValues || []) {
    if (v in IDX) reached = Math.max(reached, IDX[v]);
  }
  return { won, lost, open, reached };
}
```

Et remplacer la ligne `module.exports = { wilson };` par :

```js
module.exports = { wilson, analyzeDeal, FUNNEL };
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `npx jest utils/stageWinRates.test.js`
Expected: PASS (tous les tests, y compris ceux de Task 1).

- [ ] **Step 5: Commit**

```bash
git add utils/stageWinRates.js utils/stageWinRates.test.js
git commit -m "feat(pilot) stageWinRates : reconstruction du parcours depuis l'historique dealstage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fonction `computeStageWinRates()` (statistiques par étape)

**Files:**
- Modify: `utils/stageWinRates.js`
- Test: `utils/stageWinRates.test.js`

**Interfaces:**
- Consumes: `wilson`, `analyzeDeal`, `FUNNEL` (mêmes fichier).
- Produces: `computeStageWinRates(deals)` où `deals = [{ won, lost, open, reached }]`. Retourne un tableau de 4 objets `{ id, label, won, resolved, suggested, ciLow, ciHigh, confidence }`. `suggested`/`ciLow`/`ciHigh` en pourcentages entiers ou `null`. `CONFIDENCE_MIN` exporté (= 30).

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à `utils/stageWinRates.test.js` :

```js
const { computeStageWinRates } = require('./stageWinRates');

// Fabrique n deals résolus ayant atteint l'étape `reached`, dont w gagnés.
function resolvedDeals(reached, w, total) {
  const out = [];
  for (let i = 0; i < total; i++) {
    const won = i < w;
    out.push({ won, lost: !won, open: false, reached });
  }
  return out;
}

describe('computeStageWinRates', () => {
  it('renvoie une ligne par étape du funnel', () => {
    const r = computeStageWinRates([]);
    expect(r.map(s => s.id)).toEqual(['qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin', 'contractsent']);
  });
  it('étape sans deal résolu → confidence none, suggested null', () => {
    const r = computeStageWinRates([]);
    expect(r[0].confidence).toBe('none');
    expect(r[0].suggested).toBeNull();
  });
  it('tous gagnés à Contrat → 100 % à toutes les étapes atteintes', () => {
    const deals = resolvedDeals(3, 40, 40); // 40 gagnés, reached = 3 (donc >= toutes les étapes)
    const r = computeStageWinRates(deals);
    expect(r[0].suggested).toBe(100);
    expect(r[3].suggested).toBe(100);
    expect(r[0].confidence).toBe('ok'); // 40 >= 30
  });
  it('confidence low si moins de 30 résolus', () => {
    const deals = resolvedDeals(0, 5, 10); // 10 résolus atteignant Qualif, 5 gagnés
    const r = computeStageWinRates(deals);
    expect(r[0].resolved).toBe(10);
    expect(r[0].suggested).toBe(50);
    expect(r[0].confidence).toBe('low');
  });
  it('deals ouverts exclus du calcul', () => {
    const deals = [
      { won: true, lost: false, open: false, reached: 0 },
      { won: false, lost: false, open: true, reached: 0 }, // ouvert : ignoré
    ];
    const r = computeStageWinRates(deals);
    expect(r[0].resolved).toBe(1);
    expect(r[0].suggested).toBe(100);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest utils/stageWinRates.test.js`
Expected: FAIL (`computeStageWinRates is not a function`).

- [ ] **Step 3: Écrire l'implémentation minimale**

Dans `utils/stageWinRates.js`, ajouter au-dessus de `module.exports` :

```js
const CONFIDENCE_MIN = 30; // seuil "échantillon solide"

// Pour chaque étape du funnel : P(gagné | a atteint l'étape), sur les deals RÉSOLUS.
function computeStageWinRates(deals) {
  const resolved = (deals || []).filter(d => d.won || d.lost);
  return FUNNEL.map((s, i) => {
    const reached = resolved.filter(d => d.reached >= i);
    const n = reached.length;
    const w = reached.filter(d => d.won).length;
    const p = n ? w / n : null;
    const ci = wilson(w, n);
    let confidence = 'none';
    if (n >= CONFIDENCE_MIN) confidence = 'ok';
    else if (n > 0) confidence = 'low';
    return {
      id: s.id,
      label: s.label,
      won: w,
      resolved: n,
      suggested: p == null ? null : Math.round(p * 100),
      ciLow: ci.low == null ? null : Math.round(ci.low * 100),
      ciHigh: ci.high == null ? null : Math.round(ci.high * 100),
      confidence,
    };
  });
}
```

Et remplacer la ligne `module.exports = ...` par :

```js
module.exports = { wilson, analyzeDeal, computeStageWinRates, FUNNEL, CONFIDENCE_MIN };
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `npx jest utils/stageWinRates.test.js`
Expected: PASS (tous les tests).

- [ ] **Step 5: Commit**

```bash
git add utils/stageWinRates.js utils/stageWinRates.test.js
git commit -m "feat(pilot) stageWinRates : proba de gain par étape avec fiabilité

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Endpoint backend `GET /api/pipeline-conversion` (fetch + cache)

**Files:**
- Modify: `server.js` (insérer après la route `POST /api/pipeline-ponderation`, juste avant le commentaire `// --- Calcul UNIQUE du pipeline pondéré HubSpot ---`, soit après la ligne 559)

**Interfaces:**
- Consumes: `hubspotSearch(body)` et `hubspotWrite(method, endpoint, body)` (helpers existants dans `server.js`), `analyzeDeal` + `computeStageWinRates` (Task 1-3).
- Produces: `GET /api/pipeline-conversion[?refresh=1]` → JSON `{ available: true, computedAt, stages: [...] }` ou `{ available: false }`.

- [ ] **Step 1: Écrire le code de l'endpoint**

Dans `server.js`, insérer ce bloc juste après la fermeture de la route `POST /api/pipeline-ponderation` (après la ligne 559) :

```js
// --- Suggestion de pondération : P(gagné | atteint étape X) depuis l'historique dealstage ---
// Les hs_date_entered_* sont vides sur ce portail ; on reconstruit le parcours via l'historique
// de la propriété dealstage (batch/read, max 50 ids/lot). Résultat mis en cache 12 h.
const { analyzeDeal: analyzeDealForConversion, computeStageWinRates } = require('./utils/stageWinRates');

let conversionCache = null;
let conversionCacheTime = 0;
const CONVERSION_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 h

// Récupère tous les deals du pipeline "default", lit leur historique dealstage, et les analyse.
async function fetchDealStageHistories() {
  const ids = [];
  let after;
  while (true) {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: 'default' }] }],
      properties: ['createdate'],
      limit: 100,
    };
    if (after) body.after = after;
    const r = await hubspotSearch(body);
    if (r.results) ids.push(...r.results.map(d => d.id));
    if (r.paging && r.paging.next && r.paging.next.after) after = r.paging.next.after;
    else break;
  }

  const deals = [];
  for (let i = 0; i < ids.length; i += 50) { // batch history plafonné à 50 ids
    const chunk = ids.slice(i, i + 50);
    const res = await hubspotWrite('POST', '/crm/v3/objects/deals/batch/read', {
      propertiesWithHistory: ['dealstage'],
      properties: ['hs_is_closed', 'hs_is_closed_won'],
      inputs: chunk.map(id => ({ id })),
    });
    for (const d of (res.results || [])) {
      const hist = (d.propertiesWithHistory && d.propertiesWithHistory.dealstage) || [];
      deals.push(analyzeDealForConversion({
        historyValues: hist.map(e => e.value),
        isClosedWon: d.properties.hs_is_closed_won === 'true',
        isClosed: d.properties.hs_is_closed === 'true',
      }));
    }
  }
  return deals;
}

// Calcule (ou renvoie le cache) les suggestions par étape.
async function computePipelineConversion(forceRefresh) {
  if (!forceRefresh && conversionCache && (Date.now() - conversionCacheTime) < CONVERSION_CACHE_TTL) {
    return conversionCache;
  }
  const deals = await fetchDealStageHistories();
  conversionCache = { available: true, computedAt: new Date().toISOString(), stages: computeStageWinRates(deals) };
  conversionCacheTime = Date.now();
  return conversionCache;
}

// GET /api/pipeline-conversion — suggestions de pondération basées sur l'historique réel.
// ?refresh=1 force le recalcul. En cas d'échec, renvoie { available:false } sans casser le modal.
app.get('/api/pipeline-conversion', async (req, res) => {
  try {
    res.json(await computePipelineConversion(req.query.refresh === '1'));
  } catch (e) {
    console.error('GET /api/pipeline-conversion error:', e.message);
    res.json({ available: false });
  }
});
```

- [ ] **Step 2: Vérifier que le serveur démarre sans erreur**

Run: `node -e "require('./server.js')"` puis Ctrl+C après le message de démarrage (ou lancer `npm start`).
Expected: le serveur démarre sans exception (pas d'erreur de syntaxe ni de require manquant).

- [ ] **Step 3: Vérifier la réponse de l'endpoint**

Démarrer le serveur (`npm start`), puis dans un autre terminal :

Run: `curl -s "http://localhost:3000/api/pipeline-conversion" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s),null,2)))"`
Expected: un JSON `{ "available": true, "computedAt": "...", "stages": [ {id, label, suggested, resolved, ciLow, ciHigh, confidence}, x4 ] }`. Le premier appel prend environ 3 s (lecture de l'historique). Note : en local, l'auth dashboard est contournée (`isLocalDashboardBypass`) ; si l'appel renvoie une page d'auth, tester depuis le dashboard connecté.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(pilot) endpoint /api/pipeline-conversion : suggestions de ponderation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Enrichir le modal `openPonderationModal` (frontend)

**Files:**
- Modify: `public/pilot.html` (remplacer la fonction `openPonderationModal`, lignes 11267-11290, et ajouter les fonctions d'aide)

**Interfaces:**
- Consumes: `GET /api/pipeline-ponderation` (existant) et `GET /api/pipeline-conversion` (Task 4).
- Produces: modal enrichi ; `savePonderation` (existant) reste compatible (les inputs conservent leur `data-stage-id`).

- [ ] **Step 1: Remplacer `openPonderationModal` et ajouter les fonctions d'aide**

Dans `public/pilot.html`, remplacer **entièrement** la fonction `openPonderationModal` (lignes 11267-11290) par le bloc suivant (les fonctions `closePonderationModal` et `savePonderation` qui suivent restent inchangées) :

```js
    let ponderationSuggestions = []; // dernières suggestions chargées (pour "Tout appliquer")
    let lastPonderationConv = null;  // dernier calcul réussi (pour conserver l'affichage si un recalcul échoue)

    async function openPonderationModal() {
      const modal = document.getElementById('ponderationModal');
      const body = document.getElementById('ponderationBody');
      if (!modal || !body) return;
      body.innerHTML = '<p style="color:var(--text-secondary)">Chargement…</p>';
      modal.classList.add('active');
      try {
        const [data, conv] = await Promise.all([
          fetch('/api/pipeline-ponderation').then(r => r.json()),
          fetch('/api/pipeline-conversion').then(r => r.json()).catch(() => ({ available: false })),
        ]);
        renderPonderationBody(data.stages || [], conv);
      } catch (e) {
        body.innerHTML = '<p style="color:#b91c1c">Erreur de chargement du barème.</p>';
      }
    }

    // Construit le contenu du modal : barème éditable + colonne "Suggéré (données)".
    function renderPonderationBody(stages, conv) {
      const body = document.getElementById('ponderationBody');
      const suggByStage = {};
      const available = conv && conv.available && Array.isArray(conv.stages);
      if (available) conv.stages.forEach(s => { suggByStage[s.id] = s; });
      ponderationSuggestions = available ? conv.stages : [];
      if (available) lastPonderationConv = conv;

      const rows = stages.map(s => {
        const sg = suggByStage[s.id];
        let suggCell = '<span style="color:var(--text-secondary)">—</span>';
        if (sg && sg.confidence === 'none') {
          suggCell = '<span style="color:var(--text-secondary)">pas assez de données</span>';
        } else if (sg && sg.suggested != null) {
          const dot = sg.confidence === 'ok' ? '🟢' : '🟠';
          const title = 'Intervalle de confiance 95 % : ' + sg.suggested + ' % (entre ' + sg.ciLow + ' % et ' + sg.ciHigh
            + ' %). Échantillon : ' + sg.resolved + ' deals résolus.'
            + (sg.confidence === 'low' ? ' Échantillon réduit, à prendre avec prudence.' : '');
          suggCell = '<span title="' + title + '" style="cursor:help">' + sg.suggested + '% · ' + sg.resolved + ' deals ' + dot + 'ⓘ</span>'
            + ' <button class="kpi-btn" style="padding:0.1rem 0.5rem;font-size:0.8rem" onclick="applyPonderationSuggestion(\'' + s.id + '\',' + sg.suggested + ')">Appliquer</button>';
        }
        return '<tr><td style="padding:0.4rem 0">' + s.label + '</td>'
          + '<td style="text-align:right"><input class="kpi-num-input" type="number" min="0" max="100" step="1" value="' + s.probability + '" data-stage-id="' + s.id + '"></td>'
          + '<td style="padding:0.4rem 0 0.4rem 0.8rem;font-size:0.85rem">' + suggCell + '</td></tr>';
      }).join('');

      const computedTxt = (available && conv.computedAt)
        ? new Date(conv.computedAt).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
        : '';
      const footer = available
        ? '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.8rem;font-size:0.85rem">'
          + '<button class="kpi-btn" onclick="applyAllPonderationSuggestions()">Tout appliquer</button>'
          + '<span style="color:var(--text-secondary)"><a href="#" onclick="recalcPonderationSuggestions();return false" style="color:var(--primary)">&#8635; Recalculer</a>'
          + (computedTxt ? ' · calculé ' + computedTxt : '') + '</span></div>'
        : '<p style="font-size:0.8rem;color:var(--text-secondary);margin:0.6rem 0 0">Suggestions indisponibles pour le moment.</p>';

      body.innerHTML =
        '<p style="font-size:0.82rem;color:var(--text-secondary);margin:0 0 0.9rem">'
        + 'Probabilité de signature par étape. Elle pilote le pipeline pondéré (montant × %) et les prévisions de trésorerie / EBE qui s\'appuient dessus.</p>'
        + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem"><thead><tr>'
        + '<th style="text-align:left;padding:0.3rem 0;color:var(--text-secondary);font-weight:600">Étape</th>'
        + '<th style="text-align:right;color:var(--text-secondary);font-weight:600">Pondération (%)</th>'
        + '<th style="text-align:left;padding-left:0.8rem;color:var(--text-secondary);font-weight:600">Suggéré (données)</th></tr></thead><tbody>'
        + rows + '</tbody></table>' + footer;
    }

    // Copie la valeur suggérée dans le champ de l'étape (sans sauvegarder).
    function applyPonderationSuggestion(stageId, value) {
      const inp = document.querySelector('#ponderationBody input[data-stage-id="' + stageId + '"]');
      if (inp) inp.value = Math.max(0, Math.min(100, value));
    }

    function applyAllPonderationSuggestions() {
      (ponderationSuggestions || []).forEach(s => {
        if (s.confidence !== 'none' && s.suggested != null) applyPonderationSuggestion(s.id, s.suggested);
      });
    }

    // Recalcul forcé, en conservant les valeurs déjà saisies dans les champs.
    // En cas d'échec du calcul, on garde les suggestions précédentes (lastPonderationConv).
    async function recalcPonderationSuggestions() {
      const current = {};
      document.querySelectorAll('#ponderationBody input[data-stage-id]').forEach(inp => { current[inp.dataset.stageId] = inp.value; });
      try {
        const [data, conv] = await Promise.all([
          fetch('/api/pipeline-ponderation').then(r => r.json()),
          fetch('/api/pipeline-conversion?refresh=1').then(r => r.json()).catch(() => ({ available: false })),
        ]);
        const stages = (data.stages || []).map(s => ({ ...s, probability: current[s.id] != null ? current[s.id] : s.probability }));
        if (!(conv && conv.available) && lastPonderationConv) {
          renderPonderationBody(stages, lastPonderationConv); // conserve les suggestions précédentes
          alert('Recalcul impossible, suggestions précédentes conservées.');
        } else {
          renderPonderationBody(stages, conv);
        }
      } catch (e) {
        alert('Recalcul impossible pour le moment.');
      }
    }
```

- [ ] **Step 2: Vérifier l'affichage dans le navigateur**

Démarrer le serveur (`npm start`), ouvrir `http://localhost:3000`, ouvrir la card « Pipeline pondere » (icône engrenage) pour afficher le modal.
Expected :
- une 3e colonne « Suggéré (données) » affiche, par étape, `XX% · N deals` avec une pastille 🟢/🟠 ;
- au survol de la pastille, l'infobulle montre l'intervalle de confiance et l'effectif ;
- « Appliquer » copie la valeur dans le champ de gauche ; « Tout appliquer » remplit les 4 champs ;
- « Recalculer » relance le calcul (environ 3 s) et met à jour la date ;
- « Enregistrer » fonctionne comme avant (le barème est bien sauvegardé).

- [ ] **Step 3: Vérifier que le barème s'enregistre toujours**

Dans le modal : cliquer « Tout appliquer », puis « Enregistrer ». Rouvrir le modal.
Expected : les valeurs de la colonne « Pondération (%) » reflètent les suggestions appliquées (persistées via `POST /api/pipeline-ponderation`).

- [ ] **Step 4: Commit**

```bash
git add public/pilot.html
git commit -m "feat(pilot) modal ponderation : suggestions de % basees sur les donnees + IC

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes d'exécution

- Après la Task 5, un redémarrage du serveur resynchronise `dist/pilot.html` depuis `public/pilot.html` (la route `/` sert déjà `public/` directement, donc un simple rafraîchissement du navigateur suffit pendant le dev).
- Le cache de conversion (12 h) est **indépendant** du barème : modifier la pondération n'invalide pas les suggestions (elles conseillent le barème, elles n'en dépendent pas). Ne pas ajouter d'appel à `invalidatePonderationCaches()` pour ce cache.
- Hors périmètre (rappel) : pas d'auto-application, pas de sélecteur de période, pas d'alerte de dérive, correction du bug `stageEnteredAt` traitée séparément.
