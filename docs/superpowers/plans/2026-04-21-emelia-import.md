# Import Emelia — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer Task 1 (scraping Sales Navigator) par un workflow d'import de fichier `.xlsx` Emelia, avec nettoyage serveur, rapport de rejets, et wizard 3 étapes dans l'UI.

**Architecture:** Nouveau endpoint `POST /api/prospector/import-emelia` (multer + xlsx, mode dry_run) + logic de nettoyage extraite dans `utils/emeliaCleaner.js` (testable) + wizard vanilla JS dans `prospector.js` (3 étapes : upload → aperçu → confirmation). Task 1 complètement supprimée (3 endpoints + statuts `scrapping_pending`/`Profil incomplet`).

**Tech Stack:** Node.js/Express (CommonJS), multer, xlsx, Supabase (supabaseAdmin), vanilla JS frontend (prospector.js)

---

## Fichiers touchés

| Action | Fichier |
|---|---|
| Créer | `utils/emeliaCleaner.js` |
| Créer | `utils/emeliaCleaner.test.js` |
| Modifier | `package.json` — +multer, +xlsx, +script test |
| Modifier | `server.js` — +endpoint import-emelia, +requires multer/xlsx, -3 endpoints Task 1 |
| Modifier | `public/js/prospector-ui.js` — -statuts Task 1 |
| Modifier | `public/js/prospector.js` — -Task 1 refs, +wizard Emelia, +route, +bouton campagne |
| Renommer | `skill_prospector_V10.md` → `skill_prospector_V10_backup.md` |
| Créer | `skill_prospector_V11.md` |

---

## Task 1 — Installer les dépendances

**Fichiers :** Modify `package.json`

- [ ] **Étape 1 : Ajouter multer, xlsx et le script test dans package.json**

Ouvrir `package.json` et modifier la section `dependencies` et `scripts` :

```json
{
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js",
    "frontend:dev": "vite",
    "frontend:build": "vite build",
    "frontend:preview": "vite preview",
    "test": "jest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.80.0",
    "@supabase/supabase-js": "^2.99.1",
    "adm-zip": "^0.5.17",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "express-session": "^1.19.0",
    "googleapis": "^171.4.0",
    "imap": "^0.8.19",
    "jsonwebtoken": "^9.0.3",
    "lucide-react": "^1.8.0",
    "mailparser": "^3.9.4",
    "multer": "^1.4.5-lts.1",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^7.14.1",
    "xlsx": "^0.18.5"
  }
}
```

- [ ] **Étape 2 : Installer**

```bash
npm install
```

Résultat attendu : `added X packages` sans erreur.

- [ ] **Étape 3 : Vérifier que les modules sont disponibles**

```bash
node -e "require('multer'); require('xlsx'); console.log('OK')"
```

Résultat attendu : `OK`

- [ ] **Étape 4 : Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add multer + xlsx dependencies"
```

---

## Task 2 — Logique de nettoyage Emelia (TDD)

**Fichiers :** Create `utils/emeliaCleaner.js`, Create `utils/emeliaCleaner.test.js`

- [ ] **Étape 1 : Écrire le fichier de tests**

Créer `utils/emeliaCleaner.test.js` :

```javascript
'use strict';
const { cleanEmeliaRows } = require('./emeliaCleaner');

const baseRow = {
  firstName: 'Anne-Laure', lastName: 'Avril',
  linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABR',
  title: 'Responsable Achats', company: 'Alstef',
  industry: 'Fabrication', location: 'Rennes',
  summary: 'Expert achats', description: 'En charge de',
  companyDescription: 'Fabricant de robots',
};

