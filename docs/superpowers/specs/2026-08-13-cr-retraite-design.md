# CR retraité · vue économique hors capitalisation · design

> Statut : proposition validée par l'utilisateur le 2026-08-13 (analyse code + revue d'expert comptable) · spec en attente de relecture utilisateur.
> Branche prévue : `feat/cr-retraite`. Prolonge le lot produits-et-suivis (2026-08-08, section E : production immobilisée).

## Contexte et objectif

Le CR classique mélange deux effets du mécanisme de capitalisation sans les isoler : la production immobilisée (compte 72, 158 247 € en 2026 au jour de la spec) neutralise immédiatement les charges portées à l'actif et gonfle l'EBE, tandis que les dotations de la même année (10 376 € en 2026, actifs mis en service en cours d'année) ne reflètent que quelques mois d'amortissement. Résultat : une image de rentabilité temporairement flatteuse par rapport à l'activité récurrente.

**Objectif** : une vue « CR retraité » À CÔTÉ du CR classique (jamais à sa place), qui neutralise l'effet complet de la capitalisation : le contrefactuel « comme si on n'avait jamais capitalisé ». Uniquement les KPI existants du CR, recalculés ; aucun nouveau KPI. Pratique de place standard (retraitements de gestion, ajustements de quality of earnings sur les coûts de développement activés) : verdict d'expert rendu le 2026-08-13, cohérent.

**Périmètre du retraitement (décision)** : les « actifs neutralisés » sont les immobilisations `traitement === 'immobilise'` qui possèdent AU MOINS UN poste (toutes années confondues), c'est à dire celles dont le montant amortissable provient de quote-parts de charges d'exploitation (même critère de bascule que `montantAmortissable`). Un actif sans postes (ex. rachat de brevet externe, montant saisi manuellement) ne génère aucune production immobilisée : ses dotations ne sont PAS neutralisées (elles sont le seul endroit où son coût touche le CR). Aujourd'hui les 2 immos (SaaS, Outil simapro CIR) ont des postes : périmètre = tout, et le garde-fou est automatique pour l'avenir.

**Ce que le retraitement ne touche JAMAIS** : le CA, le pipeline pondéré, les charges d'exploitation, les subventions, les aides, le crédit d'impôt CII/CIR (calculé sur les dépenses éligibles des postes, indépendant du choix comptable de capitaliser), le miroir trésorerie `computeResultatFactuelForYear` (l'IS réellement dû, le remboursement de crédit N+1 et toute la page trésorerie restent basés sur le CR classique). La vue retraitée est un affichage, pas une écriture.

## A · Calcul retraité (module pur `utils/crRetraite.js`, TDD)

Formules, appliquées séparément à chaque colonne (factuel et projeté) :

1. **EBE retraité** = EBE classique − production immobilisée (factuel − factuel, projeté − projeté).
2. **Dotations neutralisées** = Σ dotations de l'année des immos à postes ; **dotations retraitées** = Σ dotations de l'année des immos SANS postes. Invariant : neutralisées + retraitées = amortissements classiques (même boucle de calcul, exact à l'euro).
3. **Résultat d'exploitation retraité** = EBE retraité − dotations retraitées.
4. **IS retraité** = même barème PME que le classique (15 % jusqu'à 42 500 €, 25 % au-delà, seuils env), appliqué au résultat d'exploitation retraité. Étiqueté THÉORIQUE partout.
5. **Impôt net retraité** = IS retraité − crédit d'impôt (crédit strictement identique au classique, aucun recalcul).
6. **Résultat net retraité (après IS)** = résultat d'exploitation retraité − IS retraité ; **résultat net estimatif retraité** = résultat d'exploitation retraité − impôt net retraité. Mêmes conventions que le CR classique (le front dérive « après IS » de la même façon dans les deux vues).

Signature :

```js
// computeCrRetraite({ ebe: {factuel, projete}, amortissements,
//                     productionImmobilisee: {factuel, projete},
//                     dotationsParImmo: [{ nom, dotation, aPostes }],
//                     creditTotal, isFn })
// -> { ebe: {factuel, projete},
//      dotationsNeutralisees: { montant, parImmo: [{ nom, dotation }] },
//      amortissements,                       // retraitées
//      resultatExploitation: {factuel, projete},
//      is: {factuel, projete},
//      impotNet: {factuel, projete},
//      resultatNet: {factuel, projete} }     // estimatif, après crédit (même clé que /api/ebe)
```

`isFn` = `computeIS` de server.js passé en paramètre : la source unique du barème (env-configurable) reste server.js, le module pur n'en duplique pas les seuils. Les tests utilisent un barème identique aux valeurs par défaut.

## B · Serveur (`/api/ebe` seulement)

1. **Détail des dotations par immo** : nouvelle fonction `computeDotationsDetailForYear(year)` → `{ total, parImmo: [{ nom, dotation, aPostes }] }`. Réutilise le fetch immos existant + `fetchPostesByImmo` + `montantAmortissable` + `computeDotationForYear` (aucune formule nouvelle : c'est la boucle actuelle de `sumDotationsForYear` qui garde le détail au lieu de le jeter). `nom` = même repli que utils/productionImmobilisee.js (`libelle || nom || titre`). Tolérante : tables absentes ou erreur → `{ total: 0, parImmo: [] }`. `sumDotationsForYear` devient un wrapper qui renvoie `.total` : les appelants existants (miroir, /api/ebe) sont intacts.
2. **`/api/ebe`** : champ ADDITIF `retraite { ... }` (forme du module pur ci-dessus), calculé avec les données déjà chargées par l'endpoint (ebe factuel/projeté, amortissements, productionImmobilisee, détail dotations, creditImpot.total, computeIS). Rien d'autre ne change dans la réponse : aucun consommateur existant n'est cassé.
3. **Miroir `computeResultatFactuelForYear` : INTOUCHÉ.** C'est un choix de conception, pas un oubli : la trésorerie et l'IS réel suivent la comptabilité classique.
4. Une ligne de log `[retraite] CR retraite %d : EBE retraite %d€, dotations neutralisees %d€` au patron des logs produits.

## C · Front (public/pilot.html puis copie dist/pilot.html, bit-identiques)

1. **Bascule de vue** : deuxième groupe de pastilles « CR classique / CR retraité » à côté des onglets exercice, même patron `.cr-year-btn` (nouvel état `crViewMode`, défaut classique). Orthogonal aux deux contrôles existants : exercice courant/précédent × projeté × classique/retraité, les 6 combinaisons fonctionnent.
2. **Vue retraitée** :
   - bandeau sous le sélecteur : « Vue économique : rentabilité récurrente hors effet de la capitalisation. Production immobilisée neutralisée : X € (colonne courante). L'IS réel et la trésorerie suivent le CR classique. » Le message porte l'esprit : on gagne moins en récurrent ET on investit X € dans nos propres outils ;
   - la ligne « Production immobilisée » n'apparaît pas (montant neutralisé, l'information est dans le bandeau) ;
   - la ligne « Dotations aux amortissements » affiche la valeur retraitée, sous-ligne « dotations des actifs neutralisés retirées avec la production immobilisée » ; le clic ouvre une modale de détail (au lieu du lien direct vers le module) : dotations classiques, − neutralisées par immo (noms via `escapeHtml`), = retraitées, avec le lien vers le module Immobilisations ;
   - la modale IS affiche la base retraitée et la mention « IS théorique recalculé sur la base retraitée ; l'IS réellement dû reste celui du CR classique » ;
   - le bloc estimatif (crédit d'impôt) garde le crédit inchangé et affiche le résultat net estimatif retraité.
3. Vue classique : rendu strictement identique à aujourd'hui.
4. Contraintes : textes UI en français, jamais de tiret cadratin, `public/js/prospector.js` intouché.

## D · Invariants et tests (module pur, RED d'abord)

- **I1 · Invariant vie-entière (le test qui démontre la cohérence inter-exercices)** : pour un actif synthétique dont les postes tiennent sur une année et l'amortissement sur 5 ans, une fois l'actif totalement amorti, Σ sur toutes les années (production immobilisée N − dotations neutralisées N) = 0, donc Σ des écarts de résultat d'exploitation classique − retraité = 0. Données de test choisies rondes (montants divisibles) pour un zéro exact ; à défaut, tolérance de quelques euros d'arrondis annuels documentée dans le test.
- **I2** : dotationsNeutralisees.montant + amortissements retraités = amortissements classiques, à l'euro ; dotationsNeutralisees.montant = somme exacte de parImmo.
- **I3 · Périmètre** : une immo sans postes (brevet externe) garde ses dotations dans les retraitées, jamais dans les neutralisées ; une immo à postes est neutralisée même une année où elle n'a pas de poste (dotations d'une tranche capitalisée antérieure).
- **I4 · Colonnes** : le factuel retraité utilise productionImmobilisee.factuel, le projeté .projete ; l'IS est recalculé par colonne.
- **I5 · Cascade** : resultatNet retraité = resultatExploitation retraité − (is retraité − creditTotal), par colonne.
- **I6** : creditTotal identique dans les deux vues (le module ne le recalcule jamais).
- **Chiffres de contrôle recette 2026** (données live du jour de la spec, ordre de grandeur : le module Immobilisations bouge) : EBE retraité projeté = 399 111 − 158 247 = 240 864 € ; dotations retraitées = 0 (les 2 immos ont des postes) ; IS retraité projeté = 6 375 + (240 864 − 42 500) × 25 % = 55 966 € ; résultat net estimatif retraité ≈ 212 k€ (contre 322 757 en classique). L'écart ≈ 110 k€ est l'effet temporaire de capitalisation isolé par la vue.

## E · Limites connues (assumées, documentées ici)

1. **Déficits reportables ignorés** : l'IS théorique est recalculé année par année ; si une année « charge pleine » du contrefactuel avait été déficitaire, son déficit reportable aurait réduit l'IS retraité des années suivantes. Impact nul tant que le résultat retraité de chaque année reste positif (cas actuel).
2. **Approximations héritées du CR classique** : résultat imposable ≈ résultat d'exploitation, conditions du taux réduit 15 % supposées remplies. Rien de nouveau : la vue retraitée est exactement aussi approximative que la classique.
3. **Crédit d'impôt identique dans les deux vues** : défendable (les dépenses de personnel de recherche sont en général éligibles l'année où elles sont engagées, indépendamment de l'activation comptable) ; l'assiette exacte relève du dossier CIR de l'expert-comptable, à évoquer avec lui en même temps que la confirmation des quote-parts.
4. **Années post-capitalisation** : une fois la capitalisation terminée (ex. 2029), le résultat retraité dépasse le classique (plus de bonus à retirer, dotations neutralisées). C'est le comportement attendu du contrefactuel (les charges ont pesé plus tôt) ; la sous-ligne des dotations l'explique.
5. **Pas une vue cash** : le retraité reste un compte de résultat d'engagement (CA facturé non encaissé, charges engagées). La trésorerie a sa propre page.
6. **Vue locale au CR** : Analytics, scénarios, graphes N vs N-1 et trésorerie restent en lecture classique.

## Découpage prévu (plan à venir)

T1 module pur `utils/crRetraite.js` + tests (TDD) · T2 serveur (détail dotations + branchement `/api/ebe`, miroir intouché) · T3 front (bascule, bandeau, modales, parité dist).

## Hors lot
- Retraitement des graphes comparatifs N vs N-1 et des scénarios.
- Toute écriture comptable ou export : la vue est un affichage de pilotage.
