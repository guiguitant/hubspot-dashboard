# Write-back des primes vers Google Sheets · Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pilot écrit automatiquement (cron + bouton) les primes calculées dans l'onglet KPI vers le Google Sheet (onglet Masse_salariale, catégorie `.Primes`, une ligne par associé), en figeant le passé et en gérant le débordement d'exercice, puis retire le double compte des primes dans l'EBE.

**Architecture:** Le moteur pur `computePrimePayments` (utils/) gagne la règle de date unifiée + une sortie par associé/mois. Un module pur `primesSheetMap` découvre les coordonnées du Sheet et construit les écritures. Un client `googleSheets` (googleapis, compte de service) lit et écrit. L'orchestration (`syncPrimesToSheet`), l'endpoint et le cron vivent dans server.js (monolithe existant). L'horodatage de synchro est persisté dans une table Supabase.

**Tech Stack:** Node.js/Express CommonJS, googleapis ^171.4.0 (déjà présent), node-cron (à ajouter), jest ^30, Supabase, vanilla JS (public/pilot.html).

## Global Constraints

- Backend CommonJS uniquement (`require` / `module.exports`), jamais `import`/`export`.
- Réponses, commentaires de code et libellés UI en **français**. **Jamais de tiret cadratin** « — » (utiliser · : , ;).
- **Ne pas modifier** `public/js/prospector.js` (automatisation Dispatch).
- Source du front = `public/pilot.html` (dist/pilot.html est un artefact synchronisé au démarrage serveur, lignes 229-234 : ne pas éditer dist à la main).
- Secrets Google (`.env` : `client_email`, `private_key_id`, `private_key`, `GOOGLE_SHEET_ID`) : **jamais commités**, traités comme des mots de passe.
- Le write-back appelle le moteur avec **`versements: []`** (charge totale, pas le résiduel) et **`pastPolicy: 'drop'`** (figement du passé).
- Onglet cible = constante `MASSE_TAB = 'Masse_salariale'`.
- Chaque message de commit se termine par : `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Spec de référence : `docs/superpowers/specs/2026-07-31-primes-gsheet-writeback-design.md`.

## File Structure

- **Modifier** `utils/kpiCompute.js` : règle de date unifiée (étage 1) + param `participants` + sortie `byPartnerMonth` dans `computePrimePayments`.
- **Modifier** `utils/kpiCompute.test.js` : mettre à jour le test du deal facturé en retard + ajouter tests date/byPartnerMonth.
- **Créer** `utils/primesSheetMap.js` : fonctions PURES (colToLetter, parseMonthHeader, discoverLayout, assertPartners, buildUpdates).
- **Créer** `utils/primesSheetMap.test.js` : tests du module pur.
- **Créer** `utils/googleSheets.js` : client authentifié (readGrid, batchWrite).
- **Modifier** `server.js` : require des nouveaux modules + node-cron ; helper `computePrimesByPartnerMonth` + `primeParticipantsForYear` ; `syncPrimesToSheet` ; état Supabase (read/write) ; endpoints `POST /api/primes/sync-gsheet` et `GET /api/primes/sync-status` ; cron dans `app.listen` ; retrait du fold EBE.
- **Modifier** `public/pilot.html` : bouton « Synchroniser le GSheet » + fonction `syncPrimesGsheet` + affichage « dernière synchro ».
- **Modifier** `package.json` : ajouter `node-cron`.
- **Supabase (SQL, hors code)** : table `primes_sheet_sync`.

---

### Task 1 : Moteur · règle de date de versement unifiée

**Files:**
- Modify: `utils/kpiCompute.js` (fonction `computePrimePayments`, lignes ~435-437)
- Test: `utils/kpiCompute.test.js` (bloc `describe('computePrimePayments ...')`, lignes ~494-568)

**Interfaces:**
- Consumes: `quarterOfDate(d)` et `yearOfDate(d)` (déjà définis dans le module) et `monthAfterQuarterClose(y, q)`.
- Produces: `computePrimePayments` place l'étage 1 à M+1 de la clôture du trimestre de la **date d'acompte** (signature = portillon + montant uniquement). Signature de retour inchangée à ce stade.

- [ ] **Step 1 : Mettre à jour le test existant qui devient faux**

Dans `utils/kpiCompute.test.js`, remplacer le test « deal facture en retard » (lignes ~513-517) par :

```js
  it('deal facture au trimestre suivant (T3) : versement a M+1 de la cloture du T3 (octobre)', () => {
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: '2026-08-20' })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.byMonth['2026-10']).toBe(9000);
    expect(r.byMonth['2026-04']).toBeUndefined();
    expect(r.byMonth['2026-09']).toBeUndefined();
  });

  it('deal signe T1 facture au T2 : versement en juillet (M+1 cloture T2)', () => {
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: '2026-05-15' })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.byMonth['2026-07']).toBe(9000);
    expect(r.byMonth['2026-04']).toBeUndefined();
  });
