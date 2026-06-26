# Spec — Onglet KPI : objectifs & avancement par partner

**Date :** 2026-06-26
**Branche :** `feat/kpi-partners`
**Auteur :** Nathan + Claude

## 1. Objectif

Reproduire dans l'application le tableau de suivi commercial/opérationnel (objectifs vs réalisé
par partner), sous forme de **bar charts** dans un **nouvel onglet « KPI »**.

Pour chaque partner et pour le total (« All »), on suit trois métriques sur l'année civile :

- **CA signé – Newsale** : CA des missions signées de type `Newsale`, attribué aux partners **commerciaux**.
- **CA signé – Upsale** : CA des missions signées de type `Upsale`, attribué aux partners **commerciaux**.
- **CA opéré** : CA des missions en cours/terminées, attribué aux partners **opérationnels**.

Chaque métrique compare un **Objectif** (saisi manuellement) à un **Réalisé / In progress** (calculé
depuis Notion), et affiche un **Taux d'avancement** = Réalisé / Objectif.

## 2. Décisions validées

| Sujet | Décision |
|---|---|
| Signé vs Opéré | Selon l'**état** de la mission |
| États « signé » | Tous sauf `Annulé` → partners **commerciaux** |
| États « opéré » | `En cours` + `Terminé` → partners **opérationnels** |
| Période | **Année civile** = année de **signature** (sélecteur d'année dans l'onglet) |
| Base d'année d'une mission | **`created_time`** de la page Notion (= date de création de la ligne ≈ date de signature). 100 % du CA affecté à cette année, décorrélé de la facturation. Aucune modif Notion requise. |
| Mapping type | `type_ca` Notion : libellés exacts `Newsale` / `Upsale` |
| `type_ca` vide / autre | **Ignoré** côté signé ; listé dans une alerte « missions non classées » |
| Répartition CA (2-3 partners) | Réglable manuellement ; **défaut = parts égales** (50/50, 33/33/33) |
| Split commercial vs opérationnel | **Séparés** (les deux listes de partners diffèrent) |
| Liste des partners | **Automatique** depuis les champs People de Notion |
| Objectifs | **Individuels** par partner ; **« All » = somme** (jamais saisi) |
| UI de réglage | Panneau « Réglages » dans l'onglet KPI |
| Stockage des données nouvelles | **Supabase** |
| Calcul d'attribution | **Côté serveur** (`server.js`) ; le front affiche uniquement |
| Placement | Nouvelle entrée **« KPI »** dans la sidebar |

## 3. Modèle de données (Supabase)

### Table `kpi_objectives`
Les objectifs individuels par partner / année / type.

| colonne | type | rôle |
|---|---|---|
| `id` | uuid (pk) | identifiant |
| `partner` | text | prénom du partner (tel que renvoyé par Notion) |
| `year` | int | année civile (ex. 2026) |
| `type` | text | `newsale` \| `upsale` \| `opere` |
| `montant` | numeric | objectif en € |

Contrainte d'unicité : `(partner, year, type)` (upsert sur ce triplet).

### Table `kpi_ca_split`
Uniquement les répartitions **personnalisées** (overrides). Absence de ligne = parts égales.

| colonne | type | rôle |
|---|---|---|
| `id` | uuid (pk) | identifiant |
| `mission_id` | text | id de la page mission Notion |
| `axis` | text | `commercial` \| `operationnel` |
| `partner` | text | prénom du partner |
| `pct` | numeric | pourcentage attribué (0-100) |

Contrainte d'unicité : `(mission_id, axis, partner)`.

**Règle de répartition :** pour une mission + axe donnés, si aucune ligne `kpi_ca_split` n'existe,
le CA est réparti **à parts égales** entre les partners de cet axe. Si des lignes existent, on
applique les `pct` (qui doivent sommer à 100 ; sinon on normalise).

Le **« All » n'est jamais stocké** : il est recalculé comme la somme des partners.

## 4. Backend (`server.js`)

### `GET /api/kpi?year=YYYY`
Renvoie le tableau calculé. Algorithme :

1. Récupère les missions via `fetchAllNotionMissions()` (fonction existante). **Prérequis :** ajouter
   `dateCreation: page.created_time` au mapping de `fetchAllNotionMissions()` (le champ `page.created_time`
   est déjà disponible mais pas encore exposé).
2. Filtre les missions dont l'**année de `dateCreation`** (= année de signature) vaut `YYYY`.
3. Charge `kpi_objectives` (année `YYYY`) et `kpi_ca_split` depuis Supabase.
4. Pour chaque mission :
   - **Signé** (état ≠ `Annulé`) : répartit `ca` entre `partnerCommercial` (split commercial, défaut
     égal) et range le montant dans `newsale` ou `upsale` selon `type_ca`. Si `type_ca` n'est ni
     `Newsale` ni `Upsale` → la mission va dans `unclassified`, pas dans signé.
   - **Opéré** (état ∈ {`En cours`, `Terminé`}) : répartit `ca` entre `partnerOperationnel`
     (split opérationnel, défaut égal) dans `opere`.
