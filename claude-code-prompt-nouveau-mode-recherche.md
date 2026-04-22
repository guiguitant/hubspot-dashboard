# Releaf Prospector — Prompt Claude Code VSC
## Feature : Nouveau mode de recherche campagne (Sales Navigator Builder)

---

## 📋 CHANGELOG — Corrections audit Cowork (16/04/2026)

> Ce bloc identifie les corrections apportées lors de l'audit final (session Cowork).
> Peut être supprimé une fois les modifications intégrées et testées dans VSC.

| Section | Type | Description |
|---|---|---|
| §5 `buildSalesNavUrl` | 🧹 Suppression | `deduplicateSectorIds()` supprimé — les doublons sont éliminés à la source (seed nettoyé §6.1) |
| §5 `buildSalesNavUrl` TS | 🐛 Bug critique | **INDUSTRY : `text:` OBLIGATOIRE** — ajout `text: s.label` dans le mapping INDUSTRY. Sans ça, filtre silencieusement ignoré (25M+ résultats) |
| §5 `buildSalesNavUrl` CJS | 🐛 Bug critique | Même fix backend — `text: s.label` ajouté pour INDUSTRY |
| §6.1 SECTORS_SEED | 🐛 Bug données | `id:58` (Matériaux de construction) → `id:3197` (vérifié via UI Sales Nav le 16/04/2026) |
| §6.1 SECTORS_SEED | 📝 Doc majeure | Ajout tableau IDs vérifiés en live + avertissement IDs Sales Nav ≠ API v2 |
| §7.4 `CampaignFormErrors` | 🐛 Bug TypeScript | Nouveau type séparé pour éviter référence circulaire `keyof CampaignFormState` |
| §8 MIGRATION 5 | 🐛 Bug données | Industriels Bretagne : `id:132` (E-Learning!) → `id:3198` (Industrie automobile, vérifié ✅) |
| §9 Test GEO+INDUSTRY | 🐛 Bug test | `id:47` → `id:48` + ajout assertion `text:Construction` obligatoire |
| §9 Test INDUSTRY text: | 🆕 Nouveau test | Test dédié : INDUSTRY doit inclure `text:` (sinon filtre ignoré) — avec accents encodés |
| §9 Test SENIORITY | 🐛 Bug test | `expect(id:6)` → `expect(id:220)` + ajout assertion `text:Directeur` |
| §11 Points de vigilance | 🆕 Nouveau point 5 | INDUSTRY requiert `id:` ET `text:` — format confirmé en live + renumérotation 6→7, 7→8, 8→9 |
| §11 Point 4 | 🐛 Stale comment | "(1-10)" → "(100-320)" (IDs confirmés en live le 16/04/2026) |
| §3 `CampaignCriteria` | 🔄 Refacto | `sectorIds[]` : ajout champ `parent_category: string` |
| §6.1 `linkedin_sectors` | 🔄 Refacto majeure | Nouveau schéma DB avec `parent_category` + `verified` + UNIQUE `label_fr` (supprime doublons) |
| §6.1 SECTORS_SEED | 🔄 Refacto | Seed restructuré avec `parent_category`, `verified`, 15 catégories parent |
| §6.1 | 🆕 Nouveau | Constante `SECTOR_PARENT_CATEGORIES` (15 catégories EN→FR) + type `SectorEntry` |
| §7 `<SectorSelector>` | 🔄 Refacto majeure | Réécriture complète : sélecteur à 2 niveaux (catégorie parent → secteurs), typeahead ≥2 chars, pills catégories, "Tout inclure" par catégorie, tags include/exclude |
| §6.1 SECTORS_SEED | 🐛 Bug données | `id:132` (Industrie automobile) → `id:3198` (vérifié via tâche verify-salesnav-sector-ids) |
| §6.1 SECTORS_SEED | 🧹 Nettoyage | 10 secteurs fantômes supprimés (IDs legacy 3,8,12,16,24,35,69,84,110,130,1187 — absents de la BDD Excel source) |
| §6.1 SECTORS_SEED | 🔄 Refacto majeure | **Seed complet remplacé** : 136 secteurs (tous vérifiés ✅), 15 catégories parent (EN+FR), source de vérité = Excel BDD |
| §6.1 | 🆕 Nouveau | Instruction « source de vérité = Excel » + procédure de mise à jour des secteurs en 5 étapes |
| §4 Request body | 🐛 Bug données | `id:47` (Comptabilité) → `id:48` (Construction) + ajout `parent_category` dans l'exemple sectorIds |
| §8 Migration 5 | 🐛 Bug données | `id:53` → `id:3198` pour "Industrie automobile" (vérifié ✅) + ajout `parent_category` + typos labels corrigées |
| §9 Tests | 🐛 Cohérence | Ajout `parent_category` manquant dans les 2 tests sectorIds |

---

## 1. Contexte & Objectif

**Releaf Prospector** est un CRM B2B de prospection LinkedIn. Il existe déjà un backend en production à `https://hubspot-dashboard-1c7z.onrender.com`.

Tu dois implémenter **une nouvelle feature de création de campagne** avec un formulaire de filtres Sales Navigator avancé (mode Prospect uniquement), qui génère automatiquement une URL Sales Navigator valide stockée avec la campagne.

Cette URL sera ensuite utilisée par l'assistant IA (Claude en mode Cowork) pour automatiser le scraping de prospects sur LinkedIn Sales Navigator.

---

## 2. Stack technique

- **Frontend** : React 18 + Vite + TypeScript
- **Backend** : Node.js / Express (serveur existant à étendre)
- **Base de données** : Supabase (PostgreSQL)
- **Auth** : Token Bearer stocké en localStorage (`auth_token`)
- **Styles** : CSS custom (variables CSS, pas de Tailwind)
- **Icônes** : Lucide React
- **Data fetching** : React Query

**Couleurs :**
```css
:root {
  --primary: #2D6A4F;
  --primary-light: #B7E4C7;
  --primary-foreground: #ffffff;
  --background: #ffffff;
  --foreground: #1a1a1a;
  --muted: #f3f4f6;
  --muted-foreground: #6b7280;
  --destructive: #ef4444;
  --warning: #f59e0b;
  --success: #22c55e;
  --border: #e5e7eb;
  --radius: 8px;
}
```

---

## 3. Correction critique : Modèles de données

### ⚠️ Le modèle Campaign simplifié du prototype Lovable est INCORRECT

Le vrai backend utilise des statuts français et une structure `criteria` JSON.

### Modèle Campaign réel

```typescript
type CampaignStatus = 'À lancer' | 'En cours' | 'En suivi' | 'Terminée' | 'Archivée';

interface CampaignCriteria {
  jobTitles:   { value: string; type: 'include' | 'exclude' }[];
  seniorities: { code: SeniorityCode; type: 'include' | 'exclude' }[];
  geoIds:      { id: string; text: string; type: 'include' | 'exclude' }[];
  sectorIds:   { id: number; label: string; parent_category: string; type: 'include' | 'exclude' }[];
  headcounts:  HeadcountCode[];   // ex: ['C','D','E'] = 11-200 salariés
  keywords?:   string[];          // Mots-clés positifs uniquement (voir §5.3)
}

interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  priority: number;            // 1 = plus prioritaire, entre 1 et 5
  criteria: CampaignCriteria;  // JSONB — stocke tous les filtres SalesNav
  sales_nav_url?: string;      // URL de RECHERCHE générée automatiquement
  message_template?: string;   // Instructions Claude pour la séquence
  target_count?: number;       // Entier positif, optionnel
  created_at: string;
  // ⚠️ sector_label et geography_label ne sont PAS des colonnes DB.
  // Ils sont calculés à la volée depuis criteria au moment de la query :
  //   sector_label    = criteria.sectorIds.find(s => s.type === 'include')?.label
  //   geography_label = criteria.geoIds.find(g => g.type === 'include')?.text
}
```

### Modèle Prospect réel (statuts backend)

```typescript
// ⚠️ Ces statuts sont EXACTEMENT ceux du CHECK constraint en base (migration 13)
// Ne jamais utiliser un statut hors de cette liste — la DB rejette silencieusement ou explose
type ProspectStatus =
  | 'Profil à valider'    // Scrapé sur SalesNav, en attente validation manuelle
  | 'Non pertinent'       // Rejeté lors de la validation
  | 'Nouveau'             // Validé → invitation LinkedIn à envoyer
  | 'Invitation envoyée'  // Invitation LinkedIn envoyée, en attente d'acceptation
  | 'Invitation acceptée' // Connexion acceptée → message à préparer
  | 'Message à valider'   // Message généré par Claude, à valider par Nathan
  | 'Message à envoyer'   // Validé par Nathan → prêt à envoyer
  | 'Message envoyé'      // Message LinkedIn envoyé
  | 'Discussion en cours' // Échange en cours avec le prospect
  | 'Gagné'               // Prospect converti
  | 'Perdu'               // Prospect perdu
  | 'Profil restreint'    // Profil LinkedIn non accessible
  | 'Hors séquence';      // Sorti de la séquence (désintérêt, no-show, etc.)
  // ⚠️ 'Hors séquence' est nouveau — voir migration §8 pour l'ajout au CHECK constraint

interface Prospect {
  id: string;
  first_name: string;
  last_name: string;
  company: string;
  job_title: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;      // URL profil LinkedIn standard (/in/username) — NULLABLE en DB
                              // Non disponible si profil non visible lors du scraping SalesNav
  sales_nav_url?: string;     // ⚠️ URL profil Sales Navigator (/sales/lead/...)
                              // DIFFÉRENT de Campaign.sales_nav_url qui est l'URL de recherche
  sector?: string;
  geography?: string;
  status: ProspectStatus;
  campaign_id: string | null;
  source?: string;
  created_at: string;
  last_contact_date?: string;
  notes?: string;
  pending_message?: string;   // Message généré en attente d'envoi
}
```

> **⚠️ Distinction critique `sales_nav_url`** :
> - `Campaign.sales_nav_url` = URL de **recherche** Sales Navigator (ex: `/sales/search/people?query=...`)
> - `Prospect.sales_nav_url` = URL de **profil** Sales Navigator (ex: `/sales/lead/ACwAAAXXX,NAME:Jean-Dupont`)
> Ces deux URLs sont de nature complètement différente. Ne pas confondre dans les modèles, la DB, et le frontend.

### Types de référence

```typescript
// Codes Sales Navigator niveaux hiérarchiques — IDs VÉRIFIÉS EN LIVE le 16/04/2026
// ⚠️ Ces codes remplacent l'ancien enum (OWNER, PARTNER, CXO...) qui était incorrect
// UNPAID n'existe pas dans LinkedIn Sales Navigator → supprimé
// PARTNER fusionné avec OWNER → OWNER_PARTNER
// MANAGER splitté en deux niveaux → MANAGER_SR et MANAGER_JR
type SeniorityCode =
  | 'OWNER_PARTNER'  // 320 — Propriétaire / partenaire
  | 'C_LEVEL'        // 310 — Comité Exécutif
  | 'VP'             // 300 — Vice-président
  | 'DIRECTOR'       // 220 — Directeur
  | 'MANAGER_SR'     // 210 — Manager expérimenté
  | 'MANAGER_JR'     // 200 — Manager niveau débutant
  | 'STRATEGIC'      // 130 — Stratégique (experts/conseillers)
  | 'SENIOR'         // 120 — Expérimenté
  | 'ENTRY'          // 110 — Premier emploi
  | 'TRAINEE';       // 100 — Stagiaire

// Codes Sales Navigator effectifs entreprise
type HeadcountCode = 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
// B=1-10, C=11-50, D=51-200, E=201-500, F=501-1000, G=1001-5000, H=5001-10000, I=10001+
// ⚠️ HEADCOUNT est toujours INCLUDED — pas de logique exclude pour les effectifs
```

---

## 4. Backend — Endpoints à étendre / créer

> **⚠️ Les endpoints POST et PUT campaigns existent déjà** (`server.js:3817` et `server.js:3854`).
> Ne pas les recréer from scratch — les étendre en ajoutant les nouveaux champs.
> Champs existants à **CONSERVER** dans le handler et le whitelist PUT :
> `name, status, priority, criteria, daily_quota, sector, geography, details, objectives`
> Champs à **SUPPRIMER** : `excluded_keywords` (déprécié — remplacé par `criteria.jobTitles[].type = 'exclude'`)
> Champs à **AJOUTER** : `message_template, target_count, sales_nav_url`

### 4.1 `POST /api/prospector/campaigns`

