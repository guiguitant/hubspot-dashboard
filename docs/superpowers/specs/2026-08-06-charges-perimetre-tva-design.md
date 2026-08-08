# Charges du compte de résultat : périmètre, TVA, fenêtrage · design

> Statut : IMPLÉMENTÉ · en recette utilisateur (merge en attente de validation) · 2026-08-07 (audit 6 axes du 2026-08-06 + arbitrages utilisateur ; périmètre et TVA tranchés en expertise comptable sur délégation explicite de l'utilisateur)
> Branche : `fix/charges-perimetre-tva`

## 1. Problème

Le total de charges 2026 du compte de résultat (509 638 €) est faussé par six défauts, et diverge de la carte Analytics (468 535 €) depuis le 31/07/2026 (bascule de la carte sur le budget pur). L'audit complet est dans le rapport du workflow `wf_b789d780-ea8` ; synthèse :

| # | Défaut | Origine | Impact 2026 |
|---|--------|---------|-------------|
| D1 | Réel bancaire TTC additionné au budget HT | 2026-03-18 (da65879), grossit d'un mois chaque mois | ~25 157 € de TVA comptée en charge |
| D2 | TVA reversée à l'État comptée en charge | idem | 27 838 € |
| D3 | IS payé compté en charge ET recalculé par `computeIS` | 2026-07-22 (création vue CR) | 3 647 € (+ remboursement 15 852 € jamais déduit) |
| D4 | Fenêtre réelle coupée au 28 du mois | 2026-03-18 | 26 968 € de charges de fin juillet invisibles (à la baisse) |
| D5 | Total Analytics : catégories négatives jetées (`if (sum > 0)`) | 2026-03-18 | +14 652 € |
| D6 | Filtre primes cherche « Primes commerciales », la sous-catégorie Qonto réelle est « Primes associées » | 2026-08-04 (chantier primes) | 14 400 € de primes 2025 comptés en charge 2026 ; +14 400 de plus dès le prochain virement |

## 2. Décisions (toutes actées)

1. **Périmètre (décision d'expert, PCG)** : la TVA reversée n'est jamais une charge (comptes de tiers 445) ; l'IS est une charge mais hors exploitation et déjà recalculé plus bas → les deux sortent des charges d'exploitation. Le **prélèvement à la source reste** en charges (partie du salaire brut) : on exclut des sous-catégories précises, jamais la catégorie « Impôts et taxes » entière. **Tâche 10 (2026-08-08)** : ce périmètre s'applique désormais des DEUX côtés, réel Qonto (`chargesPerimetre.isHorsExploitation`) ET budget CR_Prev (`chargesPerimetre.isHorsExploitationBudget`, libellé budgétaire distinct : « IS (impôt sur les sociétés) ») ; voir I1 en section 5, résolu par ce même commit.
2. **TVA (décision d'expert, RÉVISÉE le 2026-08-06 après analyse comparative des sources)** : conversion du réel en HT par **hiérarchie de sources** : (0) TVA **exacte de la facture fournisseur Pennylane** rattachée à la transaction via le lettrage comptable (`supplier_invoices` + `ledger_entry_lines`, accessibles avec le token en place ; 349 factures jan-juil 2026, HT+TVA=TTC sur 100 %, concordance 0,3 % avec les comptes 4456* du grand livre ; couvre 65-69 % des euros de dépense) ; (1) taux de la table du classeur pour le couple catégorie/sous-catégorie ; (2) taux de la catégorie ; (3) TTC inchangé. La table devient un REPLI (~9 % des flux) au lieu de la source unique. Le champ `vat_amount` de Qonto est écarté (48,5 % de couverture, 15 % d'erreur bidirectionnelle, faux zéros indiscernables). La TVA **non récupérable** reste en charge. Le point « holdings à confirmer comptable » se dissout : leur TVA est lue sur leurs factures. Limite assumée : le mois en cours retombe majoritairement sur la table tant que le comptable n'a pas saisi (médiane 4 jours, p90 38 jours) ; un indicateur de complétude l'affiche. Contrat : `montantHT(tx, tableTaux, indexExact)` avec `indexExact` optionnel (rétro-compatible, construit par deux fetchs bulk en cache 10 min, jamais d'appel par facture).
3. **D6** : constante remplacée par une **liste normalisée** (accents/casse ignorés), défaut `['Primes associées', 'Primes commerciales']`, surchargée par env. **Plus jamais de silence** : compteur `primesExclues { nb, montant }` exposé et journalisé.
4. **D4** : vraie fin de mois (heure locale, même référentiel que le bucketing), fenêtres N et N-1.
5. **D5** : `if (sum !== 0)` sur les trois filtres (`totals`, `ventilationChargesDetail`, `prevSubVentilation`).
6. **Primes 2025 (validé utilisateur)** : saisie manuelle de 24 000 € HT en décembre 2025 (12 000 Vincent + 12 000 Guillaume) dans `.Primes` du classeur ; la réinjection les remonte dans les charges 2025. Précaution préalable : vérifier que la ligne Primes de Plan_TRE ne recopie pas Masse_salariale (sinon décaissement fantôme déc. 2025).
7. **Réinjection primes (corrections annexes de l'audit)** : participants dérivés de l'année de la fenêtre (pas de l'année courante) ; libellé `sousCat: '.Primes'` aligné sur CR_Prev ; log du montant réinjecté.
8. **Carte Analytics** : garde sa source budget mais l'affiche (« Budget de charges HT · CR_Prev ») ; commentaires mensongers du front corrigés (dont pilot.html:10436).
9. **Route legacy `/api/charges`** : reçoit les mêmes exclusions et la même conversion (sinon deux vérités).
10. **Tests** : helpers purs testés jest (normalisation, exclusions, fin de mois, montantHT) + script de recette qui vérifie l'invariant « total = somme de sa série mensuelle » sur chaque endpoint.

## 3. Chiffres attendus (recette, à ±1 €/mois d'arrondi)

- D4 seul : `real.total` 280 695 → **307 663** ; juillet complet 70 188.
- D5 seul : `/api/previsionnel-charges` 2026 → **453 883** (= somme de sa série), moyenne 37 824.
- D6 seul : −14 400 sur le total hybride.
- Périmètre (TVA reversée + IS, jan-juil) : −31 485 environ.
- TVA HT (jan-juil) : −24 800 à −25 900 (central ~25 157), sous réserve holdings.
- Résultat net combiné 2026 : total charges attendu ~**491 000 à 494 000 €** (mesure exacte à la recette). Résultat 2025 corrigé : positif (~+100 k€), à recalculer après rattrapage primes.

## 4. Résultats mesurés (recette du 2026-08-07)

- CR 2026 (hybride) : `totalCharges` **476 648 €** (départ 509 638 €) ; invariant total = somme de la série mensuelle vérifié. Exclusions : primes 14 400 € (2 tx) + TVA/IS 22 055 € (5 tx). TVA exacte de facture Pennylane (priorité 0) : 191 977 € / 271 208 € = **70,8 %** des euros du réel convertis par cette priorité.
- Carte Analytics (budget pur, CR_Prev) : **453 883 €**, invariant vérifié, moyenne mensuelle 37 824 €.
- EBE 2026 : factuel **+45 482 €** (départ +12 632 €), projeté 231 582 €.
- 2025 : charges **359 725 €** (départ 441 951 €), EBE factuel **+64 254 €** (départ −17 972 €) : l'exercice 2025 est désormais cohérent avec l'impôt réellement payé.
- Cache index TVA (`fetchIndexExactTVA`) : premier appel ~33 s, appels suivants 0,09 s (cache 10 min, par `fromDate`).
- Tests : 275/275.

## 5. Hors périmètre (sujets suivants, signalés par l'audit ou en cours de chantier)

Signalés par l'audit initial :

- Écart subventions : 105 333 € encaissés (Qonto) vs 58 800 € comptés (`/api/ebe`, source Plan_TRE).
- SaaS immobilisé : salaires et prestation Polara en charges pleines ET amortis, sans production immobilisée en produit.
- Crédits fournisseurs (avoirs, 142 € en 2026) non déduits : négligeable, revoir si ça grossit.
- Pont HubSpot → Notion (création automatique des missions) : n'existe pas, chantier séparé si souhaité.

Signalés en cours de route (T6/T8), non corrigés car hors périmètre de leur tâche respective :

- Bug latent pré-existant : le graphe « Charges N vs N-1 » lit `analyticsChargesData?.real?.end` (pilot.html:10310) pour distinguer visuellement les mois passés des mois prévisionnels (hachures), mais `analyticsChargesData` provient de `/api/previsionnel-charges`, qui ne retourne jamais de champ `real` (seul `/api/charges-hybride` le fait). `realEnd` vaut donc toujours `null` : les hachures ne s'affichent jamais. Probablement hérité d'une époque où ce graphe consommait `/api/charges-hybride`. Non touché en T8 (aucun changement de logique JS dans son périmètre) : à corriger en tâche séparée si le rendu visuel doit être restauré.
- ~~Sous-titres des cartes « Charges du mois » et « Moyenne mensuelle »...~~ RÉSOLU (revue finale, C3) : harmonisés avec la carte « Budget de charges HT » (« CR_Prev · budget du mois, hors réel bancaire » / « CR_Prev · moyenne budget, hors réel bancaire »).
- Factures en devise étrangère non converties : 21/349 factures (6 %) exclues de l'index TVA exact faute d'un champ HT fiable en euros sur `supplier_invoices` ; impact faible en euros, traité par prudence (repli sur la table ou le TTC).
- ~~Pas d'éviction des entrées expirées du cache index TVA par `fromDate`...~~ SANS OBJET depuis la revue finale (C1) : la fenêtre de l'index est désormais FIXE (1er janvier de `currentYear - 2`, indépendante de l'appelant), `indexExactTVACacheByFrom` n'a donc plus jamais qu'une seule clé possible en pratique. Voir aussi I2 ci-dessous (cache négatif) pour le comportement en cas de panne Pennylane.

Signalés par la revue finale de branche (2026-08-07), documentés sans changement de code :

- ~~**I1** : les exclusions PCG (TVA reversée, IS · cf section 2.1) ne s'appliquent qu'au réel Qonto...~~ RÉSOLU (Tâche 10, 2026-08-08) : `chargesPerimetre.isHorsExploitationBudget(label)` (nouveau helper pur, testé jest) reconnaît les sous-lignes budgétaires hors exploitation sur libellé normalisé (« is ( » en préfixe ou « impot sur les societes » en contenance pour l'IS ; « paiements de la tva »/« tva reversee »/« reversement tva » pour la TVA reversée, aucune ligne de ce type dans le classeur à ce jour). Branché via `filterCRPrevBudgetHorsExploitation(categories, subCategories)` (server.js) aux DEUX chemins « charges » qui agrègent les sous-lignes de CR_Prev : `/api/previsionnel-charges` et la partie prévisionnelle de `computeChargesHybride`. Reste volontairement NON filtré : la trésorerie (`buildTresorerieFromQonto`), l'EBE prévisionnel (`buildPrevisionnel`) et le picker d'override (`/api/cr-prev/categories`), qui ont besoin du décaissement budgété complet (IS/TVA compris) pour leurs propres usages. Mesuré à la recette (2026-08-08) : `/api/previsionnel-charges?start=2026-01&end=2026-12` passe de 453 883 € à **469 735 €** (= ligne 6 du classeur, la ligne IS de −15 852 € n'est plus omise à tort) ; `/api/charges-hybride` 2026 reste inchangé à 476 648 € car la ligne IS est budgétée en avril, un mois déjà hors de la fenêtre prévisionnelle de `computeChargesHybride` (celle-ci démarre au mois courant, la ligne était donc déjà absente du calcul avant ce correctif, sans lien avec le filtre PCG).
- **I4** : la série comparative N-1 (`comparaison.Nm1`, boucle `txsNm1` de `computeChargesHybride`) ne reçoit pas la réinjection de la charge des primes (celle-ci n'alimente que `chargesParMoisN`, jamais `chargesParMoisNm1`). Sans effet en 2026 : aucune prime 2025 n'est présente dans Qonto sous la sous-catégorie exclue (rattrapage 2025 saisi directement dans le GSheet, pas de virement Qonto correspondant). Mais dès 2027, la barre N-1 « 2026 » du graphe Charges N vs N-1 sera amputée des primes exclues du réel 2026 (puisqu'elles ne sont réinjectées que côté N, jamais côté N-1). Décision : documenté, à corriger avant 2027 si la comparaison N/N-1 doit rester homogène.

Action utilisateur restante :

- Coller la table de repli des taux de TVA (~10 lignes, livrée en T5, onglet « Categories » du classeur, colonnes C/D/E).
- Créer la colonne « Récupérable » (colonne E) dans ce même onglet ; tant qu'elle n'existe pas, toutes les lignes sont considérées récupérables par défaut (attention particulière : la ligne `Travel Expenses` doit être marquée « non » dès que la colonne existe, sinon elle sera convertie en HT à tort).
