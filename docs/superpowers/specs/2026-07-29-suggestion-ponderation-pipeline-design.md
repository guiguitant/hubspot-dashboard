# Suggestion de pondération du pipeline basée sur les données

Date : 2026-07-29
Statut : design validé, prêt pour le plan d'implémentation

## Contexte et problème

Le barème de pondération du pipeline (`KANBAN_STAGES` dans `server.js`) attribue une probabilité de signature à chaque étape : RDV Qualif 30 %, RDV Propale 50 %, Négociation 60 %, Contrat envoyé 80 %. Ces valeurs sont **saisies à la main** et pilotent le pipeline pondéré (montant × %), les prévisions de trésorerie et l'EBE. Elles sont réglables dans le modal « Réglages pondération » (`openPonderationModal` dans `public/pilot.html`), qui écrit via `POST /api/pipeline-ponderation`.

Objectif : aider l'utilisateur à régler ce barème en lui **suggérant**, à côté de chaque champ, la probabilité réellement observée dans l'historique HubSpot. L'utilisateur garde toujours la main (aucune application automatique).

## Découvertes sur les données (justifient la méthode)

Analyse menée le 2026-07-29 sur les 310 deals du pipeline `default` :

- Les propriétés `hs_date_entered_<stage>` sont **vides pour 100 % des deals**. La méthode « standard » de funnel via ces dates est inutilisable ici. (Conséquence : le champ `stageEnteredAt` du kanban, `server.js` ~ligne 903, est toujours nul. Bug latent, hors périmètre de ce chantier.)
- La seule source fiable du parcours est l'**historique de la propriété `dealstage`** : `POST /crm/v3/objects/deals/batch/read` avec `propertiesWithHistory: ['dealstage']` (maximum **50** inputs par lot).
- **~47 % des deals résolus et 63 % des gagnés n'ont aucun parcours** (importés ou créés directement à leur étape finale). Les statistiques reflètent donc surtout les deals récents gérés nativement. Les passages en RDV Qualif / RDV Propale sont sous-enregistrés (statuts régularisés en bloc au closing).

Probabilités mesurées (tout l'historique, deals résolus, IC 95 %) :

| Étape | P(gagné) | IC 95 % | Effectif résolu |
|---|---|---|---|
| RDV Qualif | 43 % | 34-53 % | 98 |
| RDV Propale | 56 % | 45-67 % | 73 |
| Négociation | 60 % | 47-71 % | 62 |
| Contrat envoyé | 69 % | 55-80 % | 51 |

## Définition du calcul

Pour chaque étape X (les 4 étapes forecast du funnel) :

`P(gagné | a atteint X)` = (deals gagnés ayant atteint au moins X) / (deals **résolus** ayant atteint au moins X)

- « Résolu » = gagné (`hs_is_closed_won = true`) ou perdu (`hs_is_closed = true` et non gagné). Les deals ouverts sont **exclus** du calcul (parade à la censure à droite).
- « A atteint X » = l'étape la plus avancée réellement occupée dans l'historique `dealstage` est ≥ X (interprétation cumulative : atteint X ou au-delà). Un deal résolu sans aucune étape du funnel dans son historique est **écarté** du calcul.
- Fenêtre : **tout l'historique** (fixe). 2026 est immature (deals encore ouverts), 2025 très incomplet (imports). Pas de sélecteur de période dans l'UI.
- Intervalle de confiance : **Wilson à 95 %**, robuste pour petits échantillons.
- Fiabilité affichée : `ok` (pastille verte) si au moins **30 deals résolus** à cette étape, `low` (pastille orange) en dessous, `none` (pas de suggestion) si 0 deal résolu. Seuil ajustable.

Les 4 étapes calculées correspondent exactement aux 4 lignes éditables du barème (`KANBAN_STAGES` avec `forecast !== false`). « À relancer plus tard » (`forecast: false`) est hors périmètre.

## Architecture

Approche retenue : un **endpoint dédié** `GET /api/pipeline-conversion`, séparé de `/api/pipeline-ponderation` (config), pour isoler le calcul statistique lourd (~3 s) de la lecture instantanée du barème.

Trois composants :

### 1. Module de calcul pur · `utils/stageWinRates.js` (nouveau)

Fonctions pures, testables en isolation (comme `utils/kpiCompute.js`), sans aucun appel réseau. Reprend la logique validée par le prototype `conversion-v2.js` :

- `analyzeDeal({ historyValues, isClosedWon, isClosed })` → `{ won, lost, open, reached }`. Reconstruit le statut (gagné/perdu/ouvert) et `reached` = index de l'étape funnel la plus avancée présente dans `historyValues` (liste chronologique des valeurs de `dealstage`), -1 si aucune étape du funnel. C'est ici que vit la logique de parcours, pour qu'elle soit testable.
- `computeStageWinRates(deals)` où `deals = [{ won, lost, open, reached }]`. Retourne, par étape : `{ id, label, won, resolved, p, ciLow, ciHigh, suggested, confidence }` (`suggested` = `Math.round(p * 100)`, ou `null` si `resolved` = 0).
- `wilson(x, n)` : intervalle de confiance de Wilson à 95 %.

### 2. Récupération + cache · `server.js`

- `fetchDealStageHistories()` : recherche les deals du pipeline `default` (pagination), lit l'historique `dealstage` par lots de 50, puis appelle `analyzeDeal()` du module pour chaque deal (aucune logique de calcul ici, seulement l'accès réseau).
- `computePipelineConversion()` : appelle `fetchDealStageHistories()` puis `computeStageWinRates()`, et **met le résultat en cache** (variable module + timestamp, TTL ~12 h, sur le modèle de `openDealsCache`). Ne met jamais en cache un résultat vide ou une erreur.
- `GET /api/pipeline-conversion` : renvoie le résultat en cache (le calcule si le cache est expiré/vide). Paramètre `?refresh=1` : force le recalcul (bouton « Recalculer »).

