# Fusion Analytics + Dépenses · conception

Date : 2026-07-24
Auteur : Nathan Gourdin (avec Claude)
Statut : validé (design), en attente du plan d'implémentation

## Contexte

Aujourd'hui l'app Pilot a deux onglets séparés dans la sidebar :

- **Dépenses** (`page-depenses`) : détail des sorties d'argent, source **Pennylane** (`/api/depenses`, transactions catégorisées par la comptable, fenêtre glissante de 13 mois).
- **Analytics** (`page-analytics`) : analyse du CA (source **Notion**, `/api/analytics`) et des charges (source **Qonto** + prévi GSheet, `/api/charges` et `/api/charges-hybride`), avec un sélecteur de période, une carte EBE, un toggle « pipeline pondéré » et un toggle « prévisionnel ».

Ces deux onglets décrivent en partie les mêmes mouvements bancaires mais via **deux catégorisations différentes** (comptable dans Pennylane vs automatique dans Qonto). Ils ne partagent pas le même code ni la même période d'analyse.

## Objectif

Fusionner les deux onglets sous un seul onglet **« Analytics »** avec deux sous-onglets : **Chiffre d'affaires** et **Charges**. Simplifier le périmètre (3 périodes, moins de toggles), rapatrier le détail des dépenses dans le sous-onglet Charges, et intégrer le prévisionnel automatiquement.

## Décisions cadrées avec le user

1. **Source du sous-onglet Charges** : deux sources assumées et **étiquetées visuellement**.
   - Le **détail des dépenses** reste sur **Pennylane** (catégories comptables, plus fines).
   - Le **comparatif N vs N-1** reste sur **Qonto + prévi GSheet**.
   - Risque accepté : les totaux des deux blocs ne se recoupent pas exactement. Mitigation : chaque bloc porte une mention claire de sa source.
2. **CA Signé** : sourcé depuis **Notion** (et non HubSpot). Comme chaque mission Notion porte une date de signature (date de création de la ligne), le CA signé est calculable sur **n'importe quelle période**, y compris une date personnalisée.
3. **Épuration** : on retire la carte EBE, le toggle « pipeline pondéré » et les presets de période superflus (mois en cours, mois dernier, 7 jours, année en cours).
4. **Cards Charges (A)** : les 3 cards (Sorties ce mois, Moyenne mensuelle 6 mois, Dépenses récurrentes) sont des indicateurs **instantanés** (toujours actuels), indépendants de la période sélectionnée. Leurs libellés sont intrinsèquement figés.
5. **Détail Pennylane (B)** : les graphes de détail **suivent la période sélectionnée**.

## Design

### Navigation et structure

- **Sidebar** : une seule entrée « Analytics ». L'entrée « Dépenses » est retirée.
- Page `page-analytics` :
  - En haut : le **sélecteur de période** (commun aux deux sous-onglets).
  - Puis **2 sous-onglets** : « Chiffre d'affaires » (défaut) | « Charges ».
- La page `page-depenses` est supprimée ; son contenu est rapatrié dans le sous-onglet Charges.

### Sélecteur de période (3 choix)

- **Exercice courant** : 1er janvier → 31 décembre de l'année en cours (comportement déjà en place).
- **Exercice précédent** : année N-1 complète (janvier → décembre).
- **Date personnalisée** : bornes libres.
- Retirés : « Année en cours », « Mois en cours », « Mois dernier », « 7 derniers jours ».
- Retirés aussi : la ligne de cards « communes » du haut (dont EBE) et le toggle pipeline pondéré.

### Sous-onglet « Chiffre d'affaires » · source Notion