Étendre le handler existant (`server.js:3817`) pour accepter les nouveaux champs et générer l'URL Sales Navigator.

**Validation obligatoire côté backend :**
- `name` requis et non-vide
- `priority` entier entre 1 et 5 (retourner 400 si hors range)
- `target_count` entier positif si fourni (retourner 400 si négatif ou non-entier)
- `criteria` doit contenir au moins UN filtre non-vide parmi `jobTitles`, `geoIds`, `sectorIds`, `seniorities`, `headcounts`, `keywords` — retourner 400 si tous vides
- `criteria.keywords` maximum 5 entrées — retourner 400 si dépassé
- **`status` est ignoré depuis le body** — toujours forcé à `'À lancer'` côté serveur à la création

**Request body :**
```json
{
  "name": "BTP Île-de-France QHSE Q1",
  "priority": 1,
  "criteria": {
    "jobTitles": [
      { "value": "Responsable HSE", "type": "include" },
      { "value": "Directeur QHSE", "type": "include" },
      { "value": "stagiaire", "type": "exclude" }
    ],
    "seniorities": [
      { "code": "DIRECTOR",    "type": "include" },
      { "code": "MANAGER_SR", "type": "include" }
    ],
    "geoIds": [
      { "id": "104246759", "text": "Île-de-France, France", "type": "include" }
    ],
    "sectorIds": [
      { "id": 48, "label": "Construction", "parent_category": "Construction", "type": "include" }
    ],
    "headcounts": ["D", "E", "F"],
    "keywords": ["Bilan Carbone", "RE2020"]
  },
  "message_template": "Approche RSE, mentionner la réglementation RE2020",
  "target_count": 150
}
```

**Response :**
```json
{
  "id": "uuid",
  "sales_nav_url": "https://www.linkedin.com/sales/search/people?query=(...)",
  "...": "tous les champs campaign"
}
```

### 4.2 `PUT /api/prospector/campaigns/:id`

Étendre le whitelist existant (`server.js:3858`) :
```javascript
// Whitelist complète après modification :
const allowed = [
  'name', 'status', 'priority', 'criteria',
  'daily_quota', 'sector', 'geography', 'details', 'objectives',
  'message_template', 'target_count'
  // ⚠️ 'excluded_keywords' RETIRÉ — déprécié
  // ⚠️ 'sales_nav_url' NON dans le whitelist — toujours régénéré automatiquement côté serveur
];
```
Si `criteria` est présent dans le body → régénérer `sales_nav_url` via `buildSalesNavUrl(criteria)` et l'inclure dans l'UPDATE.
Mêmes validations que POST pour `priority`, `target_count`, `criteria.keywords`.

### 4.3 `GET /api/prospector/campaigns/:id`

Retourne une campagne avec son `criteria` complet et `sales_nav_url`.
**⚠️ Filtrer impérativement par `account_id` :** `.eq('id', id).eq('account_id', req.accountId)` — sans ce filtre, un utilisateur peut accéder aux campagnes d'un autre compte par brute-force d'UUID.

### 4.4 `GET /api/prospector/reference/sectors`

Protéger avec `accountContext` (vérification auth), mais **sans filtre `account_id`** — données partagées entre tous les comptes.

Retourne les 136 secteurs LinkedIn avec leurs IDs.

**⚠️ Colonnes retournées** : `id`, `label_fr`, `parent_category`, `verified` (schema §6.1 — pas de colonne `label`).

```json
[
  { "id": 48,   "label_fr": "Construction",              "parent_category": "Construction",  "verified": true },
  { "id": 3226, "label_fr": "Aéronautique et aérospatiale", "parent_category": "Manufacturing", "verified": true }
]
```

### 4.5 `GET /api/prospector/reference/geos`

Même protection que `/reference/sectors` : `accountContext` sans filtre `account_id`.

Retourne les zones géographiques disponibles (pays, régions FR, villes).

```json
[
  { "id": "105015875", "label_fr": "France",        "type": "COUNTRY" },
  { "id": "104246759", "label_fr": "Île-de-France", "type": "REGION" },
  { "id": "106383538", "label_fr": "Paris",          "type": "CITY" }
]
```

### 4.6 `POST /api/prospector/sync` (endpoint existant — body exact attendu)

Crée les prospects scrapés en masse depuis Sales Navigator. Déduplication à 3 niveaux.

**Validation obligatoire côté backend :**
- Vérifier que `campaign_id` appartient à `req.accountId` avant tout traitement — retourner 404 sinon (**faille IDOR** si absent)
  ```javascript
  const { data: campaign } = await supabaseAdmin
    .from('campaigns')
    .select('id')
    .eq('id', campaign_id)
    .eq('account_id', req.accountId)
    .single();
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  ```
- Maximum 25 prospects par batch — retourner 400 si `prospects.length > 25`

**Request body :**
```json
{
  "campaign_id": "uuid-de-la-campagne",
  "prospects": [
    {
      "first_name": "Jean",
      "last_name": "Dupont",
      "job_title": "Directeur HSE",
      "company": "Vinci Construction",
      "linkedin_url": "https://www.linkedin.com/in/jean-dupont-hse",
      "sales_nav_url": "https://www.linkedin.com/sales/lead/ACwAAABXXX,NAME:Jean-Dupont",
      "geography": "Paris, Île-de-France",
      "source": "Sales Navigator"
    }
  ]
}
```

**Comportement attendu — déduplication à 3 niveaux (ordre de priorité) :**
1. Match par `linkedin_url` (normalisé via `normalizeLinkedinUrl()` — `server.js:68`) → **skip complet**, ne rien modifier
2. Match par `sales_nav_url` → **skip complet**, ne rien modifier
3. Match par `first_name + last_name + company` → **skip complet**, ne rien modifier

> **⚠️ Architecture DB** : un prospect appartient à UN SEUL compte via `campaign_id`. Il n'y a pas de table de liaison prospect-campagne. Skip complet sur doublon = comportement correct pour éviter les conflits d'appartenance.

- Statut créé = `'Profil à valider'`
- `linkedin_url` est nullable — ne pas rejeter un prospect sans `linkedin_url` si `sales_nav_url` est présent
- Response : `{ "created": 12, "skipped": 3, "total": 15 }`

---

## 5. Backend — Logique critique : Générateur d'URL Sales Navigator

> **⚠️ Deux implémentations distinctes à créer :**
> - **Backend** : JavaScript CommonJS (`require`/`module.exports`) — le backend n'utilise PAS TypeScript
> - **Frontend** : TypeScript (version ci-dessous avec annotations de types)
> Ces deux fichiers doivent rester synchronisés manuellement. Tout bugfix doit être appliqué dans les deux.

**Version TypeScript (frontend uniquement) :**

```typescript
function buildSalesNavUrl(criteria: CampaignCriteria): string {
  const filters: string[] = [];

  // ✅ FIX : utiliser encodeURIComponent pour couvrir TOUS les caractères
  // français (é, è, ê, î, ô, ç, à, ù, É, Â, œ, '...) sans exception
  function encodeText(text: string): string {
    return encodeURIComponent(text);
    // Note : encodeURIComponent encode aussi ( ) : , → ce qui est correct
    // pour les valeurs TEXT dans les filtres Sales Navigator
  }

  function buildFilterBlock(
    type: string,
    items: { id: string | number; text?: string; type: 'include' | 'exclude' }[]
  ): string | null {
    if (!items || items.length === 0) return null;
    const values = items.map(item => {
      const selType = item.type === 'include' ? 'INCLUDED' : 'EXCLUDED';
      return item.text
        ? `(id:${item.id},text:${encodeText(item.text)},selectionType:${selType})`
        : `(id:${item.id},selectionType:${selType})`;
    });
    return `(type:${type},values:List(${values.join(',')}))`;
  }

  // Géographie
  const geo = buildFilterBlock('GEO', criteria.geoIds || []);
  if (geo) filters.push(geo);

  // Intitulé de poste — filtre CURRENT_TITLE (texte libre, PAS d'id)
  if (criteria.jobTitles?.length > 0) {
    const titles = criteria.jobTitles.map(t => {
      const sel = t.type === 'include' ? 'INCLUDED' : 'EXCLUDED';
      return `(text:${encodeText(t.value)},selectionType:${sel})`;
    });
    filters.push(`(type:CURRENT_TITLE,values:List(${titles.join(',')}))`);
  }

  // Niveau hiérarchique — ⚠️ VOIR SECTION 5.2 pour les IDs
  // ⚠️ SENIORITY_LEVEL requiert OBLIGATOIREMENT id: ET text: (vérifié en live 16/04/2026)
  if (criteria.seniorities?.length > 0) {
    const seniorities = criteria.seniorities
      .map(s => {
        const sel = s.type === 'include' ? 'INCLUDED' : 'EXCLUDED';
        const mapping = SENIORITY_URL_ID_MAP[s.code]; // mapping §5.2 → { id, text }
        if (!mapping) {
          console.warn(`buildSalesNavUrl: code séniorité inconnu "${s.code}" — ignoré`);
          return null;
        }
        return `(id:${mapping.id},text:${encodeText(mapping.text)},selectionType:${sel})`;
      })
      .filter(Boolean);
    if (seniorities.length > 0) {
      filters.push(`(type:SENIORITY_LEVEL,values:List(${seniorities.join(',')}))`);
    }
  }

  // Secteur d'activité
  // 🐛 FIX AUDIT 16/04/2026 : text: OBLIGATOIRE pour INDUSTRY (vérifié en live)
  //    Sans text:, le filtre est SILENCIEUSEMENT IGNORÉ (25M+ résultats = aucun filtre)
  //    Format confirmé par l'UI Sales Nav : (id:48,text:Construction,selectionType:INCLUDED)
  // ℹ️ deduplicateSectorIds() SUPPRIMÉ — les doublons sont éliminés à la source (seed nettoyé, §6.1)
  const sectors = (criteria.sectorIds || []);
  const sector = buildFilterBlock(
    'INDUSTRY',
    sectors.map(s => ({ id: s.id, text: s.label, type: s.type }))
  );
  if (sector) filters.push(sector);

  // Effectifs
  if (criteria.headcounts?.length > 0) {
    const hc = criteria.headcounts.map(code => `(id:${code},selectionType:INCLUDED)`);
    filters.push(`(type:COMPANY_HEADCOUNT,values:List(${hc.join(',')}))`);
  }

  // Construction de l'URL finale
  const base = 'https://www.linkedin.com/sales/search/people';

  // Keywords : chaque terme multi-mots est mis entre guillemets encodés
  const keywordParts = (criteria.keywords || []).map(k => {
    const encoded = encodeURIComponent(`"${k}"`); // ex: "Bilan Carbone" → %22Bilan%20Carbone%22
    return encoded;
  });
  const keywordString = keywordParts.join('%20'); // AND implicite entre les termes

  const filterPart = filters.length > 0
    ? `filters:List(${filters.join(',')})`
    : '';

  const keywordPart = keywordString
    ? `keywords:${keywordString}`
    : '';

  const queryParts = [
    'recentSearchParam:(doLogHistory:true)',
    'spellCorrectionEnabled:true',
    filterPart,
    keywordPart,
  ].filter(Boolean).join(',');

  return `${base}?query=(${queryParts})`;
}
```

**Version CommonJS (backend uniquement — même logique, sans annotations TypeScript) :**