describe('cleanEmeliaRows', () => {
  it('accepte une ligne valide complète', () => {
    const { accepted, rejections } = cleanEmeliaRows([baseRow], new Set());
    expect(accepted).toHaveLength(1);
    expect(rejections).toHaveLength(0);
    expect(accepted[0].first_name).toBe('Anne-Laure');
    expect(accepted[0].linkedin_url).toBe('https://www.linkedin.com/in/ACwAABR');
  });

  it('rejette si firstName vide', () => {
    const { accepted, rejections } = cleanEmeliaRows([{ ...baseRow, firstName: '' }], new Set());
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Prénom manquant');
    expect(rejections[0].name).toBe('(inconnu)');
  });

  it('rejette si linkedinUrlProfile absent', () => {
    const { accepted, rejections } = cleanEmeliaRows([{ ...baseRow, linkedinUrlProfile: '' }], new Set());
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('URL LinkedIn manquante');
  });

  it('rejette si title ET company tous les deux vides', () => {
    const { accepted, rejections } = cleanEmeliaRows([{ ...baseRow, title: '', company: '' }], new Set());
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Titre de poste et entreprise manquants');
  });

  it('accepte si title vide mais company présente', () => {
    const { accepted } = cleanEmeliaRows([{ ...baseRow, title: '' }], new Set());
    expect(accepted).toHaveLength(1);
    expect(accepted[0].job_title).toBeNull();
    expect(accepted[0].company).toBe('Alstef');
  });

  it('accepte si company vide mais title présent', () => {
    const { accepted } = cleanEmeliaRows([{ ...baseRow, company: '' }], new Set());
    expect(accepted).toHaveLength(1);
    expect(accepted[0].company).toBeNull();
    expect(accepted[0].job_title).toBe('Responsable Achats');
  });

  it('rejette un doublon (url déjà dans existingUrls)', () => {
    const existing = new Set(['https://www.linkedin.com/in/ACwAABR']);
    const { accepted, rejections } = cleanEmeliaRows([baseRow], existing);
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toContain('Doublon');
  });

  it('déduplique au sein du même import (intra-import)', () => {
    const rows = [baseRow, { ...baseRow }];
    const { accepted, rejections } = cleanEmeliaRows(rows, new Set());
    expect(accepted).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toContain('Doublon');
  });

  it('concatène summary et description avec séparateur', () => {
    const { accepted } = cleanEmeliaRows([baseRow], new Set());
    expect(accepted[0].linkedin_summary).toBe('Expert achats\n\n---\n\nEn charge de');
  });

  it('utilise uniquement summary si description vide', () => {
    const { accepted } = cleanEmeliaRows([{ ...baseRow, description: '' }], new Set());
    expect(accepted[0].linkedin_summary).toBe('Expert achats');
  });

  it('met linkedin_summary à null si summary ET description vides', () => {
    const { accepted } = cleanEmeliaRows([{ ...baseRow, summary: '', description: '' }], new Set());
    expect(accepted[0].linkedin_summary).toBeNull();
  });

  it('mappe company_description', () => {
    const { accepted } = cleanEmeliaRows([baseRow], new Set());
    expect(accepted[0].company_description).toBe('Fabricant de robots');
  });

  it('numéro de ligne commence à 2 (ligne 1 = header)', () => {
    const { rejections } = cleanEmeliaRows([{ ...baseRow, firstName: '' }], new Set());
    expect(rejections[0].row).toBe(2);
  });
});
```

- [ ] **Étape 2 : Lancer les tests — vérifier qu'ils échouent (module introuvable)**

```bash
npm test -- utils/emeliaCleaner.test.js
```

Résultat attendu : `Cannot find module './emeliaCleaner'`

- [ ] **Étape 3 : Implémenter `utils/emeliaCleaner.js`**

Créer `utils/emeliaCleaner.js` :

```javascript
'use strict';

/**
 * @param {object[]} rows - Parsed rows from Emelia xlsx (sheet_to_json output)
 * @param {Set<string>} existingLinkedinUrls - LinkedIn URLs already in DB for this account
 * @returns {{ accepted: object[], rejections: object[] }}
 */
function cleanEmeliaRows(rows, existingLinkedinUrls) {
  const seenUrls = new Set(existingLinkedinUrls);
  const accepted = [];
  const rejections = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    const firstName = String(row.firstName || '').trim();
    const lastName = String(row.lastName || '').trim();
    const name = [firstName, lastName].filter(Boolean).join(' ') || '(inconnu)';
    const linkedinUrl = String(row.linkedinUrlProfile || '').trim();
    const title = String(row.title || '').trim();
    const company = String(row.company || '').trim();

    if (!firstName) {
      rejections.push({ row: rowNum, name: '(inconnu)', reason: 'Prénom manquant' });
      return;
    }
    if (!linkedinUrl) {
      rejections.push({ row: rowNum, name, reason: 'URL LinkedIn manquante' });
      return;
    }
    if (!title && !company) {
      rejections.push({ row: rowNum, name, reason: 'Titre de poste et entreprise manquants' });
      return;
    }
    if (seenUrls.has(linkedinUrl)) {
      rejections.push({ row: rowNum, name, reason: 'Doublon (déjà présent dans un compte actif)' });
      return;
    }

    seenUrls.add(linkedinUrl);

    const summaryParts = [row.summary, row.description]
      .map(s => String(s || '').trim())
      .filter(Boolean);
    const linkedinSummary = summaryParts.length > 1
      ? summaryParts.join('\n\n---\n\n')
      : summaryParts[0] || null;

    accepted.push({
      first_name: firstName,
      last_name: lastName || null,
      linkedin_url: linkedinUrl,
      job_title: title || null,
      company: company || null,
      sector: String(row.industry || '').trim() || null,
      geography: String(row.location || '').trim() || null,
      linkedin_summary: linkedinSummary,
      company_description: String(row.companyDescription || '').trim() || null,
    });
  });

  return { accepted, rejections };
}