Contrat de réponse :

```json
{
  "available": true,
  "computedAt": "2026-07-29T14:32:00.000Z",
  "stages": [
    { "id": "qualifiedtobuy", "label": "RDV Qualif",
      "suggested": 43, "won": 42, "resolved": 98,
      "ciLow": 34, "ciHigh": 53, "confidence": "ok" }
  ]
}
```

En cas d'échec du calcul : `{ "available": false }` (le modal reste fonctionnel sans suggestions).

### 3. Enrichissement du modal · `public/pilot.html`

Seule la fonction `openPonderationModal` est modifiée (rien d'autre) :

- Après le chargement du barème, appel de `GET /api/pipeline-conversion`.
- Pour chaque ligne d'étape, affichage à droite du champ : `43% · 98 deals` + pastille de confiance `🟢`/`🟠` portant une **infobulle** (`title`) avec l'IC complet : « Intervalle de confiance 95 % : 43 % (entre 34 % et 53 %). Échantillon : 98 deals résolus. »
- Bouton **Appliquer** par ligne : copie la valeur suggérée (arrondie à l'entier) dans le champ, sans sauvegarder.
- Bouton **Tout appliquer** : copie les 4 suggestions dans les champs.
- Lien **Recalculer** (appel `?refresh=1`) + date du dernier calcul affichée.
- Boutons **Enregistrer** / **Annuler** : inchangés.
- Si `available: false` ou une étape en `confidence: none` : mention « Suggestions indisponibles » / « pas assez de données », sans bouton Appliquer.

Maquette :

```
Étape            Pondération      Suggéré (données)
RDV Qualif        [ 30 ]%     43% · 98 deals 🟢ⓘ [Appliquer]
RDV Propale       [ 50 ]%     56% · 73 deals 🟢ⓘ [Appliquer]
Négociation       [ 60 ]%     60% · 62 deals 🟢ⓘ [Appliquer]
Contrat envoyé    [ 80 ]%     69% · 51 deals 🟢ⓘ [Appliquer]

[ Tout appliquer ]        ↻ Recalculer · calculé 14:32
```

## Flux de données

1. Ouverture du modal → `GET /api/pipeline-ponderation` (barème actuel, instantané) + `GET /api/pipeline-conversion` (suggestions, cache).
2. `computePipelineConversion` (si cache expiré) → `fetchDealStageHistories` (HubSpot) → `computeStageWinRates` → cache.
3. Clic Appliquer / Tout appliquer → écrit dans les champs (frontend seulement).
4. Clic Enregistrer → `POST /api/pipeline-ponderation` (flux existant inchangé).

## Gestion des erreurs

- La suggestion est un bonus, jamais bloquante : si HubSpot échoue, le modal s'ouvre normalement avec le barème éditable et « Suggestions indisponibles pour le moment ».
- Le cache conserve la dernière valeur réussie : un « Recalculer » en échec affiche un message et garde les suggestions précédentes.
- Aucun résultat vide ou partiel n'est mis en cache.

## Tests

`utils/stageWinRates.test.js` (Jest, comme `utils/kpiCompute.test.js`) sur la logique pure :

- courbe croissante sur un jeu de deals réaliste ;
- étape sans deal résolu → `confidence: none`, pas de division par zéro ;
- cas extrêmes tous gagnés / tous perdus → 100 % / 0 % ;
- bornes de l'intervalle de Wilson (valeurs connues, bornage 0-100) ;
- `analyzeDeal` : reconstruction de `reached` et du statut à partir d'un historique `dealstage` fictif (sauts d'étapes, deal sans parcours, deal monté puis perdu, deal encore ouvert).

Pas de test de l'appel réseau HubSpot (API externe).

## Hors périmètre (YAGNI)

- Pas d'auto-application ni d'auto-sauvegarde des suggestions.
- Pas de sélecteur de période dans l'UI.
- Pas d'alerte de dérive, pas d'historique des recalibrations.
- Pas de modèle prédictif multi-facteurs (montant, secteur, ancienneté dans l'étape).
- Correction du bug latent `stageEnteredAt` : sujet séparé, hors de ce chantier.
