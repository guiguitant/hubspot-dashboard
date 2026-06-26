# KPI par partner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un onglet « KPI » au dashboard Pilot affichant, par partner et au total, l'avancement des objectifs commerciaux (CA signé Newsale/Upsale) et opérationnels (CA opéré) sous forme de bar charts.

**Architecture :** Le calcul d'attribution (répartition du CA Notion entre partners + agrégation vs objectifs) vit dans un module pur testable `utils/kpiCompute.js`. `server.js` expose 3 routes (`GET /api/kpi`, `POST /api/kpi/objectives`, `POST /api/kpi/split`) qui lisent les missions Notion + 2 nouvelles tables Supabase et délèguent le calcul au module. Le front (`public/pilot.html`) ajoute une page rendant les charts (Chart.js, déjà chargé) et un panneau de réglages.

**Tech Stack :** Node.js/Express (CommonJS), Supabase (PostgreSQL + RLS), Jest, Chart.js 4.4.1 + chartjs-plugin-datalabels (déjà chargés côté front), vanilla JS.

## Global Constraints

- Backend en **CommonJS** (`require`/`module.exports`) — jamais `import/export`.
- Jest config : `testMatch: ['**/utils/**/*.test.js']` — **tout test doit être dans `utils/` et finir par `.test.js`**.
- Client Supabase : utiliser **`supabase`** (pas `supabaseAdmin`) pour les tables KPI, comme la table `scenarios` (config dashboard mono-tenant).
- Les routes `/api/kpi*` sont **automatiquement protégées** par l'auth dashboard (TOTP) — NE PAS ajouter `/api/kpi` à `PROSPECTOR_PREFIXES` ([server.js:80](../../../server.js#L80)).
- `public/pilot.html` et `dist/pilot.html` doivent rester **identiques** : après toute édition de `public/pilot.html`, copier vers `dist/pilot.html`.
- Mapping métier (verbatim du spec) :
  - **Signé** = états ≠ `Annulé` → partners **commerciaux**, rangé `newsale`/`upsale` selon `type_ca` (`Newsale`/`Upsale`).
  - **Opéré** = états `En cours` + `Terminé` → partners **opérationnels**.
  - **Année** = année de `created_time` de la page Notion.
  - `type_ca` ni `Newsale` ni `Upsale` → mission **non classée** (exclue du signé).
  - Répartition par défaut = **parts égales** ; override stocké uniquement si différent.
  - **« All » = somme des partners** (jamais stocké).
  - `tx avancement` = réalisé / objectif ; objectif = 0 → `null`.

---

## File Structure

- **Create** `migrations/30_kpi_tables.sql` — 2 tables Supabase (`kpi_objectives`, `kpi_ca_split`) + RLS.
- **Create** `utils/kpiCompute.js` — module pur : `computeKpi()` + helpers exportés.
- **Create** `utils/kpiCompute.test.js` — tests Jest du module.
- **Modify** `server.js` — expose `dateCreation` dans `fetchAllNotionMissions()` ; ajoute 3 routes.
- **Modify** `public/pilot.html` — lien sidebar, page `#page-kpi`, JS de rendu + réglages.
- **Sync** `dist/pilot.html` — copie de `public/pilot.html`.

---

## Task 1 : Migration Supabase (tables KPI)

**Files:**
- Create: `migrations/30_kpi_tables.sql`

**Interfaces:**
- Produces : tables `kpi_objectives(partner, year, type, montant)` unique `(partner, year, type)` ; `kpi_ca_split(mission_id, axis, partner, pct)` unique `(mission_id, axis, partner)`.

- [ ] **Step 1 : Créer le fichier de migration**

Create `migrations/30_kpi_tables.sql` :

```sql
-- Migration 30 : tables KPI (objectifs individuels + répartition CA par partner)
-- Alimentent l'onglet KPI du dashboard Pilot.
-- Pattern RLS identique à scenarios (mono-tenant, accès ouvert ; l'accès est déjà
-- gaté en amont par l'auth dashboard TOTP côté serveur).

CREATE TABLE kpi_objectives (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  partner TEXT NOT NULL,
  year INT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('newsale','upsale','opere')),
  montant NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (partner, year, type)
);

CREATE TABLE kpi_ca_split (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  mission_id TEXT NOT NULL,
  axis TEXT NOT NULL CHECK (axis IN ('commercial','operationnel')),
  partner TEXT NOT NULL,
  pct NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (mission_id, axis, partner)
);

CREATE INDEX idx_kpi_objectives_year ON kpi_objectives(year);
CREATE INDEX idx_kpi_ca_split_mission ON kpi_ca_split(mission_id);

ALTER TABLE kpi_objectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE kpi_ca_split  ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on kpi_objectives" ON kpi_objectives FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on kpi_ca_split"  ON kpi_ca_split  FOR ALL USING (true) WITH CHECK (true);
```

- [ ] **Step 2 : Appliquer la migration dans Supabase**

Cette migration s'applique **manuellement** : ouvrir le SQL Editor de Supabase, coller le contenu du fichier, exécuter. (C'est le process du repo — les fichiers `migrations/*.sql` ne sont pas exécutés automatiquement.)
Vérification : dans Supabase, les tables `kpi_objectives` et `kpi_ca_split` apparaissent dans le Table Editor.

- [ ] **Step 3 : Commit**

```bash
git add migrations/30_kpi_tables.sql
git commit -m "feat(kpi): migration tables kpi_objectives + kpi_ca_split"
```

---

## Task 2 : Module de calcul `utils/kpiCompute.js` (TDD)

**Files:**
- Create: `utils/kpiCompute.js`
- Test: `utils/kpiCompute.test.js`