5. Agrège par partner ; calcule `all` = somme des partners ; calcule `txAvancement` = réalisé / objectif
   (si objectif = 0 → `null`, affiché « — »).
6. Réponse JSON :

```jsonc
{
  "year": 2026,
  "partners": [
    {
      "partner": "Nathan",
      "newsale":  { "objectif": 100000, "realise": 16150, "tx": 0.16 },
      "upsale":   { "objectif": 50000,  "realise": 61400, "tx": 1.23 },
      "opere":    { "objectif": 225000, "realise": 119816, "tx": 0.53 }
    }
  ],
  "all": { "newsale": {...}, "upsale": {...}, "opere": {...} },
  "unclassified": [ { "id": "...", "nom": "...", "client": "...", "ca": 12000 } ],
  "missionsForSplit": [
    { "id": "...", "nom": "...", "ca": 20000,
      "commercial": ["Vincent","Nathan"], "operationnel": ["Guillaume"],
      "splitCommercial": { "Vincent": 50, "Nathan": 50 },
      "splitOperationnel": { "Guillaume": 100 } }
  ]
}
```

`missionsForSplit` ne liste que les missions de l'année ayant **2+ partners** sur au moins un axe
(celles qui ont besoin d'un réglage).

### `POST /api/kpi/objectives`
Body : `{ partner, year, type, montant }` → upsert dans `kpi_objectives`.

### `POST /api/kpi/split`
Body : `{ mission_id, axis, splits: [{ partner, pct }] }` → remplace les lignes du couple
`(mission_id, axis)` dans `kpi_ca_split`. Envoyer un tableau vide (ou des parts égales) supprime
l'override et revient au défaut.

Authentification : ces routes suivent la même protection que les autres routes Pilot existantes.

## 5. Frontend (`public/pilot.html`)

Nouvelle entrée **« KPI »** dans la sidebar (`navigateTo('kpi')`), avec une page `#page-kpi`.

### A. Sélecteur d'année
Dropdown, par défaut l'année en cours. Change → refetch `/api/kpi?year=...`.

### B. Bar charts (Chart.js, déjà chargé)
Un graphique par partner + un graphique **« All »**. Pour chaque : **barres groupées**, 3 groupes
(Newsale, Upsale, Opéré), 2 barres par groupe (**Objectif** vs **Réalisé**), avec le **% d'avancement**
affiché au-dessus de chaque groupe (via `chartjs-plugin-datalabels`, déjà chargé).

### C. Panneau « Réglages » (dépliable)
- **Objectifs** : grille éditable — une ligne par partner, colonnes Newsale / Upsale / Opéré.
- **Répartition CA** : liste des missions de l'année à 2+ partners ; pour chaque axe concerné, des
  champs `%` pré-remplis (parts égales par défaut). Validation : la somme par axe doit faire 100 %.
- Bouton **Enregistrer** → appelle `POST /api/kpi/objectives` et `POST /api/kpi/split`, puis refetch.

### D. Alerte « missions non classées »
Encart visible si `unclassified` non vide : liste nom + client + CA, invitant à corriger `type_ca`
dans Notion.

Réutilise la charte existante : variables `--primary`, composants `.section`, `.kpi-block`, style des
onglets `.analytics-tab`.

## 6. Hors périmètre (YAGNI)

- Pas d'historique des objectifs (on garde la dernière valeur saisie par année).
- Pas d'export PDF/Excel du tableau KPI.
- Pas de gestion fine des droits par partner (tout le monde voit tout, comme le reste de Pilot).
- Pas de notion de « 3+ partners » spécifique : la logique de parts égales et d'override gère
  n'importe quel nombre de partners.

## 7. Tests / vérification

- **Backend** : tests unitaires sur la fonction d'agrégation (mission mockées) couvrant : 1 partner
  (100 %), 2 partners défaut (50/50), 2 partners avec override, mission `Annulé` exclue du signé,
  mission `Planning` exclue de l'opéré, `type_ca` vide → `unclassified`, `all` = somme des partners.
- **Manuel** : vérifier en navigateur que les chiffres d'un partner correspondent à un calcul fait à
  la main sur quelques missions réelles de l'année.
- `node --check server.js` après modifications backend.

## 8. Points à confirmer avant implémentation

_Aucun point ouvert : la base d'année a été tranchée (`created_time` ≈ date de signature)._
</content>
</invoke>
