# Releaf Prospector — Brief d'implémentation

## Contexte

Ce document décrit l'implémentation d'un module CRM de prospection LinkedIn appelé **Releaf Prospector**, à intégrer dans la webapp existante de Releaf Carbon.

Les screenshots de référence visuelle sont dans ce même dossier `/docs/prospector/` :
- `01-dashboard.png` — Dashboard (partie haute)
- `02-dashboard-scroll.png` — Dashboard (partie basse, activité récente)
- `03-prospects.png` — Liste des prospects
- `04-campagnes.png` — Liste des campagnes
- `05-imports.png` — Centre d'import
- `06-rappels.png` — Page des rappels

---

## Stack existante (ne pas modifier)

- **Backend** : Node.js + Express (`server.js`) — API proxy vers Qonto, Notion, HubSpot, Google Sheets
- **Frontend** : Vanilla JS + HTML/CSS dans `public/index.html` avec Chart.js
- **BDD** : Supabase (PostgreSQL) — déjà configuré dans le projet
- **Hébergement** : Render

**Contrainte absolue** : pas de React, pas de framework frontend. Tout en Vanilla JS natif.

---

## Ce qu'il faut créer

### Nouveaux fichiers à créer

```
public/
  prospector.html        ← app principale (SPA en vanilla JS)
  css/
    prospector.css       ← styles dédiés au module
  js/
    prospector.js        ← logique principale
    prospector-db.js     ← couche d'accès Supabase
    prospector-ui.js     ← composants UI réutilisables
```

### Modifications à apporter aux fichiers existants