**Interfaces:**
- Produces :
  - `computeKpi({ missions, objectives, splits, year }) → { year, partners[], all, unclassified[], missionsForSplit[] }`
    - `missions` : objets renvoyés par `fetchAllNotionMissions()` (champs utilisés : `id, nom, client, ca, etat, typeCa, partnerCommercial[], partnerOperationnel[], dateCreation`).
    - `objectives` : `[{ partner, year, type, montant }]` (lignes `kpi_objectives`).
    - `splits` : `[{ mission_id, axis, partner, pct }]` (lignes `kpi_ca_split`).
    - `partners` : `[{ partner, newsale:{objectif,realise,tx}, upsale:{...}, opere:{...} }]`.
    - `all` : `{ newsale:{objectif,realise,tx}, upsale:{...}, opere:{...} }`.
    - `unclassified` : `[{ id, nom, client, ca }]`.
    - `missionsForSplit` : `[{ id, nom, ca, commercial[], operationnel[], splitCommercial{}, splitOperationnel{} }]`.
  - Constantes exportées `OPERE_STATES`, `SIGNE_EXCLUDED_STATES`.

- [ ] **Step 1 : Écrire les tests (qui échouent)**

Create `utils/kpiCompute.test.js` :

```javascript
'use strict';
const { computeKpi, OPERE_STATES, SIGNE_EXCLUDED_STATES } = require('./kpiCompute');

// Helper : fabrique une mission avec des valeurs par défaut raisonnables.
function mission(over = {}) {
  return {
    id: 'm1', nom: 'Mission', client: 'Client', ca: 10000,
    etat: 'En cours', typeCa: 'Newsale',
    partnerCommercial: ['Vincent'], partnerOperationnel: ['Guillaume'],
    dateCreation: '2026-03-01T10:00:00.000Z',
    ...over,
  };
}

describe('constantes', () => {
  it('opéré = En cours + Terminé', () => {
    expect(OPERE_STATES).toEqual(['En cours', 'Terminé']);
  });
  it('signé exclut Annulé', () => {
    expect(SIGNE_EXCLUDED_STATES).toEqual(['Annulé']);
  });
});

describe('computeKpi — attribution de base', () => {
  it('1 partner commercial → 100% en newsale ; 1 partner opérationnel → 100% en opéré', () => {
    const r = computeKpi({ missions: [mission()], objectives: [], splits: [], year: 2026 });
    const vincent = r.partners.find(p => p.partner === 'Vincent');
    const guillaume = r.partners.find(p => p.partner === 'Guillaume');
    expect(vincent.newsale.realise).toBe(10000);
    expect(vincent.opere.realise).toBe(0);
    expect(guillaume.opere.realise).toBe(10000);
    expect(guillaume.newsale.realise).toBe(0);
  });

  it('Upsale range le CA en upsale', () => {
    const r = computeKpi({ missions: [mission({ typeCa: 'Upsale' })], objectives: [], splits: [], year: 2026 });
    const v = r.partners.find(p => p.partner === 'Vincent');
    expect(v.upsale.realise).toBe(10000);
    expect(v.newsale.realise).toBe(0);
  });

  it('2 partners commerciaux sans override → 50/50', () => {
    const r = computeKpi({
      missions: [mission({ partnerCommercial: ['Vincent', 'Nathan'] })],
      objectives: [], splits: [], year: 2026,
    });
    expect(r.partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(5000);
    expect(r.partners.find(p => p.partner === 'Nathan').newsale.realise).toBe(5000);
  });

  it('2 partners commerciaux avec override 70/30', () => {
    const r = computeKpi({
      missions: [mission({ id: 'mX', partnerCommercial: ['Vincent', 'Nathan'] })],
      objectives: [],
      splits: [
        { mission_id: 'mX', axis: 'commercial', partner: 'Vincent', pct: 70 },
        { mission_id: 'mX', axis: 'commercial', partner: 'Nathan', pct: 30 },
      ],
      year: 2026,
    });
    expect(r.partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(7000);
    expect(r.partners.find(p => p.partner === 'Nathan').newsale.realise).toBe(3000);
  });
});

describe('computeKpi — filtres états & année', () => {
  it('Annulé → exclu du signé ET de l\'opéré', () => {
    const r = computeKpi({ missions: [mission({ etat: 'Annulé' })], objectives: [], splits: [], year: 2026 });
    expect(r.partners).toEqual([]);
  });

  it('Planning → compté en signé mais PAS en opéré', () => {
    const r = computeKpi({ missions: [mission({ etat: 'Planning' })], objectives: [], splits: [], year: 2026 });
    expect(r.partners.find(p => p.partner === 'Vincent').newsale.realise).toBe(10000);
    expect(r.partners.find(p => p.partner === 'Guillaume')).toBeUndefined();
  });

  it('mauvaise année → mission ignorée', () => {
    const r = computeKpi({ missions: [mission({ dateCreation: '2025-12-31T23:00:00.000Z' })], objectives: [], splits: [], year: 2026 });
    expect(r.partners).toEqual([]);
  });
});

describe('computeKpi — non classées', () => {
  it('type_ca vide → unclassified, pas en newsale/upsale, mais opéré OK', () => {
    const r = computeKpi({ missions: [mission({ typeCa: 'Non défini' })], objectives: [], splits: [], year: 2026 });
    expect(r.unclassified).toEqual([{ id: 'm1', nom: 'Mission', client: 'Client', ca: 10000 }]);
    expect(r.partners.find(p => p.partner === 'Vincent')).toBeUndefined();
    expect(r.partners.find(p => p.partner === 'Guillaume').opere.realise).toBe(10000);
  });
});

describe('computeKpi — objectifs, tx, all', () => {
  it('tx = realise/objectif ; objectif 0 → tx null', () => {
    const r = computeKpi({
      missions: [mission({ ca: 16150 })],
      objectives: [{ partner: 'Vincent', year: 2026, type: 'newsale', montant: 100000 }],
      splits: [], year: 2026,
    });
    const v = r.partners.find(p => p.partner === 'Vincent');
    expect(v.newsale.objectif).toBe(100000);
    expect(v.newsale.tx).toBeCloseTo(0.1615, 4);
    expect(v.upsale.tx).toBeNull(); // objectif 0
  });

  it('all = somme des partners', () => {
    const r = computeKpi({
      missions: [
        mission({ id: 'a', partnerCommercial: ['Vincent'], ca: 30000 }),
        mission({ id: 'b', partnerCommercial: ['Nathan'], ca: 20000 }),
      ],
      objectives: [
        { partner: 'Vincent', year: 2026, type: 'newsale', montant: 100000 },
        { partner: 'Nathan', year: 2026, type: 'newsale', montant: 50000 },
      ],
      splits: [], year: 2026,
    });
    expect(r.all.newsale.realise).toBe(50000);
    expect(r.all.newsale.objectif).toBe(150000);
  });

  it('partner présent via objectif seul (aucune mission) apparaît avec realise 0', () => {
    const r = computeKpi({
      missions: [],
      objectives: [{ partner: 'Solo', year: 2026, type: 'opere', montant: 5000 }],
      splits: [], year: 2026,
    });
    const solo = r.partners.find(p => p.partner === 'Solo');
    expect(solo.opere.objectif).toBe(5000);
    expect(solo.opere.realise).toBe(0);
    expect(solo.opere.tx).toBe(0);
  });
});

describe('computeKpi — missionsForSplit', () => {
  it('liste les missions de l\'année à 2+ partners avec split par défaut égal', () => {
    const r = computeKpi({
      missions: [mission({ id: 'mY', partnerCommercial: ['Vincent', 'Nathan'], partnerOperationnel: ['Guillaume'] })],
      objectives: [], splits: [], year: 2026,
    });
    expect(r.missionsForSplit).toHaveLength(1);
    const m = r.missionsForSplit[0];
    expect(m.id).toBe('mY');
    expect(m.splitCommercial).toEqual({ Vincent: 50, Nathan: 50 });
    expect(m.splitOperationnel).toEqual({ Guillaume: 100 });
  });

  it('mission à 1 seul partner par axe → pas listée', () => {
    const r = computeKpi({ missions: [mission()], objectives: [], splits: [], year: 2026 });
    expect(r.missionsForSplit).toEqual([]);
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier l'échec**

Run: `npx jest utils/kpiCompute.test.js`
Expected: FAIL — `Cannot find module './kpiCompute'`.

- [ ] **Step 3 : Écrire l'implémentation minimale**

Create `utils/kpiCompute.js` :

```javascript
'use strict';

