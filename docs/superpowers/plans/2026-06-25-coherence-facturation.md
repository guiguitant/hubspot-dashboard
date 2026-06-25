# Contrôle de cohérence facturation & facture englobante — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre qu'une facture englobe plusieurs lignes (choix Garder/Déplacer) et afficher un contrôle de cohérence TTC permanent (Σ factures liées vs montant attendu de la ligne) dans la modale de matching.

**Architecture:** Le calcul de cohérence (pur, sans I/O) est extrait dans `utils/facturationCoherence.js`, testé en TDD avec Jest. Le serveur enrichit l'endpoint `suggest` ciblé (montants des lignes + factures liées) et l'endpoint `link` (flag `keepDuplicates` + bloc cohérence englobante dans la réponse 409), en réutilisant le helper. Le front (`public/pilot.html`) affiche un indicateur live recalculé à chaque coche, et remplace le `confirm()` natif par un panneau de choix Garder/Déplacer. La modif front est reportée dans `dist/pilot.html`.

**Tech Stack:** Node.js/Express (CommonJS), Jest (testMatch `utils/**/*.test.js`), HTML/vanilla JS (IIFE).

## Global Constraints

- Référence montants : **Notion = HT**, **Pennylane (`inv.amount`) = TTC**, conversion `TTC = HT × 1.2`.
- Montant HT attendu d'une ligne : acompte → `mission.montantAcompte` ; solde → `mission.ca − mission.montantAcompte` (convention server.js:2438-2439).
- Le contrôle de cohérence est **informatif, jamais bloquant** : on affiche toujours l'écart (€ et %), surligné si ≠ 0, sans empêcher l'enregistrement.
- Backend CommonJS (`require`/`module.exports`), pas d'`import/export`.
- Ne **pas** pousser sur `master` (déploiement prod auto au push). Commits locaux uniquement.
- Toute modif de `public/pilot.html` doit être reportée à l'identique dans `dist/pilot.html`.

---

### Task 1: Helper pur de cohérence (`utils/facturationCoherence.js`)

**Files:**
- Create: `utils/facturationCoherence.js`
- Test: `utils/facturationCoherence.test.js`

**Interfaces:**
- Consumes: rien (fonctions pures).
- Produces:
  - `TVA_RATE` = `1.2` (number).
  - `lineExpectedTTC(mission, type)` → `number`. `mission` = `{ ca, montantAcompte }`, `type` = `'acompte' | 'solde'`.
  - `computeEcart(sumTTC, targetTTC)` → `{ sumTTC: number, targetTTC: number, ecart: number, ecartPct: number|null }`. `ecartPct` = `null` si `targetTTC === 0`.

- [ ] **Step 1: Écrire le test qui échoue**

Create `utils/facturationCoherence.test.js`:

```js
'use strict';
const { TVA_RATE, lineExpectedTTC, computeEcart } = require('./facturationCoherence');

describe('lineExpectedTTC', () => {
  it('acompte = montantAcompte HT × 1.2', () => {
    expect(lineExpectedTTC({ ca: 10000, montantAcompte: 4000 }, 'acompte')).toBeCloseTo(4800, 5);
  });
  it('solde = (ca - montantAcompte) HT × 1.2', () => {
    expect(lineExpectedTTC({ ca: 10000, montantAcompte: 4000 }, 'solde')).toBeCloseTo(7200, 5);
  });
  it('champs manquants → 0', () => {
    expect(lineExpectedTTC({}, 'acompte')).toBe(0);
    expect(lineExpectedTTC(null, 'solde')).toBe(0);
  });
});

describe('computeEcart', () => {
  it('calcule écart absolu et relatif', () => {
    const r = computeEcart(14400, 13200);
    expect(r.sumTTC).toBe(14400);
    expect(r.targetTTC).toBe(13200);
    expect(r.ecart).toBeCloseTo(1200, 5);
    expect(r.ecartPct).toBeCloseTo(1200 / 13200, 5);
  });
  it('cible nulle → ecartPct null (pas de division par zéro)', () => {
    const r = computeEcart(500, 0);
    expect(r.ecart).toBe(500);
    expect(r.ecartPct).toBeNull();
  });
  it('TVA_RATE exporté = 1.2', () => {
    expect(TVA_RATE).toBe(1.2);
  });
});
```