```javascript
// utils/buildSalesNavUrl.js
const { SENIORITY_URL_ID_MAP } = require('./constants');

function buildSalesNavUrl(criteria) {
  const filters = [];

  function encodeText(text) {
    return encodeURIComponent(text);
  }

  function buildFilterBlock(type, items) {
    if (!items || items.length === 0) return null;
    const values = items.map(item => {
      const selType = item.type === 'include' ? 'INCLUDED' : 'EXCLUDED';
      return item.text
        ? `(id:${item.id},text:${encodeText(item.text)},selectionType:${selType})`
        : `(id:${item.id},selectionType:${selType})`;
    });
    return `(type:${type},values:List(${values.join(',')}))`;
  }

  const geo = buildFilterBlock('GEO', criteria.geoIds || []);
  if (geo) filters.push(geo);

  if (criteria.jobTitles && criteria.jobTitles.length > 0) {
    const titles = criteria.jobTitles.map(t => {
      const sel = t.type === 'include' ? 'INCLUDED' : 'EXCLUDED';
      return `(text:${encodeText(t.value)},selectionType:${sel})`;
    });
    filters.push(`(type:CURRENT_TITLE,values:List(${titles.join(',')}))`);
  }

  if (criteria.seniorities && criteria.seniorities.length > 0) {
    const seniorities = criteria.seniorities
      .map(s => {
        const sel = s.type === 'include' ? 'INCLUDED' : 'EXCLUDED';
        const mapping = SENIORITY_URL_ID_MAP[s.code]; // { id, text }
        if (!mapping) {
          console.warn(`buildSalesNavUrl: code séniorité inconnu "${s.code}" — ignoré`);
          return null;
        }
        // ⚠️ text: OBLIGATOIRE pour SENIORITY_LEVEL (vérifié en live 16/04/2026)
        return `(id:${mapping.id},text:${encodeText(mapping.text)},selectionType:${sel})`;
      })
      .filter(Boolean);
    if (seniorities.length > 0) {
      filters.push(`(type:SENIORITY_LEVEL,values:List(${seniorities.join(',')}))`);
    }
  }

  // 🐛 FIX AUDIT 16/04/2026 : text: OBLIGATOIRE pour INDUSTRY (vérifié en live)
  //    Sans text:, le filtre est silencieusement ignoré par Sales Navigator
  const sector = buildFilterBlock(
    'INDUSTRY',
    (criteria.sectorIds || []).map(s => ({ id: s.id, text: s.label, type: s.type }))
  );
  if (sector) filters.push(sector);

  if (criteria.headcounts && criteria.headcounts.length > 0) {
    const hc = criteria.headcounts.map(code => `(id:${code},selectionType:INCLUDED)`);
    filters.push(`(type:COMPANY_HEADCOUNT,values:List(${hc.join(',')}))`);
  }

  const base = 'https://www.linkedin.com/sales/search/people';
  const keywordParts = (criteria.keywords || []).map(k => encodeURIComponent(`"${k}"`));
  const keywordString = keywordParts.join('%20');

  const filterPart = filters.length > 0 ? `filters:List(${filters.join(',')})` : '';
  const keywordPart = keywordString ? `keywords:${keywordString}` : '';

  const queryParts = [
    'recentSearchParam:(doLogHistory:true)',
    'spellCorrectionEnabled:true',
    filterPart,
    keywordPart,
  ].filter(Boolean).join(',');

  return `${base}?query=(${queryParts})`;
}

module.exports = { buildSalesNavUrl };
```

### 5.2 ✅ IDs numériques pour SENIORITY_LEVEL — Vérifiés en live le 16/04/2026

**⚠️ Double correction critique :**
1. Les IDs sont dans la plage `100-320` (pas `1-10` comme supposé initialement)
2. Le filtre `SENIORITY_LEVEL` requiert **obligatoirement** `id:` **ET** `text:` — l'id seul ne fonctionne pas

**Mapping vérifié — à implémenter côté backend (CommonJS) ET frontend (TS) :**

```typescript
// ✅ IDs et labels vérifiés sur URL Sales Navigator réelle — 16/04/2026
export const SENIORITY_URL_ID_MAP: Record<SeniorityCode, { id: number; text: string }> = {
  OWNER_PARTNER: { id: 320, text: 'Propriétaire / partenaire' },
  C_LEVEL:       { id: 310, text: 'Comité Exécutif' },
  VP:            { id: 300, text: 'Vice-président' },
  DIRECTOR:      { id: 220, text: 'Directeur' },
  MANAGER_SR:    { id: 210, text: 'Manager expérimenté' },
  MANAGER_JR:    { id: 200, text: 'Manager niveau débutant' },
  STRATEGIC:     { id: 130, text: 'Stratégique' },
  SENIOR:        { id: 120, text: 'Expérimenté' },
  ENTRY:         { id: 110, text: 'Premier emploi' },
  TRAINEE:       { id: 100, text: 'Stagiaire' },
};
```

**Usage dans la fonction (les deux versions) :**
```
const mapping = SENIORITY_URL_ID_MAP[s.code];
→ `(id:${mapping.id},text:${encodeURIComponent(mapping.text)},selectionType:INCLUDED)`
```

### 5.3 Note sur les keywords

- Les `keywords` sont une liste de termes **positifs uniquement** dans `CampaignCriteria`. L'interface ne gère pas les keywords exclus (suppression silencieuse) car Sales Navigator n'a pas de filtre natif d'exclusion de keywords équivalent — documenter ce choix dans l'UI.
- Chaque terme multi-mots est automatiquement mis entre guillemets dans l'URL pour forcer la recherche exacte (ex: `"Bilan Carbone"` plutôt que `Bilan` AND `Carbone` séparés).
- **Limite : maximum 5 keywords** — validée côté **backend** (retourner 400) ET côté **frontend** (input disabled au-delà de 5).

---

## 6. Données de référence à seeder

### 6.1 Secteurs LinkedIn (136 secteurs)

> **⚠️ CRITIQUE — DÉCOUVERTE DU 16/04/2026 (vérification live Sales Navigator) :**
>
> 1. **`text:` est OBLIGATOIRE** pour le filtre INDUSTRY dans l'URL Sales Navigator.
>    Sans `text:`, le filtre est **silencieusement ignoré** (25M+ résultats = aucun filtre actif).
>    Format confirmé : `(id:48,text:Construction,selectionType:INCLUDED)`
>
> 2. **Les IDs Sales Navigator ≠ toujours LinkedIn API v2** (Microsoft Learn).
>    Certains matchent (id:114 Nanotechnologie, id:93 Entreposage) mais d'autres divergent
>    (id:3197 vs id:58 pour "Matériaux de construction", id:3238 vs id:133 pour "Biotechnologie").
>
> 3. **`label_fr` sert AUSSI de valeur `text:` dans l'URL** → il DOIT correspondre EXACTEMENT
>    au label affiché par le typeahead Sales Navigator (en français). Un mismatch = filtre ignoré.
>
> 4. **Procédure de vérification d'un ID** : Sales Navigator → Recherche prospect → filtre Secteur
>    → taper le nom → sélectionner → copier l'URL → extraire `id:` et `text:` du query string.
>
> **IDs vérifiés en live le 16/04/2026 :**
> | label_fr | ID confirmé | Source |
> |---|---|---|
> | Construction | 48 | UI Sales Nav (10K+ résultats ✅) — via Chiropracteurs test |
> | Matériaux de construction | **3197** (PAS 58 ni 49) | UI Sales Nav |
> | Biotechnologie | **3238** (PAS 133) | UI Sales Nav |
> | Recherche en nanotechnologie | **114** (PAS 134) | UI Sales Nav |
> | Entreposage et stockage | **93** (PAS 400) | UI Sales Nav |
> | Entreposage, stockage | **3229** (entrée distincte !) | UI Sales Nav |

#### Table `linkedin_sectors`

```sql
CREATE TABLE linkedin_sectors (
  id          INTEGER PRIMARY KEY,         -- ID Sales Navigator (PAS l'API v2 — vérifié via typeahead UI)
  label_fr    TEXT NOT NULL UNIQUE,         -- Label FR exact du typeahead Sales Nav (sert de text: dans l'URL)
  parent_category TEXT NOT NULL,            -- Catégorie parent Sales Nav (15 catégories, clé EN)
  verified    BOOLEAN DEFAULT FALSE,        -- true = ID vérifié en live sur Sales Nav
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- ⚠️ UNIQUE sur label_fr → empêche les doublons d'étiquette à la source (plus besoin de deduplicateSectorIds)
-- ⚠️ label_fr DOIT correspondre EXACTEMENT au typeahead Sales Nav car il est utilisé comme text: dans l'URL
```

#### 15 catégories parent (constante frontend)

Les 15 catégories parent utilisées dans la BDD Releaf Prospector (sous-ensemble des catégories Sales Navigator). La clé `key` est en anglais (stable, identique à Sales Nav interne). Le `label_fr` est le libellé affiché dans le `<SectorSelector>`.

```typescript
// constantes/sectorCategories.ts
export const SECTOR_PARENT_CATEGORIES: { key: string; label_fr: string }[] = [
  { key: "Construction",                  label_fr: "Construction" },
  { key: "Manufacturing",                 label_fr: "Industrie" },
  { key: "Transportation, Logistics, Supply Chain and Storage", label_fr: "Transport, logistique et supply chain" },
  { key: "Oil, Gas, and Mining",           label_fr: "Pétrole, gaz et mines" },
  { key: "Utilities",                      label_fr: "Énergie et services publics" },
  { key: "Professional Services",          label_fr: "Services professionnels" },
  { key: "Wholesale",                      label_fr: "Commerce de gros" },
  { key: "Retail",                         label_fr: "Commerce de détail" },
  { key: "Farming, Ranching, Forestry",    label_fr: "Agriculture, élevage et sylviculture" },
  { key: "Hospitals and Health Care",      label_fr: "Hôpitaux et santé" },
  { key: "Education",                      label_fr: "Éducation" },
  { key: "Government Administration",      label_fr: "Administration publique" },
  { key: "Consumer Services",              label_fr: "Services aux particuliers" },
  { key: "Administrative and Support Services", label_fr: "Services administratifs et de soutien" },
  { key: "Financial Services",             label_fr: "Services financiers" },
];
```

#### Type TypeScript SectorEntry

```typescript
interface SectorEntry {
  id:              number;    // ID Sales Navigator (vérifié via typeahead)
  label_fr:        string;    // Label FR exact du typeahead (= text: dans l'URL)
  parent_category: string;    // Clé EN de la catégorie parent (ex: "Construction")
  verified:        boolean;   // true = ID confirmé en live
}
```

#### ⚠️ Source de vérité : `Prospector_BDD_filtres_salesnav.xlsx`

> Le fichier Excel `Prospector_BDD_filtres_salesnav.xlsx` (situé à la racine du dossier Prospector) est la **source de vérité unique** pour les secteurs LinkedIn.
> Le seed TypeScript ci-dessous en est une copie fidèle. **En cas de divergence, c'est l'Excel qui prime.**
>
> **Procédure de mise à jour des secteurs :**
> 1. Modifier le fichier Excel (ajouter/supprimer/corriger une ligne)
> 2. Regénérer le seed ci-dessous à partir de l'Excel
> 3. Mettre à jour la constante `SECTOR_PARENT_CATEGORIES` si une nouvelle catégorie parent apparaît
> 4. Exécuter la migration Supabase pour synchroniser la table `linkedin_sectors`
> 5. Ne jamais modifier le seed ci-dessous sans avoir modifié l'Excel d'abord

#### Seed complet — 136 secteurs Releaf Carbon (tous vérifiés ✅)

> **Tous les IDs ont été vérifiés via le typeahead Sales Navigator le 16/04/2026.**
> **AUCUN doublon de label_fr** — chaque label correspond exactement au typeahead Sales Nav.

