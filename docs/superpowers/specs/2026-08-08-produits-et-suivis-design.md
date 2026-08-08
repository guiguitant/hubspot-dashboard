# Produits (subventions), indicateur TVA, alerte Notion, clôture souple primes · design

> Statut : VALIDÉ (arbitrages utilisateur du 2026-08-08) · Branche : `feat/produits-et-suivis`
> Prolonge les chantiers primes (gsheet-primes-writeback) et charges (2026-08-06-charges-perimetre-tva).

## A · Subventions : produits réalisés depuis Qonto, périmètre PCG

**Problème** : `/api/ebe` compte 58 800 € de subventions (Plan_TRE figé) alors que 105 333 € ont été encaissés. Ventilation réelle (validée utilisateur) : 39 200 € d'**avance remboursable** (emprunt à taux 0 · JAMAIS un produit, sa place est en trésorerie/passif), 58 800 € de **subvention pure** (produit), ~7 333 € d'**aides à l'embauche** (produit).

**Décision** (option retenue par l'utilisateur : catégories Qonto dédiées) :
1. L'utilisateur a créé 3 sous-catégories Qonto sous « Subventions et aides » et va reclasser les 12 encaissements (aujourd'hui tous sous « Aides à l'embauche »).
2. Helper pur `classifyProduitSubvention(sousCat)` (normalisation accents/casse, comme les primes) : `'exclu'` si le libellé évoque une avance remboursable (« avance remboursable », « avance », « prêt »...), `'produit'` si subvention/aide, `null` sinon. Liste par motifs, robuste aux libellés exacts inconnus (l'API Qonto n'expose pas la liste des catégories).
3. **Produits hybrides** comme les charges : mois clos → crédits Qonto réels de la catégorie « Subventions et aides » (avances exclues) ; mois courant/futurs → Plan_TRE (inchangé). Branché dans `/api/ebe` (et `computeResultatFactuelForYear`) à la place du montant Plan_TRE seul pour la partie réalisée.
4. **Alerte rapprochement** : compteur exposé (`subventionsReel { produits, exclus, nonClasses }`) + avertissement si un crédit significatif (> 500 €) hors CA reste sans sous-catégorie reconnue. Jamais d'exclusion silencieuse (leçon du chantier charges).
5. Le remboursement d'IS (crédit « Impôts et taxes », 15 852 €) reste hors produits (déjà exclu côté charges · symétrie).

## B · Indicateur de complétude TVA (points 7+10 de la revue)

Badge sur le Compte de résultat, alimenté par le passthrough `tvaExacte` de `/api/ebe` : « TVA exacte : X % des dépenses réelles » (couverture de la priorité 0). Nuance visuelle (atténué/alerte) sous un seuil (< 50 %) avec title expliquant que le dernier mois clos s'affine à mesure de la saisie comptable. Aucun nouveau calcul : affichage pur.

## C · Alerte « deal gagné sans mission Notion » (proposition utilisateur)

**Problème** : la création des missions Notion est manuelle ; un deal HubSpot gagné peut être oublié ou rapproché de la mauvaise ligne (cas Somarail).
**Solution** : endpoint `GET /api/coherence/deals-notion` : compare les deals HubSpot gagnés de l'année (`fetchWonDealsBetween`) aux missions Notion (`fetchAllNotionMissions`). Rapprochement : une mission « couvre » un deal si montant identique à ±1 % ET (date de signature Notion dans le trimestre du closedate OU nom/client similaires après normalisation). Renvoie les deals non couverts `{ nom, montant, closedate }`. Front : bandeau discret dans la section KPI (même patron que les bandeaux couverture/clawback existants) : « ⚠ X deal(s) gagné(s) sans mission Notion · voir » avec modale liste. Zéro écriture : la création reste manuelle.

## D · Clôture souple des primes (proposition utilisateur validée)

**Problème** : une charge de prime du T4 saisie après le 31/12 est définitivement perdue (exercice figé au 1er janvier).
**Décision** : (1) **Période de grâce** : jusqu'au **20 janvier** (constante `PRIMES_GRACE_JOURS = 20`, surchargeable env), l'exercice N-1 reste écrivable : `primesFloorKey` renvoie `(N-1)-01` pendant la grâce ; `computePrimesChargeSchedule` traite alors l'exercice N-1 comme encore ouvert (ses charges datées N-1 sont conservées et écrites) EN PLUS de l'exercice N. Après la grâce, comportement actuel (figé). C'est le miroir des écritures post-clôture qu'un expert-comptable passe toujours. (2) **Alerte décembre** : dans la section KPI primes, en décembre uniquement, bandeau « Clôture : X deal(s) signé(s) non facturé(s) · leurs primes doivent être facturées avant fin janvier » listant les deals concernés (statut provisoire). Tests moteur pour la grâce (avant/pendant/après).

**Limite connue** (relevée en revue, pré-existante au chantier grâce) : une provision d'un deal signé au T4/N-1, écrite en décembre N-1 pendant la grâce, si le deal n'est facturé qu'APRÈS le 20 janvier (fin de grâce), reste figée dans la colonne décembre N-1 (jamais contrepassée automatiquement) tandis que la charge définitive part en exercice N (date réelle de facturation) : la même prime peut alors être comptée deux fois. Ce mécanisme existait déjà avant la grâce (gel au 1er janvier, fenêtre d'auto-correction d'un seul jour) ; la grâce l'AMÉLIORE en étendant cette fenêtre de 1 à 20 jours, sans la fermer. Aucune contrepassation automatique des provisions gelées inter-exercices n'existe à ce jour : à surveiller en fin d'année, le bandeau de décembre servant justement à réduire ce cas à la source (en poussant à facturer avant la clôture). Pendant la grâce (~20 jours par an), l'écran « État d'avancement » mélange donc les entrées N-1 et N, cohérent avec la source unique (`/api/primes/avancement`).

## Hors lot / en attente
- **SaaS production immobilisée** : données trouvées dans le module Immobilisations de Pilot (postes par personne/année), MAIS incohérence à clarifier avec le comptable : des postes 2026 identiques figurent dans les deux immos (SaaS et Simapro · Evane 29 120, Arthur 58 539, Thomas 40 473) → quote-parts déjà ventilées ou salaires entiers à ventiler ? Câblage (produit « Production immobilisée » jusqu'à mise en service + dotation ensuite) après réponse.
- Réinjection primes N-1 (échéance avant janvier 2027, compris par l'utilisateur).
- Tableau « Répartition par catégorie » : CONSERVÉ (décision utilisateur).