module.exports = { cleanEmeliaRows };
```

- [ ] **Étape 4 : Relancer les tests — tous doivent passer**

```bash
npm test -- utils/emeliaCleaner.test.js
```

Résultat attendu : `Tests: 13 passed, 13 total`

- [ ] **Étape 5 : Commit**

```bash
git add utils/emeliaCleaner.js utils/emeliaCleaner.test.js
git commit -m "feat: add Emelia row cleaning logic with tests"
```

---

## Task 3 — Migration DB

**Fichiers :** Supabase (migration SQL directe)

- [ ] **Étape 1 : Ajouter les deux nouvelles colonnes**

Dans l'éditeur SQL Supabase (ou via psql), exécuter :

```sql
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS linkedin_summary TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS company_description TEXT;
```

Résultat attendu : `ALTER TABLE` sans erreur.

- [ ] **Étape 2 : Migrer les statuts Task 1 obsolètes**

```sql
UPDATE prospects
SET status = 'Profil à valider'
WHERE status IN ('scrapping_pending', 'Profil incomplet');
```

Résultat attendu : `UPDATE X` (note le nombre de lignes affectées pour vérification).

- [ ] **Étape 3 : Vérifier**

```sql
SELECT status, COUNT(*) FROM prospects GROUP BY status ORDER BY COUNT(*) DESC;
```

Résultat attendu : aucune ligne avec status `scrapping_pending` ou `Profil incomplet`.

---

## Task 4 — Endpoint `POST /api/prospector/import-emelia`

**Fichiers :** Modify `server.js:1-12` (requires), `server.js:4090` (après l'endpoint import existant)

- [ ] **Étape 1 : Ajouter les requires multer, xlsx et emeliaCleaner en haut de server.js**

Après la ligne `const { buildSalesNavUrl } = require('./utils/buildSalesNavUrl');` (ligne 11), insérer :

```javascript
const multer = require('multer');
const XLSX = require('xlsx');
const { cleanEmeliaRows } = require('./utils/emeliaCleaner');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
```

- [ ] **Étape 2 : Ajouter l'endpoint après la ligne 4090 (après la fermeture de `/api/prospector/import`)**

Insérer après la ligne `});` qui ferme l'endpoint `/api/prospector/import` (~ligne 4090) :

```javascript
// POST /api/prospector/import-emelia — Import depuis fichier xlsx Emelia
// dry_run=true : analyse uniquement, pas d'insertion
app.post('/api/prospector/import-emelia', accountContext, upload.single('file'), async (req, res) => {
  try {
    const campaign_id = req.body.campaign_id;
    const isDryRun = req.body.dry_run === 'true' || req.body.dry_run === true;

    if (!campaign_id) return res.status(400).json({ error: 'campaign_id requis' });
    if (!req.file) return res.status(400).json({ error: 'Fichier requis' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('prospects')
      .select('linkedin_url')
      .eq('account_id', req.accountId)
      .not('status', 'in', '("Non pertinent","Perdu")');
    if (existingErr) throw existingErr;

    const existingUrls = new Set((existing || []).map(p => p.linkedin_url).filter(Boolean));
    const { accepted, rejections } = cleanEmeliaRows(rows, existingUrls);

    if (isDryRun) {
      return res.json({ imported: accepted.length, rejected: rejections.length, rejections });
    }

    let insertedCount = 0;
    if (accepted.length > 0) {
      const toInsert = accepted.map(p => ({
        ...p,
        account_id: req.accountId,
        campaign_id,
        status: 'Profil à valider',
      }));
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('prospects')
        .insert(toInsert)
        .select('id');
      if (insertErr) throw insertErr;
      insertedCount = inserted.length;

      await supabaseAdmin.from('imports').insert({
        account_id: req.accountId,
        campaign_id,
        filename: req.file.originalname,
        total_rows: rows.length,
        imported: insertedCount,
        duplicates: rejections.filter(r => r.reason.includes('Doublon')).length,
        errors: rejections.filter(r => !r.reason.includes('Doublon')).length,
      });
    }

    res.json({ imported: insertedCount, rejected: rejections.length, rejections });
  } catch (err) {
    console.error('Erreur /api/prospector/import-emelia:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Étape 3 : Démarrer le serveur et vérifier qu'il démarre sans erreur**

```bash
npm start
```

Résultat attendu : `Server running on port 3000` sans `Error` ni `Cannot find module`.

- [ ] **Étape 4 : Tester l'endpoint dry_run avec curl**

Depuis un autre terminal (le serveur doit tourner). Remplacer `<TOKEN>` par un token JWT valide et `<CAMPAIGN_ID>` par un UUID de campagne existante :

```bash
curl -X POST http://localhost:3000/api/prospector/import-emelia \
  -H "Authorization: Bearer <TOKEN>" \
  -F "file=@\"Industriels - Bretagne.xlsx\"" \
  -F "campaign_id=<CAMPAIGN_ID>" \
  -F "dry_run=true"
```

Résultat attendu : JSON avec `imported`, `rejected`, `rejections` — pas d'insertion en DB.

- [ ] **Étape 5 : Commit**

```bash
git add server.js
git commit -m "feat: add POST /api/prospector/import-emelia endpoint"
```

---

## Task 5 — Supprimer l'infrastructure Task 1 du backend

**Fichiers :** Modify `server.js`

- [ ] **Étape 1 : Supprimer l'endpoint `POST /api/prospector/sync`**

Rechercher le commentaire `// POST /api/prospector/sync` (~ligne 4216) et supprimer le bloc entier jusqu'à la prochaine accolade fermante `});` suivie d'une ligne blanche. Ce bloc fait environ 170 lignes (4216–4383).

- [ ] **Étape 2 : Supprimer l'endpoint `GET /api/prospector/prospects/incomplete`**

Rechercher `// GET /api/prospector/prospects/incomplete` (~ligne 4385) et supprimer le bloc jusqu'au `});` correspondant (~25 lignes).

- [ ] **Étape 3 : Supprimer l'endpoint `PATCH /api/prospector/prospects/:id/enrich`**

Rechercher `// PATCH /api/prospector/prospects/:id/enrich` (~ligne 4411) et supprimer le bloc jusqu'au `});` correspondant (~30 lignes).

- [ ] **Étape 4 : Supprimer les constantes scraping Task 1**

Rechercher et supprimer les lignes définissant :
- `MAX_ENRICHMENTS_PER_CAMPAIGN`
- `BREAK_EVERY_N_VISITS`
- `BREAK_DURATION_MS`

(Ces constantes n'existent que si elles sont dans server.js — vérifier avec `grep -n "MAX_ENRICHMENTS\|BREAK_EVERY\|BREAK_DURATION" server.js`)

- [ ] **Étape 5 : Vérifier que le serveur démarre sans erreur**

```bash
npm start
```

Résultat attendu : démarrage propre. Vérifier aussi que `GET /api/prospector/import` répond encore (endpoint conservé) :

```bash
curl -X GET http://localhost:3000/api/prospector/campaigns \
  -H "Authorization: Bearer <TOKEN>"
```

Résultat attendu : JSON avec la liste des campagnes.

- [ ] **Étape 6 : Commit**

```bash
git add server.js
git commit -m "feat: remove Task 1 scraping infrastructure (sync, incomplete, enrich endpoints)"
```

---

## Task 6 — Nettoyer les références Task 1 dans le frontend

**Fichiers :** Modify `public/js/prospector-ui.js`, Modify `public/js/prospector.js`

- [ ] **Étape 1 : Supprimer `scrapping_pending` et `Profil incomplet` de `prospector-ui.js`**

Dans `public/js/prospector-ui.js`, supprimer les lignes suivantes dans `STATUS_CLASSES`, `STATUS_COLORS`, et `STATUS_ICONS` :

Dans `STATUS_CLASSES` (autour de la ligne 10) — supprimer :
```javascript
'Profil incomplet': 'badge-profil-incomplet',
```

Dans `STATUS_COLORS` (si présent) — supprimer toute entrée `'Profil incomplet'` et `'scrapping_pending'`.

Dans `STATUS_ICONS` (si présent) — idem.

- [ ] **Étape 2 : Nettoyer le dashboard dans `prospector.js`**

Dans `prospector.js`, à la ligne 152, modifier la destructuration du `Promise.all` :

Avant :
```javascript
const [reminders, pipeline, activity, pendingMessages, profilsAValider, profilsIncomplets, chartData] = await Promise.all([
  DB.getReminders({ status: 'pending' }),
  DB.getProspectCountsByStatus(),
  DB.getRecentInteractions(10),
  DB.getProspects({ status: 'Message à valider' }),
  DB.getProspects({ status: 'Profil à valider' }),
  APIClient.get('/api/prospector/prospects/incomplete?limit=100').then(r => r.json()).catch(() => []),
  APIClient.get('/api/prospector/daily-activity').then(r => r.json()).catch(() => ({ dates: [], series: {} })),
]);
```

Après :
```javascript
const [reminders, pipeline, activity, pendingMessages, profilsAValider, chartData] = await Promise.all([
  DB.getReminders({ status: 'pending' }),
  DB.getProspectCountsByStatus(),
  DB.getRecentInteractions(10),
  DB.getProspects({ status: 'Message à valider' }),
  DB.getProspects({ status: 'Profil à valider' }),
  APIClient.get('/api/prospector/daily-activity').then(r => r.json()).catch(() => ({ dates: [], series: {} })),
]);
```

- [ ] **Étape 3 : Supprimer le bloc `profilsIncomplets` du dashboard (~lignes 201-209)**

Rechercher `// Profils incomplets à enrichir` et supprimer le bloc `if (profilsIncomplets.length > 0) { ... }` entier (environ 8 lignes).

- [ ] **Étape 4 : Vérifier dans le navigateur**

Ouvrir `http://localhost:3000/prospector#dashboard` — le dashboard doit charger sans erreur console.

- [ ] **Étape 5 : Commit**

```bash
git add public/js/prospector-ui.js public/js/prospector.js
git commit -m "feat: remove Task 1 status references from frontend"
```

---

## Task 7 — Wizard Emelia dans `prospector.js`

**Fichiers :** Modify `public/js/prospector.js`

- [ ] **Étape 1 : Ajouter la route `#emelia-import` au switch du routeur**

Dans le `switch (page)` (~ligne 20), ajouter après la ligne `case '#imports':` :

```javascript
case '#emelia-import': renderEmeliaImport(app, params.get('campaign_id')); break;
```

- [ ] **Étape 2 : Mettre à jour `renderImports` pour appeler `renderEmeliaImport`**

Remplacer la fonction `renderImports` (~ligne 2916) :

Avant :
```javascript
function renderImports(container) {
  _importState = { step: 1, rawData: null, headers: [], mapping: {}, parsed: [], duplicates: [], file: null };
  renderImportStep(container);
}
```

Après :
```javascript
function renderImports(container) {
  renderEmeliaImport(container, null);
}
```

- [ ] **Étape 3 : Ajouter la section EMELIA IMPORT après la section IMPORTS existante**

Localiser la fin de la section IMPORTS dans `prospector.js` (après les fonctions `renderImportUpload`, `renderImportMapping`, `renderImportPreview`, `renderImportDone`). Ajouter après le dernier `}` de cette section :

```javascript
// ============================================================
// EMELIA IMPORT
// ============================================================
let _emeliaPendingFile = null;
let _emeliaDryRunResult = null;
let _emeliaCampaignId = null;
let _emeliaCampaignsList = [];

async function renderEmeliaImport(container, preselectedCampaignId) {
  _emeliaPendingFile = null;
  _emeliaDryRunResult = null;
  _emeliaCampaignId = preselectedCampaignId || null;

  if (!preselectedCampaignId) {
    try {
      const r = await APIClient.get('/api/prospector/campaigns');
      const data = await r.json();
      _emeliaCampaignsList = (data.campaigns || []).filter(c => c.status !== 'Terminée' && c.status !== 'Archivée');
    } catch (e) {
      _emeliaCampaignsList = [];
    }
  }

  _renderEmeliaStep1(container);
}

function _renderEmeliaStep1(container) {
  const campaignSelector = !_emeliaCampaignId ? `
    <div class="form-group" style="margin-bottom:1.25rem">
      <label class="form-label" style="display:block;margin-bottom:4px;font-weight:500">Campagne</label>
      <select id="emeliaCampaignSel" class="form-control" style="width:100%">
        <option value="">— Sélectionner une campagne —</option>
        ${_emeliaCampaignsList.map(c => `<option value="${c.id}">${UI.esc(c.name)}</option>`).join('')}
      </select>
    </div>
  ` : '';

  container.innerHTML = `
    <div class="page-header"><h1 class="page-title">Import Emelia</h1></div>
    <div class="card" style="max-width:600px;margin:0 auto">
      <div class="card-body" style="padding:2rem">
        <p style="color:#6b7280;margin-bottom:1.5rem">Importez un fichier <strong>.xlsx</strong> exporté depuis Emelia. Les profils seront ajoutés en statut <strong>Profil à valider</strong>.</p>
        ${campaignSelector}
        <div class="form-group" style="margin-bottom:1.25rem">
          <label class="form-label" style="display:block;margin-bottom:4px;font-weight:500">Fichier Emelia (.xlsx)</label>
          <div id="emeliaDrop" style="border:2px dashed #d1d5db;border-radius:8px;padding:2rem;text-align:center;cursor:pointer;transition:border-color 0.2s">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5" style="margin:0 auto 0.75rem;display:block"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <p id="emeliaDragLabel" style="margin:0;color:#6b7280">Glisser un fichier .xlsx ici ou <span style="color:#2563eb;text-decoration:underline">parcourir</span></p>
            <input type="file" id="emeliFileInput" accept=".xlsx" style="display:none">
          </div>
        </div>
        <button id="emeliAnalyzeBtn" class="btn btn-primary" style="width:100%" disabled onclick="App.emeliAnalyze()">Analyser le fichier</button>
      </div>
    </div>
  `;

  const drop = document.getElementById('emeliaDrop');
  const input = document.getElementById('emeliFileInput');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#2563eb'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = '#d1d5db'; });
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.style.borderColor = '#d1d5db';
    if (e.dataTransfer.files[0]) _emeliSetFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files[0]) _emeliSetFile(input.files[0]); });
}

function _emeliSetFile(file) {
  if (!file.name.endsWith('.xlsx')) {
    UI.toast('Format invalide — seuls les fichiers .xlsx sont acceptés', 'error');
    return;
  }
  _emeliaPendingFile = file;
  document.getElementById('emeliaDragLabel').textContent = `📄 ${file.name} (${(file.size / 1024).toFixed(1)} Ko)`;
  document.getElementById('emeliAnalyzeBtn').disabled = false;
}

async function emeliAnalyze() {
  const campaignId = _emeliaCampaignId || (document.getElementById('emeliaCampaignSel') || {}).value;
  if (!campaignId) { UI.toast('Sélectionnez une campagne', 'error'); return; }
  if (!_emeliaPendingFile) { UI.toast('Sélectionnez un fichier', 'error'); return; }
  _emeliaCampaignId = campaignId;

  const btn = document.getElementById('emeliAnalyzeBtn');
  btn.textContent = 'Analyse en cours…';
  btn.disabled = true;

  try {
    const fd = new FormData();
    fd.append('file', _emeliaPendingFile);
    fd.append('campaign_id', campaignId);
    fd.append('dry_run', 'true');

    const token = localStorage.getItem('auth_token');
    const headers = { 'Authorization': `Bearer ${token}` };
    const switchId = localStorage.getItem('activeAccountId');
    if (switchId) headers['X-Switch-Account'] = switchId;

    const res = await fetch('/api/prospector/import-emelia', { method: 'POST', headers, body: fd });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erreur serveur'); }
    _emeliaDryRunResult = await res.json();
    _renderEmeliaStep2(document.getElementById('app'));
  } catch (err) {
    UI.toast('Erreur : ' + err.message, 'error');
    btn.textContent = 'Analyser le fichier';
    btn.disabled = false;
  }
}

function _renderEmeliaStep2(container) {
  const r = _emeliaDryRunResult;
  const rejHtml = r.rejections.length === 0 ? '' : `
    <div style="margin-top:1rem;border:1px solid #fecaca;border-radius:6px;padding:0.75rem;background:#fef2f2">
      <p style="font-weight:600;margin:0 0 0.5rem;color:#dc2626">❌ ${r.rejected} profil(s) rejeté(s)</p>
      <ul style="list-style:none;padding:0;margin:0;font-size:0.85rem;color:#6b7280">
        ${r.rejections.map(rej => `<li style="padding:3px 0">Ligne ${rej.row} — <strong>${UI.esc(rej.name)}</strong> — ${UI.esc(rej.reason)}</li>`).join('')}
      </ul>
    </div>`;

  container.innerHTML = `
    <div class="page-header"><h1 class="page-title">Import Emelia — Aperçu</h1></div>
    <div class="card" style="max-width:600px;margin:0 auto">
      <div class="card-body" style="padding:2rem">
        <div style="padding:1rem;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;margin-bottom:0.75rem">
          <p style="margin:0;color:#15803d;font-weight:600">✅ ${r.imported} prospect(s) prêt(s) à importer</p>
        </div>
        ${rejHtml}
        <div style="display:flex;gap:0.75rem;margin-top:1.5rem">
          <button class="btn btn-ghost" onclick="App.emeliReset()">Annuler</button>
          <button class="btn btn-primary" style="flex:1" onclick="App.emeliConfirm()" ${r.imported === 0 ? 'disabled' : ''}>
            Confirmer l'import (${r.imported} prospects)
          </button>
        </div>
      </div>
    </div>`;
}

async function emeliConfirm() {
  const btn = document.querySelector('[onclick="App.emeliConfirm()"]');
  if (btn) { btn.textContent = 'Import en cours…'; btn.disabled = true; }

  try {
    const fd = new FormData();
    fd.append('file', _emeliaPendingFile);
    fd.append('campaign_id', _emeliaCampaignId);
    fd.append('dry_run', 'false');

    const token = localStorage.getItem('auth_token');
    const headers = { 'Authorization': `Bearer ${token}` };
    const switchId = localStorage.getItem('activeAccountId');
    if (switchId) headers['X-Switch-Account'] = switchId;

    const res = await fetch('/api/prospector/import-emelia', { method: 'POST', headers, body: fd });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Erreur serveur'); }
    const result = await res.json();
    _renderEmeliaStep3(document.getElementById('app'), result);
  } catch (err) {
    UI.toast('Erreur : ' + err.message, 'error');
    if (btn) { btn.textContent = 'Confirmer l\'import'; btn.disabled = false; }
  }
}

function _renderEmeliaStep3(container, result) {
  container.innerHTML = `
    <div class="page-header"><h1 class="page-title">Import terminé</h1></div>
    <div class="card" style="max-width:600px;margin:0 auto">
      <div class="card-body" style="padding:2rem;text-align:center">
        <div style="font-size:3rem;margin-bottom:1rem">✅</div>
        <h2 style="margin-bottom:0.5rem">${result.imported} prospect(s) importé(s)</h2>
        <p style="color:#6b7280;margin-bottom:2rem">Statut initial : <strong>Profil à valider</strong></p>
        <button class="btn btn-primary" onclick="location.hash='#prospects?status=${encodeURIComponent('Profil à valider')}'">
          Valider les profils →
        </button>
      </div>
    </div>`;
}

function emeliReset() {
  renderEmeliaImport(document.getElementById('app'), _emeliaCampaignId);
}
```

- [ ] **Étape 4 : Exposer les fonctions sur l'objet `App`**

Rechercher l'objet `App` dans `prospector.js` (c'est un objet ou un `return { ... }` exposant les fonctions publiques). Ajouter les nouvelles fonctions :

```javascript
emeliAnalyze,
emeliConfirm,
emeliReset,
```

- [ ] **Étape 5 : Tester dans le navigateur**

Ouvrir `http://localhost:3000/prospector#imports` — le wizard Emelia doit s'afficher avec upload + dropdown campagnes.

- [ ] **Étape 6 : Commit**

```bash
git add public/js/prospector.js
git commit -m "feat: add Emelia import wizard to prospector UI"
```

---

## Task 8 — Bouton d'import dans la page campagne

**Fichiers :** Modify `public/js/prospector.js`

- [ ] **Étape 1 : Ajouter le bouton "Importer Emelia" dans `renderCampaignDetail`**

Dans la fonction `renderCampaignDetail` (~ligne 1759), dans le div `class="flex gap-2 items-center"`, ajouter le bouton avant le bouton Archiver :

Avant :
```javascript
<div class="flex gap-2 items-center">
  <button class="btn btn-outline" onclick="window.location.href='/campaigns/edit/${id}'" style="display:flex;align-items:center;gap:6px">
    ${svgEdit} Modifier
  </button>
  ${campaign.status !== 'Archivée'
    ? `<button class="btn btn-ghost" onclick="App.archiveCampaign('${id}', true)" style="display:flex;align-items:center;gap:6px">${svgArch} Archiver</button>`
    : `<button class="btn btn-outline" onclick="App.archiveCampaign('${id}', false)">Désarchiver</button>`
  }
</div>
```

Après :
```javascript
<div class="flex gap-2 items-center">
  <button class="btn btn-outline" onclick="window.location.href='/campaigns/edit/${id}'" style="display:flex;align-items:center;gap:6px">
    ${svgEdit} Modifier
  </button>
  ${campaign.status !== 'Archivée' && campaign.status !== 'Terminée' ? `
    <button class="btn btn-outline" onclick="location.hash='#emelia-import?campaign_id=${id}'" style="display:flex;align-items:center;gap:6px">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Importer Emelia
    </button>
  ` : ''}
  ${campaign.status !== 'Archivée'
    ? `<button class="btn btn-ghost" onclick="App.archiveCampaign('${id}', true)" style="display:flex;align-items:center;gap:6px">${svgArch} Archiver</button>`
    : `<button class="btn btn-outline" onclick="App.archiveCampaign('${id}', false)">Désarchiver</button>`
  }
</div>
```

- [ ] **Étape 2 : Tester le bouton dans le navigateur**

Ouvrir une campagne active (`#campaign-detail?id=xxx`). Le bouton "Importer Emelia" doit apparaître. Cliquer dessus doit naviguer vers le wizard avec la campagne pré-sélectionnée.

- [ ] **Étape 3 : Commit**

```bash
git add public/js/prospector.js
git commit -m "feat: add Importer Emelia button on campaign detail page"
```

---

## Task 9 — Fichiers skill Dispatch

**Fichiers :** Rename `skill_prospector_V10.md`, Create `skill_prospector_V11.md`

- [ ] **Étape 1 : Archiver le skill V10**

```bash
cp skill_prospector_V10.md skill_prospector_V10_backup.md
```

- [ ] **Étape 2 : Créer `skill_prospector_V11.md`**

Copier le contenu de `skill_prospector_V10.md` dans `skill_prospector_V11.md`, puis supprimer :
- Tout le bloc "TASK 1" (tout ce qui décrit le scraping Sales Navigator, Phase 1, Phase 2, les quotas de scraping, les endpoints `/api/prospector/sync`, `/api/prospector/prospects/incomplete`, `/api/prospector/prospects/:id/enrich`)
- Toutes les mentions de `scrapping_pending`, `Profil incomplet`, `MAX_ENRICHMENTS_PER_CAMPAIGN`, `BREAK_EVERY_N_VISITS`
- Les instructions de lancement de Task 1

Garder uniquement : Task 2 (séquence LinkedIn : enrollment, invitations, messages, suivi), les endpoints séquence/locks, les statuts Task 2, les quotas d'invitation/message.

- [ ] **Étape 3 : Vérifier qu'aucune mention de Task 1 ne subsiste**

```bash
grep -i "task 1\|scrapping_pending\|Profil incomplet\|/api/prospector/sync\|incomplete\|enrich\|phase 1\|phase 2\|sales.nav.*scrap" skill_prospector_V11.md
```

Résultat attendu : aucune ligne retournée.

- [ ] **Étape 4 : Commit**

```bash
git add skill_prospector_V10_backup.md skill_prospector_V11.md
git commit -m "docs: archive V10 skill, create V11 without Task 1"
```

---

## Task 10 — Test d'intégration end-to-end

- [ ] **Étape 1 : Test complet du workflow**

1. Ouvrir une campagne active dans le navigateur
2. Cliquer "Importer Emelia"
3. Sélectionner `Industriels - Bretagne.xlsx` (le fichier de test disponible à la racine du projet)
4. Cliquer "Analyser le fichier"
5. Vérifier le rapport : X prospects prêts, rejets éventuels avec raisons
6. Cliquer "Confirmer l'import"
7. Vérifier la redirection vers "Profil à valider"
8. Vérifier que les prospects apparaissent dans la vue avec les bons champs

- [ ] **Étape 2 : Vérifier les nouvelles colonnes dans Supabase**

```sql
SELECT first_name, last_name, linkedin_url, linkedin_summary, company_description
FROM prospects
WHERE status = 'Profil à valider'
ORDER BY created_at DESC
LIMIT 5;
```

Résultat attendu : `linkedin_summary` et `company_description` renseignés pour les prospects avec les données Emelia correspondantes.

- [ ] **Étape 3 : Vérifier la déduplication**

Relancer l'import du même fichier → le rapport doit indiquer tous les prospects en doublon, aucune insertion.

- [ ] **Étape 4 : Commit final**

```bash
git add .
git commit -m "feat: Emelia import workflow — feature complete"
```