```typescript
const SECTORS_SEED: SectorEntry[] = [
  // --- Services administratifs et de soutien (Administrative and Support Services) — 2 secteurs ---
  { id: 122,  label_fr: "Services relatifs aux bâtiments",                parent_category: "Administrative and Support Services", verified: true },
  { id: 110,  label_fr: "Événementiel",                                   parent_category: "Administrative and Support Services", verified: true },

  // --- Construction (Construction) — 12 secteurs ---
  { id: 48,   label_fr: "Construction",                                                               parent_category: "Construction", verified: true },
  { id: 406,  label_fr: "Construction de bâtiments",                                                  parent_category: "Construction", verified: true },
  { id: 413,  label_fr: "Construction de bâtiments non résidentiels",                                 parent_category: "Construction", verified: true },
  { id: 408,  label_fr: "Construction de bâtiments résidentiels",                                     parent_category: "Construction", verified: true },
  { id: 431,  label_fr: "Construction de routes, autoroutes et ponts",                                parent_category: "Construction", verified: true },
  { id: 419,  label_fr: "Construction des services publics de distribution",                          parent_category: "Construction", verified: true },
  { id: 51,   label_fr: "Génie civil",                                                                parent_category: "Construction", verified: true },
  { id: 1001, label_fr: "Travaux Publics",                                                            parent_category: "Construction", verified: true },
  { id: 453,  label_fr: "Travaux d'installation électrique, plomberie et autres travaux d'installation", parent_category: "Construction", verified: true },
  { id: 435,  label_fr: "Travaux de construction spécialisés",                                        parent_category: "Construction", verified: true },
  { id: 460,  label_fr: "Travaux de finition de bâtiment",                                            parent_category: "Construction", verified: true },
  { id: 436,  label_fr: "Travaux de maçonnerie générale et gros œuvre de bâtiment",                   parent_category: "Construction", verified: true },

  // --- Services aux particuliers (Consumer Services) — 1 secteur ---
  { id: 3192, label_fr: "Biens de consommation",    parent_category: "Consumer Services", verified: true },

  // --- Éducation (Education) — 1 secteur ---
  { id: 132,  label_fr: "Fournisseurs d'apprentissage en ligne", parent_category: "Education", verified: true },

  // --- Agriculture, élevage et sylviculture (Farming, Ranching, Forestry) — 1 secteur ---
  { id: 63,   label_fr: "Agriculture",              parent_category: "Farming, Ranching, Forestry", verified: true },

  // --- Services financiers (Financial Services) — 1 secteur ---
  { id: 141,  label_fr: "Commerce et développement international", parent_category: "Financial Services", verified: true },

  // --- Administration publique (Government Administration) — 1 secteur ---
  { id: 388,  label_fr: "Programmes de qualité environnementale", parent_category: "Government Administration", verified: true },

  // --- Hôpitaux et santé (Hospitals and Health Care) — 2 secteurs ---
  { id: 2081, label_fr: "Hôpitaux",                              parent_category: "Hospitals and Health Care", verified: true },
  { id: 14,   label_fr: "Hôpitaux et services de santé",         parent_category: "Hospitals and Health Care", verified: true },

  // --- Industrie (Manufacturing) — 77 secteurs ---
  { id: 3225, label_fr: "Articles de sport",                                          parent_category: "Manufacturing", verified: true },
  { id: 3226, label_fr: "Aéronautique et aérospatiale",                               parent_category: "Manufacturing", verified: true },
  { id: 679,  label_fr: "Cokéfaction et raffinage",                                   parent_category: "Manufacturing", verified: true },
  { id: 62,   label_fr: "Construction de matériel ferroviaire",                        parent_category: "Manufacturing", verified: true },
  { id: 1002, label_fr: "Distribution de Pièces",                                     parent_category: "Manufacturing", verified: true },
  { id: 3223, label_fr: "Emballages et conteneurs",                                   parent_category: "Manufacturing", verified: true },
  { id: 615,  label_fr: "Fabrication d'accessoires de mode",                           parent_category: "Manufacturing", verified: true },
  { id: 481,  label_fr: "Fabrication d'aliments pour animaux",                         parent_category: "Manufacturing", verified: true },
  { id: 998,  label_fr: "Fabrication d'appareils d'éclairage électrique",              parent_category: "Manufacturing", verified: true },
  { id: 1005, label_fr: "Fabrication d'appareils électroménagers",                     parent_category: "Manufacturing", verified: true },
  { id: 112,  label_fr: "Fabrication d'appareils électroménagers, électriques et électroniques", parent_category: "Manufacturing", verified: true },
  { id: 20,   label_fr: "Fabrication d'articles de sport",                             parent_category: "Manufacturing", verified: true },
  { id: 146,  label_fr: "Fabrication d'emballages et conteneurs",                      parent_category: "Manufacturing", verified: true },
  { id: 983,  label_fr: "Fabrication d'instruments de mesure et de contrôle",          parent_category: "Manufacturing", verified: true },
  { id: 852,  label_fr: "Fabrication d'éléments en métal pour la construction",        parent_category: "Manufacturing", verified: true },
  { id: 973,  label_fr: "Fabrication d'équipements audio et vidéo",                    parent_category: "Manufacturing", verified: true },
  { id: 923,  label_fr: "Fabrication d'équipements aérauliques et frigorifiques",      parent_category: "Manufacturing", verified: true },
  { id: 964,  label_fr: "Fabrication d'équipements de communication",                  parent_category: "Manufacturing", verified: true },
  { id: 17,   label_fr: "Fabrication d'équipements médicaux",                          parent_category: "Manufacturing", verified: true },
  { id: 3241, label_fr: "Fabrication d'équipements pour les énergies renouvelables",   parent_category: "Manufacturing", verified: true },
  { id: 2468, label_fr: "Fabrication d'équipements électriques",                       parent_category: "Manufacturing", verified: true },
  { id: 562,  label_fr: "Fabrication de bière",                                        parent_category: "Manufacturing", verified: true },
  { id: 142,  label_fr: "Fabrication de boissons",                                     parent_category: "Manufacturing", verified: true },
  { id: 703,  label_fr: "Fabrication de caoutchouc et fibres synthétiques",            parent_category: "Manufacturing", verified: true },
  { id: 794,  label_fr: "Fabrication de chaux et d'éléments en plâtre",                parent_category: "Manufacturing", verified: true },
  { id: 52,   label_fr: "Fabrication de composants pour l'industrie aéronautique et aérospatiale", parent_category: "Manufacturing", verified: true },
  { id: 3254, label_fr: "Fabrication de compteurs intelligents",                       parent_category: "Manufacturing", verified: true },
  { id: 849,  label_fr: "Fabrication de coutellerie et d'outils à main",               parent_category: "Manufacturing", verified: true },
  { id: 55,   label_fr: "Fabrication de machines",                                     parent_category: "Manufacturing", verified: true },
  { id: 901,  label_fr: "Fabrication de machines agricoles et forestières, pour l'extraction ou la construction", parent_category: "Manufacturing", verified: true },
  { id: 147,  label_fr: "Fabrication de machines d'automatisation",                    parent_category: "Manufacturing", verified: true },
  { id: 135,  label_fr: "Fabrication de machines industrielles",                       parent_category: "Manufacturing", verified: true },
  { id: 928,  label_fr: "Fabrication de machines pour la métallurgie",                 parent_category: "Manufacturing", verified: true },
  { id: 918,  label_fr: "Fabrication de machines pour le commerce et les industries de services", parent_category: "Manufacturing", verified: true },
  { id: 1095, label_fr: "Fabrication de matelas et stores",                            parent_category: "Manufacturing", verified: true },
  { id: 1029, label_fr: "Fabrication de matériel de transport",                        parent_category: "Manufacturing", verified: true },
  { id: 1090, label_fr: "Fabrication de meubles de bureau et de magasin",              parent_category: "Manufacturing", verified: true },
  { id: 26,   label_fr: "Fabrication de meubles et d'articles d'ameublement",          parent_category: "Manufacturing", verified: true },
  { id: 1080, label_fr: "Fabrication de meubles pour particuliers et institutions",    parent_category: "Manufacturing", verified: true },
  { id: 935,  label_fr: "Fabrication de moteurs, génératrices et transformateurs électriques et de matériel de distribution et de commande électrique", parent_category: "Manufacturing", verified: true },
  { id: 61,   label_fr: "Fabrication de papier et de produits en papier",              parent_category: "Manufacturing", verified: true },
  { id: 722,  label_fr: "Fabrication de peintures, enduits et adhésifs",               parent_category: "Manufacturing", verified: true },
  { id: 3255, label_fr: "Fabrication de piles à combustible",                          parent_category: "Manufacturing", verified: true },
  { id: 876,  label_fr: "Fabrication de pièces tournées et d'éléments de fixation",    parent_category: "Manufacturing", verified: true },
  { id: 799,  label_fr: "Fabrication de produits abrasifs et de produits minéraux non métalliques", parent_category: "Manufacturing", verified: true },
  { id: 709,  label_fr: "Fabrication de produits agrochimiques et d'engrais",          parent_category: "Manufacturing", verified: true },
  { id: 23,   label_fr: "Fabrication de produits alimentaires et boissons",            parent_category: "Manufacturing", verified: true },
  { id: 54,   label_fr: "Fabrication de produits chimiques",                           parent_category: "Manufacturing", verified: true },
  { id: 773,  label_fr: "Fabrication de produits en argile et matériaux réfractaires", parent_category: "Manufacturing", verified: true },
  { id: 784,  label_fr: "Fabrication de produits en bois",                             parent_category: "Manufacturing", verified: true },
  { id: 763,  label_fr: "Fabrication de produits en caoutchouc",                       parent_category: "Manufacturing", verified: true },
  { id: 743,  label_fr: "Fabrication de produits en caoutchouc et en plastique",       parent_category: "Manufacturing", verified: true },
  { id: 117,  label_fr: "Fabrication de produits en plastique",                        parent_category: "Manufacturing", verified: true },
  { id: 24,   label_fr: "Fabrication de produits informatiques et électroniques",      parent_category: "Manufacturing", verified: true },
  { id: 840,  label_fr: "Fabrication de produits métalliques",                         parent_category: "Manufacturing", verified: true },
  { id: 873,  label_fr: "Fabrication de ressorts et de produits en fil métallique",    parent_category: "Manufacturing", verified: true },
  { id: 3247, label_fr: "Fabrication de robots",                                      parent_category: "Manufacturing", verified: true },
  { id: 861,  label_fr: "Fabrication de réservoirs, citernes et conteneurs métalliques", parent_category: "Manufacturing", verified: true },
  { id: 727,  label_fr: "Fabrication de savons, détergents et produits d'entretien",   parent_category: "Manufacturing", verified: true },
  { id: 7,    label_fr: "Fabrication de semi-conducteurs",                             parent_category: "Manufacturing", verified: true },
  { id: 144,  label_fr: "Fabrication de semi-conducteurs pour énergies renouvelables", parent_category: "Manufacturing", verified: true },
  { id: 871,  label_fr: "Fabrication de serrures et de ferrures",                      parent_category: "Manufacturing", verified: true },
  { id: 994,  label_fr: "Fabrication de supports magnétiques et optiques",             parent_category: "Manufacturing", verified: true },
  { id: 60,   label_fr: "Fabrication de textiles",                                    parent_category: "Manufacturing", verified: true },
  { id: 887,  label_fr: "Fabrication de valves, billes et cylindres en métal",         parent_category: "Manufacturing", verified: true },
  { id: 779,  label_fr: "Fabrication de verre et d'articles en verre",                 parent_category: "Manufacturing", verified: true },
  { id: 145,  label_fr: "Fabrication de verre, de produits céramiques et de ciment",   parent_category: "Manufacturing", verified: true },
  { id: 1,    label_fr: "Fabrication pour l'aérospatiale et la défense",               parent_category: "Manufacturing", verified: true },
  { id: 3198, label_fr: "Industrie automobile",                                       parent_category: "Manufacturing", verified: true },
  { id: 3239, label_fr: "Industrie bois et papiers",                                  parent_category: "Manufacturing", verified: true },
  { id: 25,   label_fr: "Industrie manufacturière",                                   parent_category: "Manufacturing", verified: true },
  { id: 3193, label_fr: "Meubles",                                                    parent_category: "Manufacturing", verified: true },
  { id: 807,  label_fr: "Métallurgie",                                                parent_category: "Manufacturing", verified: true },
  { id: 3218, label_fr: "Semi-conducteurs",                                           parent_category: "Manufacturing", verified: true },
  { id: 83,   label_fr: "Services d'impression",                                      parent_category: "Manufacturing", verified: true },
  { id: 3259, label_fr: "Technologie énergétique",                                    parent_category: "Manufacturing", verified: true },
  { id: 883,  label_fr: "Traitements des métaux",                                     parent_category: "Manufacturing", verified: true },

  // --- Pétrole, gaz et mines (Oil, Gas, and Mining) — 4 secteurs ---
  { id: 56,   label_fr: "Exploitation minière",               parent_category: "Oil, Gas, and Mining", verified: true },
  { id: 345,  label_fr: "Extraction de minerais métalliques",  parent_category: "Oil, Gas, and Mining", verified: true },
  { id: 356,  label_fr: "Extraction de minerais non métalliques", parent_category: "Oil, Gas, and Mining", verified: true },
  { id: 332,  label_fr: "Industries extractives",              parent_category: "Oil, Gas, and Mining", verified: true },

  // --- Services professionnels (Professional Services) — 8 secteurs ---
  { id: 3238, label_fr: "Biotechnologie",                           parent_category: "Professional Services", verified: true },
  { id: 47,   label_fr: "Comptabilité",                             parent_category: "Professional Services", verified: true },
  { id: 3213, label_fr: "Environnement et énergies renouvelables",  parent_category: "Professional Services", verified: true },
  { id: 3221, label_fr: "Ingénierie mécanique ou industrielle",     parent_category: "Professional Services", verified: true },
  { id: 3248, label_fr: "Ingénierie robotique",                     parent_category: "Professional Services", verified: true },
  { id: 3242, label_fr: "Services d'ingénierie",                    parent_category: "Professional Services", verified: true },
  { id: 86,   label_fr: "Services de conseil en environnement",     parent_category: "Professional Services", verified: true },
  { id: 11,   label_fr: "Services et conseil aux entreprises",      parent_category: "Professional Services", verified: true },

  // --- Commerce de détail (Retail) — 6 secteurs ---
  { id: 3211, label_fr: "Biens et équipements pour les entreprises",                            parent_category: "Retail", verified: true },
  { id: 27,   label_fr: "Commerce de détail",                                                   parent_category: "Retail", verified: true },
  { id: 1319, label_fr: "Commerce de détail d'appareils électriques et électroniques",           parent_category: "Retail", verified: true },
  { id: 138,  label_fr: "Commerce de détail de machines et d'équipements de bureau",             parent_category: "Retail", verified: true },
  { id: 1324, label_fr: "Commerce de détail de matériaux de construction et matériel de jardinage", parent_category: "Retail", verified: true },
  { id: 1309, label_fr: "Commerce de détail de meubles et articles d'ameublement",               parent_category: "Retail", verified: true },

  // --- Transport, logistique et supply chain (Transportation, Logistics, Supply Chain and Storage) — 6 secteurs ---
  { id: 93,   label_fr: "Entreposage et stockage",                                     parent_category: "Transportation, Logistics, Supply Chain and Storage", verified: true },
  { id: 94,   label_fr: "Transport aérien",                                            parent_category: "Transportation, Logistics, Supply Chain and Storage", verified: true },
  { id: 95,   label_fr: "Transport maritime",                                          parent_category: "Transportation, Logistics, Supply Chain and Storage", verified: true },
  { id: 116,  label_fr: "Transport, logistique, chaîne logistique et stockage",        parent_category: "Transportation, Logistics, Supply Chain and Storage", verified: true },
  { id: 87,   label_fr: "Transports de fret et de colis",                              parent_category: "Transportation, Logistics, Supply Chain and Storage", verified: true },
  { id: 92,   label_fr: "Transports routiers de fret",                                 parent_category: "Transportation, Logistics, Supply Chain and Storage", verified: true },

  // --- Énergie et services publics (Utilities) — 3 secteurs ---
  { id: 398,  label_fr: "Services de gestion des eaux, eaux usées, vapeur et climatisation", parent_category: "Utilities", verified: true },
  { id: 400,  label_fr: "Traitement et distribution d'eau",                                  parent_category: "Utilities", verified: true },
  { id: 1986, label_fr: "Traitement et élimination des déchets",                             parent_category: "Utilities", verified: true },

  // --- Commerce de gros (Wholesale) — 11 secteurs ---
  { id: 133,  label_fr: "Commerce de gros",                                                  parent_category: "Wholesale", verified: true },
  { id: 1187, label_fr: "Commerce de gros d'équipements industriels",                         parent_category: "Wholesale", verified: true },
  { id: 1267, label_fr: "Commerce de gros de boissons alcoolisées",                           parent_category: "Wholesale", verified: true },
  { id: 49,   label_fr: "Commerce de gros de matériaux de construction",                      parent_category: "Wholesale", verified: true },
  { id: 1206, label_fr: "Commerce de gros de matériaux recyclables",                          parent_category: "Wholesale", verified: true },
  { id: 1171, label_fr: "Commerce de gros de matériel électrique et électronique",            parent_category: "Wholesale", verified: true },
  { id: 1137, label_fr: "Commerce de gros de meubles et articles d'ameublement",              parent_category: "Wholesale", verified: true },
  { id: 1212, label_fr: "Commerce de gros de papier et d'articles de papeterie",              parent_category: "Wholesale", verified: true },
  { id: 134,  label_fr: "Commerce de gros import-export",                                    parent_category: "Wholesale", verified: true },
  { id: 3209, label_fr: "Import et export",                                                  parent_category: "Wholesale", verified: true },
  { id: 3197, label_fr: "Matériaux de construction",                                         parent_category: "Wholesale", verified: true },
];
// Total : 136 secteurs, 15 catégories parent, tous vérifiés ✅ (16/04/2026)
```