- [ ] **Step 2: Lancer le test → échec attendu**

Run: `npx jest utils/facturationCoherence.test.js`
Expected: FAIL avec `Cannot find module './facturationCoherence'`.

- [ ] **Step 3: Implémenter le helper minimal**

Create `utils/facturationCoherence.js`:

```js
'use strict';

// Taux TVA pour convertir les montants HT (Notion) en TTC (Pennylane).
// Aligné sur la convention server.js (TTC = HT × 1.2).
const TVA_RATE = 1.2;

// Montant TTC attendu d'une ligne (mission, type) à partir des montants HT Notion.
// acompte → montantAcompte ; solde → ca - montantAcompte (cf. server.js:2438-2439).
function lineExpectedTTC(mission, type) {
  if (!mission) return 0;
  const ca = Number(mission.ca) || 0;
  const acpt = Number(mission.montantAcompte) || 0;
  const ht = type === 'acompte' ? acpt : (ca - acpt);
  return ht * TVA_RATE;
}

// Compare une somme TTC à une cible TTC. ecartPct = null si cible nulle.
function computeEcart(sumTTC, targetTTC) {
  const sum = Number(sumTTC) || 0;
  const target = Number(targetTTC) || 0;
  const ecart = sum - target;
  const ecartPct = target !== 0 ? ecart / target : null;
  return { sumTTC: sum, targetTTC: target, ecart, ecartPct };
}

module.exports = { TVA_RATE, lineExpectedTTC, computeEcart };
```

- [ ] **Step 4: Lancer le test → succès attendu**

Run: `npx jest utils/facturationCoherence.test.js`
Expected: PASS (3 suites, tous verts).

- [ ] **Step 5: Commit**

```bash
git add utils/facturationCoherence.js utils/facturationCoherence.test.js
git commit -m "feat(facturation): helper pur de cohérence TTC (testé)"
```

---

### Task 2: Enrichir `GET /api/facturation-matching/suggest` (cas ciblé)

**Files:**
- Modify: `server.js:2747-2764` (réponse du cas ciblé `missionNom && type`)

**Interfaces:**
- Consumes: `mission.montantAcompte`, `mission.ca`, `invoices` (déjà en mémoire dans le handler), `parseLinkedInvoiceList`, `currentRaw`.
- Produces (réponse JSON enrichie) :
  - `mission` gagne `montantAcompte` (HT).
  - nouveau champ `linkedDetails: [{ invoiceNumber, amount, status }]` (un par n° de `currentlyLinkedList` ; `amount`/`status` = `null` si la facture est introuvable côté Pennylane).

- [ ] **Step 1: Modifier la réponse ciblée**

Dans `server.js`, le bloc `return res.json({ ... })` du cas ciblé (actuellement lignes 2747-2764) devient :

```js
      const currentRaw = type === 'acompte' ? mission.factAcptPenny : mission.factSoldePenny;
      const currentList = parseLinkedInvoiceList(currentRaw);
      // Patch cohérence : montants TTC des factures déjà liées (lookup dans invoices en mémoire).
      const invByNum = new Map(
        (invoices || [])
          .filter(inv => inv && inv.invoiceNumber)
          .map(inv => [inv.invoiceNumber.toLowerCase(), inv])
      );
      const linkedDetails = currentList.map(num => {
        const inv = invByNum.get(num.toLowerCase());
        return {
          invoiceNumber: num,
          amount: inv ? inv.amount : null,
          status: inv ? inv.status : null,
        };
      });
      return res.json({
        mission: { nom: mission.nom, client: mission.client, ca: mission.ca, montantAcompte: mission.montantAcompte, pageId: mission.id },
        type,
        currentlyLinked: currentRaw,
        currentlyLinkedList: currentList,
        linkedDetails,
        suggestions: suggestions.map(c => ({
          invoiceNumber: c.inv.invoiceNumber,
          customerName: c.inv.customerName,
          amount: c.inv.amount,
          date: c.inv.date,
          status: c.inv.status,
          paid: c.inv.paid,
          score: c.score,
          reasons: c.reasons,
          pdfInvoiceSubject: c.inv.pdfInvoiceSubject || '',
          pdfDescription: c.inv.pdfDescription || '',
        })),
      });
```