```

- [ ] **Step 2 : Lancer les tests, vérifier l'échec**

Run: `npx jest utils/kpiCompute.test.js -t "computePrimePayments"`
Expected: FAIL sur les deux nouveaux cas (aujourd'hui le moteur place en septembre / avril, pas octobre / juillet).

- [ ] **Step 3 : Appliquer la nouvelle règle de date**

Dans `utils/kpiCompute.js`, fonction `computePrimePayments`, remplacer le bloc actuel :

```js
        let mk = monthAfterQuarterClose(year, q + 1);
        const mkFact = monthAfterDate(acompte);
        if (mkFact && mkFact > mk) mk = mkFact;      // le plus tardif des deux
```

par :

```js
        // Regle unifiee : versement a M+1 de la cloture du trimestre OU l'acompte est facture.
        // Le trimestre de signature (q) ne sert qu'au portillon (gateOk) et au montant.
        const qFact = quarterOfDate(acompte);
        const yFact = yearOfDate(acompte);
        let mk = (qFact && yFact) ? monthAfterQuarterClose(yFact, qFact) : monthAfterQuarterClose(year, q + 1);
```

- [ ] **Step 4 : Lancer les tests, vérifier le succès**

Run: `npx jest utils/kpiCompute.test.js`
Expected: PASS (tout le fichier, y compris les cas « à temps », « rattrapage », « T4 » qui restent valides).

- [ ] **Step 5 : Commit**

```bash
git add utils/kpiCompute.js utils/kpiCompute.test.js
git commit -m "feat(pilot) primes : versement a M+1 de la cloture du trimestre de facturation de l'acompte" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2 : Moteur · sortie `byPartnerMonth` + participants

**Files:**
- Modify: `utils/kpiCompute.js` (`computePrimePayments`)
- Test: `utils/kpiCompute.test.js`

**Interfaces:**
- Consumes: nouveau paramètre optionnel `participants` (array de noms) dans l'objet d'options de `computePrimePayments`.
- Produces: `computePrimePayments` retourne désormais `{ byMonth, byPartnerMonth, detail, enAttente, verse }` où `byPartnerMonth = { [partner]: { 'YYYY-MM': montant } }`. Étage 1 ventilé par associé, étage 2 (collectif) réparti à parts égales sur `participants` (fallback : partners porteurs de CA signé) au mois N+1.

- [ ] **Step 1 : Écrire les tests (byPartnerMonth)**

Ajouter dans le bloc `describe('computePrimePayments ...')` de `utils/kpiCompute.test.js` :

```js
  it('byPartnerMonth : etage 1 ventile par associe au bon mois', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10', participants: ['Vincent', 'Guillaume', 'Nathan'] });
    expect(r.byPartnerMonth.Vincent['2026-04']).toBe(9000);
    expect(r.byPartnerMonth.Guillaume).toBeUndefined();
  });

  it('byPartnerMonth : etage 2 reparti a parts egales en N+1, byMonth garde le total', () => {
    const r = computePrimePayments({ missions: [], splits: [], config: cfg, year: 2026, caFacture: 660000, versements: [], now: '2026-02-10', participants: ['Vincent', 'Guillaume', 'Nathan'] });
    // collectif = 7% * 150000 = 10500 ; /3 = 3500 par associe
    expect(r.byPartnerMonth.Vincent['2027-03']).toBe(3500);
    expect(r.byPartnerMonth.Guillaume['2027-03']).toBe(3500);
    expect(r.byPartnerMonth.Nathan['2027-03']).toBe(3500);
    expect(r.byMonth['2027-03']).toBe(10500); // total collectif inchange
  });
```

- [ ] **Step 2 : Lancer les tests, vérifier l'échec**

Run: `npx jest utils/kpiCompute.test.js -t "byPartnerMonth"`
Expected: FAIL (`r.byPartnerMonth` est `undefined`).

- [ ] **Step 3 : Implémenter `byPartnerMonth` + `participants`**

Dans `utils/kpiCompute.js`, fonction `computePrimePayments` :

3a. Ajouter `participants` à la déstructuration des options :

```js
function computePrimePayments({ missions, splits, config, year, caFacture, versements = [], now, versementEtage2Mois, pastPolicy = 'rattrapage', participants = null }) {
```

3b. Juste après `const byMonth = {};` ajouter l'accumulateur et son helper :

```js
  const byMonth = {};
  const byPartnerMonth = {};
  const addPM = (partner, mk, amount) => {
    if (!partner) return;
    (byPartnerMonth[partner] = byPartnerMonth[partner] || {})[mk] = (byPartnerMonth[partner][mk] || 0) + amount;
  };
```

3c. Dans l'étage 1, juste après l'appel `add(mk, montant, { etage: 1, ... });`, ajouter :

```js
        add(mk, montant, { etage: 1, deal: deal.id, nom: deal.nom, partner: p, montant, rattrapage: isPast });
        addPM(p, mk, montant);
```

3d. Dans l'étage 2, après le `add(mk, collTotal, { etage: 2, ... });` existant, répartir sur les participants. Remplacer le bloc :

```js
    if (!(isPast && pastPolicy === 'drop')) {
      if (isPast) mk = nowKey;
      add(mk, collTotal, { etage: 2, montant: collTotal, rattrapage: isPast });
    }
```

par :

```js
    if (!(isPast && pastPolicy === 'drop')) {
      if (isPast) mk = nowKey;
      add(mk, collTotal, { etage: 2, montant: collTotal, rattrapage: isPast });
      const parts = (participants && participants.length) ? participants : Object.keys(sq.detailByPartner || {});
      if (parts.length) {
        const share = Math.round(collTotal / parts.length);
        for (const p of parts) addPM(p, mk, share);
      }
    }
```