### 6.2 Zones géographiques LinkedIn (table `linkedin_geos`)

> **⚠️ IDs À VÉRIFIER** — Ces IDs ont été identifiés via l'API LinkedIn mais n'ont pas tous été testés en conditions réelles. Tester impérativement `Île-de-France` (id: `104246759`) et `Paris` (id: `106383538`) en les utilisant dans une vraie URL Sales Navigator.

```typescript
const GEOS_SEED = [
  // Pays prioritaires
  { id: "105015875", label_fr: "France",      geo_type: "COUNTRY" },
  { id: "100565514", label_fr: "Belgique",    geo_type: "COUNTRY" },
  { id: "106693272", label_fr: "Suisse",      geo_type: "COUNTRY" },
  { id: "104042105", label_fr: "Luxembourg",  geo_type: "COUNTRY" },
  { id: "101282230", label_fr: "Allemagne",   geo_type: "COUNTRY" },
  { id: "105646813", label_fr: "Espagne",     geo_type: "COUNTRY" },

  // 13 Régions françaises (LinkedIn = Country → Region → City, PAS de département)
  { id: "104246759", label_fr: "Île-de-France",              geo_type: "REGION" },
  { id: "103623254", label_fr: "Auvergne-Rhône-Alpes",       geo_type: "REGION" },
  { id: "102203735", label_fr: "Provence-Alpes-Côte d'Azur", geo_type: "REGION" },
  { id: "105007536", label_fr: "Hauts-de-France",            geo_type: "REGION" },
  { id: "103876217", label_fr: "Occitanie",                  geo_type: "REGION" },
  { id: "105563475", label_fr: "Nouvelle-Aquitaine",         geo_type: "REGION" },
  { id: "101735443", label_fr: "Grand Est",                  geo_type: "REGION" },
  { id: "104731846", label_fr: "Pays de la Loire",           geo_type: "REGION" },
  { id: "104433326", label_fr: "Normandie",                  geo_type: "REGION" },
  { id: "103737322", label_fr: "Bretagne",                   geo_type: "REGION" },
  { id: "103286073", label_fr: "Bourgogne-Franche-Comté",    geo_type: "REGION" },
  { id: "102215960", label_fr: "Centre-Val de Loire",        geo_type: "REGION" },
  { id: "106926833", label_fr: "Corse",                      geo_type: "REGION" },

  // Grandes villes
  { id: "106383538", label_fr: "Paris",        geo_type: "CITY" },
  { id: "103815258", label_fr: "Lyon",         geo_type: "CITY" },
  { id: "103857854", label_fr: "Marseille",    geo_type: "CITY" },
  { id: "105073465", label_fr: "Toulouse",     geo_type: "CITY" },
  { id: "104787182", label_fr: "Bordeaux",     geo_type: "CITY" },
  { id: "100323840", label_fr: "Lille",        geo_type: "CITY" },
  { id: "105580607", label_fr: "Strasbourg",   geo_type: "CITY" },
  { id: "102565100", label_fr: "Nantes",       geo_type: "CITY" },
  { id: "106456329", label_fr: "Grenoble",     geo_type: "CITY" },
  { id: "105282085", label_fr: "Nice",         geo_type: "CITY" },
  { id: "104946573", label_fr: "Rennes",       geo_type: "CITY" },
  { id: "106719766", label_fr: "Montpellier",  geo_type: "CITY" },
  { id: "106834928", label_fr: "Metz",         geo_type: "CITY" },
  { id: "103264728", label_fr: "Clermont-Ferrand", geo_type: "CITY" },
  { id: "106045821", label_fr: "Rouen",        geo_type: "CITY" },
  { id: "100853905", label_fr: "Dijon",        geo_type: "CITY" },
];
```

> **Note architecture géographique LinkedIn :** LinkedIn ne modélise pas les 96 départements français. La granularité max disponible est Région → Ville/Commune. Ne jamais ajouter de département comme entité géographique — ça retournera 0 résultats.

### 6.3 Codes effectifs (constante frontend + backend)

```typescript
export const HEADCOUNT_OPTIONS: { code: HeadcountCode; label: string }[] = [
  { code: 'B', label: '1-10 salariés' },
  { code: 'C', label: '11-50 salariés' },
  { code: 'D', label: '51-200 salariés' },
  { code: 'E', label: '201-500 salariés' },
  { code: 'F', label: '501-1 000 salariés' },
  { code: 'G', label: '1 001-5 000 salariés' },
  { code: 'H', label: '5 001-10 000 salariés' },
  { code: 'I', label: '10 001+ salariés' },
];
```

### 6.4 Niveaux hiérarchiques (constante)

```typescript
// ✅ Labels alignés avec le libellé exact LinkedIn — vérifiés le 16/04/2026
export const SENIORITY_OPTIONS: { code: SeniorityCode; label: string }[] = [
  { code: 'OWNER_PARTNER', label: 'Propriétaire / partenaire' },
  { code: 'C_LEVEL',       label: 'Comité Exécutif' },
  { code: 'VP',            label: 'Vice-président' },
  { code: 'DIRECTOR',      label: 'Directeur' },
  { code: 'MANAGER_SR',    label: 'Manager expérimenté' },
  { code: 'MANAGER_JR',    label: 'Manager niveau débutant' },
  { code: 'STRATEGIC',     label: 'Stratégique' },
  { code: 'SENIOR',        label: 'Expérimenté' },
  { code: 'ENTRY',         label: 'Premier emploi' },
  { code: 'TRAINEE',       label: 'Stagiaire' },
];
```

---

## 7. Frontend — Formulaire de création de campagne

### 7.1 Route

`/campaigns/new` — page complète avec sidebar collapsible

### 7.2 Sections du formulaire

**Section 1 — Informations générales**
- Nom de la campagne (input texte, requis)
- Priorité (select 1-5, défaut: 3)
- Statut (select parmi `CampaignStatus`, défaut: "À lancer")
- Nombre de prospects cible (input number, optionnel)

**Section 2 — Critères de recherche Sales Navigator**

Formulaire de filtres en grille 2 colonnes :

| Colonne gauche | Colonne droite |
|---|---|
| **Intitulé de poste** — tags include/exclude (texte libre) | **Secteur d'activité** — 136 secteurs avec recherche + checkboxes include/exclude |
| **Niveau hiérarchique** — 10 niveaux, 3 états par niveau | **Effectifs entreprise** — 8 tranches, checkboxes |
| **Zone géographique** — autocomplete → tags include/exclude | |

**Section 3 — Mots-clés**
- Tags positifs uniquement (max 5 tags, validation visuelle au-dessus)
- Placeholder : "Bilan Carbone, RSE, RE2020, ICPE..."
- Tooltip : "Les mots-clés sont recherchés dans les profils et entreprises"

**Section 4 — Instructions pour Claude**
- Textarea "Instructions de personnalisation pour la séquence de messages"
- Placeholder : "Mentionner la réglementation RE2020, approche RSE décarbonation..."
- Aide : "Ce texte sera transmis à Claude pour personnaliser les messages envoyés"

**Section 5 — Prévisualisation URL Sales Navigator** _(composant clé)_
- Bloc readonly affichant l'URL générée en temps réel (debounce 300ms)
- Bouton "Ouvrir dans Sales Navigator" (target=\_blank)
- Warning si aucun filtre actif : "⚠️ Ajoutez au moins un filtre pour générer une URL valide"
- Badge rouge si criteria complètement vide → empêcher la soumission du formulaire

**Validation formulaire :**
- Le bouton "Créer la campagne" est disabled si `criteria` est complètement vide (tous les tableaux vides)
- Message d'erreur inline : "Veuillez définir au moins un critère de recherche"

### 7.3 Composants réutilisables à créer

**`<SalesNavTagInput>`** — champ texte + tags include/exclude
```
- Input avec dropdown au focus
- 2 boutons dans le dropdown : [+ Inclure] (vert) / [− Exclure] (rouge)
- Tags affichés : fond vert clair / rouge clair selon type
- Croix de suppression sur chaque tag
- Touche Enter = ajoute en mode "include" par défaut
```

**`<SectorSelector>`** — sélecteur hiérarchique à 2 niveaux (catégorie parent → secteurs)