// États : voir spec 2026-06-26-kpi-partners-design.md §2.
const SIGNE_EXCLUDED_STATES = ['Annulé'];          // signé = tout sauf ça
const OPERE_STATES = ['En cours', 'Terminé'];      // opéré = ces états
const TYPES = ['newsale', 'upsale', 'opere'];

// Année (number) depuis un ISO timestamp ('2026-03-01T...' → 2026), sinon null.
function yearOf(iso) {
  return iso ? Number(String(iso).slice(0, 4)) : null;
}

// Répartit `ca` entre `partners` selon `overrides` ({partner: pct}) si non vide,
// sinon à parts égales. Retourne { partner: montant }.
function splitAmount(ca, partners, overrides) {
  const out = {};
  if (!partners || partners.length === 0) return out;
  const hasOverride = overrides && Object.keys(overrides).length > 0;
  if (hasOverride) {
    const totalPct = partners.reduce((s, p) => s + (Number(overrides[p]) || 0), 0);
    for (const p of partners) {
      const pct = Number(overrides[p]) || 0;
      out[p] = totalPct > 0 ? ca * (pct / totalPct) : ca / partners.length;
    }
  } else {
    const share = ca / partners.length;
    for (const p of partners) out[p] = share;
  }
  return out;
}

// Map d'affichage des pourcentages pour le panneau réglages (défaut égal ou override).
function displaySplit(partners, overrides) {
  const out = {};
  if (!partners || partners.length === 0) return out;
  const hasOverride = overrides && Object.keys(overrides).length > 0;
  if (hasOverride) {
    for (const p of partners) out[p] = Number(overrides[p]) || 0;
  } else {
    const eq = Math.round((100 / partners.length) * 100) / 100;
    for (const p of partners) out[p] = eq;
  }
  return out;
}