3e. Ajouter `byPartnerMonth` au retour :

```js
  return { byMonth, byPartnerMonth, detail, enAttente, verse };
```

- [ ] **Step 4 : Lancer les tests, vérifier le succès**

Run: `npx jest utils/kpiCompute.test.js`
Expected: PASS (fichier entier).

- [ ] **Step 5 : Commit**

```bash
git add utils/kpiCompute.js utils/kpiCompute.test.js
git commit -m "feat(pilot) primes : sortie byPartnerMonth (primes par associe et par mois)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3 : Module pur `primesSheetMap` (découverte + écritures)

**Files:**
- Create: `utils/primesSheetMap.js`
- Test: `utils/primesSheetMap.test.js`

**Interfaces:**
- Produces:
  - `colToLetter(idx)` : index colonne 0-based → lettre A1.
  - `parseMonthHeader(v)` : libellé → `'YYYY-MM'` ou null (gère `MM/YYYY` et `YYYY-MM...`).
  - `discoverLayout(grid, { labelCol=2, partnerNames=null })` → `{ headerRow, primesRow, monthCols: {'YYYY-MM': colIdx}, partnerRows: {nom: rowIdx} }`. Throw si en-tête mois ou `.Primes` introuvable.
  - `assertPartners(layout, expected)` : throw si un participant attendu n'a pas de ligne.
  - `buildUpdates(layout, byPartnerMonth, tabName, nowKey)` → `{ updates: [{ range, value }] }`. Écrit, pour chaque associé, chaque mois présent avec `mk >= nowKey` (figement), la valeur ou 0.

- [ ] **Step 1 : Écrire les tests**

Créer `utils/primesSheetMap.test.js` :

```js
'use strict';
const { colToLetter, parseMonthHeader, discoverLayout, assertPartners, buildUpdates } = require('./primesSheetMap');

// Grille type : 2 lignes vides en tete (gerees), en-tete mois en ligne 3 (index 2),
// colonne C (index 2) = libelles, colonnes mois espacees de 2.
function grid() {
  return [
    [],
    [],
    ['', '', 'Compte de resultat', '01/2026', '', '02/2026', '', '03/2026', '', '04/2026'],
    ['', '', '.Salaires nets', 12000, '', 12000, '', 12000, '', 12000],
    ['', '', 'Vincent', 0, '', 0, '', 0, '', 0],
    ['', '', '.Primes', '', '', '', '', '', '', ''],
    ['', '', 'Vincent', 0, '', 0, '', 0, '', 0],
    ['', '', 'Guillaume', 0, '', 0, '', 0, '', 0],
    ['', '', 'Nathan', 0, '', 0, '', 0, '', 0],
    ['', '', '.Charges soci. + patr.', 0, '', 0, '', 0, '', 0],
  ];
}

describe('primesSheetMap', () => {
  it('colToLetter', () => {
    expect(colToLetter(0)).toBe('A');
    expect(colToLetter(25)).toBe('Z');
    expect(colToLetter(26)).toBe('AA');
  });

  it('parseMonthHeader gere MM/YYYY et ISO', () => {
    expect(parseMonthHeader('04/2026')).toBe('2026-04');
    expect(parseMonthHeader('2026-04-01')).toBe('2026-04');
    expect(parseMonthHeader('Salaires')).toBeNull();
  });

  it('discoverLayout trouve en-tete, .Primes et les 3 associes malgre les lignes vides', () => {
    const L = discoverLayout(grid(), { partnerNames: ['Vincent', 'Guillaume', 'Nathan'] });
    expect(L.monthCols['2026-04']).toBe(9);
    expect(L.partnerRows.Vincent).toBe(6); // la ligne Vincent SOUS .Primes, pas celle sous .Salaires
    expect(L.partnerRows.Guillaume).toBe(7);
    expect(L.partnerRows.Nathan).toBe(8);
  });

  it('assertPartners throw si un associe manque', () => {
    const L = discoverLayout(grid(), { partnerNames: ['Vincent', 'Guillaume', 'Nathan'] });
    expect(() => assertPartners(L, ['Vincent', 'Inconnu'])).toThrow();
    expect(() => assertPartners(L, ['Vincent', 'Nathan'])).not.toThrow();
  });

  it('discoverLayout throw si .Primes absente', () => {
    const g = grid().filter(row => String(row[2]) !== '.Primes');
    expect(() => discoverLayout(g)).toThrow(/Primes/);
  });

  it('buildUpdates : mois passes figes, mois >= nowKey ecrits (valeur ou 0)', () => {
    const L = discoverLayout(grid(), { partnerNames: ['Vincent', 'Guillaume', 'Nathan'] });
    const byPM = { Vincent: { '2026-04': 3500 } };
    const { updates } = buildUpdates(L, byPM, 'Masse_salariale', '2026-03');
    // Vincent : 03/2026 (colonne H=index7) -> 0, 04/2026 (colonne J=index9) -> 3500 ; 01 et 02 figes
    const vincent04 = updates.find(u => u.range === 'Masse_salariale!J7');
    expect(vincent04.value).toBe(3500);
    const vincent03 = updates.find(u => u.range === 'Masse_salariale!H7');
    expect(vincent03.value).toBe(0);
    expect(updates.some(u => u.range === 'Masse_salariale!D7')).toBe(false); // 01/2026 fige
  });
});
```

- [ ] **Step 2 : Lancer les tests, vérifier l'échec**

Run: `npx jest utils/primesSheetMap.test.js`
Expected: FAIL (module inexistant).

- [ ] **Step 3 : Implémenter le module**

Créer `utils/primesSheetMap.js` :

```js
'use strict';

