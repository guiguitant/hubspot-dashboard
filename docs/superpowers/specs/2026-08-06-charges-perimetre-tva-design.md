# Charges du compte de résultat : périmètre, TVA, fenêtrage · design

> Statut : VALIDÉ (audit 6 axes du 2026-08-06 + arbitrages utilisateur ; périmètre et TVA tranchés en expertise comptable sur délégation explicite de l'utilisateur)
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

1. **Périmètre (décision d'expert, PCG)** : la TVA reversée n'est jamais une charge (comptes de tiers 445) ; l'IS est une charge mais hors exploitation et déjà recalculé plus bas → les deux sortent des charges d'exploitation. Le **prélèvement à la source reste** en charges (partie du salaire brut) : on exclut des sous-catégories précises, jamais la catégorie « Impôts et taxes » entière.
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

## 4. Hors périmètre (sujets suivants, signalés par l'audit)

- Écart subventions : 105 333 € encaissés (Qonto) vs 58 800 € comptés (`/api/ebe`, source Plan_TRE).
- SaaS immobilisé : salaires et prestation Polara en charges pleines ET amortis, sans production immobilisée en produit.
- Crédits fournisseurs (avoirs, 142 € en 2026) non déduits : négligeable, revoir si ça grossit.
- Pont HubSpot → Notion (création automatique des missions) : n'existe pas, chantier séparé si souhaité.