- `server.js` : ajouter les routes API nécessaires (import CSV/JSON, endpoint d'ingestion Claude Dispatch)
- `public/index.html` : ajouter un lien de navigation vers `/prospector.html`

---

## Design system

Reproduire fidèlement le design des screenshots. Voici les valeurs exactes :

```css
/* Couleurs */
--color-primary: #2D6A4F;        /* vert forêt — boutons principaux, nav active, badges */
--color-primary-light: #B7E4C7;  /* vert sauge clair — backgrounds subtils */
--color-bg: #FFFFFF;
--color-surface: #F9FAFB;        /* fond des cards */
--color-border: #E5E7EB;
--color-text: #111827;
--color-text-muted: #6B7280;
--color-overdue: #EF4444;        /* rouge — rappels en retard */
--color-today: #F59E0B;          /* orange — rappels aujourd'hui */

/* Statuts prospects */
--status-nouveau: #3B82F6;       /* bleu */
--status-contacte: #F59E0B;      /* orange */
--status-discussion: #10B981;    /* vert clair */
--status-rdv: #1D4ED8;           /* bleu foncé */
--status-gagne: #2D6A4F;         /* vert foncé */
--status-perdu: #EF4444;         /* rouge */

/* Statuts campagnes */
--status-active: #2D6A4F;
--status-terminee: #B7E4C7;
--status-brouillon: #E5E7EB;
--status-pause: #F59E0B;

/* Typography */
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--font-size-xs: 12px;
--font-size-sm: 13px;
--font-size-base: 14px;
--font-size-lg: 16px;
--font-size-xl: 20px;
--font-size-2xl: 28px;

/* Spacing & layout */
--radius: 8px;
--radius-sm: 4px;
--shadow: 0 1px 3px rgba(0,0,0,0.08);
--shadow-md: 0 4px 12px rgba(0,0,0,0.1);
```

### Navbar (voir tous les screenshots)

- Logo "🌿 Releaf Prospector" à gauche (lien vers dashboard)
- Navigation centrale : Dashboard / Prospects / Campagnes / Imports / Rappels
- Lien actif : bouton vert foncé (#2D6A4F) avec texte blanc, border-radius 6px
- Liens inactifs : texte gris (#6B7280)
- Icône cloche 🔔 à droite avec badge rouge (count des rappels en retard + aujourd'hui)
- Hauteur navbar : 56px, bordure bottom légère, fond blanc

---

## Pages et fonctionnalités

### 1. Dashboard (`#dashboard`) — voir `01-dashboard.png` et `02-dashboard-scroll.png`

**4 stat cards en haut (grid 4 colonnes) :**
- Prospects cette semaine (icône 👥)
- Total prospects (icône 📤)
- Rappels en attente (icône 🕐)
- Campagnes actives (icône 📈)

**Layout principal : 2 colonnes (65% / 35%)**

**Colonne gauche — "Actions à faire" :**
- Liste des rappels dont `due_date <= aujourd'hui` (statut `pending`)
- Chaque item : nom prospect + badge type d'action | note | date (rouge si en retard) | bouton "Fait" | bouton "+3j"
- Bouton "Fait" → met le rappel en statut `done`
- Bouton "+3j" → snooze de 3 jours (due_date + 3j, statut reste `pending`)
- Voir `01-dashboard.png` pour le rendu exact

**Colonne droite — "Pipeline" :**
- Liste verticale des statuts avec count et badge coloré
- Nouveau / Contacté / En discussion / RDV planifié / Gagné / Perdu

**Section pleine largeur — "Activité récente" :**
- 10 dernières interactions (toutes confondues)
- Colonnes : date | badge type | nom prospect | description
- Voir `02-dashboard-scroll.png`

---

### 2. Prospects (`#prospects`) — voir `03-prospects.png`

**Header :** titre "Prospects" + bouton "Importer" (outline) + bouton "+ Ajouter" (vert plein)

**Barre de filtres :**
- Input recherche (placeholder: "Rechercher nom, entreprise, email...")
- Select "Tous les statuts"
- Select "Tous les secteurs"
- Select "Toutes les régions"

**Table :**
Colonnes : Nom (bold) | Entreprise | Secteur | Région | Statut (badge coloré) | Dernier contact | icône lien externe (ouvre LinkedIn URL dans nouvel onglet)

Clic sur une ligne → ouvre la page détail du prospect (`#prospect-detail?id=XXX`)

**Modal "Ajouter prospect" :**
Champs : Prénom, Nom, Entreprise, Poste, Email, Téléphone, LinkedIn URL, Secteur, Région, Campagne (select), Notes
Validation + détection doublon avant sauvegarde

---

### 3. Détail prospect (`#prospect-detail`)

**Profile card (haut de page) :**
- Nom complet (H1) + poste + entreprise
- Badges : secteur, région, campagne source
- Champs : email (cliquable mailto), téléphone, LinkedIn URL (lien externe)
- Sélecteur de statut (dropdown inline)
- Bouton "Modifier" + bouton "Supprimer"

**Bannière doublon :**
- Affichée si un prospect avec même email OU même LinkedIn URL OU même prénom+nom existe déjà
- Fond orange clair, texte "⚠️ Doublon potentiel détecté — [Nom du doublon]", lien vers le doublon

**Timeline interactions :**
- Liste chronologique inversée (plus récent en haut)
- Chaque entrée : date | badge type | description
- Bouton "+ Enregistrer une interaction" → modal avec champs : type (Ajout LinkedIn / Message envoyé / Email / Appel / Réunion), date, notes

**Section Rappels :**
- Liste des rappels liés à ce prospect
- Bouton "+ Ajouter un rappel" → modal : type, date, note
- Boutons Fait / +3j sur chaque rappel

**Notes libres :**
- Zone textarea auto-sauvegardée (debounce 1s)
- Sauvegardée dans le champ `notes` de la table `prospects`

---

### 4. Campagnes (`#campagnes`) — voir `04-campagnes.png`

**Header :** titre "Campagnes" + bouton "+ Nouvelle campagne"

**Table :**
Colonnes : Nom | Secteur | Géographie | Statut (badge) | Prospects (X / Y) | Créée le

Statuts : Active (vert) / Terminée (vert clair) / Brouillon (gris) / En pause (orange)

Clic sur une ligne → détail campagne avec liste des prospects liés + stats basiques

**Modal "Nouvelle campagne" :**
Champs : Nom, Secteur, Géographie, Template message (textarea), Objectif (nombre de prospects), Statut

---

### 5. Centre d'import (`#imports`) — voir `05-imports.png`

**Stepper 4 étapes** : 1. Upload → 2. Mapping → 3. Aperçu → 4. Terminé

**Étape 1 — Upload :**
- Zone drag & drop (tirets, icône upload, texte "Glissez-déposez votre fichier ici")
- Formats acceptés : CSV, JSON
- Bouton "Choisir un fichier"

**Étape 2 — Mapping :**
- Table avec colonnes source du fichier à gauche
- Select par ligne pour mapper vers les champs DB (prénom, nom, email, téléphone, LinkedIn URL, entreprise, poste, secteur, région, campagne)
- Prévisualisation de la première valeur de chaque colonne

**Étape 3 — Aperçu :**
- Table prévisualisant les N premières lignes mappées
- Section "Doublons détectés" : liste les lignes qui matchent un prospect existant (email OU LinkedIn URL OU prénom+nom)
- Options : "Ignorer les doublons" / "Mettre à jour les existants"
- Bouton "Lancer l'import"

**Étape 4 — Terminé :**
- Résumé : X importés / Y doublons ignorés / Z erreurs
- Bouton "Voir les prospects" → redirige vers #prospects

---

### 6. Rappels (`#rappels`) — voir `06-rappels.png`

**Header :** titre "Rappels" + filtre statut (dropdown : En attente / Fait / Snoozé)

**Liste des rappels triée par date :**
- En retard (fond rose clair) → badge rouge "En retard"
- Aujourd'hui → badge orange "Aujourd'hui"
- À venir → pas de badge
- Chaque item : nom prospect | badge type d'action | note | date | bouton ✓ Fait | bouton +3j

---

## Base de données Supabase

### Tables à créer

```sql
-- Prospects
CREATE TABLE prospects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  company TEXT,
  job_title TEXT,
  sector TEXT,
  geography TEXT,
  status TEXT DEFAULT 'Nouveau' CHECK (status IN ('Nouveau','Contacté','En discussion','RDV planifié','Gagné','Perdu')),
  score INTEGER DEFAULT 0,
  source_campaign_id UUID REFERENCES campaigns(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Campagnes
CREATE TABLE campaigns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  sector TEXT,
  geography TEXT,
  message_template TEXT,
  status TEXT DEFAULT 'Brouillon' CHECK (status IN ('Active','Terminée','Brouillon','En pause')),
  target_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Interactions
CREATE TABLE interactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  type TEXT CHECK (type IN ('Ajout LinkedIn','Message envoyé','Email','Appel','Réunion')),
  date DATE DEFAULT CURRENT_DATE,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Rappels
CREATE TABLE reminders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  due_date DATE NOT NULL,
  type TEXT,
  note TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','done','snoozed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Imports
CREATE TABLE imports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  filename TEXT,
  total_rows INTEGER DEFAULT 0,
  imported INTEGER DEFAULT 0,
  duplicates INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Note :** Créer `campaigns` avant `prospects` à cause de la foreign key.

---

## Routes Express à ajouter dans server.js

```javascript
// Toutes les routes CRUD sont gérées côté client via le SDK Supabase JS
// Seules routes custom nécessaires dans server.js :

// POST /api/prospector/import
// Reçoit un JSON array de prospects depuis Claude Dispatch
// Effectue la déduplication et l'insertion en masse
// Body : { prospects: [...], campaign_id: "uuid", skip_duplicates: true }
// Response : { imported: N, duplicates: N, errors: N }

// GET /api/prospector/export
// Export CSV de tous les prospects (avec filtres optionnels)
// Query params : status, sector, geography, campaign_id
```

---

## Endpoint d'ingestion Claude Dispatch

Claude Dispatch génère un fichier CSV ou JSON et doit pouvoir l'envoyer à la webapp.

**Format JSON attendu :**
```json
{
  "campaign_id": "uuid-optionnel",
  "skip_duplicates": true,
  "prospects": [
    {
      "first_name": "Jean",
      "last_name": "Dupont",
      "email": "jean.dupont@entreprise.fr",
      "linkedin_url": "https://linkedin.com/in/jeandupont",
      "company": "Entreprise SAS",
      "job_title": "Directeur Général",
      "sector": "Industrie",
      "geography": "Île-de-France"
    }
  ]
}
```

**Logique de déduplication :**
Un prospect est considéré doublon si l'un de ces critères matche un prospect existant :
1. `email` identique (non null)
2. `linkedin_url` identique (non null)
3. `first_name` + `last_name` identiques (insensible à la casse)

---

## Navigation SPA

L'app fonctionne en Single Page Application avec routing par hash :

```javascript
// Routes
#dashboard          → renderDashboard()
#prospects          → renderProspects()
#prospect-detail    → renderProspectDetail(id) // ?id=UUID en query param
#campagnes          → renderCampagnes()
#campaign-detail    → renderCampaignDetail(id)
#imports            → renderImports()
#rappels            → renderRappels()
```

Écouter `window.addEventListener('hashchange', router)` + appel initial au chargement.

---

## Ordre d'implémentation recommandé

1. **Créer les tables Supabase** (SQL ci-dessus)
2. **Créer `prospector.html`** avec navbar + structure SPA + routing hash
3. **Créer `prospector-db.js`** — toutes les fonctions CRUD Supabase
4. **Créer `prospector.css`** — design system complet
5. **Implémenter le Dashboard** (`renderDashboard`)
6. **Implémenter Prospects** (liste + modal ajout + détail)
7. **Implémenter Rappels** (liste + actions Fait/+3j)
8. **Implémenter Campagnes** (liste + modal création + détail)
9. **Implémenter Import** (stepper 4 étapes)
10. **Ajouter routes Express** dans `server.js`
11. **Tester l'endpoint d'ingestion** avec un JSON de test

---

## Notes importantes

- Réutiliser les variables d'environnement Supabase déjà présentes dans le projet (`SUPABASE_URL`, `SUPABASE_ANON_KEY`)
- Charger le SDK Supabase via CDN dans `prospector.html` : `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`
- Pas de build step, pas de bundler — tout en fichiers statiques servis par Express
- Le fichier `prospector.html` doit être accessible via la route `/prospector` dans `server.js`
- Utiliser `fetch` natif pour les appels à l'API interne, SDK Supabase pour la BDD