// Index colonne 0-based -> lettre A1 (0->A, 25->Z, 26->AA).
function colToLetter(idx) {
  let n = idx, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Libelle d'en-tete -> cle 'YYYY-MM' (gere 'MM/YYYY', 'M/YYYY', 'YYYY-MM...'), sinon null.
function parseMonthHeader(v) {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return m[2] + '-' + m[1].padStart(2, '0');
  m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return m[1] + '-' + m[2];
  return null;
}

// Decouvre la structure de la grille (tableau 2D de lignes du sheet).
// labelCol = index 0-based de la colonne des libelles (defaut 2 = colonne C).
// partnerNames (optionnel) = ne retenir comme sous-lignes que ces noms.
function discoverLayout(grid, opts = {}) {
  const labelCol = opts.labelCol != null ? opts.labelCol : 2;
  const partnerNames = opts.partnerNames || null;

  // 1) Ligne d'en-tete = celle qui contient le plus de cellules 'mois'.
  let headerRow = -1, monthCols = {}, best = 0;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const found = {};
    for (let c = 0; c < row.length; c++) {
      const mk = parseMonthHeader(row[c]);
      if (mk && found[mk] == null) found[mk] = c;
    }
    if (Object.keys(found).length > best) { best = Object.keys(found).length; headerRow = r; monthCols = found; }
  }
  if (headerRow < 0 || best === 0) throw new Error('Ligne d\'en-tete des mois introuvable');

  // 2) Categorie .Primes dans la colonne des libelles.
  let primesRow = -1;
  for (let r = 0; r < grid.length; r++) {
    const label = String((grid[r] || [])[labelCol] || '').trim();
    if (/^\.\s*primes\b/i.test(label)) { primesRow = r; break; }
  }
  if (primesRow < 0) throw new Error('Categorie .Primes introuvable');

  // 3) Sous-lignes = lignes suivantes sans prefixe de categorie ('.'/'cm.') jusqu'a la prochaine.
  const partnerRows = {};
  for (let r = primesRow + 1; r < grid.length; r++) {
    const label = String((grid[r] || [])[labelCol] || '').trim();
    if (!label) continue;
    if (/^(\.|cm\.)/i.test(label)) break;
    if (partnerNames && !partnerNames.includes(label)) continue;
    if (partnerRows[label] == null) partnerRows[label] = r;
  }
  return { headerRow, primesRow, monthCols, partnerRows };
}

// Throw si un participant attendu n'a pas de ligne (garde-fou : ne rien ecrire au mauvais endroit).
function assertPartners(layout, expected) {
  const missing = (expected || []).filter(p => layout.partnerRows[p] == null);
  if (missing.length) throw new Error('Associe(s) introuvable(s) dans .Primes : ' + missing.join(', '));
}

// Construit les ecritures. Pour chaque associe (ligne connue) et chaque mois present dans la grille
// avec mk >= nowKey (figement du passe), ecrit la valeur de byPartnerMonth ou 0 (remise a zero des
// primes obsoletes). Retourne { updates: [{ range, value }] }.
function buildUpdates(layout, byPartnerMonth, tabName, nowKey) {
  const updates = [];
  for (const [partner, rowIdx] of Object.entries(layout.partnerRows)) {
    for (const [mk, colIdx] of Object.entries(layout.monthCols)) {
      if (mk < nowKey) continue; // figement : on ne touche pas le passe
      const src = byPartnerMonth[partner] || {};
      const value = Math.round(src[mk] || 0);
      updates.push({ range: tabName + '!' + colToLetter(colIdx) + (rowIdx + 1), value });
    }
  }
  return { updates };
}

module.exports = { colToLetter, parseMonthHeader, discoverLayout, assertPartners, buildUpdates };
```

- [ ] **Step 4 : Lancer les tests, vérifier le succès**

Run: `npx jest utils/primesSheetMap.test.js`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add utils/primesSheetMap.js utils/primesSheetMap.test.js
git commit -m "feat(pilot) primes : module pur de decouverte et d'ecriture des cellules .Primes" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4 : Client Google Sheets authentifié

**Files:**
- Create: `utils/googleSheets.js`

**Interfaces:**
- Produces:
  - `readGrid(tabName, range)` → tableau 2D (valeurs formatées).
  - `batchWrite(updates)` où `updates = [{ range, value }]` → `{ updated }`. Une seule requête `values.batchUpdate`, `valueInputOption: 'RAW'`.
- Consumes: `process.env.client_email`, `process.env.private_key` (échappement `\n`), `process.env.GOOGLE_SHEET_ID`.

- [ ] **Step 1 : Implémenter le client**

Créer `utils/googleSheets.js` :

```js
'use strict';
const { google } = require('googleapis');