- **4 cards** :
  - **CA Facturé** (existe) : Σ acompte + solde facturés sur la période (dates d'émission de facture).
  - **CA Signé** (nouveau) : Σ `CA mission` des missions dont la date de signature (date de création Notion) tombe dans la période.
  - **Ticket moyen** (existe).
  - **Nb factures** (existe).
- **Graphes** (tous déjà présents) : CA N vs N-1 (par mois), Subventionné vs non, Canal d'acquisition, Nature de mission, Type de CA, CA par client (Top 15).

### Sous-onglet « Charges » · deux sources étiquetées

- **3 cards instantanées** (source Pennylane, toujours actuelles) : Sorties ce mois, Moyenne mensuelle 6 mois, Dépenses récurrentes. La card « Sans catégorie » est retirée.
- **Bloc « Comparatif »** (source **Qonto + prévi GSheet**, mention visible) :
  - Bar chart **Charges N vs N-1** par mois.
  - Le **prévisionnel est intégré automatiquement** : mois passés = réel Qonto, mois en cours + futurs = prévi GSheet. **Plus de case à cocher** (on utilise `/api/charges-hybride` par défaut).
- **Bloc « Détail des dépenses »** (source **Pennylane**, mention visible, **piloté par la période**) :
  - Sorties par mois.
  - **Répartition par catégorie** : consolidation des deux vues « par catégorie » redondantes en **une seule** vue Pennylane (catégories comptables), présentée avec le graphe d'Analytics + la table. Le bouton Sous-catégories n'est proposé que si Pennylane fournit des sous-catégories ; sinon on garde seulement Catégories.
  - Top 15 fournisseurs.
  - Dépenses récurrentes détectées.

## Changements backend

- **`/api/analytics`** : ajouter `caSigne` (Σ `ca` des missions signées dans la période, datées par `dateCreation`) et `nbSigne` (nombre de missions signées).
- **`/api/depenses`** : accepter des paramètres optionnels `start` / `end` pour scoper les transactions du bloc détail selon la période. Rétrocompatible (sans paramètres = comportement actuel, 13 mois). Le fetch Pennylane doit couvrir la borne `start` demandée (élargir la fenêtre si la période dépasse 13 mois, ex. exercice précédent).
  - Les **3 cards instantanées** restent calculées sur une fenêtre récente (mois en cours / 6 derniers mois), indépendamment de `start`/`end`. Le endpoint expose donc, en plus des transactions scopées, un bloc `snapshot` (ou le front conserve un second fetch récent). Recommandation : le endpoint renvoie `snapshot` pour éviter un double appel.
- **`/api/charges-hybride`** : inchangé, devient la source par défaut du comparatif N vs N-1.
- **`/api/ebe`** : inchangé côté serveur (toujours utilisé par le Cockpit), simplement plus appelé par cet onglet.

## Fichiers touchés

- `public/pilot.html` (structure des pages, sidebar, fonctions de rendu, navigation) puis synchro vers `dist/pilot.html`.
- `server.js` (`/api/analytics`, `/api/depenses`).

## Risques et points d'attention

- **Deux totaux non réconciliés** dans le sous-onglet Charges (Pennylane vs Qonto). Mitigation : étiquetage clair de la source sur chaque bloc.
- **Fenêtre Pennylane** : pour « Exercice précédent », la période dépasse la fenêtre par défaut de 13 mois ; il faut élargir le fetch.
- **CA Signé daté par `dateCreation`** : c'est un proxy de la date de signature (convention déjà utilisée pour l'année KPI). À signaler ; peut différer de la vraie date de signature si la ligne Notion est créée en décalé.
- **Rétrocompatibilité** : garder `/api/depenses` fonctionnel sans paramètres (au cas où d'autres consommateurs l'appellent). Aucun impact attendu sur `prospector.js` / Dispatch (onglets non consommés par l'automatisation).
- **Références à `navigateTo('depenses')`** et aux appels de rendu au boot : à nettoyer/rebrancher sur le sous-onglet Charges.

## Non-objectifs

- Ne pas réconcilier Pennylane et Qonto en une source unique (choix explicite : deux sources).
- Ne pas toucher à l'EBE du Cockpit/KPI ni à la trésorerie.
- Ne pas modifier le calcul du CA signé HubSpot existant dans l'onglet KPI (il reste pour les primes).

## Tests de validation

- **Playwright** : ouvrir Analytics, basculer entre les 2 sous-onglets, changer les 3 périodes, vérifier que les cards et graphes se rendent sans erreur JS.
- **Curl** : `/api/analytics?start=&end=` renvoie `caSigne`/`nbSigne` ; `/api/depenses?start=&end=` renvoie les transactions scopées + `snapshot`.
- Vérifier que les mentions de source (Pennylane / Qonto) sont visibles sur chaque bloc du sous-onglet Charges.
