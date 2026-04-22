# Design — Import Emelia & suppression Task 1

**Date :** 2026-04-21  
**Branche :** `feat/emelia-import`  
**Statut :** Approuvé

---

## Contexte

La Task 1 (scraping Sales Navigator par manipulation DOM) est trop fragile et génère trop d'erreurs. Elle est remplacée par un workflow manuel : l'utilisateur scrape lui-même via Emelia, récupère un fichier `.xlsx` enrichi, et l'importe dans Prospector. Task 2 (séquence LinkedIn) reste inchangée.

---

## Nouveau workflow

```
[Campagne créée] → URL Sales Nav générée (inchangé)
       ↓
[User] → Emelia scrape l'URL → fichier .xlsx
       ↓
[Prospector] → Import du fichier (depuis campagne OU vue globale)
       ↓
[Serveur] → Parsing xlsx + nettoyage → rapport de rejets
       ↓
[User] → Confirme l'import
       ↓
[DB] → Prospects créés en statut "Profil à valider"
       ↓
[User] → Validation individuelle / select-all → statut "Nouveau"
       ↓
[Task 2] → Enrollment → Invitations → Messages → Suivi (inchangé)
```

---

## Ce qui change vs l'existant

| Composant | Avant | Après |
|---|---|---|
| Task 1 | Scraping Sales Nav DOM (2 phases) | **Supprimé** |
| Ingestion prospects | `POST /api/prospector/sync` | **Nouveau** `POST /api/prospector/import-emelia` |
| Statuts | 14 dont `scrapping_pending`, `Profil incomplet` | **12 statuts** (2 supprimés) |
| DB `prospects` | — | **+`linkedin_summary`**, **+`company_description`** |
| UI import | Import vanilla JS générique | **Nouveau composant React `EmeliaImportWizard`** |
| Dépendances | — | **+`multer`**, **+`xlsx`** |
| Skill Dispatch | `skill_prospector_V10.md` | **`skill_prospector_V11.md`** (sans Task 1) |

## Ce qui ne change pas

- Task 2 complète (séquence, invitations, messages, suivi)
- Vue de validation `Profil à valider` (checkboxes, select-all, bulk validate déjà opérationnels)
- Endpoint `/api/prospector/import` existant (import JSON générique conservé)
- Logique de dédup 3 niveaux (réutilisée)
- Statuts `Profil à valider` → `Nouveau` et toute la suite
- Quotas, locks, sequences

---

## Format du fichier Emelia

Fichier `.xlsx` exporté par Emelia. Colonnes utilisées :

| Colonne Emelia | Champ Prospector | Notes |
|---|---|---|
| `firstName` | `first_name` | Requis |
| `lastName` | `last_name` | |
| `linkedinUrlProfile` | `linkedin_url` | Format ID LinkedIn (`/in/ACwAABR...`) — LinkedIn résout vers slug lors de la navigation |
| `title` | `job_title` | Requis (voir règles rejet) |
| `company` | `company` | Requis (voir règles rejet) |
| `industry` | `sector` | |
| `location` | `geography` | |
| `summary` + `description` | `linkedin_summary` | Concaténés : `summary\n\n---\n\ndescription` |
| `companyDescription` | `company_description` | |

Colonnes ignorées : `id`, `fullName`, `isPremium`, `openProfile`, `companyId`, `companyLocation`, `companySize`, `estimatedMinRevenue`, `estimatedMaxRevenue`, `companyPage`, `companyWebsite`, `type`.

---

## Backend

### Nouvelles dépendances

```
multer   — parsing multipart/form-data (upload fichier)
xlsx     — parsing fichier .xlsx côté serveur
```

### Migration DB

```sql
-- Nouvelles colonnes
ALTER TABLE prospects ADD COLUMN linkedin_summary TEXT;
ALTER TABLE prospects ADD COLUMN company_description TEXT;

-- Migration statuts Task 1 obsolètes avant suppression
UPDATE prospects
SET status = 'Profil à valider'
WHERE status IN ('scrapping_pending', 'Profil incomplet');
```

### Endpoint : `POST /api/prospector/import-emelia`

**Auth :** middleware `accountContext` (identique aux routes protégées existantes).

**Input :** `multipart/form-data`
- `file` — fichier `.xlsx`
- `campaign_id` — UUID (requis)
- `dry_run` — boolean (optionnel, défaut `false`)

**Mode dry_run :** Si `dry_run=true`, le serveur parse, nettoie et retourne le rapport (imported/rejected) **sans insérer en DB**. C'est ce mode que l'UI utilise à l'étape 1 (Analyser). L'étape 2 (Confirmer) renvoie la même requête avec `dry_run=false` pour déclencher l'insertion réelle.