let _sheets = null;
// Client Sheets memoise, authentifie via le compte de service (.env). scope = ecriture Sheets.
function sheetsClient() {
  if (_sheets) return _sheets;
  const auth = new google.auth.JWT({
    email: process.env.client_email,
    key: (process.env.private_key || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

// Lit une plage 'A1:BZ300' d'un onglet. Retourne un tableau 2D (lignes), valeurs affichees.
async function readGrid(tabName, range) {
  const res = await sheetsClient().spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${tabName}!${range}`,
    valueRenderOption: 'FORMATTED_VALUE',
    majorDimension: 'ROWS',
  });
  return res.data.values || [];
}

// Ecrit une liste de cellules en un seul appel. updates = [{ range:'Onglet!J7', value:3500 }].
async function batchWrite(updates) {
  if (!updates || !updates.length) return { updated: 0 };
  const res = await sheetsClient().spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map(u => ({ range: u.range, values: [[u.value]] })),
    },
  });
  return { updated: res.data.totalUpdatedCells || 0 };
}

module.exports = { readGrid, batchWrite };
```

- [ ] **Step 2 : Vérifier le chargement du module (pas d'appel réseau)**

Run: `node -e "require('./utils/googleSheets'); console.log('ok module googleSheets')"`
Expected: affiche `ok module googleSheets` sans erreur (validation de syntaxe et de require ; l'auth réelle est testée en Task 6 via le dry-run).

- [ ] **Step 3 : Commit**

```bash
git add utils/googleSheets.js
git commit -m "feat(pilot) primes : client Google Sheets authentifie (compte de service)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 : Table Supabase d'état de synchro

**Files:**
- (SQL exécuté par l'utilisateur dans Supabase, à documenter dans le plan de session)

**Interfaces:**
- Produces: table `primes_sheet_sync` (`id text pk`, `last_run_at timestamptz`, `ok boolean`, `summary jsonb`, `updated_at timestamptz`).

- [ ] **Step 1 : Fournir et faire exécuter le SQL**

Donner à l'utilisateur ce SQL à exécuter dans l'éditeur SQL Supabase :

```sql
create table if not exists primes_sheet_sync (
  id text primary key default 'default',
  last_run_at timestamptz,
  ok boolean,
  summary jsonb,
  updated_at timestamptz default now()
);
-- Lignes gerees par le service role (serveur). Pas d'acces client direct.
alter table primes_sheet_sync enable row level security;
```

- [ ] **Step 2 : Vérifier**

Demander confirmation que la table existe (SELECT vide sans erreur : `select * from primes_sheet_sync;`).

- [ ] **Step 3 : Pas de commit** (aucun fichier modifié ; la migration est hors dépôt).

---

### Task 6 : Orchestration serveur + endpoints (avec dry-run)

**Files:**
- Modify: `server.js` (require en tête ~12-19 ; helpers près de `computePrimesCommercialesForYear` ~8228 ; endpoints après un `app.post('/api/kpi/...')` existant, ~6699)

**Interfaces:**
- Consumes: `utils/googleSheets`, `utils/primesSheetMap`, `computePrimePayments`, `computeKpi`, `computeBillingForYear`, `fetchAllNotionMissions`, `supabase`.
- Produces:
  - `primeParticipantsForYear(kpi)` → array de noms (réplique `primeCommercialPartners()` du front).
  - `computePrimesByPartnerMonth(years, nowIso)` → `{ byPartnerMonth, participants }` (fusion des années, `versements: []`, `pastPolicy: 'drop'`).
  - `syncPrimesToSheet()` → `{ ok, updated, cells, participants, dry }` ou `{ ok:false, error }`. Persiste l'état.
  - `POST /api/primes/sync-gsheet` et `GET /api/primes/sync-status`.

- [ ] **Step 1 : Ajouter les require**

Dans `server.js`, après la ligne `const { computeDepenses } = require('./utils/depensesCompute');` (~19) :

```js
const gsheets = require('./utils/googleSheets');
const primesMap = require('./utils/primesSheetMap');
const MASSE_TAB = 'Masse_salariale';
```

- [ ] **Step 2 : Ajouter les helpers et l'orchestration**

Juste après la fonction `computePrimesCommercialesForYear` (~ligne 8249), ajouter :

```js
// Liste des participants au collectif = meme regle que le front (primeCommercialPartners) :
// partners KPI ayant un signal newsale/upsale (realise ou objectif), sinon tous les partners.
function primeParticipantsForYear(kpi) {
  const parts = (kpi.partners || []).filter(p =>
    (p.newsale && (p.newsale.realise || p.newsale.objectif)) ||
    (p.upsale && (p.upsale.realise || p.upsale.objectif)));
  return (parts.length ? parts : (kpi.partners || [])).map(p => p.partner);
}

// Primes par associe et par mois, fusionnees sur `years`. versements:[] = charge totale (independante
// des validations Phase 3) ; pastPolicy:'drop' = figement du passe (aucun mois passe produit).
async function computePrimesByPartnerMonth(years, nowIso) {
  const [cfgRow, splitRows, factRows, objRows] = await Promise.all([
    supabase.from('kpi_prime_config').select('config').eq('id', 'default').maybeSingle(),
    supabase.from('kpi_ca_split').select('*'),
    supabase.from('facture_overrides').select('*'),
    supabase.from('kpi_objectives').select('*'),
  ]);
  const config = cfgRow && cfgRow.data ? cfgRow.data.config : null;
  const splits = (splitRows && splitRows.data) || [];
  const factOverrides = (factRows && factRows.data) || [];
  const objectives = (objRows && objRows.data) || [];
  const missions = await fetchAllNotionMissions();

  // Participants : calcules sur l'annee courante (derniere de la liste).
  const kpiRef = computeKpi({ missions, objectives, splits, year: years[years.length - 1] });
  const participants = primeParticipantsForYear(kpiRef);

  const byPartnerMonth = {};
  for (const y of years) {
    const caFacture = computeBillingForYear(missions, factOverrides, y).total;
    const pay = computePrimePayments({ missions, splits, config, year: y, caFacture, versements: [], now: nowIso, pastPolicy: 'drop', participants });
    for (const [partner, months] of Object.entries(pay.byPartnerMonth || {})) {
      const dst = byPartnerMonth[partner] = byPartnerMonth[partner] || {};
      for (const [mk, amt] of Object.entries(months)) dst[mk] = (dst[mk] || 0) + amt;
    }
  }
  return { byPartnerMonth, participants };
}

// Etat de synchro (horodatage) persiste en base.
async function writePrimesSyncState(state) {
  try {
    await supabase.from('primes_sheet_sync').upsert({ id: 'default', updated_at: new Date().toISOString(), ...state });
  } catch (e) { console.error('[primes-sync] etat non persiste:', e.message); }
}

// Un run complet : calcule -> lit le sheet -> decouvre -> ecrit -> persiste. Tolerant (jamais throw).
// PRIMES_SYNC_DRYRUN=1 : lit et decouvre mais n'ecrit pas (validation avant premiere ecriture reelle).
async function syncPrimesToSheet() {
  const nowIso = new Date().toISOString();
  const nowKey = nowIso.slice(0, 7);
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear];
  try {
    const { byPartnerMonth, participants } = await computePrimesByPartnerMonth(years, nowIso);
    const grid = await gsheets.readGrid(MASSE_TAB, 'A1:BZ300');
    const layout = primesMap.discoverLayout(grid, { labelCol: 2, partnerNames: participants });
    primesMap.assertPartners(layout, participants);
    const { updates } = primesMap.buildUpdates(layout, byPartnerMonth, MASSE_TAB, nowKey);
    const dry = process.env.PRIMES_SYNC_DRYRUN === '1';
    let updated = 0;
    if (!dry) ({ updated } = await gsheets.batchWrite(updates));
    const summary = { updated, cells: updates.length, participants, dry };
    await writePrimesSyncState({ last_run_at: nowIso, ok: true, summary });
    console.log(`[primes-sync] ok : ${updates.length} cellules, ${updated} ecrites${dry ? ' (dry-run)' : ''}`);
    return { ok: true, ...summary };
  } catch (e) {
    console.error('[primes-sync] echec :', e.message);
    await writePrimesSyncState({ last_run_at: nowIso, ok: false, summary: { error: e.message } });
    return { ok: false, error: e.message };
  }
}
```

- [ ] **Step 3 : Ajouter les endpoints**

Après le endpoint `app.post('/api/kpi/prime-config', ...)` (repérer son `});` de fin, ~ligne 6720), ajouter :

```js
// Declenche une synchronisation des primes vers le GSheet (protege par dashboardGate global).
app.post('/api/primes/sync-gsheet', async (_req, res) => {
  const r = await syncPrimesToSheet();
  res.status(r.ok ? 200 : 500).json(r);
});

// Etat de la derniere synchro (pour l'affichage "derniere synchro" dans Pilot).
app.get('/api/primes/sync-status', async (_req, res) => {
  try {
    const { data } = await supabase.from('primes_sheet_sync').select('*').eq('id', 'default').maybeSingle();
    res.json(data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 4 : Dry-run contre le vrai Sheet (validation de la découverte)**

Lancer le serveur avec le dry-run activé, puis déclencher une synchro :

```bash
PRIMES_SYNC_DRYRUN=1 npm start
```

Dans un autre terminal (session dashboard authentifiée requise ; en local, `dashboardGate` a un bypass local, cf `isLocalDashboardBypass`) :

```bash
curl -s -X POST http://localhost:3000/api/primes/sync-gsheet | cat
```

Expected: `{"ok":true,"updated":0,"cells":<N>,"participants":[...],"dry":true}`. Vérifier que `cells > 0`, que `participants` contient bien les 3 associés, et qu'aucune erreur « Associe introuvable » / « en-tete introuvable » n'apparaît. Si erreur, ajuster (nom d'onglet `MASSE_TAB`, `labelCol`, format des en-têtes) AVANT toute écriture réelle.

- [ ] **Step 5 : Écriture réelle (contrôlée)**

Relancer sans le dry-run, déclencher une synchro, puis vérifier visuellement dans le Sheet que la ligne `.Primes` des mois à venir est bien remplie pour les 3 associés :

```bash
npm start
curl -s -X POST http://localhost:3000/api/primes/sync-gsheet | cat
```

Expected: `{"ok":true,"updated":<>0,"cells":<N>,...}` et cellules `.Primes` correctes dans le Sheet (mois futurs = primes calculées, mois passés inchangés).

- [ ] **Step 6 : Commit**

```bash
git add server.js
git commit -m "feat(pilot) primes : synchronisation vers GSheet (orchestration + endpoints + dry-run)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7 : Cron quotidien

**Files:**
- Modify: `package.json` (dépendance `node-cron`)
- Modify: `server.js` (require + planification dans `app.listen`)

**Interfaces:**
- Consumes: `node-cron`, `syncPrimesToSheet`.

- [ ] **Step 1 : Installer node-cron**

Run: `npm install node-cron`
Expected: `node-cron` ajouté à `dependencies` de `package.json`.

- [ ] **Step 2 : Require en tête de server.js**

Après les autres require (~ligne 20) :

```js
const cron = require('node-cron');
```

- [ ] **Step 3 : Planifier dans `app.listen`**

Dans le callback `app.listen(PORT, async () => { ... })`, avant la fermeture `});` (~ligne 11818), ajouter :

```js
  // Synchro quotidienne des primes vers le GSheet (1x/nuit, 03:00). Idempotent.
  try {
    cron.schedule('0 3 * * *', () => {
      syncPrimesToSheet().catch(e => console.error('[primes-sync cron] echec :', e.message));
    });
    console.log('[startup] cron primes -> GSheet planifie (0 3 * * *)');
  } catch (e) {
    console.error('[startup] cron primes non planifie :', e.message);
  }
```

- [ ] **Step 4 : Vérifier le démarrage**

Run: `npm start`
Expected: le log `[startup] cron primes -> GSheet planifie (0 3 * * *)` apparaît, le serveur démarre sans erreur. Arrêter le serveur.

- [ ] **Step 5 : Commit**

```bash
git add package.json package-lock.json server.js
git commit -m "feat(pilot) primes : cron quotidien de synchro vers GSheet" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8 : Bouton et statut côté Pilot

**Files:**
- Modify: `public/pilot.html` (zone `.prime-actions` ~ligne 4375 ; fonctions JS près de `renderKpiPrime` ~ligne 11501)

**Interfaces:**
- Consumes: `POST /api/primes/sync-gsheet`, `GET /api/primes/sync-status`.

- [ ] **Step 1 : Ajouter le bouton**

Dans `.prime-actions` (après le bouton « Réglages primes », ~ligne 4377) :

```html
          <button class="analytics-tab" onclick="syncPrimesGsheet(this)" title="Ecrire les primes calculees dans le Google Sheet (Masse_salariale)">⇪ Synchroniser le GSheet</button>
          <span id="primesSyncStatus" class="prime-ro" style="align-self:center"></span>
```

- [ ] **Step 2 : Ajouter les fonctions JS**

Près de `renderKpiPrime` (~ligne 11501), ajouter :

```js
    async function syncPrimesGsheet(btn) {
      const old = btn.textContent;
      btn.disabled = true; btn.textContent = 'Synchro…';
      try {
        const res = await fetch('/api/primes/sync-gsheet', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'echec');
        btn.textContent = '✓ ' + (data.updated || 0) + ' cellules';
        loadPrimesSyncStatus();
      } catch (e) {
        btn.textContent = '✗ ' + (e.message || 'erreur');
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 4000);
      }
    }

    async function loadPrimesSyncStatus() {
      try {
        const res = await fetch('/api/primes/sync-status');
        const s = await res.json();
        const el = document.getElementById('primesSyncStatus');
        if (el && s && s.last_run_at) {
          const d = new Date(s.last_run_at);
          el.textContent = 'Derniere synchro : ' + d.toLocaleString('fr-FR') + (s.ok ? '' : ' (echec)');
        }
      } catch (e) { /* silencieux */ }
    }
```

- [ ] **Step 3 : Charger le statut à l'affichage de l'onglet primes**

Dans `renderKpiPrime`, juste après `section.style.display = '';` (~ligne 11507), ajouter :

```js
      loadPrimesSyncStatus();
```

- [ ] **Step 4 : Vérifier dans le navigateur**

Lancer `npm start`, ouvrir Pilot, onglet KPI, zone primes. Cliquer « Synchroniser le GSheet ».
Expected: le bouton passe à « Synchro… » puis « ✓ N cellules », et « Derniere synchro : … » s'affiche. Vérifier les cellules dans le Sheet.

- [ ] **Step 5 : Commit**

```bash
git add public/pilot.html
git commit -m "feat(pilot) primes : bouton 'Synchroniser le GSheet' et statut derniere synchro" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9 : Retrait du double compte des primes dans l'EBE

**Files:**
- Modify: `server.js` (`computeResultatFactuelForYear` ~8283-8293 ; `/api/ebe` ~8333-8381)

**Interfaces:**
- Le compte de résultat n'ajoute plus le pool de primes : celui-ci entre désormais via la formule `.Primes → CR_Prev` (déjà compté dans `totalCharges` par `fetchAndParseCRPrev`). `primesCommerciales` reste calculé et exposé à titre d'info (pas ré-additionné). La trésorerie (`primesCommercialesVersees`) n'est pas touchée.

- [ ] **Step 1 : Vérifier la précondition (obligatoire avant toute modif)**

Confirmer, dans le Sheet, que :
1. la ligne `.Primes` est bien renseignée (Task 6 exécutée) ;
2. une formule agrège `.Primes` dans le total du compte de résultat de CR_Prev.

Puis comparer `/api/previsionnel-charges` (CR_Prev pur) et `/api/ebe` (avec fold) pour l'année en cours :

```bash
curl -s "http://localhost:3000/api/ebe?year=2026" | cat
```

Noter `charges.total` et `charges.primesCommerciales`. Si `.Primes` alimente déjà CR_Prev, alors `charges.total` contient DÉJÀ les primes une fois via CR_Prev ET une fois via le fold : c'est précisément le double compte à retirer. Ne continuer que si la précondition est vraie.

- [ ] **Step 2 : Retirer le fold dans `computeResultatFactuelForYear`**

Remplacer (~8283-8287) :

```js
  const primesCommerciales = await computePrimesCommercialesForYear(year, missions);
  const totalChargesAvecPrimes = totalCharges + primesCommerciales;
  const totalSubv = financements.subventions.reduce((s, f) => s + f.montant, 0);
  const totalAide = financements.aides.reduce((s, f) => s + f.montant, 0);
  const ebe = caFacture - totalChargesAvecPrimes + totalSubv + totalAide;
```

par :

```js
  // Primes : INFO seulement. Elles entrent dans totalCharges via la formule .Primes -> CR_Prev,
  // donc on ne les ajoute plus ici (sinon double compte). La tresorerie reste inchangee.
  const primesCommerciales = await computePrimesCommercialesForYear(year, missions);
  const totalSubv = financements.subventions.reduce((s, f) => s + f.montant, 0);
  const totalAide = financements.aides.reduce((s, f) => s + f.montant, 0);
  const ebe = caFacture - totalCharges + totalSubv + totalAide;
```

Puis dans le `return` (~8293), remplacer `totalCharges: totalChargesAvecPrimes` par `totalCharges` (le total sans re-fold) en gardant `primesCommerciales` :

```js
  return { year, caFacture, totalCharges, primesCommerciales, resExploit, isBrut, creditTotal, impotNet, remboursementCredit };
```

- [ ] **Step 3 : Retirer le fold dans `/api/ebe`**

Remplacer (~8333-8334) :

```js
    const primesCommerciales = await computePrimesCommercialesForYear(yearParam, missions);
    const totalChargesAvecPrimes = totalCharges + primesCommerciales;
```

par :

```js
    // Primes : INFO seulement (deja dans totalCharges via .Primes -> CR_Prev). Pas de re-fold.
    const primesCommerciales = await computePrimesCommercialesForYear(yearParam, missions);
```

Puis remplacer les usages de `totalChargesAvecPrimes` par `totalCharges` dans les 3 lignes suivantes (`ebeFactuel` ~8345, `ebeProjete` ~8347, et `charges: { total: totalChargesAvecPrimes, primesCommerciales }` ~8381 → `charges: { total: totalCharges, primesCommerciales }`).

- [ ] **Step 4 : Vérifier la cohérence des chiffres**

Run: `npm start` puis `curl -s "http://localhost:3000/api/ebe?year=2026" | cat`
Expected: `charges.total` reste cohérent (les primes sont comptées **une seule fois**, via CR_Prev), l'EBE n'a pas doublé la charge de primes. Comparer avec `/api/previsionnel-charges` pour confirmer l'alignement.

- [ ] **Step 5 : Lancer toute la suite de tests**

Run: `npx jest`
Expected: PASS (aucune régression sur les utils).

- [ ] **Step 6 : Commit**

```bash
git add server.js
git commit -m "fix(pilot) EBE : primes comptees une seule fois via .Primes -> CR_Prev (retrait du fold)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes d'exécution

- **Ordre impératif** : Task 6 (écriture réelle de `.Primes`) et vérification de la formule CR_Prev **avant** Task 9 (retrait du fold), sinon fenêtre de sous-compte ou de double compte.
- **Impact trésorerie** (Task 1) : la règle de date modifie aussi les dates de décaissement des primes dans le plan de trésorerie (moteur partagé). Après Task 1, vérifier le plan de trésorerie sur un cas de deal facturé en retard.
- **Primes décaissées dans le réel Qonto** (soulevé par Nathan, parking lot) : pour les mois clos, `computeChargesHybride` prend le réel Qonto, qui contient les primes déjà décaissées, tandis que les mois futurs prennent CR_Prev (`.Primes`). À la Task 9, analyser si ces primes décaissées gonflent indûment les charges réelles (double compte, ou incohérence cash vs charge du CR) et, le cas échéant, les neutraliser dans les charges réelles pour rester aligné avec le traitement `.Primes` des mois futurs.
- **Backfill initial** (hors plan, décision de démarrage) : si les mois déjà écoulés de l'année doivent être remplis, le faire en one-shot (ex. abaisser temporairement `nowKey`) après validation ; le régime courant fige le passé.
- **Secrets** : ne jamais committer `.env`. Les creds Google y sont déjà.
