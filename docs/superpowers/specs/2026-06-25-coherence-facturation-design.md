# Contrôle de cohérence facturation & facture englobante — Design

Date : 2026-06-25
Statut : validé (en attente plan d'implémentation)

## Contexte

Dans l'onglet **Facturation** de Pilot, chaque « ligne » est un couple **(mission, type)** où
`type ∈ {acompte, solde}`. Chaque ligne stocke dans Notion une liste de numéros de factures
Pennylane (propriétés `Fact acpt Penny` / `Fact solde Penny`, valeurs séparées par `,` `;` ou
retour ligne).

Règle actuelle (stricte) : **un numéro de facture ne peut vivre que dans une seule ligne**.
Tenter d'affecter un n° déjà utilisé ailleurs déclenche un `409 INVALID_DUPLICATE` ; si l'on
confirme, le serveur **retire** la facture de l'autre ligne pour l'amener ici (déplacement forcé,
via `confirmDuplicates: true`).

Référence montants : **Notion = HT**, **Pennylane (`inv.amount`) = TTC**, conversion `TTC = HT × 1.2`
(cf. commentaire `server.js:2408`).

## Problème

1. Une même facture peut légitimement **englober plusieurs lignes** (ex : un seul règlement couvre
   l'acompte ET le solde, ou deux missions). Le déplacement forcé interdit ce cas.
2. Aucun garde-fou ne signale qu'une ligne est sur/sous-facturée par rapport au montant attendu.

## Objectifs

- Remplacer le blocage par un **choix** : *Garder sur les 2 lignes* (nouveau) ou *Déplacer ici*
  (comportement actuel).
- Ajouter un **contrôle de cohérence permanent par ligne** (indicateur live dans la modale) :
  Σ(TTC des factures liées à la ligne) vs montant TTC attendu de la ligne.
- Dans le cas englobante, afficher en plus un contrôle **par facture** : Σ(TTC des lignes couvertes
  par la facture) vs montant TTC de la facture.

Décisions de cadrage (validées) :
- Comportement conflit : **laisser le choix** (Garder / Déplacer).
- Base de comparaison : **TTC vs TTC** (les montants HT des lignes sont convertis × 1,2).
- Tolérance : **aucune tolérance binaire** — on affiche toujours l'écart (€ et %), surligné si ≠ 0,
  jamais bloquant. Justification : le split acompte/solde côté Notion (50/50 par défaut) diverge
  souvent du réel, donc l'écart est un signal informatif, pas une erreur.
- Affichage du contrôle par ligne : **indicateur live dans la modale**, recalculé à chaque
  coche/décoche, pas de popup supplémentaire dans le cas normal.

## Modèle de données — manques identifiés

L'endpoint ciblé `GET /api/facturation-matching/suggest` (server.js:2747) renvoie aujourd'hui pour
la mission `{ nom, client, ca, pageId }` et, pour les factures déjà liées, de simples chaînes de n°
**sans montant**. Seules les *propositions* portent un `amount`. Deux enrichissements sont donc
nécessaires pour rendre l'indicateur live calculable côté front.

## Conception

### 1. Serveur — `GET /api/facturation-matching/suggest` (cas ciblé) — server.js:2747

Enrichir la réponse :
- `mission` : ajouter **`montantAcompte`** et **`montantFinal`** (HT, déjà présents sur l'objet
  mission — cf. server.js:2770-2771).
- Ajouter **`linkedDetails: [{ invoiceNumber, amount, status }]`** : pour chaque n° de
  `currentlyLinkedList`, lookup dans `invoices` (déjà en mémoire) pour récupérer le montant TTC.
  Un n° introuvable côté Pennylane est renvoyé avec `amount: null`.

### 2. Serveur — `POST /api/facturation-matching/link` — server.js:2816

- **Nouveau flag `keepDuplicates`** dans le body. Trois cas désormais :
  - ni `confirmDuplicates` ni `keepDuplicates` + conflits → `409 INVALID_DUPLICATE` (enrichi, voir
    plus bas).
  - `confirmDuplicates: true` → retire des autres lignes puis PATCH ici. **Inchangé** (= « Déplacer
    ici »).
  - `keepDuplicates: true` → **ne retire rien**, PATCH la ligne cible seulement (= « Garder sur les
    2 lignes »). `cleanedFromOthers` = 0.
- Réponse `409 INVALID_DUPLICATE` enrichie d'un bloc **cohérence englobante**, calculé côté serveur
  (missions + factures déjà en mémoire), par facture en conflit :
  ```
  coherence: [{
    invoice,            // n° facture
    invoiceTTC,         // inv.amount
    lines: [{ mission, type, lineTTC }],   // ligne cible + lignes en conflit
    sumLinesTTC,        // Σ lineTTC
    ecart,              // sumLinesTTC − invoiceTTC
    ecartPct            // ecart / invoiceTTC
  }]
  ```
  `lineTTC` = `(type==='acompte' ? montantAcompte : (ca − montantAcompte)) × 1.2`.
  Formule canonique retenue : `ca − montantAcompte` pour le solde (convention du moteur de
  scoring server.js:2438-2439), plutôt que `montantFinal`, pour éviter une seconde source de vérité.

### 3. Front — modale matching — public/pilot.html

#### 3a. Indicateur live permanent — `renderFactMatchingModalBody` (public/pilot.html:11455)
Construire un **lookup montants** `{ n° → amount }` à partir des `suggestions` ET de
`linkedDetails`. À chaque rendu / coche / décoche, afficher un encart :
- `Attendu TTC` = `(type==='acompte' ? mission.montantAcompte : (ca − mission.montantAcompte)) × 1.2`
  (formule canonique `ca − montantAcompte` pour le solde, cf. §2).
- `Lié TTC` = Σ des montants TTC des factures cochées présentes dans le lookup.
- `Écart` = `Lié TTC − Attendu TTC`, affiché en € et % ; surligné orange si ≠ 0.
- Factures cochées **absentes du lookup** (saisie manuelle, montant inconnu) : exclues de la somme,
  avec mention « N facture(s) au montant inconnu, exclue(s) du calcul ».

L'écouteur `change` des checkboxes (public/pilot.html:11544) doit recalculer et mettre à jour cet
encart sans re-render complet (préserver le focus).

#### 3b. Cas conflit — `confirmFactMatchingMulti` (public/pilot.html:11596)
Remplacer le `confirm()` natif (lignes 11596-11608) par le rendu d'un **panneau dans
`factMatchingModalBody`** :
- ⚠️ Avertissement listant les conflits (« F-XXXX est aussi liée à *Mission* / type »).
- **Tableau de cohérence englobante** (depuis `json.coherence`) : Σ lignes TTC · montant facture TTC
  · écart (€ et %), surligné si ≠ 0.
- Boutons :
  - **[ Garder sur les 2 lignes ]** → `confirmFactMatchingMulti` avec `keepDuplicates: true`.
  - **[ Déplacer ici ]** → `confirmFactMatchingMulti` avec `confirmDuplicates: true`.
  - **[ Annuler ]** → restaure la modale (`body.innerHTML = prev`).
- Le toast « X lien(s) retiré(s) » ne s'affiche que pour « Déplacer ici » (déjà conditionné par
  `json.cleanedFromOthers > 0`).

`confirmFactMatchingMulti` prend donc une option d'action (`'keep'` | `'move'` | défaut) au lieu du
booléen `confirmDuplicates` unique.

### 4. Build — dist/pilot.html
Reporter à l'identique les modifications de `public/pilot.html` dans `dist/pilot.html` (version
servie ; les deux fichiers sont déjà suivis et modifiés dans le working tree).

## Hors périmètre (YAGNI)

- Pas de persistance d'un drapeau « englobante » : le modèle reste « liste de n° par ligne », la
  facture apparaît simplement dans plusieurs listes.
- Pas de re-calcul serveur des montants pour les factures saisies manuellement dans l'indicateur
  live (montant inconnu → exclu + mention).
- Pas de seuil bloquant ni de validation empêchant l'enregistrement en cas d'écart.

## Tests / vérification

- `node --check server.js` après modif serveur.
- Vérif manuelle dans la modale :
  - Ligne mono-facture cohérente → écart ~0.
  - Ligne avec facture trop grosse/petite → écart affiché et surligné.
  - Facture déjà liée ailleurs → panneau de conflit avec cohérence englobante + 3 boutons ;
    « Garder » laisse la facture sur les 2 lignes, « Déplacer » la retire de l'autre.
  - Saisie manuelle d'un n° → mention « montant inconnu ».