```
Props :
  value:    SectorSelection[]   — secteurs actuellement sélectionnés
  onChange: (sectors: SectorSelection[]) => void

  type SectorSelection = { id: number; label: string; parent_category: string; type: 'include' | 'exclude' }

Architecture du composant :
┌──────────────────────────────────────────────────────────┐
│  🏭 3 secteurs sélectionnés                         [▼] │  ← Bouton trigger (fermé)
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  🔍 Rechercher un secteur...              [Tout effacer] │  ← Input recherche (typeahead)
│──────────────────────────────────────────────────────────│
│  Catégorie : [Toutes ▾] [Construction ▾] [Industrie ▾]  │  ← Filtre catégorie parent (pills)
│──────────────────────────────────────────────────────────│
│  ☑ Construction                    [Inclure ✓] [Excl ✗] │  ← Secteur avec boutons include/exclude
│  ☑ Construction de bâtiments       [Inclure ✓] [Excl ✗] │
│  ☐ Génie civil                     [Inclure ✓] [Excl ✗] │
│  ☐ Travaux de construction spéc... [Inclure ✓] [Excl ✗] │
│  ...                                                     │  ← Liste scrollable (max-height: 320px)
│──────────────────────────────────────────────────────────│
│  ☑ = sélectionné include (fond vert clair)               │
│  ☒ = sélectionné exclude (fond rouge clair)              │
│  ☐ = non sélectionné                                     │
└──────────────────────────────────────────────────────────┘

Comportement de la recherche typeahead :
  - Filtrage dès 2 caractères tapés (pas avant — trop de bruit avec 1 char)
  - Filtre sur label_fr avec match insensible aux accents et à la casse
    Ex: "fab" → "Fabrication de boissons", "Fabrication de machines industrielles"...
  - Le filtre catégorie parent se combine avec la recherche texte :
    catégorie "Construction" + recherche "bât" → seuls les secteurs Construction contenant "bât"
  - Si aucun résultat : afficher "Aucun secteur trouvé pour cette recherche"
  - Quand la recherche est vidée, revenir à la liste filtrée par catégorie (ou complète si "Toutes")

Filtre par catégorie parent :
  - Afficher les 15 catégories comme des pills cliquables horizontalement (scrollable)
  - "Toutes" est sélectionné par défaut → affiche les 136 secteurs groupés par catégorie
  - Cliquer une catégorie → affiche UNIQUEMENT les secteurs de cette catégorie
  - Les catégories sont triées par pertinence Releaf :
    Construction, Industrie, Transport/logistique/supply chain, Pétrole/gaz/mines,
    Énergie et services publics, Services professionnels, Commerce de gros,
    puis le reste par ordre alpha

Sélection include/exclude :
  - Par défaut, cliquer un secteur l'ajoute en mode "include" (fond vert clair)
  - Bouton toggle visible au hover/focus pour basculer include ↔ exclude
  - Secteur exclu = fond rouge clair + icône ✗
  - Un secteur peut être désélectionné en recliquant dessus

Raccourci "Sélectionner tout" par catégorie :
  - Quand une catégorie est filtrée, un lien "Tout inclure (12)" apparaît en haut de la liste
  - Cliquer → inclut tous les secteurs visibles de cette catégorie d'un coup
  - Ne PAS proposer ce raccourci quand "Toutes" est sélectionné (trop de secteurs)

Tags de sélection (sous le bouton trigger quand fermé) :
  - Chaque secteur sélectionné = un tag avec son label_fr
  - Tag vert = include, tag rouge = exclude
  - Croix de suppression sur chaque tag
  - Si > 5 tags : afficher les 3 premiers + "+N autres" cliquable (ouvre le dropdown)

Données source :
  - Charger depuis GET /api/prospector/reference/sectors (voir §4)
  - Réponse attendue : SectorEntry[] (id, label_fr, parent_category, verified)
  - Cache côté client (React Query, staleTime: Infinity — les secteurs ne changent pas)
```

**`<GeoSearch>`** — autocomplete géographique
```
- Input texte → filtre en temps réel la liste linkedin_geos
- Résultats groupés : 🌍 Pays > 🗺️ Régions > 🏙️ Villes
- Clic sur un résultat → ajoute un tag (include par défaut)
- Toggle include/exclude sur les tags existants
- Si aucun résultat : afficher "Aucune zone trouvée — la recherche au niveau
  département n'est pas disponible sur LinkedIn"
```

**`<HeadcountPicker>`** — sélection des tranches
```
- 8 options affichées comme pills/checkboxes
- Sélection multiple, style pill actif = vert
```

**`<SeniorityPicker>`** — 3 états par niveau
```
10 niveaux avec cycle :
  Neutre (gris) → clic → Inclus (vert, icône ✓) → clic → Exclu (rouge, icône ✗) → clic → Neutre
```

**`<KeywordTagInput>`** — tags simples positifs
```
- Identique à SalesNavTagInput mais SANS mode exclude
- Compteur "X/5 mots-clés" visible
- Input disabled quand 5 tags atteints
- Tooltip sur chaque tag au hover (explication du terme)
```

**`<SalesNavUrlPreview>`** — prévisualisation URL
```
- Reçoit `criteria: CampaignCriteria` en prop
- Appelle buildSalesNavUrl() en local (SANS appel API)
- Affiche l'URL tronquée (max 120 chars visible + tooltip complet au hover)
- Bouton "Tester dans Sales Navigator" → window.open(url, '_blank')
- Badge "⚠️ Aucun filtre actif" si criteria vide
- Indicateur de nombre de filtres actifs (ex: "3 filtres actifs")
```

### 7.4 State management

```typescript
// useReducer ou Zustand local à la page (pas de Redux)

// 🐛 FIX AUDIT 16/04/2026 : type séparé pour éviter la référence circulaire
// errors: Partial<Record<keyof CampaignFormState, string>> référencerait CampaignFormState elle-même
type CampaignFormErrors = Partial<Record<
  'name' | 'priority' | 'status' | 'targetCount' | 'criteria' | 'messageTemplate',
  string
>>;

interface CampaignFormState {
  // Section 1
  name: string;
  priority: number;
  status: CampaignStatus;
  targetCount: number | null;

  // Section 2 — critères SalesNav
  criteria: CampaignCriteria;

  // Section 3 & 4
  messageTemplate: string;

  // UI state
  isDirty: boolean;
  isSubmitting: boolean;
  errors: CampaignFormErrors; // type séparé — évite la référence circulaire keyof CampaignFormState
}

// L'URL est calculée sans état (dérivée de criteria)
const generatedUrl = useMemo(() => buildSalesNavUrl(form.criteria), [form.criteria]);

// Helper : vérifier si criteria est vide
const isCriteriaEmpty = (c: CampaignCriteria) =>
  !c.jobTitles?.length &&
  !c.seniorities?.length &&
  !c.geoIds?.length &&
  !c.sectorIds?.length &&
  !c.headcounts?.length &&
  !c.keywords?.length;
```

---

## 8. Schéma Supabase — Migrations