**Traitement (dans l'ordre) :**

1. Parse le fichier xlsx → tableau de lignes via `xlsx`
2. **Règles de rejet** — ligne rejetée si :
   - `firstName` vide ou absent
   - `title` ET `company` tous les deux vides
   - `linkedinUrlProfile` absent
   - Doublon : `linkedin_url` déjà présente dans les prospects actifs du compte (toutes campagnes)
3. **Normalisation** des lignes acceptées :
   - `linkedin_url` ← `linkedinUrlProfile` (stocké tel quel, pas de transformation)
   - `linkedin_summary` ← `summary + "\n\n---\n\n" + description` si les deux présents, sinon le non-vide
   - `company_description` ← `companyDescription`
   - `sector` ← `industry`
   - `geography` ← `location`
4. **Insertion** batch via `supabaseAdmin`, `account_id` injecté depuis `req.accountId`, `campaign_id` depuis le body, statut = `'Profil à valider'`
5. **Réponse :**

```json
{
  "imported": 47,
  "rejected": 3,
  "rejections": [
    { "row": 2, "name": "Yan Guiselin", "reason": "Titre de poste manquant" },
    { "row": 5, "name": "Anne Dupont",  "reason": "Doublon (déjà dans un compte actif)" },
    { "row": 9, "name": "(inconnu)",    "reason": "Prénom manquant" }
  ]
}
```

### Suppression infrastructure Task 1

Supprimer de `server.js` :
- `POST /api/prospector/sync` (~lignes 4218–4383)
- `GET /api/prospector/prospects/incomplete` (~ligne 4386)
- `PATCH /api/prospector/prospects/:id/enrich` (~ligne 4412)
- Constantes scraping : `MAX_ENRICHMENTS_PER_CAMPAIGN`, `BREAK_EVERY_N_VISITS`, `BREAK_DURATION_MS`

Supprimer du code client `prospector.js` :
- Appels à `/api/prospector/sync` et `/api/prospector/prospects/incomplete`
- Références aux statuts `scrapping_pending` et `Profil incomplet`

---

## Frontend

### Composant : `EmeliaImportWizard`

**Fichier :** `src/components/campaigns/EmeliaImportWizard.jsx`

Wizard en 3 étapes :

**Étape 1 — Upload**
- Zone drag & drop + bouton "Parcourir" (accepte `.xlsx` uniquement)
- Si lancé depuis une campagne : `campaign_id` pré-rempli, affiché en lecture seule
- Si lancé depuis la vue globale : dropdown de sélection de campagne (obligatoire avant de continuer)
- Bouton "Analyser le fichier" → `POST /api/prospector/import-emelia` avec le fichier

**Étape 2 — Aperçu avant import**
- Affiche le résultat du parsing serveur : nombre de prospects prêts + liste des rejets avec raisons
- Bouton "Confirmer l'import" → déclenche l'insertion en DB
- Bouton "Annuler"

**Étape 3 — Confirmation**
- Résumé : "X prospects ajoutés en statut Profil à valider"
- Lien direct vers la vue de validation (`#prospects?status=Profil%20à%20valider`)

### Points d'entrée

- **Depuis la page campagne :** bouton "Importer fichier Emelia" (masqué si statut `Terminée` ou `Archivée`)
- **Depuis la vue globale Prospector :** bouton "Importer" dans le header avec sélecteur de campagne

### Vue de validation (aucune modification nécessaire)

La vue `Profil à valider` est **déjà complète** :
- Checkboxes individuelles par prospect
- "Tout sélectionner" (`toggleSelectAll` — [prospector.js:535](../../../public/js/prospector.js#L535))
- Barre d'actions bulk activée sur le filtre "Profil à valider" ([prospector.js:556](../../../public/js/prospector.js#L556))
- Bouton "Valider" → `bulkValidate()` → statut `Nouveau`
- Modal de confirmation pour >= 2 prospects + undo

---

## Skill Dispatch

- `skill_prospector_V10.md` → renommé `skill_prospector_V10_backup.md` (archivé, non utilisé)
- `skill_prospector_V11.md` → créé sans aucune mention de Task 1 ni du workflow de scraping

---

## Risques & points de vigilance

| Risque | Mitigation |
|---|---|
| LinkedIn ID URLs (`/in/ACwAABR...`) non résolues en DB — Task 2 navigue vers ces URLs | À valider manuellement : coller une URL Emelia dans Chrome et vérifier la redirection vers le slug |
| Prospects existants en `scrapping_pending` ou `Profil incomplet` | Migration SQL avant de supprimer les statuts du code |
| Import d'un gros fichier (100+ lignes) | Parsing côté serveur avec `xlsx` — pas de limite côté client |
| Doublons cross-campagnes non détectés | La dédup couvre tous les prospects actifs du compte (`account_id`) |
| `company_description` et `linkedin_summary` NULL pour les prospects créés avant cette feature | Acceptable — ces champs sont optionnels pour Task 2 |