function computeKpi({ missions, objectives, splits, year }) {
  // Index des overrides : splitIndex[mission_id][axis] = { partner: pct }
  const splitIndex = {};
  for (const s of splits || []) {
    splitIndex[s.mission_id] = splitIndex[s.mission_id] || {};
    splitIndex[s.mission_id][s.axis] = splitIndex[s.mission_id][s.axis] || {};
    splitIndex[s.mission_id][s.axis][s.partner] = Number(s.pct) || 0;
  }

  // Accumulateur des montants réalisés par partner/type.
  const acc = {};
  const add = (partner, type, amount) => {
    acc[partner] = acc[partner] || { newsale: 0, upsale: 0, opere: 0 };
    acc[partner][type] += amount;
  };

  const unclassified = [];
  const missionsForSplit = [];

  for (const m of missions || []) {
    if (yearOf(m.dateCreation) !== year) continue;
    const ca = Number(m.ca) || 0;

    // --- Signé (commercial) : états != Annulé ---
    if (!SIGNE_EXCLUDED_STATES.includes(m.etat)) {
      let type = null;
      if (m.typeCa === 'Newsale') type = 'newsale';
      else if (m.typeCa === 'Upsale') type = 'upsale';

      if (type) {
        const shares = splitAmount(ca, m.partnerCommercial, (splitIndex[m.id] || {}).commercial);
        for (const [p, amt] of Object.entries(shares)) add(p, type, amt);
      } else {
        unclassified.push({ id: m.id, nom: m.nom, client: m.client, ca });
      }
    }

    // --- Opéré (opérationnel) : En cours / Terminé ---
    if (OPERE_STATES.includes(m.etat)) {
      const shares = splitAmount(ca, m.partnerOperationnel, (splitIndex[m.id] || {}).operationnel);
      for (const [p, amt] of Object.entries(shares)) add(p, 'opere', amt);
    }

    // --- missionsForSplit : missions de l'année à 2+ partners sur un axe ---
    const com = m.partnerCommercial || [];
    const ope = m.partnerOperationnel || [];
    if (com.length >= 2 || ope.length >= 2) {
      missionsForSplit.push({
        id: m.id, nom: m.nom, ca,
        commercial: com, operationnel: ope,
        splitCommercial: displaySplit(com, (splitIndex[m.id] || {}).commercial),
        splitOperationnel: displaySplit(ope, (splitIndex[m.id] || {}).operationnel),
      });
    }
  }

  // Objectifs indexés par partner/type (année filtrée).
  const objIndex = {};
  for (const o of objectives || []) {
    if (o.year !== year) continue;
    objIndex[o.partner] = objIndex[o.partner] || {};
    objIndex[o.partner][o.type] = Number(o.montant) || 0;
  }

  // Liste des partners = union (réalisé) ∪ (objectifs).
  const names = new Set([...Object.keys(acc), ...Object.keys(objIndex)]);
  const partners = [];
  const allReal = { newsale: 0, upsale: 0, opere: 0 };
  const allObj = { newsale: 0, upsale: 0, opere: 0 };

  for (const name of [...names].sort()) {
    const real = acc[name] || { newsale: 0, upsale: 0, opere: 0 };
    const obj = objIndex[name] || {};
    const row = { partner: name };
    for (const type of TYPES) {
      const realise = Math.round(real[type] || 0);
      const objectif = Math.round(obj[type] || 0);
      row[type] = { objectif, realise, tx: objectif > 0 ? realise / objectif : null };
      allReal[type] += realise;
      allObj[type] += objectif;
    }
    partners.push(row);
  }

  const all = {};
  for (const type of TYPES) {
    all[type] = {
      objectif: allObj[type], realise: allReal[type],
      tx: allObj[type] > 0 ? allReal[type] / allObj[type] : null,
    };
  }

  return { year, partners, all, unclassified, missionsForSplit };
}

module.exports = { computeKpi, yearOf, splitAmount, displaySplit, OPERE_STATES, SIGNE_EXCLUDED_STATES };
```

- [ ] **Step 4 : Lancer les tests pour vérifier le succès**

Run: `npx jest utils/kpiCompute.test.js`
Expected: PASS — tous les `describe`/`it` verts.

- [ ] **Step 5 : Commit**

```bash
git add utils/kpiCompute.js utils/kpiCompute.test.js
git commit -m "feat(kpi): module de calcul computeKpi + tests"
```

---

## Task 3 : Exposer `created_time` + route `GET /api/kpi`

**Files:**
- Modify: `server.js` (mapping `fetchAllNotionMissions` ~ligne 1590 ; require du module ; nouvelle route)

**Interfaces:**
- Consumes : `computeKpi` (Task 2), `fetchAllNotionMissions()` (existant), client `supabase` (existant).
- Produces : `GET /api/kpi?year=YYYY` → JSON `{ year, partners, all, unclassified, missionsForSplit }`.

- [ ] **Step 1 : Exposer `dateCreation` dans le mapping mission**

Dans `server.js`, dans `fetchAllNotionMissions()`, le mapping retourne un objet commençant par `id: page.id,` ([server.js:1591](../../../server.js#L1591)). Ajouter une ligne juste après `id: page.id,` :

```javascript
      dateCreation: page.created_time || null, // date de création de la ligne Notion ≈ date de signature (base d'année KPI)
