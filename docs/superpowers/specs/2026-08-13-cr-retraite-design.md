# CR hors capitalisation (ex « CR retraité ») · vue économique · design

> Statut : proposition validée par l'utilisateur le 2026-08-13, AMENDÉE le même jour par la revue d'un panel de 5 experts indépendants (PCG, contrôle de gestion, due diligence, 2 contradicteurs), verdict unanime « cohérent avec réserves » · spec v2 en attente de relecture utilisateur.
> Branche prévue : `feat/cr-retraite` (le slug technique garde l'ancien nom). Prolonge le lot produits-et-suivis (2026-08-08, section E : production immobilisée).

## Contexte et objectif

Le CR classique mélange deux effets du mécanisme de capitalisation sans les isoler : la production immobilisée (compte 72, 158 247 € en 2026 au jour de la spec) neutralise immédiatement les charges portées à l'actif et gonfle l'EBE, tandis que les dotations de la même année (10 376 € en 2026, actifs mis en service en cours d'année) ne reflètent que quelques mois d'amortissement. Résultat : une image de rentabilité temporairement flatteuse par rapport à l'activité vue toutes charges supportées.

**Objectif** : une vue « CR hors capitalisation » À CÔTÉ du CR comptable (jamais à sa place), le contrefactuel « comme si les dépenses de développement étaient restées en charges ». Uniquement les KPI existants du CR, recalculés ; aucun nouveau KPI. Pratique de place standard (retraitements de gestion, ajustements de quality of earnings sur les coûts de développement activés).

**Nommage (décision post-panel, unanime chez les 5 experts)** : bannir « retraité » employé nu (ambigu : l'« EBE retraité » bancaire désigne d'autres retraitements), bannir « rentabilité récurrente » (faux en phase de build : rien ne garantit que l'effort de développement soit un niveau de croisière) et ne JAMAIS employer « résultat courant » (agrégat PCG défini, autre sens). Libellés retenus : pastilles « CR comptable / CR hors capitalisation » ; bandeau contrefactuel explicite (voir C).

**Périmètre du retraitement (décision, justification corrigée post-panel)** : les « actifs neutralisés » sont les immobilisations `traitement === 'immobilise'` qui possèdent AU MOINS UN poste (toutes années confondues). Le critère réel que ce test implémente est « cet actif a-t-il produit du compte 72 » (les postes sont exactement ce qui alimente `computeProductionImmobilisee`, et `montantAmortissable` bascule sur la somme des postes dès qu'il y en a : l'invariant vie-entière est garanti par construction), PAS « cet actif est-il produit en interne ». Conséquences :
- un actif sans postes (montant saisi manuellement) garde ses dotations : elles sont le seul endroit où son coût touche le CR ;
- un actif mixte (part achetée + quote-parts internes) n'est pas représentable : règle de saisie documentée « un actif mixte se crée en deux immobilisations distinctes » ;
- le cas futur « facture de prestataire immobilisée directement sans poste » échapperait au périmètre (jamais passée en charges ni par le 72) : couvert plus tard par un champ `origine` sur l'immobilisation (hors lot, voir plus bas).

**Ce que le retraitement ne touche JAMAIS** : le CA, le pipeline pondéré, les charges d'exploitation, les subventions, les aides, le crédit d'impôt CII/CIR (voir la garde méthode B en B.4), le miroir trésorerie `computeResultatFactuelForYear` (l'IS réellement dû, le remboursement de crédit N+1 et toute la page trésorerie restent basés sur le CR comptable). La vue est un affichage, pas une écriture.

**Règle d'usage (à écrire dans l'UI, demande des 5 experts)** : IS dû, trésorerie, dividendes et calcul des primes se lisent sur le CR comptable ; la vue hors capitalisation sert au pilotage interne (marge réelle de l'activité, dimensionnement de l'effort de développement) et à la discussion investisseur, toujours accompagnée de sa réconciliation.

## A · Calcul (module pur `utils/crRetraite.js`, TDD)

Formules, appliquées séparément à chaque colonne (factuel et projeté) :

1. **EBE hors capitalisation** = EBE classique − production immobilisée (factuel − factuel, projeté − projeté).
2. **Dotations neutralisées** = Σ dotations de l'année des immos à postes ; **dotations conservées** = Σ dotations de l'année des immos SANS postes. Invariant : neutralisées + conservées = amortissements classiques (même boucle de calcul, exact à l'euro).
3. **Résultat d'exploitation hors capitalisation** = EBE hors capitalisation − dotations conservées.
4. **IS théorique** = même barème PME que le classique (15 % jusqu'à 42 500 €, 25 % au-delà, seuils env), appliqué au résultat d'exploitation hors capitalisation. Étiqueté THÉORIQUE partout.
5. **Impôt net** = IS théorique − crédit d'impôt (crédit identique au classique en phase 1 ; garde B.4 si une immo passe en assiette « amortissement »).
6. **Résultat net (après IS)** = résultat d'exploitation hors capitalisation − IS théorique ; **résultat net estimatif** = résultat d'exploitation hors capitalisation − impôt net. Mêmes conventions que le CR classique.

Signature :

```js
// computeCrRetraite({ ebe: {factuel, projete}, amortissements,
//                     productionImmobilisee: {factuel, projete},
//                     dotationsParImmo: [{ nom, dotation, aPostes, assietteCredit }],
//                     creditTotal, isFn })
// -> { ebe: {factuel, projete},
//      dotationsNeutralisees: { montant, parImmo: [{ nom, dotation }] },
//      amortissements,                       // conservées
//      resultatExploitation: {factuel, projete},
//      is: {factuel, projete},
//      impotNet: {factuel, projete},
//      resultatNet: {factuel, projete},      // estimatif, après crédit (même clé que /api/ebe)
//      creditAdosseAuxDotations: bool }      // garde B.4 : un actif neutralisé est en assiette 'amortissement'
```

`isFn` = `computeIS` de server.js passé en paramètre : la source unique du barème (env-configurable) reste server.js, le module pur n'en duplique pas les seuils. Les tests utilisent un barème identique aux valeurs par défaut.

## B · Serveur (`/api/ebe` seulement)

1. **Détail des dotations par immo** : nouvelle fonction `computeDotationsDetailForYear(year)` → `{ total, parImmo: [{ nom, dotation, aPostes, assietteCredit }] }`. Réutilise le fetch immos existant + `fetchPostesByImmo` + `montantAmortissable` + `computeDotationForYear` (aucune formule nouvelle : la boucle actuelle de `sumDotationsForYear` garde le détail au lieu de le jeter). `nom` = même repli que utils/productionImmobilisee.js (`libelle || nom || titre`). Tolérante : tables absentes ou erreur → `{ total: 0, parImmo: [] }`. `sumDotationsForYear` devient un wrapper qui renvoie `.total` : les appelants existants (miroir, /api/ebe) sont intacts.
2. **Correctif de cohérence pré-existant (année de poste, trouvé par le panel)** : un poste à `annee` NULL entre à 100 % dans la base amortissable (`_prorataPoste` : `if (!annee) return 1`, server.js) alors que utils/productionImmobilisee.js le rattache à l'année de mise en service avec un vrai prorata, et que `sumCreditsForYear` applique déjà ce repli (server.js ~953) : trois lectures différentes du même poste. Correctif : appliquer le MÊME repli d'année (mise en service) dans le calcul des dotations (`montantAmortissable`/`_prorataPoste` via des postes normalisés en amont, comme le fait `sumCreditsForYear`). ATTENTION : peut modifier les dotations du CR CLASSIQUE si des postes à année NULL existent en base ; mesurer avant/après en recette et le dire à l'utilisateur.
3. **Invariant sur données réelles (garde-fou de survie, demande du panel)** : pour chaque immo à postes, vérifier que Σ (production immobilisée de toutes ses années civiles) = `montantAmortissable` à quelques euros d'arrondi près ; exposer un drapeau `invariantCasse: [{ nom, ecart }]` dans `retraite` et un badge d'anomalie dans la vue. C'est le seul contrôle qui survivra aux saisies futures (le test synthétique I1 ne voit pas les données réelles).
4. **Garde crédit d'impôt (méthode B)** : le mode `assiette_credit === 'amortissement'` existe déjà (server.js ~841, migration 40) : le crédit y est adossé aux dotations. Si un actif NEUTRALISÉ est dans ce mode, « crédit inchangé » devient incohérent (on retire du contrefactuel la charge qui fonde le crédit). Phase 1 : pas de recalcul, mais drapeau `creditAdosseAuxDotations` + badge d'avertissement explicite dans la vue (« crédit adossé aux dotations neutralisées : crédit non retraité »). La lettre au cabinet du 24/07 penche vers ce mode pour l'outil SimaPro : le badge s'allumera peut-être dès la réponse du cabinet.
5. **`/api/ebe`** : champ ADDITIF `retraite { ... }` (forme du module pur ci-dessus). Rien d'autre ne change dans la réponse : aucun consommateur existant n'est cassé.
6. **Miroir `computeResultatFactuelForYear` : INTOUCHÉ.** C'est un choix de conception, pas un oubli : la trésorerie et l'IS réel suivent la comptabilité.
7. Une ligne de log `[retraite] CR hors capitalisation %d : EBE %d€, dotations neutralisees %d€` au patron des logs produits.

## C · Front (public/pilot.html puis copie dist/pilot.html, bit-identiques)

1. **Bascule de vue** : deuxième groupe de pastilles « CR comptable / CR hors capitalisation » à côté des onglets exercice, même patron `.cr-year-btn` (nouvel état `crViewMode`, défaut comptable). Orthogonal aux deux contrôles existants. À l'activation de la vue hors capitalisation, la case « Projeté » est DÉCOCHÉE par défaut (colonne factuelle d'abord : mélanger un contrefactuel et du pipeline pondéré prête à confusion pour un lecteur externe) ; si l'utilisateur recoche, un badge visible « pipeline pondéré inclus » reste affiché.
2. **Pont de réconciliation en tête de vue** (à la place d'un simple bandeau, demande des 5 experts) : « Résultat d'exploitation comptable → − production immobilisée (158 247 €) → + dotations neutralisées (10 376 €) → = résultat d'exploitation hors capitalisation », suivi de la ligne la plus utile de la vue : « Surcoût d'IS {année} lié au choix de capitaliser : ≈ 36 968 €, récupéré via les amortissements des années suivantes » (seule composante réellement décaissée de l'écart). Et la lecture positive : « l'exploitation finance l'effort de développement interne ».
3. **Sous le pont, une phrase fixe** : « Contrefactuel : ce que montrerait le compte de résultat si les quote-parts de développement étaient restées en charges. L'IS réel, la trésorerie et les dividendes suivent le CR comptable. Ce n'est pas une vue de trésorerie (voir la page Trésorerie). »
4. **Dans le tableau, en vue hors capitalisation** : ligne production immobilisée absente ; ligne dotations = valeur conservée, sous-ligne « dotations des actifs neutralisés retirées avec la production immobilisée », clic → modale de détail : dotations classiques, − neutralisées par immo (`escapeHtml`), = conservées, PLUS le cumul pluriannuel « effet de la capitalisation depuis l'origine : X € · année de bascule estimée : YYYY » (données dispo via `computePlanAmortissement` et les postes par année : c'est ce qui matérialise le retour à zéro, invisible sinon puisque le CR n'affiche que N et N-1) ; modale IS : base hors capitalisation + mention « IS théorique recalculé ; l'IS réellement dû reste celui du CR comptable » ; bloc estimatif : crédit inchangé (+ badge B.4 le cas échéant).
5. **Bandeaux conditionnels** : si résultat hors capitalisation négatif → « exercice contrefactuel déficitaire : l'IS théorique des exercices suivants est surestimé (déficit reportable ignoré) » ; si `invariantCasse` non vide → badge d'anomalie ; tant que les quote-parts ne sont pas validées par le cabinet → le badge d'attente existant vaut pour LES DEUX vues (le CR comptable dépend des mêmes quote-parts).
6. Vue comptable : rendu strictement identique à aujourd'hui.
7. Contraintes : textes UI en français, jamais de tiret cadratin, `public/js/prospector.js` intouché.

## D · Invariants et tests (module pur, RED d'abord)

- **I1 · Invariant vie-entière** : pour un actif synthétique dont les postes tiennent sur une année et l'amortissement sur 5 ans, une fois l'actif totalement amorti, Σ sur toutes les années (production immobilisée N − dotations neutralisées N) = 0, donc Σ des écarts de RÉSULTAT D'EXPLOITATION comptable − hors capitalisation = 0. Données de test rondes pour un zéro exact. PRÉCISION (panel) : la convergence vaut au résultat d'exploitation UNIQUEMENT ; au résultat net elle est fausse en général (barème progressif appliqué année par année + déficits ignorés) : un test dédié exhibe un écart cumulé d'IS non nul sur un cas où une colonne passe sous 42 500 €.
- **I1 bis · Hypothèse documentée** : l'invariant suppose que le plan d'amortissement va à son terme. Sortie d'actif, mise au rebut, dépréciation (VNC en 675/6816) ne sont pas modélisées : le jour où un projet est abandonné, la charge de sortie n'est pas neutralisée et l'invariant casse (voir limite E7).
- **I2** : dotationsNeutralisees.montant + dotations conservées = amortissements classiques, à l'euro ; dotationsNeutralisees.montant = somme exacte de parImmo.
- **I3 · Périmètre** : une immo sans postes garde ses dotations dans les conservées ; une immo à postes est neutralisée même une année où elle n'a pas de poste (dotations d'une tranche capitalisée antérieure).
- **I4 · Colonnes** : le factuel utilise productionImmobilisee.factuel, le projeté .projete ; l'IS est recalculé par colonne.
- **I5 · Cascade** : resultatNet = resultatExploitation − (is − creditTotal), par colonne.
- **I6** : creditTotal identique dans les deux vues en phase 1 ; `creditAdosseAuxDotations` vrai dès qu'un actif neutralisé est en assiette 'amortissement' (test dédié).
- **I7 · Gouvernance (panel)** : test qui échoue si un consommateur HORS compte de résultat lit les champs `retraite.*` (primes, trésorerie, scénarios, analytics) : personne ne doit jamais calculer une prime sur la base la plus flatteuse des deux.
- **I8 · Invariant données réelles** : couvert côté serveur (B.3), testé sur des jeux synthétiques incluant un poste à année NULL et un actif mixte.
- **Chiffres de contrôle recette 2026** (données live du jour de la spec, ordre de grandeur) : EBE hors capitalisation projeté = 399 111 − 158 247 = 240 864 € ; dotations conservées = 0 ; IS théorique projeté = 6 375 + (240 864 − 42 500) × 25 % = 55 966 € ; résultat net estimatif ≈ 212 k€ (contre 322 757 en comptable) ; écart net ≈ 110 903 € = 147 871 × 75 % (les deux bases dépassent 42 500 €, taux marginal 25 % des deux côtés).

## E · Limites connues (assumées, documentées ici)

1. **Déficits reportables ignorés** : l'IS théorique est recalculé année par année et `computeIS` plafonne à 0 ; un exercice contrefactuel déficitaire perdrait son report (art. 209-I : report en avant illimité). Sans effet tant que chaque année hors capitalisation reste positive (cas 2026) ; bandeau C.5 dès qu'une année passe en négatif ; structure « déficit contrefactuel cumulé » en phase 2 si le cas devient réel.
2. **Approximations héritées du CR classique** : résultat imposable ≈ résultat d'exploitation, conditions du taux réduit 15 % supposées remplies (CA < 10 M€, capital libéré détenu à 75 % par des personnes physiques), pas de contribution sociale (CA < 7,63 M€). Rien de nouveau.
3. **L'étiquette « IS théorique » peut être sur la mauvaise colonne (panel, à trancher avec le cabinet)** : l'art. 236-I du CGI permet de déduire FISCALEMENT les dépenses de R&D et de conception de logiciels l'année où elles sont exposées, MÊME immobilisées comptablement (décision de gestion). Si Releaf exerce cette option, le résultat fiscal réel est proche de la vue hors capitalisation et l'IS réellement dû est INFÉRIEUR à celui du CR comptable (~56 k€ au lieu de ~93 k€). Question cabinet n° 3 ; en attendant, le bandeau reste prudent (« IS réel = CR comptable »).
4. **Années post-capitalisation** : une fois la capitalisation terminée, le résultat hors capitalisation dépasse le comptable (plus de bonus à retirer, dotations neutralisées). Comportement attendu du contrefactuel ; démonstration chiffrée en annexe ; le cumul C.4 le rend visible. NUANCE (panel) : la convergence vaut par actif ; si l'entreprise capitalise chaque année en régime permanent, l'écart d'EBE annuel ne se referme pas (seul l'écart de résultat d'exploitation converge).
5. **Pas une vue cash** : phrase à l'écran (C.3), renvoi à la page Trésorerie.
6. **Vue locale au CR** : Analytics, scénarios, graphes N vs N-1 et trésorerie restent en lecture comptable (mention à l'écran, C.3).
7. **Sorties d'actif non modélisées** (I1 bis) : abandon, cession, dépréciation cassent l'invariant ; à traiter le jour où le module Immobilisations gère les sorties.
8. **Subventions liées aux dépenses immobilisées** : l'art. 236 I bis (aides publiques à la recherche affectées à des dépenses immobilisées rapportées au rythme de l'amortissement) et le cas « subvention finançant des salaires par ailleurs capitalisés » ne sont modélisés dans aucune des deux vues. Questions cabinet n° 4 et 6.

## Questions au cabinet comptable (à poser dans le MÊME échange que la validation des quote-parts)

1. **Nature de l'outil SimaPro** : la lettre du 2026-07-24 le décrit comme « logiciel acquis » ; le module lui affecte 5 quote-parts de salaires (33 585 € de production immobilisée 2026). Si une partie du coût est un achat externe, elle n'a jamais à passer par le compte 72 : le CR comptable serait alors à corriger (et la saisie à scinder en deux immobilisations).
2. **Assiette CII/CIR par actif** : méthode A (dépenses engagées) ou B (dotations) ? Conditionne la garde B.4.
3. **Option de l'art. 236-I du CGI** : déduisons-nous fiscalement les dépenses de développement l'année de leur engagement malgré l'activation comptable ? (Change l'étiquette « IS théorique » de colonne, limite E3.)
4. **Art. 236 I bis** : s'applique-t-il aux aides affectées aux dépenses immobilisées ?
5. **Compte d'imputation (203 frais de développement ou 205 logiciels)** et conséquence sur la contrainte de distribution de dividendes (C. com. R. 123-187 : pas de distribution tant que les frais de développement ne sont pas amortis, sauf réserves libres suffisantes).
6. **Subventions finançant des salaires par ailleurs capitalisés** : faut-il les traiter en subventions d'investissement (étalement) ?
7. **Validation des quote-parts** (déjà en attente) : mêmes clés pour la production immobilisée, la base amortissable et l'assiette CII/CIR ; contrôle « par personne et par année, Σ quote-parts ≤ 100 % ».

## Découpage prévu (plan à venir)

T1 module pur `utils/crRetraite.js` + tests (TDD, I1 à I8) · T2 serveur (détail dotations + correctif année NULL mesuré + invariant données réelles + garde crédit + branchement `/api/ebe`, miroir intouché) · T3 front (bascule, pont de réconciliation, modales, bandeaux, parité dist).

## Hors lot
- **Champ `origine` (interne / acquis / mixte) sur les immobilisations** : périmètre par nature de dépense au lieu de la présence de postes ; couvre la future facture de prestataire immobilisée directement. Prérequis : réponse cabinet question 1.
- **Constat séparé sur le CR CLASSIQUE (panel, important, chantier propre)** : `montantAmortissable` somme les postes de TOUTES les années : le SaaS est amorti dès 2026 sur une base incluant les quote-parts 2027-2028 non encore engagées, et l'ajout d'un poste recalcule rétroactivement les dotations passées. Comptablement, un actif non achevé relève des immobilisations en cours (non amorties). La vue hors capitalisation y est immunisée (elle retire les deux côtés) mais le CR comptable affiche des dotations surévaluées (~8 100 € vs ~3 200 € en 2026 pour le SaaS selon le panel, à vérifier).
- Extension de la bascule aux graphes N vs N-1 et aux scénarios (phase 2 : le contrefactuel prend tout son sens en trajectoire).
- Indicateurs cash/bilan (CAF − production immobilisée, capitaux propres − frais de dev nets, LTM) : utiles en due diligence, mais hors contrainte « aucun nouveau KPI ».
- CR analytique conseil / SaaS (parking lot : la question suivante du dirigeant).
- Structure « déficit contrefactuel cumulé » pour l'IS théorique (E1), si un exercice hors capitalisation devient négatif.
- Toute écriture comptable ou export : la vue est un affichage de pilotage.

## Annexe · Pourquoi la vue hors capitalisation dépasse le CR comptable après la capitalisation (limite n° 4)

Question posée à la relecture (2026-08-13) : « le retraité doit retirer la production immobilisée et reprendre les dotations ; pourquoi peut-il être PLUS HAUT que le classique ? ». Réponse : c'est mathématiquement obligatoire, et c'est la preuve que le retraitement est juste, pas une erreur.

Actif simple de 100 construit en 2026 (salaires en charges), mis en service au 01/01/2027, amorti 20/an sur 5 ans :

| Année | Vue comptable | Vue hors capitalisation | Écart (hors capitalisation − comptable) |
|---|---|---|---|
| 2026 | charges −100 + production immobilisée +100 = 0 | charges pleines = −100 | −100 (hors capitalisation plus bas) |
| 2027 à 2031 | dotation −20/an | dotation reprise = 0 | +20/an (hors capitalisation plus haut) |
| **Cumul** | **−100** | **−100** | **0** |

Les deux vues reconnaissent le même coût total (100) : la comptable l'étale sur la durée d'amortissement, la vue hors capitalisation le date entièrement sur l'année des dépenses. Après la capitalisation, elle n'a donc plus rien à porter et passe forcément au-dessus, de l'exact montant des dotations reprises. Le cumul des écarts fait zéro : c'est l'invariant I1, verrouillé par un test du module pur (et il vaut au résultat d'exploitation ; voir D pour la nuance sur le net).

Contre-exemple (l'erreur évitée) : retirer la production immobilisée SANS reprendre les dotations donnerait un cumul de −200 : les salaires compteraient deux fois (charge pleine en 2026 + amortissements 2027-2031). C'est précisément le double comptage que le compte 72 existe pour empêcher ; le supprimer d'un côté oblige à le supprimer de l'autre.

Application aux chiffres réels 2026 (jour de la spec) : écart de résultat d'exploitation = 158 247 retirés − 10 376 repris = −147 871 € (la vue hors capitalisation est plus basse) ; après effet IS, écart de résultat net estimatif ≈ −110 903 €. Les années où plus rien n'est capitalisé, l'écart deviendra positif à hauteur des dotations reprises (~30 k€/an), jusqu'à extinction des plans d'amortissement.
