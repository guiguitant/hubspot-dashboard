# Question à Actemis · assiette et année d'imputation du CII / CIR pour des immobilisations

**Émetteur :** Nathan Gourdin (Releaf Carbon)
**Date :** 24/07/2026
**Objet :** valider la méthode de calcul et surtout **l'année sur laquelle le crédit d'impôt (CII / CIR) est acquis** pour des dépenses qui sont immobilisées (et non passées en charges).

Releaf est une PME. Nous développons un outil interne de suivi financier qui estime nos crédits CII (20 %) et CIR (30 %). Avant de nous appuyer dessus, nous voulons caler la méthode avec vous. Deux immobilisations concrètes servent d'exemple ci-dessous.

---

## La question centrale

Pour une **immobilisation** (dépenses capitalisées, pas passées en charges), l'assiette du CII / CIR d'une année est-elle :

- **(A)** les **dépenses éligibles engagées** cette année-là (salaires, prestations, coût d'acquisition), prises l'année d'engagement ; ou
- **(B)** les **dotations aux amortissements** de l'immobilisation, donc l'assiette est **étalée sur la durée d'amortissement** une fois l'actif mis en service ?

Aujourd'hui notre outil applique **(A)** pour les deux immos. Nous voulons savoir si c'est correct, et si la réponse diffère selon la **nature** de l'immobilisation (livrable R&D développé en interne vs outil/matériel acquis servant à la R&D).

L'enjeu n'est pas le montant total du crédit, mais **sur quelle(s) année(s) il tombe** (donc quel exercice voit son IS réduit / son résultat amélioré).

---

## Immobilisation 1 · « SaaS » (logiciel développé en interne, éligible CII)

- **Nature :** frais de développement d'un logiciel créé en interne, capitalisés (immobilisation incorporelle).
- **Période projet :** 20/02/2026 → 20/02/2028. **Mise en service :** 02/11/2026. **Amortissement :** linéaire, 5 ans.
- **Dépenses éligibles :** salaires R&D (Arthur, Thomas, Evane, Guillaume) + une prestation (Polara), engagés sur 2026-2028.
- **Aides France 2030 :** subvention + avance récupérable, lissées sur la durée du projet ; l'avance est réintégrée à l'assiette au fur et à mesure de son remboursement.
- **Assiette éligible CII nette (après aides) :** 163 311 € → **crédit CII estimé 32 662 € (20 %)**.

**Répartition actuelle du crédit (méthode A, année d'engagement) :**

| Année | Base CII nette | Crédit CII (20 %) | Dotation amortissement |
|------:|---------------:|------------------:|-----------------------:|
| 2026 | 64 251 € | 12 850 € | 8 131 € |
| 2027 | 42 499 € | 8 500 € | 49 462 € |
| 2028 | 561 € | 112 € | 49 462 € |
| 2029 | 11 200 € | 2 240 € | 49 462 € |
| 2030 | 11 200 € | 2 240 € | 49 462 € |
| 2031 | 11 200 € | 2 240 € | 41 331 € |
| 2032 | 11 200 € | 2 240 € | · |
| 2033 | 11 200 € | 2 240 € | · |

> Les montants 2029-2033 correspondent à la **réintégration de l'avance récupérable** au moment de ses remboursements (pas à des dépenses nouvelles).

**Si méthode (B) au contraire**, l'assiette CII serait la dotation aux amortissements (8 131 € en 2026, ~49 462 €/an ensuite), et le crédit serait étalé différemment.

---

## Immobilisation 2 · « Outil simapro » (outil acquis servant à la R&D, éligible CIR)

- **Nature :** logiciel/outil (SimaPro, logiciel d'analyse de cycle de vie) **acquis** et utilisé pour nos travaux de R&D.
- **Mise en service :** 01/09/2026. **Amortissement :** linéaire, 5 ans.
- **Assiette :** 61 878 € → **crédit CIR estimé 18 563 € (30 %)**.

**Répartition actuelle du crédit (méthode A) :** la totalité, soit **18 563 €, est imputée sur 2026** (année d'acquisition).

**Si méthode (B) :** l'assiette CIR serait la **dotation aux amortissements** de l'outil, soit :

| Année | Dotation | Crédit CIR (30 %) si assiette = dotation |
|------:|---------:|-----------------------------------------:|
| 2026 | 4 137 € | 1 241 € |
| 2027 | 12 376 € | 3 713 € |
| 2028 | 12 376 € | 3 713 € |
| 2029 | 12 376 € | 3 713 € |
| 2030 | 12 376 € | 3 713 € |
| 2031 | 8 239 € | 2 472 € |

C'est ici que l'écart est le plus fort : **18 563 € sur 2026** (méthode A) contre **~1 241 € sur 2026** puis étalement (méthode B). Pour un actif amortissable utilisé pour la recherche, notre lecture des textes (assiette = dotations aux amortissements) pencherait plutôt vers (B), mais nous voulons votre confirmation.

---

## Questions précises

1. **Assiette (A ou B) ?** Pour chacune des deux immobilisations ci-dessus, l'assiette annuelle est-elle les dépenses engagées l'année (A) ou les dotations aux amortissements (B) ? La réponse dépend-elle de la nature (logiciel développé en interne = livrable R&D vs outil acquis servant à la R&D) ?

2. **Dépenses de personnel capitalisées :** quand les salaires R&D sont immobilisés (frais de développement), entrent-ils dans l'assiette CII/CIR **l'année où ils sont exposés**, ou via les dotations ? Y a-t-il une **règle anti double-comptage** (ne pas compter à la fois la dépense et la dotation) ?

3. **Année d'acquisition du crédit et imputation :** le crédit est-il acquis au titre de l'exercice de la dépense/dotation, imputé sur l'IS de **ce même exercice**, l'excédent étant **restitué** (nous sommes une PME) ? Sur quel exercice comptabiliser la créance ?

4. **Taux et forfaits (à confirmer) :** nous appliquons **CII 20 %** (forfait des frais de fonctionnement supprimé depuis le 01/01/2023) et **CIR 30 %** avec un **forfait de 40 %** des dépenses de personnel. Est-ce exact pour nos exercices ?

5. **Aides publiques (France 2030) :** nous **déduisons les aides de l'assiette**, en les **lissant sur la durée du projet** ; pour l'**avance récupérable**, nous la déduisons puis la **réintégrons à l'assiette au moment de chaque remboursement**. Cette méthode est-elle correcte, ou faut-il déduire l'aide l'année de son encaissement ?

6. **Sous-traitance :** pour qu'une **prestation** entre dans l'assiette CII/CIR, l'**agrément** du prestataire est-il requis ? Des **plafonds** s'appliquent-ils ?

---

## Ce que fait l'outil aujourd'hui (pour repérage)

- Assiette = **dépenses engagées l'année** (méthode A), pour les deux immos.
- Base nette = dépenses éligibles − aides lissées + réintégration des avances remboursées.
- Crédit = base nette × taux (CII 20 % / CIR 30 %), imputé sur l'IS de l'exercice, **surplus intégré au résultat net** de la même année.
- Amortissement linéaire prorata temporis, indépendant du calcul du crédit.

Merci de nous indiquer les corrections à apporter, en priorité sur les questions 1 à 3 (l'année d'imputation), qui conditionnent la fiabilité de nos prévisions.