```sql
-- ============================================================
-- MIGRATION 1 : Extension de la table campaigns
-- ============================================================
-- ⚠️ criteria JSONB existe déjà — ADD COLUMN IF NOT EXISTS est un no-op sûr
-- ⚠️ priority INTEGER existe déjà — idem
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS criteria         JSONB    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sales_nav_url    TEXT,
  ADD COLUMN IF NOT EXISTS priority         INTEGER  DEFAULT 3,
  ADD COLUMN IF NOT EXISTS message_template TEXT,
  ADD COLUMN IF NOT EXISTS target_count     INTEGER;

-- Supprimer le champ déprécié (remplacé par criteria.jobTitles[].type = 'exclude')
ALTER TABLE campaigns
  DROP COLUMN IF EXISTS excluded_keywords;

-- ============================================================
-- MIGRATION 2 : Ajout de 'Hors séquence' au CHECK constraint prospects
-- ============================================================
-- Le statut 'Hors séquence' est nouveau — absent du CHECK constraint actuel (migration 13)
ALTER TABLE prospects
  DROP CONSTRAINT IF EXISTS prospects_status_check;

ALTER TABLE prospects
  ADD CONSTRAINT prospects_status_check CHECK (status IN (
    'Profil à valider',
    'Non pertinent',
    'Nouveau',
    'Invitation envoyée',
    'Invitation acceptée',
    'Message à valider',
    'Message à envoyer',
    'Message envoyé',
    'Discussion en cours',
    'Gagné',
    'Perdu',
    'Profil restreint',
    'Hors séquence'
  ));

-- ============================================================
-- MIGRATION 3 : Index UNIQUE sur linkedin_url pour éviter les doublons en concurrence
-- ============================================================
-- Partiel (WHERE NOT NULL) car linkedin_url est nullable (profils non visibles lors du scraping)
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_unique_linkedin_url
  ON prospects (account_id, linkedin_url)
  WHERE linkedin_url IS NOT NULL;

-- ============================================================
-- MIGRATION 4 : Tables de référence LinkedIn
-- ============================================================
CREATE TABLE IF NOT EXISTS linkedin_sectors (
  id               INTEGER PRIMARY KEY,
  label_fr         TEXT    NOT NULL UNIQUE, -- label exact du typeahead Sales Nav (= text: dans l'URL INDUSTRY)
  parent_category  TEXT    NOT NULL,        -- catégorie parent Sales Nav (clé EN — voir §6.1 SECTOR_PARENT_CATEGORIES)
  verified         BOOLEAN DEFAULT FALSE,   -- true = ID confirmé en live sur Sales Nav
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
-- ⚠️ UNIQUE sur label_fr → empêche les doublons d'étiquette à la source
-- ⚠️ label_fr DOIT correspondre EXACTEMENT au typeahead Sales Nav (il est utilisé comme text: dans l'URL)

CREATE TABLE IF NOT EXISTS linkedin_geos (
  id        VARCHAR(20) PRIMARY KEY,
  label_fr  VARCHAR(100) NOT NULL,
  label_en  VARCHAR(100),
  geo_type  VARCHAR(20) NOT NULL CHECK (geo_type IN ('COUNTRY', 'REGION', 'CITY')),
  parent_id VARCHAR(20) REFERENCES linkedin_geos(id)
);

-- Index full-text pour la recherche dans les composants frontend
CREATE INDEX IF NOT EXISTS idx_linkedin_geos_fts
  ON linkedin_geos USING gin(to_tsvector('french', label_fr));

CREATE INDEX IF NOT EXISTS idx_linkedin_sectors_fts
  ON linkedin_sectors USING gin(to_tsvector('french', label_fr));

-- ============================================================
-- RLS : Tables de référence — lecture publique pour tous les utilisateurs authentifiés
-- (données partagées entre tous les comptes, pas de filtrage account_id)
-- ============================================================
ALTER TABLE linkedin_sectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "linkedin_sectors_read" ON linkedin_sectors
  FOR SELECT TO authenticated USING (true);

ALTER TABLE linkedin_geos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "linkedin_geos_read" ON linkedin_geos
  FOR SELECT TO authenticated USING (true);

-- ============================================================
-- MIGRATION 5 : Mise à jour des 4 campagnes actives vers le nouveau format criteria
-- (données migrées manuellement — pas de conversion automatique possible)
-- ============================================================

-- PME/ETI Transport FR (compte Vincent : 411c4b67-6247-43bb-9800-8fc8e5d070f6)
UPDATE campaigns SET
  criteria = '{
    "jobTitles": [
      {"value": "Directeur Qualité", "type": "include"},
      {"value": "Directeur général", "type": "include"},
      {"value": "Directeur QHSE", "type": "include"},
      {"value": "Responsable QHSE", "type": "include"},
      {"value": "Ingénieur HSE", "type": "include"},
      {"value": "Directeur environnement", "type": "include"},
      {"value": "Responsable RSE", "type": "include"},
      {"value": "Directeur RSE", "type": "include"},
      {"value": "Responsable qualité", "type": "include"},
      {"value": "Directeur des opérations", "type": "include"},
      {"value": "Directeur HSE", "type": "include"},
      {"value": "Responsable HSE", "type": "include"},
      {"value": "Directeur administratif et financier", "type": "include"},
      {"value": "Alternant", "type": "exclude"},
      {"value": "Stagiaire", "type": "exclude"},
      {"value": "Junior", "type": "exclude"}
    ],
    "seniorities": [
      {"code": "OWNER_PARTNER", "type": "include"},
      {"code": "C_LEVEL",       "type": "include"},
      {"code": "VP",            "type": "include"},
      {"code": "DIRECTOR",      "type": "include"},
      {"code": "MANAGER_SR",    "type": "include"},
      {"code": "MANAGER_JR",    "type": "include"},
      {"code": "STRATEGIC",     "type": "include"},
      {"code": "SENIOR",        "type": "include"},
      {"code": "ENTRY",         "type": "exclude"},
      {"code": "TRAINEE",       "type": "exclude"}
    ],
    "geoIds": [
      {"id": "105015875", "text": "France", "type": "include"}
    ],
    "sectorIds": [
      {"id": 116, "label": "Transport, logistique, chaîne logistique et stockage", "type": "include"}
    ],
    "headcounts": ["C","D","E","F","G","H","I"],
    "keywords": ["Bilan carbone", "Empreinte carbone", "Bilan GES", "Impact environnemental"]
  }',
  priority = 1,
  status = 'En cours'
WHERE id = (
  SELECT id FROM campaigns
  WHERE account_id = '411c4b67-6247-43bb-9800-8fc8e5d070f6'
  AND name ILIKE '%Transport%'
  LIMIT 1
);

-- BTP Hauts-de-France (compte Nathan : c6cceb81-11e9-4bae-8b09-c55490d79646)
UPDATE campaigns SET
  criteria = '{
    "jobTitles": [
      {"value": "Directeur Qualité", "type": "include"},
      {"value": "Directeur général", "type": "include"},
      {"value": "Directeur QHSE", "type": "include"},
      {"value": "Responsable QHSE", "type": "include"},
      {"value": "Ingénieur HSE", "type": "include"},
      {"value": "Directeur environnement", "type": "include"},
      {"value": "Responsable RSE", "type": "include"},
      {"value": "Directeur RSE", "type": "include"},
      {"value": "Responsable qualité", "type": "include"},
      {"value": "Responsable achats", "type": "include"},
      {"value": "Directeur achats", "type": "include"},
      {"value": "Directeur HSE", "type": "include"},
      {"value": "Responsable HSE", "type": "include"},
      {"value": "Alternant", "type": "exclude"},
      {"value": "Stagiaire", "type": "exclude"},
      {"value": "Junior", "type": "exclude"}
    ],
    "seniorities": [
      {"code": "OWNER_PARTNER", "type": "include"},
      {"code": "C_LEVEL",       "type": "include"},
      {"code": "VP",            "type": "include"},
      {"code": "DIRECTOR",      "type": "include"},
      {"code": "MANAGER_SR",    "type": "include"},
      {"code": "MANAGER_JR",    "type": "include"},
      {"code": "STRATEGIC",     "type": "include"},
      {"code": "SENIOR",        "type": "include"},
      {"code": "ENTRY",         "type": "exclude"},
      {"code": "TRAINEE",       "type": "exclude"}
    ],
    "geoIds": [
      {"id": "105007536", "text": "Hauts-de-France", "type": "include"}
    ],
    "sectorIds": [
      {"id": 48,  "label": "Construction (général)", "type": "include"},
      {"id": 406, "label": "Construction de bâtiments", "type": "include"},
      {"id": 408, "label": "Construction de bâtiments résidentiels", "type": "include"},
      {"id": 413, "label": "Construction de bâtiments non résidentiels", "type": "include"},
      {"id": 51,  "label": "Génie civil", "type": "include"},
      {"id": 435, "label": "Travaux de construction spécialisés", "type": "include"},
      {"id": 436, "label": "Travaux de maçonnerie générale et gros œuvre", "type": "include"},
      {"id": 453, "label": "Travaux d installation électrique, plomberie", "type": "include"},
      {"id": 460, "label": "Travaux de finition de bâtiment", "type": "include"}
    ],
    "headcounts": ["C","D","E","F","G","H","I"],
    "keywords": ["Empreinte carbone chantier"]
  }',
  priority = 2,
  status = 'En suivi'
WHERE id = (
  SELECT id FROM campaigns
  WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646'
  AND name ILIKE '%BTP%'
  LIMIT 1
);

-- Brasseries / Agroalimentaire (compte Nathan)
UPDATE campaigns SET
  criteria = '{
    "jobTitles": [
      {"value": "Directeur Qualité", "type": "include"},
      {"value": "Directeur général", "type": "include"},
      {"value": "Directeur QHSE", "type": "include"},
      {"value": "Responsable QHSE", "type": "include"},
      {"value": "Ingénieur HSE", "type": "include"},
      {"value": "Directeur environnement", "type": "include"},
      {"value": "Responsable RSE", "type": "include"},
      {"value": "Directeur RSE", "type": "include"},
      {"value": "Responsable qualité", "type": "include"},
      {"value": "Responsable achats", "type": "include"},
      {"value": "Directeur achats", "type": "include"},
      {"value": "Directeur HSE", "type": "include"},
      {"value": "Responsable HSE", "type": "include"},
      {"value": "Alternant", "type": "exclude"},
      {"value": "Stagiaire", "type": "exclude"},
      {"value": "Junior", "type": "exclude"}
    ],
    "seniorities": [
      {"code": "OWNER_PARTNER", "type": "include"},
      {"code": "C_LEVEL",       "type": "include"},
      {"code": "VP",            "type": "include"},
      {"code": "DIRECTOR",      "type": "include"},
      {"code": "MANAGER_SR",    "type": "include"},
      {"code": "MANAGER_JR",    "type": "include"},
      {"code": "STRATEGIC",     "type": "include"},
      {"code": "SENIOR",        "type": "include"},
      {"code": "ENTRY",         "type": "exclude"},
      {"code": "TRAINEE",       "type": "exclude"}
    ],
    "geoIds": [
      {"id": "105015875", "text": "France", "type": "include"}
    ],
    "sectorIds": [
      {"id": 142, "label": "Fabrication de boissons", "type": "include"}
    ],
    "headcounts": ["C","D","E","F","G","H","I"],
    "keywords": ["ACV", "Empreinte carbone produit"]
  }',
  message_template = 'Ne pas prospecter la brasserie Castelain.',
  priority = 3,
  status = 'En suivi'
WHERE id = (
  SELECT id FROM campaigns
  WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646'
  AND name ILIKE '%Brasserie%'
  LIMIT 1
);

-- Industriels - Bretagne (compte Nathan)
-- 🐛 FIX AUDIT 16/04/2026 : id:132 = "E-Learning Providers" (erreur!) → id:3198 = "Industrie automobile" (vérifié ✅)
UPDATE campaigns SET
  criteria = '{
    "jobTitles": [
      {"value": "Directeur Qualité", "type": "include"},
      {"value": "Directeur général", "type": "include"},
      {"value": "Directeur QHSE", "type": "include"},
      {"value": "Responsable QHSE", "type": "include"},
      {"value": "Ingénieur HSE", "type": "include"},
      {"value": "Directeur environnement", "type": "include"},
      {"value": "Responsable RSE", "type": "include"},
      {"value": "Directeur RSE", "type": "include"},
      {"value": "Responsable qualité", "type": "include"},
      {"value": "Responsable achats", "type": "include"},
      {"value": "Directeur achats", "type": "include"},
      {"value": "Directeur HSE", "type": "include"},
      {"value": "Responsable HSE", "type": "include"},
      {"value": "Directeur administratif et financier", "type": "include"},
      {"value": "Alternant", "type": "exclude"},
      {"value": "Stagiaire", "type": "exclude"},
      {"value": "Junior", "type": "exclude"}
    ],
    "seniorities": [
      {"code": "OWNER_PARTNER", "type": "include"},
      {"code": "C_LEVEL",       "type": "include"},
      {"code": "VP",            "type": "include"},
      {"code": "DIRECTOR",      "type": "include"},
      {"code": "MANAGER_SR",    "type": "include"},
      {"code": "MANAGER_JR",    "type": "include"},
      {"code": "STRATEGIC",     "type": "include"},
      {"code": "SENIOR",        "type": "include"},
      {"code": "ENTRY",         "type": "exclude"},
      {"code": "TRAINEE",       "type": "exclude"}
    ],
    "geoIds": [
      {"id": "103737322", "text": "Bretagne", "type": "include"}
    ],
    "sectorIds": [
      {"id": 25,   "label": "Industrie manufacturière", "parent_category": "Manufacturing", "type": "include"},
      {"id": 3198, "label": "Industrie automobile", "parent_category": "Manufacturing", "type": "include"},
      {"id": 135,  "label": "Fabrication de machines industrielles", "parent_category": "Manufacturing", "type": "include"},
      {"id": 918,  "label": "Fabrication de machines pour le commerce et les industries de services", "parent_category": "Manufacturing", "type": "include"},
      {"id": 1187, "label": "Commerce de gros d'équipements industriels", "parent_category": "Wholesale", "type": "include"}
    ],
    "headcounts": ["C","D","E","F","G","H","I"],
    "keywords": ["Bilan carbone", "Empreinte carbone", "Bilan GES", "Impact environnemental"]
  }',
  priority = 1,
  status = 'En cours'
WHERE id = (
  SELECT id FROM campaigns
  WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646'
  AND name ILIKE '%Industriels%'
  LIMIT 1
);

-- Supprimer les campagnes archivées (test et campagnes obsolètes)
DELETE FROM campaigns
WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646'
  AND status = 'Archivée';
-- ⚠️ Vérifier le résultat avant d'exécuter :
-- SELECT id, name, status FROM campaigns WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646';
```

---

## 9. Tests à écrire

### Backend (Jest) — buildSalesNavUrl

```typescript
describe('buildSalesNavUrl', () => {
  it('génère une URL avec GEO + INDUSTRY + HEADCOUNT', () => {
    const url = buildSalesNavUrl({
      geoIds: [{ id: '104246759', text: 'Île-de-France, France', type: 'include' }],
      // 🐛 FIX AUDIT 16/04/2026 : id:47 → id:48 (Construction confirmé en live)
      sectorIds: [{ id: 48, label: 'Construction', parent_category: 'Construction', type: 'include' }],
      headcounts: ['D', 'E'],
      jobTitles: [], seniorities: []
    });
    expect(url).toContain('type:GEO');
    expect(url).toContain('id:104246759');
    expect(url).toContain('type:INDUSTRY');
    expect(url).toContain('id:48');
    // 🐛 FIX AUDIT 16/04/2026 : text: OBLIGATOIRE pour INDUSTRY (vérifié en live)
    expect(url).toContain('text:Construction');   // ⚠️ text: OBLIGATOIRE pour INDUSTRY
    expect(url).toContain('type:COMPANY_HEADCOUNT');
    expect(url).toContain('id:D');
    expect(url).toMatch(/\/sales\/search\/people/);
  });

  // 🐛 FIX AUDIT 16/04/2026 : nouveau test — INDUSTRY DOIT inclure text: (vérifié en live)
  it('inclut text: obligatoire pour INDUSTRY (sinon filtre silencieusement ignoré)', () => {
    const url = buildSalesNavUrl({
      sectorIds: [{ id: 3197, label: 'Matériaux de construction', parent_category: 'Wholesale', type: 'include' }],
      geoIds: [], jobTitles: [], headcounts: [], seniorities: []
    });
    expect(url).toContain('type:INDUSTRY');
    expect(url).toContain('id:3197');
    // Sans text:, Sales Nav affiche 25M+ résultats = aucun filtre actif
    expect(url).toContain('text:');
    expect(url).toContain('text:Mat%C3%A9riaux%20de%20construction');
    expect(url).toContain('selectionType:INCLUDED');
  });

  it('encode correctement TOUS les accents français', () => {
    const url = buildSalesNavUrl({
      geoIds: [{ id: '102203735', text: "Provence-Alpes-Côte d'Azur", type: 'include' }],
      jobTitles: [{ value: 'Responsable HSE', type: 'include' }],
      sectorIds: [], headcounts: [], seniorities: []
    });
    // Aucun caractère accentué ne doit apparaître littéralement dans l'URL
    expect(url).not.toMatch(/[éèêîôçàùÉÈÊÎÔÇÀÙœæûâ]/);
    expect(url).toContain('type:CURRENT_TITLE');
    // "Côte" doit être encodé
    expect(url).toContain('%C3%B4'); // ô
  });

  // 🐛 FIX AUDIT 16/04/2026 : id:6 était incorrect → id:220 (confirmé en live)
  it('utilise les IDs numériques 3 chiffres pour SENIORITY_LEVEL avec text: obligatoire', () => {
    const url = buildSalesNavUrl({
      seniorities: [{ code: 'DIRECTOR', type: 'include' }],
      geoIds: [], jobTitles: [], sectorIds: [], headcounts: []
    });
    expect(url).toContain('type:SENIORITY_LEVEL');
    expect(url).toContain('id:220');           // ✅ ID confirmé en live le 16/04/2026
    expect(url).toContain('text:Directeur');   // ⚠️ text: OBLIGATOIRE pour SENIORITY_LEVEL
    expect(url).not.toContain('id:DIRECTOR'); // NE DOIT PAS utiliser le string code
    expect(url).not.toContain('id:6');         // NE DOIT PAS utiliser l'ancien ID 1-10
  });

  it('génère un filtre CURRENT_TITLE avec include ET exclude', () => {
    const url = buildSalesNavUrl({
      jobTitles: [
        { value: 'Directeur HSE', type: 'include' },
        { value: 'stagiaire', type: 'exclude' }
      ],
      geoIds: [], sectorIds: [], headcounts: [], seniorities: []
    });
    expect(url).toContain('selectionType:INCLUDED');
    expect(url).toContain('selectionType:EXCLUDED');
  });

  it('inclut recentSearchParam et spellCorrectionEnabled', () => {
    const url = buildSalesNavUrl({ geoIds: [], jobTitles: [], sectorIds: [], headcounts: [], seniorities: [] });
    expect(url).toContain('recentSearchParam:(doLogHistory:true)');
    expect(url).toContain('spellCorrectionEnabled:true');
  });

  it('encapsule les keywords multi-mots entre guillemets encodés', () => {
    const url = buildSalesNavUrl({
      geoIds: [], jobTitles: [], sectorIds: [], headcounts: [], seniorities: [],
      keywords: ['Bilan Carbone', 'RSE']
    });
    expect(url).toContain('keywords:');
    // "Bilan Carbone" encodé avec guillemets
    expect(url).toContain('%22Bilan%20Carbone%22');
  });

  it('retourne une URL structurellement valide même avec criteria vide', () => {
    const url = buildSalesNavUrl({ geoIds: [], jobTitles: [], sectorIds: [], headcounts: [], seniorities: [] });
    expect(url).toMatch(/^https:\/\/www\.linkedin\.com\/sales\/search\/people\?query=\(/);
    // Pas de filters:List() vide
    expect(url).not.toContain('filters:List()');
  });
});
```