(Remplace l'ancien `const currentRaw = ...` et l'ancien `return res.json({...})` ; la variable `currentList` remplace l'appel `parseLinkedInvoiceList(currentRaw)` qui était inline dans `currentlyLinkedList`.)

- [ ] **Step 2: Vérifier la syntaxe**

Run: `node --check server.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Vérification manuelle (runtime)**

Démarrer le serveur (`npm start`), puis dans un navigateur/onglet appeler l'endpoint sur une mission ayant au moins une facture liée :
`/api/facturation-matching/suggest?mission=<NOM>&type=solde`
Expected : le JSON contient `mission.montantAcompte` (nombre) et un tableau `linkedDetails` avec un `amount` non-null pour les factures existantes côté Pennylane.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(facturation): suggest renvoie montantAcompte + montants des factures liées"
```

---

### Task 3: `POST /api/facturation-matching/link` — flag `keepDuplicates` + cohérence englobante

**Files:**
- Modify: `server.js:2816-2947` (handler `link`)
- Modify: `server.js` (requires en tête de fichier — ajouter l'import du helper)

**Interfaces:**
- Consumes: `lineExpectedTTC`, `computeEcart` (Task 1) ; `findDuplicateLinks`, `parseLinkedInvoiceList`, `fetchAllNotionMissions`, `fetchCustomerInvoices`, `updateNotionMissionRichTextProperty`.
- Produces : réponse `409 INVALID_DUPLICATE` enrichie d'un champ `coherence` ; le body accepte `keepDuplicates: true`.

- [ ] **Step 1: Importer le helper**

En tête de `server.js`, à côté des autres `require('./utils/...')` (rechercher `require('./utils` pour situer le groupe), ajouter :

```js
const { lineExpectedTTC, computeEcart } = require('./utils/facturationCoherence');
```

- [ ] **Step 2: Étendre la déstructuration du body**

Ligne `const { missionNom, type, invoiceNumbers, invoiceNumber, expectedCurrent, confirmDuplicates } = req.body || {};` → ajouter `keepDuplicates` :

```js
    const { missionNom, type, invoiceNumbers, invoiceNumber, expectedCurrent, confirmDuplicates, keepDuplicates } = req.body || {};
```

- [ ] **Step 3: Calculer la cohérence englobante et l'ajouter à la réponse 409**

Le bloc de détection des conflits (actuellement) :

```js
    let conflicts = [];
    if (cleaned.length > 0) {
      conflicts = findDuplicateLinks(cleaned, missions, missionNom, type);
      if (conflicts.length > 0 && !confirmDuplicates) {
        return res.status(409).json({
          error: 'Factures déjà liées ailleurs — confirmation requise pour les retirer.',
          code: 'INVALID_DUPLICATE',
          conflicts: conflicts.map(c => ({
            invoice: c.invoice,
            otherMission: c.otherMission,
            otherType: c.otherType,
            otherCurrentList: c.otherCurrentList,
          })),
        });
      }
    }
```

devient (le 409 n'est renvoyé que si ni `confirmDuplicates` ni `keepDuplicates`, et il porte le bloc `coherence`) :

```js
    let conflicts = [];
    if (cleaned.length > 0) {
      conflicts = findDuplicateLinks(cleaned, missions, missionNom, type);
      if (conflicts.length > 0 && !confirmDuplicates && !keepDuplicates) {
        // Cohérence englobante : pour chaque facture en conflit, Σ(TTC des lignes couvertes) vs TTC facture.
        const invoices409 = await fetchCustomerInvoices();
        const invByNum = new Map(
          (invoices409 || []).filter(inv => inv && inv.invoiceNumber).map(inv => [inv.invoiceNumber.toLowerCase(), inv])
        );
        // Regroupe les conflits par facture pour lister toutes les lignes qu'elle couvrira.
        const byInvoice = new Map();
        for (const c of conflicts) {
          const key = c.invoice.toLowerCase();
          if (!byInvoice.has(key)) byInvoice.set(key, { invoice: c.invoice, others: [] });
          byInvoice.get(key).others.push({ mission: c.otherMission, type: c.otherType });
        }
        const coherence = [];
        for (const { invoice, others } of byInvoice.values()) {
          // Lignes couvertes = ligne cible (mission courante) + lignes en conflit.
          const lineDefs = [{ mission: missionNom, type }, ...others];
          const lines = lineDefs.map(ld => {
            const m = missions.find(mm => mm.nom === ld.mission) || {};
            return { mission: ld.mission, type: ld.type, lineTTC: lineExpectedTTC(m, ld.type) };
          });
          const sumLinesTTC = lines.reduce((s, l) => s + l.lineTTC, 0);
          const inv = invByNum.get(invoice.toLowerCase());
          const invoiceTTC = inv ? (inv.amount || 0) : 0;
          const e = computeEcart(sumLinesTTC, invoiceTTC);
          coherence.push({ invoice, invoiceTTC, lines, sumLinesTTC, ecart: e.ecart, ecartPct: e.ecartPct });
        }
        return res.status(409).json({
          error: 'Factures déjà liées ailleurs — choisis Garder ou Déplacer.',
          code: 'INVALID_DUPLICATE',
          conflicts: conflicts.map(c => ({
            invoice: c.invoice,
            otherMission: c.otherMission,
            otherType: c.otherType,
            otherCurrentList: c.otherCurrentList,
          })),
          coherence,
        });
      }
    }
```

- [ ] **Step 4: Ne retirer des autres lignes QUE si `confirmDuplicates` (pas `keepDuplicates`)**

Le bloc de retrait commence par `if (conflicts.length > 0 && confirmDuplicates) {`. Il reste **inchangé** : avec `keepDuplicates`, `confirmDuplicates` est falsy donc ce bloc est sauté → aucun retrait, on tombe directement sur le PATCH cible. Vérifier qu'aucune autre condition ne se base sur `conflicts.length` seul.

`cleanedFromOthers: conflicts.length` dans la réponse de succès doit refléter ce qui a été réellement retiré : remplacer par `cleanedFromOthers: confirmDuplicates ? conflicts.length : 0` (ligne actuelle ~2939) pour ne pas afficher un faux toast « lien retiré » en mode Garder.

```js
        cleanedFromOthers: confirmDuplicates ? conflicts.length : 0, // 0 en mode Garder (keepDuplicates)
```

- [ ] **Step 5: Vérifier la syntaxe**

Run: `node --check server.js && echo OK`
Expected: `OK`.

- [ ] **Step 6: Vérification manuelle (runtime)**

Serveur démarré. Avec un client REST (ou la modale après Task 4/5), poster sur `/api/facturation-matching/link` un body liant une facture déjà liée ailleurs, **sans** `confirmDuplicates`/`keepDuplicates` :
Expected : `409`, `code: "INVALID_DUPLICATE"`, présence de `coherence[0]` avec `invoiceTTC`, `lines[]`, `sumLinesTTC`, `ecart`, `ecartPct`.
Puis reposter avec `keepDuplicates: true` : Expected `200 ok:true`, et la facture reste présente dans l'autre ligne (vérifier via un GET `suggest` sur l'autre mission/type).

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat(facturation): link accepte keepDuplicates + cohérence englobante dans le 409"
```

---

### Task 4: Front — indicateur live de cohérence dans la modale

**Files:**
- Modify: `public/pilot.html` — `openFactMatchingModal` (~11441, stocker `linkedDetails`), `renderFactMatchingModalBody` (~11455), binding `change` des checkboxes (~11544)

**Interfaces:**
- Consumes (réponse `suggest` enrichie Task 2) : `data.mission.montantAcompte`, `data.mission.ca`, `data.linkedDetails`, `data.suggestions[].amount`.
- Produces : fonctions front `buildFactAmountLookup()` et `updateCoherenceIndicator()` ; un conteneur `#factCoherenceIndicator` dans le body de la modale.

- [ ] **Step 1: Stocker `linkedDetails` dans l'état**

Dans `openFactMatchingModal`, le `factMatchingModalState = { ... }` (~11441-11447) gagne `linkedDetails` :

```js
        factMatchingModalState = {
          missionNom, type,
          expectedCurrent: data.currentlyLinked || '',
          currentList: currentList.slice(),
          suggestions: data.suggestions || [],
          linkedDetails: data.linkedDetails || [],
          mission: data.mission || {},
        };
```

- [ ] **Step 2: Ajouter les helpers de calcul + le conteneur indicateur**

Juste avant `function renderFactMatchingModalBody()` (~11454), ajouter :

```js
    // Construit un lookup { n°facture(min) → montant TTC } à partir des propositions + factures liées.
    function buildFactAmountLookup() {
      const map = new Map();
      for (const s of (factMatchingModalState.suggestions || [])) {
        if (s && s.invoiceNumber && s.amount != null) map.set(s.invoiceNumber.toLowerCase(), s.amount);
      }
      for (const d of (factMatchingModalState.linkedDetails || [])) {
        if (d && d.invoiceNumber && d.amount != null) map.set(d.invoiceNumber.toLowerCase(), d.amount);
      }
      return map;
    }

    // Recalcule et réécrit l'indicateur de cohérence (Σ TTC factures cochées vs attendu TTC ligne).
    function updateCoherenceIndicator() {
      const el = document.getElementById('factCoherenceIndicator');
      if (!el) return;
      const { mission: m, type, currentList } = factMatchingModalState;
      const ca = Number(m.ca) || 0;
      const acpt = Number(m.montantAcompte) || 0;
      const expectedHT = type === 'acompte' ? acpt : (ca - acpt);
      const expectedTTC = expectedHT * 1.2; // TTC = HT × 1.2 (Notion HT → Pennylane TTC)
      const lookup = buildFactAmountLookup();
      let sumTTC = 0, unknown = 0;
      for (const inv of currentList) {
        const amt = lookup.get(inv.toLowerCase());
        if (amt == null) unknown++; else sumTTC += amt;
      }
      const ecart = sumTTC - expectedTTC;
      const ecartPct = expectedTTC !== 0 ? (ecart / expectedTTC) * 100 : null;
      const ok = Math.abs(ecart) < 1;
      const color = ok ? 'var(--success)' : 'var(--warning)';
      let html = '<div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;color:var(--text-secondary);margin-bottom:0.3rem">Cohérence (TTC)</div>';
      html += '<div style="display:flex;justify-content:space-between"><span>Attendu (Notion HT × 1,2)</span><span style="font-family:monospace">' + formatEuro(expectedTTC) + '</span></div>';
      html += '<div style="display:flex;justify-content:space-between"><span>Lié (' + currentList.length + ' facture' + (currentList.length > 1 ? 's' : '') + ')</span><span style="font-family:monospace">' + formatEuro(sumTTC) + '</span></div>';
      html += '<div style="display:flex;justify-content:space-between;font-weight:700;color:' + color + '"><span>Écart</span><span style="font-family:monospace">' + (ecart >= 0 ? '+' : '') + formatEuro(ecart) + (ecartPct != null ? ' (' + (ecart >= 0 ? '+' : '') + ecartPct.toFixed(1) + '%)' : '') + '</span></div>';
      if (unknown > 0) {
        html += '<div style="margin-top:0.3rem;font-size:0.72rem;color:var(--text-secondary);font-style:italic">' + unknown + ' facture(s) au montant inconnu (saisie manuelle), exclue(s) du calcul.</div>';
      }
      el.innerHTML = html;
    }
```

- [ ] **Step 3: Insérer le conteneur dans le HTML de la modale**

Dans `renderFactMatchingModalBody`, juste après le bloc « Header » (après la ligne `html += '</div>';` qui ferme l'encart d'en-tête, ~11473), insérer le conteneur de l'indicateur :

```js
      // Indicateur de cohérence (rempli après injection via updateCoherenceIndicator)
      html += '<div id="factCoherenceIndicator" style="margin-bottom:0.8rem;padding:0.6rem;background:var(--bg-secondary);border-radius:6px;font-size:0.8rem"></div>';
```

- [ ] **Step 4: Remplir l'indicateur après l'injection HTML + à chaque coche**

Après `body.innerHTML = html;` (~11541), et après la boucle qui bind les checkboxes, appeler le calcul. Modifier le `addEventListener('change', ...)` des checkboxes (~11545-11555) pour appeler `updateCoherenceIndicator()` à la fin du handler :

```js
          // Pas de re-render complet pour éviter de perdre le focus ; on laisse les checkboxes tels quels.
          updateCoherenceIndicator();
```

Et ajouter, juste après le bloc de bind des checkboxes (avant le bind du formulaire manuel), un appel initial :

```js
      updateCoherenceIndicator();
```

- [ ] **Step 5: Vérification manuelle (navigateur)**

`npm start` + ouvrir Pilot → onglet Facturation → ouvrir la modale de matching sur une ligne.
Expected :
- L'encart « Cohérence (TTC) » affiche Attendu / Lié / Écart.
- Cocher/décocher une proposition met à jour Lié et Écart en temps réel ; écart ≠ 0 → en orange, écart ~0 → en vert.
- Ajouter un n° via la saisie manuelle → mention « 1 facture(s) au montant inconnu… ».

- [ ] **Step 6: Commit**

```bash
git add public/pilot.html
git commit -m "feat(facturation): indicateur live de cohérence TTC dans la modale matching"
```

---

### Task 5: Front — panneau de choix Garder / Déplacer (cas conflit)

**Files:**
- Modify: `public/pilot.html` — `confirmFactMatchingMulti` (~11582-11608) et l'appel du bouton Enregistrer (~11579)

**Interfaces:**
- Consumes : réponse `409` enrichie (Task 3) `json.conflicts`, `json.coherence` ; `factMatchingModalState`.
- Produces : `confirmFactMatchingMulti(action)` où `action ∈ { undefined (1er essai), 'keep', 'move' }`.

- [ ] **Step 1: Refactor de la signature + body de la requête**

Remplacer l'entête de `confirmFactMatchingMulti` et la construction du body. La fonction prend désormais `action` au lieu de `confirmDuplicates` :

```js
    async function confirmFactMatchingMulti(action) {
      const { missionNom, type, expectedCurrent, currentList } = factMatchingModalState;
      if (!missionNom || !type) return;
      const body = document.getElementById('factMatchingModalBody');
      const prev = body.innerHTML;
      body.innerHTML = '<p style="font-size:0.85rem;color:var(--text-secondary)">⏳ Écriture Notion en cours...</p>';
      try {
        const res = await fetch('/api/facturation-matching/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            missionNom, type, invoiceNumbers: currentList, expectedCurrent,
            confirmDuplicates: action === 'move',
            keepDuplicates: action === 'keep',
          }),
        });
        const json = await res.json();
```

- [ ] **Step 2: Remplacer le `confirm()` natif par le panneau de choix**

Le bloc `if (json.code === 'INVALID_DUPLICATE') { ... }` (~11596-11609) devient un rendu de panneau dans la modale avec 3 boutons (au lieu du `confirm()`/recursion) :

```js
          if (json.code === 'INVALID_DUPLICATE') {
            const conflictsList = (json.conflicts || []).map(c =>
              '• ' + c.invoice + ' → déjà liée à "' + c.otherMission + '" / ' + c.otherType
            ).join('<br>');
            let panel = '<div style="font-size:0.85rem">';
            panel += '<div style="font-weight:700;color:var(--warning);margin-bottom:0.5rem">⚠️ Conflit(s) de matching</div>';
            panel += '<div style="margin-bottom:0.8rem">' + conflictsList + '</div>';
            // Tableau de cohérence englobante (Σ lignes couvertes vs montant facture)
            for (const co of (json.coherence || [])) {
              const ok = Math.abs(co.ecart) < 1;
              const color = ok ? 'var(--success)' : 'var(--warning)';
              const pct = co.ecartPct != null ? ' (' + (co.ecart >= 0 ? '+' : '') + (co.ecartPct * 100).toFixed(1) + '%)' : '';
              panel += '<div style="padding:0.6rem;background:var(--bg-secondary);border-radius:6px;margin-bottom:0.6rem">';
              panel += '<div style="font-weight:600;margin-bottom:0.3rem">Cohérence facture ' + co.invoice + ' (englobe ' + co.lines.length + ' ligne' + (co.lines.length > 1 ? 's' : '') + ')</div>';
              panel += '<div style="display:flex;justify-content:space-between"><span>Σ lignes couvertes (TTC)</span><span style="font-family:monospace">' + formatEuro(co.sumLinesTTC) + '</span></div>';
              panel += '<div style="display:flex;justify-content:space-between"><span>Montant facture (TTC)</span><span style="font-family:monospace">' + formatEuro(co.invoiceTTC) + '</span></div>';
              panel += '<div style="display:flex;justify-content:space-between;font-weight:700;color:' + color + '"><span>Écart</span><span style="font-family:monospace">' + (co.ecart >= 0 ? '+' : '') + formatEuro(co.ecart) + pct + '</span></div>';
              panel += '</div>';
            }
            panel += '<div style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:0.8rem">« Garder » : la facture reste aussi sur l\'autre ligne (facture englobante). « Déplacer » : elle est retirée de l\'autre ligne.</div>';
            panel += '<div style="display:flex;gap:0.5rem;justify-content:flex-end">';
            panel += '<button id="factConflictCancel" class="btn" style="font-size:0.78rem;padding:0.4rem 0.8rem">Annuler</button>';
            panel += '<button id="factConflictMove" class="btn" style="font-size:0.78rem;padding:0.4rem 0.8rem">Déplacer ici</button>';
            panel += '<button id="factConflictKeep" class="btn" style="font-size:0.8rem;padding:0.4rem 1rem;background:var(--primary);color:white;font-weight:700;border:none">Garder sur les 2 lignes</button>';
            panel += '</div></div>';
            body.innerHTML = panel;
            document.getElementById('factConflictCancel').addEventListener('click', () => { body.innerHTML = prev; rebindFactMatchingModalEvents(); });
            document.getElementById('factConflictMove').addEventListener('click', () => confirmFactMatchingMulti('move'));
            document.getElementById('factConflictKeep').addEventListener('click', () => confirmFactMatchingMulti('keep'));
            return;
          }
```

- [ ] **Step 3: Mettre à jour l'appel du bouton Enregistrer**

À la fin de `renderFactMatchingModalBody`, le bind du bouton save (~11579) appelle la fonction sans action (1er essai) :

```js
      if (saveBtn) saveBtn.addEventListener('click', () => confirmFactMatchingMulti());
```

(inchangé — `confirmFactMatchingMulti()` sans argument = `action` undefined = 1er essai. Vérifier qu'aucun autre appel ne passe encore l'ancien booléen `true`.)

- [ ] **Step 4: Helper de re-bind pour le bouton Annuler**

Le bouton « Annuler » restaure `prev` (le HTML de la modale) mais les écouteurs d'événements sont perdus. Extraire le bloc de binding existant (checkboxes + formulaire manuel + unlinkAll + save, ~11543-11579) dans une fonction `rebindFactMatchingModalEvents()` appelée à la fois en fin de `renderFactMatchingModalBody` ET par le bouton Annuler. Le contenu déplacé est le code de binding actuel ; `renderFactMatchingModalBody` se termine par `body.innerHTML = html; rebindFactMatchingModalEvents();`.

- [ ] **Step 5: Vérification manuelle (navigateur)**

Sur une ligne, cocher une facture déjà liée ailleurs puis Enregistrer.
Expected :
- Panneau « ⚠️ Conflit(s) de matching » avec la liste + le tableau « Cohérence facture … (englobe N lignes) » (Σ lignes / montant facture / écart).
- « Garder sur les 2 lignes » → succès, la facture reste sur l'autre ligne (pas de toast « lien retiré »).
- « Déplacer ici » → succès, toast « 1 lien(s) retiré(s) », la facture disparaît de l'autre ligne.
- « Annuler » → retour à la modale fonctionnelle (checkboxes et indicateur live de nouveau réactifs).

- [ ] **Step 6: Commit**

```bash
git add public/pilot.html
git commit -m "feat(facturation): choix Garder/Déplacer + cohérence englobante (remplace confirm natif)"
```

---

### Task 6: Reporter les modifications dans `dist/pilot.html`

**Files:**
- Modify: `dist/pilot.html` (version servie — mêmes modifs que `public/pilot.html` Tasks 4 & 5)

**Interfaces:** aucune (copie miroir).

- [ ] **Step 1: Reporter les blocs**

Appliquer dans `dist/pilot.html` les mêmes modifications que celles faites dans `public/pilot.html` (helpers `buildFactAmountLookup`/`updateCoherenceIndicator`, conteneur `#factCoherenceIndicator`, refactor `confirmFactMatchingMulti(action)` + panneau de conflit, `rebindFactMatchingModalEvents`). Repérer les blocs équivalents dans `dist/pilot.html` (mêmes noms de fonctions) et appliquer les edits à l'identique.

- [ ] **Step 2: Vérifier la cohérence des deux fichiers**

Run (Git Bash) :
```bash
diff <(grep -n "updateCoherenceIndicator\|factConflictKeep\|keepDuplicates" public/pilot.html | sed 's/^[0-9]*://') <(grep -n "updateCoherenceIndicator\|factConflictKeep\|keepDuplicates" dist/pilot.html | sed 's/^[0-9]*://') && echo "IDENTIQUES"
```
Expected : `IDENTIQUES` (les mêmes lignes logiques présentes des deux côtés).

- [ ] **Step 3: Vérification manuelle**

Recharger l'app servie (celle qui sert `dist/`) et refaire un test rapide de l'indicateur live + du panneau de conflit.
Expected : comportement identique à `public/pilot.html`.

- [ ] **Step 4: Commit**

```bash
git add dist/pilot.html
git commit -m "build(facturation): report cohérence + Garder/Déplacer dans dist/pilot.html"
```

---

### Task 7: Vérification de bout en bout

**Files:** aucun (test manuel + relecture).

- [ ] **Step 1: Suite de tests unitaires**

Run: `npm test`
Expected : toutes les suites `utils/**` passent, y compris `facturationCoherence.test.js`.

- [ ] **Step 2: Check syntaxe serveur**

Run: `node --check server.js && echo OK`
Expected : `OK`.

- [ ] **Step 3: Scénarios fonctionnels (navigateur)**

Vérifier les 4 scénarios de la spec :
1. Ligne mono-facture cohérente → écart ~0 (vert).
2. Ligne avec facture trop grosse/petite → écart affiché en orange.
3. Facture déjà liée ailleurs → panneau conflit + cohérence englobante + 3 boutons ; « Garder » conserve sur les 2 lignes, « Déplacer » retire de l'autre.
4. Saisie manuelle d'un n° → mention « montant inconnu ».

- [ ] **Step 4: Commit final éventuel** (si ajustements)

```bash
git add -A
git commit -m "test(facturation): vérification e2e cohérence + facture englobante"
```

---

## Notes d'exécution

- Ne **pas** `git push` (déploiement prod auto au push sur `master`).
- L'écart est toujours informatif : aucun garde-fou ne doit empêcher l'enregistrement.
- En cas d'écart systématique non nul sur le solde, c'est probablement le split Notion 50/50 par défaut — comportement attendu, pas un bug.