```

- [ ] **Step 2 : Importer le module de calcul**

En haut de `server.js`, près des autres `require` (ex. après `const { createClient } = require('@supabase/supabase-js');` [server.js:12](../../../server.js#L12)), ajouter :

```javascript
const { computeKpi } = require('./utils/kpiCompute');
```

- [ ] **Step 3 : Ajouter la route `GET /api/kpi`**

Insérer ce bloc près des autres routes dashboard (ex. juste avant `app.get('/api/scenarios'` [server.js:5745](../../../server.js#L5745)) :

```javascript
// --- KPI par partner (onglet KPI) ---
// Lit les missions Notion + objectifs + overrides de répartition (Supabase),
// délègue le calcul d'attribution à utils/kpiCompute.js.
app.get('/api/kpi', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const missions = await fetchAllNotionMissions();
    const [{ data: objectives, error: objErr }, { data: splits, error: splErr }] = await Promise.all([
      supabase.from('kpi_objectives').select('*').eq('year', year),
      supabase.from('kpi_ca_split').select('*'),
    ]);
    if (objErr) throw objErr;
    if (splErr) throw splErr;
    const result = computeKpi({ missions, objectives: objectives || [], splits: splits || [], year });
    res.json(result);
  } catch (e) {
    console.error('GET /api/kpi error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4 : Vérifier la syntaxe**

Run: `node --check server.js && echo OK`
Expected: `OK`

- [ ] **Step 5 : Vérifier la route (smoke test manuel)**

Démarrer le serveur (`npm start`) avec les variables d'env habituelles, puis dans un autre terminal :
Run: `curl -s "http://localhost:3000/api/kpi?year=2026" -H "Cookie: dash_session=<session valide>" | head -c 400`
Expected : un JSON contenant `"partners"`, `"all"`, `"unclassified"`, `"missionsForSplit"`.
(Si l'auth bloque, vérifier en navigateur une fois l'onglet branché — Task 6. Le `node --check` de Step 4 reste la garantie minimale.)

- [ ] **Step 6 : Commit**

```bash
git add server.js
git commit -m "feat(kpi): expose created_time + route GET /api/kpi"
```

---

## Task 4 : Routes d'écriture `POST /api/kpi/objectives` & `POST /api/kpi/split`

**Files:**
- Modify: `server.js` (après la route `GET /api/kpi` de Task 3)

**Interfaces:**
- Produces :
  - `POST /api/kpi/objectives` body `{ partner, year, type, montant }` → upsert `kpi_objectives` sur `(partner, year, type)`.
  - `POST /api/kpi/split` body `{ mission_id, axis, splits: [{ partner, pct }] }` → remplace les lignes `(mission_id, axis)` de `kpi_ca_split` ; un `splits` vide supprime l'override (retour au défaut égal).

- [ ] **Step 1 : Ajouter les deux routes**

Juste après la route `GET /api/kpi` (Task 3) :

```javascript
// Upsert d'un objectif individuel (partner + année + type).
app.post('/api/kpi/objectives', async (req, res) => {
  try {
    const { partner, year, type, montant } = req.body || {};
    if (!partner || !year || !['newsale', 'upsale', 'opere'].includes(type)) {
      return res.status(400).json({ error: 'partner, year et type (newsale|upsale|opere) requis' });
    }
    const { error } = await supabase
      .from('kpi_objectives')
      .upsert(
        { partner, year: parseInt(year, 10), type, montant: Number(montant) || 0, updated_at: new Date().toISOString() },
        { onConflict: 'partner,year,type' }
      );
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/kpi/objectives error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Remplace la répartition d'une mission sur un axe (commercial|operationnel).
// `splits` vide → on supprime l'override (retour aux parts égales par défaut).
app.post('/api/kpi/split', async (req, res) => {
  try {
    const { mission_id, axis, splits } = req.body || {};
    if (!mission_id || !['commercial', 'operationnel'].includes(axis)) {
      return res.status(400).json({ error: 'mission_id et axis (commercial|operationnel) requis' });
    }
    // 1) purge des lignes existantes pour (mission_id, axis)
    const { error: delErr } = await supabase
      .from('kpi_ca_split').delete().eq('mission_id', mission_id).eq('axis', axis);
    if (delErr) throw delErr;
    // 2) réinsertion si fourni
    const rows = (splits || [])
      .filter(s => s && s.partner)
      .map(s => ({ mission_id, axis, partner: s.partner, pct: Number(s.pct) || 0, updated_at: new Date().toISOString() }));
    if (rows.length > 0) {
      const { error: insErr } = await supabase.from('kpi_ca_split').insert(rows);
      if (insErr) throw insErr;
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/kpi/split error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2 : Vérifier la syntaxe**

Run: `node --check server.js && echo OK`
Expected: `OK`

- [ ] **Step 3 : Commit**

```bash
git add server.js
git commit -m "feat(kpi): routes POST objectives + split"
```

---

## Task 5 : Front — lien sidebar + page KPI + navigation

**Files:**
- Modify: `public/pilot.html` (sidebar ~3362 ; page div ~avant 4107 ; `PAGE_NAMES` 5479 ; `navigateTo` ~5524)
- Sync: `dist/pilot.html`

**Interfaces:**
- Produces : page `#page-kpi` accessible via le lien sidebar `data-page="kpi"` ; appelle `initKpi()` (définie Task 6) à la navigation.

- [ ] **Step 1 : Ajouter le lien sidebar**

Dans `public/pilot.html`, après le bouton Analytics ([pilot.html:3362](../../../public/pilot.html#L3362)) :

```html
        <button class="sidebar-link" onclick="navigateTo('analytics')" data-page="analytics">
```
…et son `</button>` de fermeture, insérer juste après :

```html
        <button class="sidebar-link" onclick="navigateTo('kpi')" data-page="kpi">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7"/><rect x="13" y="6" width="3" height="11"/></svg>
          KPI
        </button>
```

- [ ] **Step 2 : Ajouter la page `#page-kpi`**

Insérer ce bloc juste avant `<div class="app-page" id="page-masse-salariale">` ([pilot.html:4107](../../../public/pilot.html#L4107)) :

```html
  <div class="app-page" id="page-kpi">
    <div class="section">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap;">
        <h2 style="margin:0;">KPI — objectifs & avancement par partner</h2>
        <div style="display:flex; align-items:center; gap:0.6rem;">
          <label for="kpiYear" style="color:var(--text-secondary); font-size:0.9rem;">Année</label>
          <select id="kpiYear" onchange="initKpi()" style="padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--card); color:var(--text);"></select>
          <button class="analytics-tab" onclick="toggleKpiReglages()" id="kpiReglagesBtn">Réglages</button>
        </div>
      </div>
    </div>

    <div id="kpiUnclassified" class="section" style="display:none; border-color:var(--warning); background:var(--warning-bg);"></div>

    <div id="kpiReglages" class="section" style="display:none;"></div>

    <div id="kpiCharts"></div>
  </div>
```

- [ ] **Step 3 : Enregistrer le nom de page**

Dans `PAGE_NAMES` ([pilot.html:5479](../../../public/pilot.html#L5479)), ajouter l'entrée `kpi: 'KPI'` :

```javascript
    const PAGE_NAMES = { cockpit: 'Cockpit', dashboard: 'Commercial', 'analyse-clients': 'Analyse clients', facturation: 'Facturation', 'frais-km': 'Frais KM', tresorerie: 'Tresorerie', 'masse-salariale': 'Masse salariale', scenarios: 'Scenarios', analytics: 'Analytics', 'proposal-engine': 'Proposal Engine', kpi: 'KPI' };
```

- [ ] **Step 4 : Brancher la navigation**

Dans `navigateTo()`, à côté des autres hooks de page (ex. après `if (page === 'analytics') initAnalytics();` [pilot.html:5524](../../../public/pilot.html#L5524)), ajouter :

```javascript
      if (page === 'kpi') initKpi();
```

- [ ] **Step 5 : Stub temporaire de `initKpi`**

Pour que la navigation ne casse pas avant Task 6, ajouter un stub provisoire dans le `<script>` (près de `navigateTo`) — il sera remplacé en Task 6 :

```javascript
    function initKpi() { /* implémenté en Task 6 */ }
    function toggleKpiReglages() { /* implémenté en Task 7 */ }
```

- [ ] **Step 6 : Synchroniser dist**

Run: `cp public/pilot.html dist/pilot.html`

- [ ] **Step 7 : Vérifier en navigateur**

Démarrer le serveur, ouvrir le dashboard, cliquer sur l'entrée **KPI** de la sidebar.
Expected : la page KPI s'affiche (titre + sélecteur d'année vide + zone charts vide), le nom « KPI » apparaît dans la topbar, aucune erreur console.
(Outil : skill `webapp-testing` pour piloter le navigateur et capturer la console.)

- [ ] **Step 8 : Commit**

```bash
git add public/pilot.html dist/pilot.html
git commit -m "feat(kpi): onglet KPI dans la sidebar + squelette de page"
```

---

## Task 6 : Front — fetch + bar charts par partner et All

**Files:**
- Modify: `public/pilot.html` (remplace le stub `initKpi`, ajoute le rendu charts)
- Sync: `dist/pilot.html`

**Interfaces:**
- Consumes : `GET /api/kpi?year=` (Task 3).
- Produces : `initKpi()` (fetch + remplit le sélecteur d'année + rend un chart par partner + un « All ») ; variables `kpiData`, `kpiCharts[]`.

- [ ] **Step 1 : Remplacer le stub `initKpi` par l'implémentation**

Remplacer `function initKpi() { /* implémenté en Task 6 */ }` (Task 5 Step 5) par :

```javascript
    let kpiData = null;
    let kpiChartInstances = [];

    function kpiPopulateYears() {
      const sel = document.getElementById('kpiYear');
      if (sel.options.length > 0) return; // déjà rempli
      const now = new Date().getFullYear();
      for (let y = now + 1; y >= now - 3; y--) {
        const opt = document.createElement('option');
        opt.value = y; opt.textContent = y;
        if (y === now) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    async function initKpi() {
      kpiPopulateYears();
      const year = document.getElementById('kpiYear').value || new Date().getFullYear();
      const container = document.getElementById('kpiCharts');
      container.innerHTML = '<p style="color:var(--text-secondary);">Chargement…</p>';
      try {
        const res = await fetch('/api/kpi?year=' + year);
        if (!res.ok) throw new Error('Erreur serveur (' + res.status + ')');
        kpiData = await res.json();
        renderKpiUnclassified();
        renderKpiCharts();
        if (document.getElementById('kpiReglages').style.display !== 'none') renderKpiReglages();
      } catch (e) {
        container.innerHTML = '<p style="color:var(--warning);">Erreur : ' + e.message + '</p>';
      }
    }

    // Couleurs : Objectif (gris) vs Réalisé (vert primaire).
    const KPI_COL_OBJ = 'rgba(120,119,116,0.35)';
    const KPI_COL_REAL = '#003D2E';
    const KPI_TYPES = [
      { key: 'newsale', label: 'Signé · Newsale' },
      { key: 'upsale',  label: 'Signé · Upsale' },
      { key: 'opere',   label: 'Opéré' },
    ];

    function kpiFmtEur(v) {
      return (Math.round(v) || 0).toLocaleString('fr-FR') + ' €';
    }

    function renderKpiCharts() {
      // Détruit les anciens charts pour éviter les fuites mémoire.
      kpiChartInstances.forEach(c => c.destroy());
      kpiChartInstances = [];

      const container = document.getElementById('kpiCharts');
      container.innerHTML = '';

      // Un bloc "All" en premier, puis un bloc par partner.
      const blocks = [{ partner: 'Tous (All)', data: kpiData.all }]
        .concat(kpiData.partners.map(p => ({ partner: p.partner, data: { newsale: p.newsale, upsale: p.upsale, opere: p.opere } })));

      if (kpiData.partners.length === 0) {
        container.innerHTML = '<div class="section"><p style="color:var(--text-secondary);">Aucune mission ni objectif pour cette année. Ajoute des objectifs via « Réglages ».</p></div>';
        return;
      }

      blocks.forEach((block, idx) => {
        const card = document.createElement('div');
        card.className = 'section';
        const canvasId = 'kpiChart_' + idx;
        card.innerHTML =
          '<h3 style="margin:0 0 0.8rem;">' + block.partner + '</h3>' +
          '<div style="height:260px;"><canvas id="' + canvasId + '"></canvas></div>';
        container.appendChild(card);

        const labels = KPI_TYPES.map(t => t.label);
        const objdata = KPI_TYPES.map(t => block.data[t.key].objectif);
        const realdata = KPI_TYPES.map(t => block.data[t.key].realise);
        // % d'avancement par type (affiché au-dessus de la barre Réalisé).
        const txLabels = KPI_TYPES.map(t => {
          const tx = block.data[t.key].tx;
          return tx === null ? '—' : Math.round(tx * 100) + '%';
        });

        const chart = new Chart(document.getElementById(canvasId), {
          type: 'bar',
          plugins: [ChartDataLabels],
          data: {
            labels,
            datasets: [
              { label: 'Objectif', data: objdata, backgroundColor: KPI_COL_OBJ,
                datalabels: { display: false } },
              { label: 'Réalisé', data: realdata, backgroundColor: KPI_COL_REAL,
                datalabels: {
                  anchor: 'end', align: 'end', color: 'var(--text)', font: { weight: '700', size: 11 },
                  formatter: (val, ctx) => txLabels[ctx.dataIndex],
                } },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, ticks: { callback: v => (v / 1000) + 'k' } } },
            plugins: {
              legend: { position: 'top' },
              tooltip: { callbacks: { label: ctx => ctx.dataset.label + ' : ' + kpiFmtEur(ctx.raw) } },
            },
          },
        });
        kpiChartInstances.push(chart);
      });
    }

    function renderKpiUnclassified() {
      const box = document.getElementById('kpiUnclassified');
      const list = (kpiData && kpiData.unclassified) || [];
      if (list.length === 0) { box.style.display = 'none'; return; }
      box.style.display = '';
      box.innerHTML =
        '<h3 style="margin:0 0 0.5rem; color:var(--warning);">⚠️ ' + list.length + ' mission(s) non classée(s) (type_ca vide)</h3>' +
        '<p style="margin:0 0 0.5rem; color:var(--text-secondary); font-size:0.9rem;">Elles ne comptent ni en Newsale ni en Upsale. Corrige leur <code>type_ca</code> dans Notion.</p>' +
        '<ul style="margin:0; padding-left:1.2rem;">' +
        list.map(m => '<li>' + (m.nom || 'Sans nom') + ' — ' + (m.client || '') + ' (' + kpiFmtEur(m.ca) + ')</li>').join('') +
        '</ul>';
    }
```

- [ ] **Step 2 : Synchroniser dist**

Run: `cp public/pilot.html dist/pilot.html`

- [ ] **Step 3 : Vérifier en navigateur**

Recharger le dashboard, aller sur KPI.
Expected : un bloc « Tous (All) » puis un bloc par partner, chacun avec un bar chart à 3 groupes (Signé·Newsale, Signé·Upsale, Opéré), 2 barres (Objectif gris / Réalisé vert), le % au-dessus du Réalisé. Changer l'année recharge les données. Si des missions sont non classées, l'encart orange apparaît.
(Outil : skill `webapp-testing`.)

- [ ] **Step 4 : Commit**

```bash
git add public/pilot.html dist/pilot.html
git commit -m "feat(kpi): bar charts par partner + All + alerte non classées"
```

---

## Task 7 : Front — panneau Réglages (objectifs + répartition) + sauvegarde

**Files:**
- Modify: `public/pilot.html` (remplace le stub `toggleKpiReglages`, ajoute le rendu + sauvegarde)
- Sync: `dist/pilot.html`

**Interfaces:**
- Consumes : `kpiData` (Task 6), `POST /api/kpi/objectives` & `POST /api/kpi/split` (Task 4).
- Produces : `toggleKpiReglages()`, `renderKpiReglages()`, `saveKpiObjective(...)`, `saveKpiSplit(...)`.

- [ ] **Step 1 : Remplacer le stub `toggleKpiReglages` + ajouter le rendu et la sauvegarde**

Remplacer `function toggleKpiReglages() { /* implémenté en Task 7 */ }` (Task 5 Step 5) par :

```javascript
    function toggleKpiReglages() {
      const box = document.getElementById('kpiReglages');
      const show = box.style.display === 'none';
      box.style.display = show ? '' : 'none';
      if (show) renderKpiReglages();
    }

    function renderKpiReglages() {
      if (!kpiData) return;
      const box = document.getElementById('kpiReglages');
      const year = document.getElementById('kpiYear').value;

      // --- A. Objectifs : une ligne par partner connu, 3 champs ---
      const partners = kpiData.partners.map(p => p.partner);
      let objHtml = '<h3 style="margin:0 0 0.8rem;">Objectifs ' + year + ' (€)</h3>';
      if (partners.length === 0) {
        objHtml += '<p style="color:var(--text-secondary);">Aucun partner détecté. Les partners apparaissent dès qu\'ils sont sur une mission de l\'année, ou saisis ci-dessous.</p>';
      }
      objHtml += '<table style="width:100%; border-collapse:collapse; margin-bottom:1.5rem;"><thead><tr>' +
        '<th style="text-align:left; padding:0.4rem;">Partner</th>' +
        '<th style="padding:0.4rem;">Newsale</th><th style="padding:0.4rem;">Upsale</th><th style="padding:0.4rem;">Opéré</th></tr></thead><tbody>';
      kpiData.partners.forEach(p => {
        objHtml += '<tr>' +
          '<td style="padding:0.4rem; font-weight:600;">' + p.partner + '</td>' +
          ['newsale', 'upsale', 'opere'].map(t =>
            '<td style="padding:0.4rem;"><input type="number" style="width:110px; padding:0.3rem; border:1px solid var(--border); border-radius:var(--radius);" ' +
            'value="' + p[t].objectif + '" ' +
            'onchange="saveKpiObjective(\'' + p.partner + '\', ' + year + ', \'' + t + '\', this.value)"></td>'
          ).join('') +
          '</tr>';
      });
      objHtml += '</tbody></table>';

      // --- B. Répartition CA : missions de l'année à 2+ partners ---
      let splitHtml = '<h3 style="margin:0 0 0.8rem;">Répartition du CA (missions à 2+ partners)</h3>';
      if (kpiData.missionsForSplit.length === 0) {
        splitHtml += '<p style="color:var(--text-secondary);">Aucune mission à plusieurs partners cette année.</p>';
      }
      kpiData.missionsForSplit.forEach((m, mi) => {
        splitHtml += '<div style="border:1px solid var(--border); border-radius:var(--radius); padding:0.8rem; margin-bottom:0.8rem;">' +
          '<div style="font-weight:600; margin-bottom:0.5rem;">' + m.nom + ' — ' + kpiFmtEur(m.ca) + '</div>';
        [['commercial', m.commercial, m.splitCommercial], ['operationnel', m.operationnel, m.splitOperationnel]].forEach(([axis, plist, smap]) => {
          if (!plist || plist.length < 2) return;
          const inputId = 'split_' + mi + '_' + axis;
          splitHtml += '<div style="margin:0.3rem 0;"><span style="display:inline-block; width:110px; color:var(--text-secondary);">' + axis + '</span>' +
            plist.map(pn =>
              '<span style="margin-right:0.8rem;">' + pn + ' <input type="number" data-partner="' + pn + '" ' +
              'style="width:64px; padding:0.25rem; border:1px solid var(--border); border-radius:var(--radius);" value="' + (smap[pn] || 0) + '"> %</span>'
            ).join('') +
            '<button class="analytics-tab" style="padding:0.25rem 0.6rem;" onclick="saveKpiSplit(\'' + m.id + '\', \'' + axis + '\', \'' + inputId + '\')">OK</button>' +
            '<span id="' + inputId + '" data-inputs="' + mi + '_' + axis + '"></span></div>';
          // marqueur invisible pour retrouver les inputs : on relit via le parent
        });
        splitHtml += '</div>';
      });

      box.innerHTML = objHtml + splitHtml;
      // Stocke la structure pour relire les inputs à la sauvegarde.
      box.dataset.year = year;
    }

    async function saveKpiObjective(partner, year, type, value) {
      try {
        const res = await fetch('/api/kpi/objectives', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partner, year: Number(year), type, montant: Number(value) || 0 }),
        });
        if (!res.ok) throw new Error('Erreur ' + res.status);
        await initKpi(); // refetch → met à jour charts + All
      } catch (e) { alert('Échec sauvegarde objectif : ' + e.message); }
    }

    async function saveKpiSplit(missionId, axis, markerId) {
      try {
        // Relit les inputs % du bloc axis : ils précèdent le <span id=markerId>.
        const marker = document.getElementById(markerId);
        const row = marker.parentElement; // le <div> de l'axe
        const inputs = row.querySelectorAll('input[data-partner]');
        const splits = Array.from(inputs).map(inp => ({ partner: inp.dataset.partner, pct: Number(inp.value) || 0 }));
        const total = splits.reduce((s, x) => s + x.pct, 0);
        if (Math.round(total) !== 100) {
          if (!confirm('La somme fait ' + total + '% (pas 100%). Les montants seront normalisés. Continuer ?')) return;
        }
        const res = await fetch('/api/kpi/split', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mission_id: missionId, axis, splits }),
        });
        if (!res.ok) throw new Error('Erreur ' + res.status);
        await initKpi();
      } catch (e) { alert('Échec sauvegarde répartition : ' + e.message); }
    }
```

- [ ] **Step 2 : Synchroniser dist**

Run: `cp public/pilot.html dist/pilot.html`

- [ ] **Step 3 : Vérifier en navigateur (parcours complet)**

Recharger, aller sur KPI, cliquer **Réglages**.
Expected :
1. Une table d'objectifs (une ligne par partner, 3 champs) ; modifier une valeur → le chart correspondant se met à jour (Objectif + % + le bloc All).
2. La liste des missions à 2+ partners ; modifier un % et cliquer **OK** → si la somme ≠ 100 %, confirmation de normalisation ; après save, les Réalisés des partners concernés bougent.
3. Aucune erreur console.
(Outil : skill `webapp-testing`.)

- [ ] **Step 4 : Commit**

```bash
git add public/pilot.html dist/pilot.html
git commit -m "feat(kpi): panneau Reglages (objectifs + repartition) + sauvegarde"
```

---

## Vérification finale (après Task 7)

- [ ] `npx jest utils/kpiCompute.test.js` → tous verts.
- [ ] `node --check server.js` → OK.
- [ ] `diff -q public/pilot.html dist/pilot.html` → identiques.
- [ ] Parcours navigateur complet : navigation, charts, changement d'année, objectifs, répartition, alerte non classées.
- [ ] Comparaison manuelle : prendre 2-3 missions réelles de l'année et vérifier à la main que les montants attribués correspondent.

## Hors périmètre (rappel)

Pas d'historique d'objectifs, pas d'export, pas de droits par partner, pas de logique « 3+ partners » spéciale (parts égales générique). Voir spec §6.
</content>