### Frontend (React Testing Library)
- `<SalesNavTagInput>` : ajouter tag include, ajouter tag exclude, supprimer tag, Enter = inclure par défaut
- `<SeniorityPicker>` : cycle 3 états sur un niveau (neutre → inclus → exclu → neutre)
- `<GeoSearch>` : taper "Paris" → sélectionner → tag créé ; taper "Seine-Saint-Denis" → message "département non disponible"
- `<KeywordTagInput>` : blocage à 5 tags
- `<SalesNavUrlPreview>` : URL mise à jour quand criteria change (debounce 300ms)
- Formulaire complet : soumettre avec criteria vide → bouton disabled + message d'erreur
- Formulaire complet : soumettre avec criteria rempli → `criteria` correctement structuré dans la requête

---

## 10. Priorités d'implémentation

1. **Types TypeScript** — `CampaignCriteria`, `SeniorityCode`, `HeadcountCode`, `SENIORITY_URL_ID_MAP`
2. **Utilitaire `buildSalesNavUrl`** — partagé backend + frontend, avec tests unitaires complets
3. **⚠️ Vérification manuelle des IDs** — tester SENIORITY_LEVEL, INDUSTRY et GEO sur une vraie URL Sales Navigator avant de seeder
4. **Seed Supabase** — 136 secteurs + géographies (pays/régions/villes)
5. **Endpoints backend** — POST/PUT campaigns (avec génération URL + validation criteria), GET reference/sectors, GET reference/geos
6. **Composants atomiques** — `SalesNavTagInput`, `SeniorityPicker`, `GeoSearch`, `HeadcountPicker`, `KeywordTagInput`
7. **`<SalesNavUrlPreview>`** — prévisualisation temps réel avec compteur de filtres actifs
8. **Formulaire `/campaigns/new`** complet assemblé avec validation
9. **Intégration API** — connexion aux endpoints existants (liste campagnes, prospects)

---

## 11. Points de vigilance Sales Navigator — URL

1. **L'URL doit être testée manuellement** après génération — LinkedIn affiche 0 résultats sans erreur visible si un paramètre est incorrect
2. **`recentSearchParam:(doLogHistory:true)`** est obligatoire dans le query string
3. **`CURRENT_TITLE` ne prend pas d'`id:`** — uniquement `text:` — ne pas confondre avec les autres filtres
4. **`SENIORITY_LEVEL` utilise des IDs numériques dans la plage 100-320** (pas 1-10 et pas les string codes — les deux retournent 0 résultats sans erreur visible). IDs confirmés le 16/04/2026 : voir §5.2. <!-- 🐛 FIX AUDIT : "(1-10)" était incorrect -->
5. **`INDUSTRY` requiert OBLIGATOIREMENT `id:` ET `text:`** — vérifié en live le 16/04/2026. Sans `text:`, le filtre est **silencieusement ignoré** (25M+ résultats = aucun filtre). Format : `(id:48,text:Construction,selectionType:INCLUDED)`. Le `text:` doit correspondre au label français du typeahead Sales Navigator. <!-- 🐛 FIX AUDIT 16/04/2026 : INDUSTRY nécessite text: -->
6. **`encodeURIComponent` sur toutes les valeurs texte** — un seul caractère accentué non encodé = 0 résultats sans message d'erreur
7. **Les GeoUrns sont des IDs numériques** (ex: `104246759`) — les préfixes `urn:li:geo:` ne s'utilisent PAS dans les URLs de recherche Sales Nav
8. **Keywords multi-mots doivent être entre guillemets** dans l'URL pour une recherche exacte
9. **Limite LinkedIn Sales Navigator :** 2 500 résultats maximum par recherche, quels que soient les filtres

---

## 12. Spécifications de navigation Claude (Task 1 — Scraping)

Cette section décrit le comportement attendu de Claude en mode Cowork lors du scraping Sales Navigator à partir de `Campaign.sales_nav_url`.

### 12.1 Pré-conditions et validation initiale

Avant de commencer le scraping, Claude doit vérifier :

```
1. Ouvrir campaign.sales_nav_url dans un onglet Chrome
2. Vérifier que LinkedIn Sales Navigator est CONNECTÉ :
   - Si la page redirige vers linkedin.com/login → ARRÊTER et notifier :
     "Session LinkedIn expirée. Veuillez vous reconnecter à Sales Navigator."
   - Si la page affiche "Upgrade to Sales Navigator" → ARRÊTER et notifier :
     "Accès Sales Navigator requis."
3. Vérifier que la recherche retourne des résultats :
   - Si "0 résultats" → ARRÊTER et notifier :
     "Aucun résultat pour cette campagne. Vérifiez les filtres ou testez l'URL manuellement."
   - Si Sales Navigator affiche une erreur ou CAPTCHA → ARRÊTER et notifier.
4. Confirmer le nombre total de résultats affiché par Sales Navigator
   (ex: "1 234 leads") avant de commencer.
```

### 12.2 Extraction des données par profil

Pour chaque carte de profil visible dans les résultats Sales Navigator, extraire :

```typescript
interface ScrapedProfile {
  first_name: string;      // Prénom (ex: "Jean")
  last_name: string;       // Nom (ex: "Dupont")
  job_title: string;       // Intitulé de poste actuel (ex: "Directeur HSE")
  company: string;         // Entreprise actuelle (ex: "Vinci Construction")
  geography: string;       // Localisation telle qu'affichée (ex: "Paris, Île-de-France, France")
  sales_nav_url: string;   // URL profil Sales Nav (commence par /sales/lead/...)
  linkedin_url?: string;   // URL profil LinkedIn standard (/in/...) — extraire si visible
  connection_degree: '1st' | '2nd' | '3rd+' | 'unknown';
}
```

**Règles d'extraction :**
- Extraire `sales_nav_url` depuis le lien du nom sur la carte → toujours disponible
- Extraire `linkedin_url` uniquement si un lien `/in/...` est directement visible — ne pas naviguer vers le profil pour l'obtenir (trop lent, risque détection)
- Les profils affichant "LinkedIn Member" (masqués) → **skipper** sans les enregistrer
- Les profils sans `job_title` visible → enregistrer avec `job_title: ""`

### 12.3 Pagination et limites

```
Règles de pagination :
- Chaque page Sales Navigator affiche 25 profils
- Pour passer à la page suivante : cliquer sur le bouton "Suivant" (>">) en bas de page
- Ne PAS modifier l'URL manuellement pour la pagination
- Arrêter la pagination si :
  a) target_count atteint (nombre de prospects non-doublons créés)
  b) 10 pages scrapées (= 250 profils max) pour éviter la détection
  c) Le bouton "Suivant" est absent/disabled (dernière page)
  d) Un CAPTCHA ou un avertissement LinkedIn apparaît

Temps d'attente entre les pages :
- Attendre que la page soit complètement chargée (tous les noms de profils visibles)
- Ajouter un délai de 2-3 secondes entre chaque clic "Suivant"
- Ne PAS scroller rapidement ou cliquer en rafale
```

### 12.4 Envoi vers le backend

Envoyer les profils en batches de **25 profils maximum** :

```
POST /api/prospector/sync
{
  "campaign_id": "...",
  "prospects": [ ...25 profils max... ]
}

→ Response: { "created": 22, "skipped": 3, "total": 25 }

Afficher un résumé après chaque batch :
"Page 1 : 22 nouveaux prospects créés (3 doublons ignorés)"
```

### 12.5 Gestion des cas d'erreur lors du scraping

| Situation | Comportement attendu |
|---|---|
| Session LinkedIn expirée | Arrêter immédiatement. Notifier l'utilisateur. |
| CAPTCHA affiché | Arrêter immédiatement. Notifier. Ne pas tenter de résoudre le CAPTCHA. |
| Profil masqué "LinkedIn Member" | Skipper ce profil, continuer. |
| 0 résultats de recherche | Arrêter. Suggérer d'assouplir les filtres. |
| Erreur API backend (5xx) | Stocker les profils en attente localement, réessayer après 30s max 2 fois, puis notifier. |
| Erreur réseau | Arrêter et notifier avec le nombre de profils déjà créés. |
| Modal/popup LinkedIn | Fermer la modal si possible (bouton "Fermer" / "Ignorer"), puis reprendre. |
| Résultats > 2 500 | Informer l'utilisateur que LinkedIn limite à 2 500 résultats et recommander d'affiner les filtres. |

### 12.6 Résumé final à présenter

```
À la fin du scraping, afficher :
"✅ Scraping terminé pour [nom de la campagne]
 → X prospects créés en statut 'Profil à valider'
 → Y doublons ignorés
 → Z profils masqués ignorés
 → Pages scrapées : N/10

 Prochaine étape : aller dans l'onglet Validation de la campagne
 pour valider ou rejeter chaque profil."
```

### 12.7 Limites à ne pas dépasser (anti-détection LinkedIn)

- **Maximum 250 profils par session** de scraping (10 pages × 25)
- **Maximum 1 session de scraping par heure** sur le même compte LinkedIn
- **Ne jamais cliquer sur les profils** pour accéder aux pages individuelles — extraire uniquement ce qui est visible dans les cartes de résultats
- **Ne pas scroller rapidement** — attendre le chargement complet de chaque page

---

## 13. Intégration avec le workflow Cowork existant

Une fois la campagne créée avec son `sales_nav_url`, le workflow complet est :

```
Task 1 — Scraping (automatisé par Claude)
  → Ouvrir campaign.sales_nav_url dans Sales Navigator
  → Extraire les profils visibles (§12)
  → POST /api/prospector/sync → prospects en "Profil à valider"

Task 2 — Validation manuelle (Nathan dans l'onglet Validation)
  → Valider → statut "Nouveau"
  → Rejeter → statut "Non pertinent"

Task 3 — Envoi invitations LinkedIn (automatisé par Claude)
  → GET /api/sequences/due-actions → liste des prospects "Nouveau"
  → Envoyer invitation LinkedIn pour chaque profil
  → POST /api/prospector/update-status → "Invitation envoyée"

Task 4 — Suivi acceptations (automatisé ou manuel)
  → Vérifier les nouvelles connexions
  → POST /api/prospector/update-status → "Invitation acceptée"

Task 5 — Génération messages (automatisé par Claude)
  → POST /api/sequences/generate-message avec message_template
  → Statut → "Message à valider"

Task 6 — Validation messages (Nathan)
  → Valider → "Message à envoyer"

Task 7 — Envoi messages (automatisé par Claude)
  → Envoyer message LinkedIn
  → POST /api/prospector/update-status → "Message envoyé"
```

Le champ `message_template` de la campagne est transmis à `POST /api/sequences/generate-message` dans le body sous `message_params.instructions`.

**Le lien entre le formulaire et le moteur d'exécution repose sur deux champs : `sales_nav_url` (où scraper) et `message_template` (comment rédiger les messages).**
