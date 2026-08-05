# Primes : découplage charge / décaissement + réel figé + état d'avancement · design

> Statut : PROPOSÉ (révisé le 2026-08-02 après critique adversariale à 3 angles)
> Remplace la règle « compta de caisse » de `2026-07-31-primes-gsheet-writeback-design.md` (charge datée au mois de décaissement).
> Décision de périmètre : **Option B** (prévisionnel juste + réel figé), retenue par le propriétaire du produit.

## 1. Problème

Aujourd'hui, une prime est datée à **un seul mois** : M+1 de la clôture du trimestre (`monthAfterQuarterClose`). Ce mois sert à la fois de **décaissement** (correct) et de **charge** dans le compte de résultat (faux). Une charge doit être rattachée à l'exercice où elle est **acquise** (comptabilité d'engagement, principe de séparation des exercices), pas où elle est **payée**. Cas critique : la prime du T4 est payée en janvier N+1 mais doit peser sur le résultat de l'année N (décembre).

De plus, le compte de résultat « réalisé » (mois clos) est calculé à partir du **réel bancaire Qonto**, qui ne connaît que les décaissements : même en datant correctement la charge dans le prévisionnel, dès qu'un mois est clos le réel re-date la prime à son paiement. Le découplage doit donc traiter les deux plans : prévisionnel **et** réel.

## 2. Principe retenu

Chaque prime porte **deux dates** :

| Date | Alimente | Règle |
|------|----------|-------|
| **charge** | `.Primes` → CR_Prev → EBE (compte de résultat) | dernier mois du trimestre de rattachement (mars, juin, sept., **déc.**) |
| **décaissement** | trésorerie (`byMonth`, inchangé) | M+1 de la clôture (avril, juil., oct., **janv. N+1**) |

Fait générateur de la charge : **la facturation de l'acompte**. Avant facturation, la prime est une **provision** (charge probable).

## 3. Périmètre

**Dans ce lot :**
- Découplage charge / décaissement dans le moteur (deux échéanciers).
- Écriture de la **charge** dans `.Primes` (au lieu du décaissement).
- **Réel figé (Option B)** : isoler les primes dans Qonto et faire lire la charge des primes toujours depuis le prévisionnel, jamais depuis le réel, pour que le résultat des mois clos reste juste (T4 notamment).
- Provisions glissantes des deals non facturés.
- Deux sous-onglets KPI (« Tableau des primes » + « État d'avancement »).

**Hors périmètre (lot suivant) :** écriture des décaissements dans l'onglet Plan_TRE (le décaissement interne est déjà correct).

## 4. Règles de calcul

**R1 · Découplage.** `computePrimePayments` produit deux échéanciers : `byMonth` / `byPartnerMonth` (décaissement, **conservés** pour la trésorerie et les tests) et de nouveaux `byMonthCharge` / `byPartnerMonthCharge` (charge). Chaque entrée de `detail` est enrichie de `{ dateCharge, dateDecaissement, statut }`.

**R2 · Charge étage 1, deal facturé.** Acompte facturé au trimestre `qFact` de l'année `yFact` : charge = `lastMonthOfQuarter(yFact, qFact)` (nouveau helper, mois = `qFact*3`) ; décaissement = `monthAfterQuarterClose(yFact, qFact)` (inchangé) ; statut selon R7.

**R3 · Provision étage 1, deal non facturé.** Deal signé, acompte pas encore facturé : charge = **dernier mois du trimestre courant ouvert**, calculé depuis la **vraie date du jour** ; la provision **glisse** à chaque recalcul ; statut = provisoire ; pas de date de décaissement.

**R4 · Rattrapage de charge (jamais perdue).** La charge d'une prime facturée est **toujours** portée par le prévisionnel, jamais « néant », même si son versement est déjà passé : une prime facturée non encore versée est une **charge à payer** qui doit peser sur le résultat dès la facturation. Si le mois de charge théorique (R2) est déjà clos **et appartient à l'exercice courant**, la charge est reportée au **dernier mois du trimestre courant ouvert** (plancher dynamique glissant, qui **remplace** la constante fixe `PRIMES_PLANCHER = '2026-10'`, supprimée). Si le mois de charge appartient à un **exercice antérieur clos**, la charge n'est **pas** reportée dans l'exercice courant (backfill de l'exercice clos, hors périmètre) : R4 ne franchit jamais la frontière d'exercice. La prime ne bascule au réel que lorsqu'elle est **effectivement versée** (l'Option B l'exclut alors du réel, cf. §5), ce qui évite tout double compte. Corollaire : le décaissement passé ne met JAMAIS la charge à « néant » (règle initiale abandonnée le 2026-08-02 après dry-run : elle supposait à tort que « versement passé » = « versé », donc dans le réel Qonto ; or aucune prime n'est encore versée, ce qui faisait disparaître les primes dues du résultat).

**R5 · Décaissement (inchangé).** Le mois de décaissement garde sa logique actuelle (M+1 + rattrapage `pastPolicy` propre à la trésorerie). Le rattrapage/`drop` ne s'applique **qu'au décaissement**, jamais à la charge.

**R6 · Étage 2 (collectif) = provision estimée.** Charge = `année + '-12'` (décembre N) ; décaissement = `(année+1) + '-' + versementEtage2Mois` (mars N+1). Statut = **provisoire** tant que l'exercice N n'est pas clos (la base est un budget `resultatAnnuel` et le seuil peut encore bouger). Un ajustement à la clôture (quand le résultat réel est connu) est possible mais hors de ce lot.

**R7 · Statuts et invariant.** Quatre statuts :
- **versé** : décaissement passé et validé (Phase 3) · aujourd'hui 0 (aucune validation branchée) ;
- **dû** : facturé, décaissement passé, pas encore validé (cas majoritaire actuel) ;
- **à venir** : facturé, décaissement futur ;
- **provisoire** : non facturé (provision).

Invariant : `total charge = versé + dû + à venir + provisoire`.

**R8 · Énumération multi-exercice.** Le moteur range les deals par **année de signature**, mais la charge est datée par **année de facturation**. Le write-back doit donc calculer sur plusieurs années de signature (N-2 à N) et retenir toutes les entrées dont la **date de charge** tombe dans l'exercice écrit. Sans ça, un deal signé en N-1 mais facturé en N verrait sa prime perdue alors que son CA est reconnu en N.

## 5. Traitement du réel figé (Option B)

Pour que la charge reste juste même après clôture d'un mois :
- **Prérequis opérationnel** : les virements de primes sont catégorisés dans Qonto sous une **sous-catégorie dédiée** (ex. « Primes commerciales »), stable et identifiable par `cashflow_subcategory.name`. Comme aucune prime n'a été versée, aucun historique n'est à recatégoriser.
- Dans `computeChargesHybride`, partie réelle (mois clos) : **exclure** les transactions de cette sous-catégorie du total réel (le décaissement des primes n'est plus compté comme charge du mois de paiement).
- Pour la charge des primes : lire `.Primes` (via CR_Prev) pour **tous les mois** de l'exercice (y compris clos), et non plus seulement les mois non clos. La charge de décembre N, écrite dans le Sheet avant la clôture (le cron tourne quotidiennement), reste ainsi portée dans l'exercice N après clôture, sans être écrasée par le réel.

Effet net : les primes sont **toujours** rattachées à leur mois de charge, jamais à leur mois de paiement, dans le prévisionnel comme dans le réalisé.

## 6. Architecture technique

### 6.1 `utils/kpiCompute.js` (moteur pur, testé)
- Ajouter `lastMonthOfQuarter(y, q)`.
- Étage 1 facturé : calculer les deux dates (R2), pousser dans les accumulateurs de charge + décaissement, enrichir `detail` avec `{ dateCharge, dateDecaissement, statut }`.
- Étage 1 non facturé : poser une provision de charge (R3, statut provisoire) dans `byPartnerMonthCharge` **et** émettre une entrée `detail` par deal (id, nom, partner, montant, dateCharge, statut, dateDecaissement=null) ; conserver `enAttente` / `enAttenteByPartner`.
- Étage 2 : dédoubler la date (R6), statut provisoire.
- Nouveaux `addCharge()` / `addPMCharge()` alimentant `byMonthCharge` / `byPartnerMonthCharge`, sans toucher `byMonth` / `byPartnerMonth`.
- Sortie : `{ byMonth, byPartnerMonth, byMonthCharge, byPartnerMonthCharge, detail(enrichi), enAttente, enAttenteByPartner, verse }`.

### 6.2 `server.js` (backend)
- **Helper partagé** `computePrimesChargeSchedule(years, nowIso)` : produit `byPartnerMonthCharge` + détail statué par deal + réconciliation, avec la **vraie date du jour** (plus de `now = OLD`) et l'**énumération multi-exercice** (R8). Consommé à la fois par le write-back et par l'endpoint d'avancement, pour qu'ils ne divergent jamais. Règle d'arrondi unique (`roundPreservingSum`).
- **Write-back** (`computePrimesByPartnerMonth`, `syncPrimesToSheet`) : bascule sur `byPartnerMonthCharge`.
- **Suppression** de `PRIMES_PLANCHER` et de son usage.
- **Réconciliation** : `gagné = somme(byPartnerMonthCharge)` (inclut étage 1 facturé + provisions + étage 2), décomposé en versé / dû / à venir / provisoire via `detail.statut`. Ne **jamais** ré-ajouter `enAttente` par-dessus (sinon double compte des provisions).
- **Charges hybrides (Option B)** : dans `computeChargesHybride`, exclure la sous-catégorie Qonto « Primes » du réel et injecter la charge des primes depuis CR_Prev pour tous les mois (cf. §5).
- **Trésorerie inchangée** (`byMonth` → `primesCommercialesVersees` → `décaissementsTRE`).
- **Nouvel endpoint** `GET /api/primes/avancement` : appelle le helper partagé, renvoie `{ parAssocie, parDeal, total, reconciliation }` avec statuts et `dateFactureAcompte` par deal.

### 6.3 `public/pilot.html` + `dist/pilot.html` (front)
- Deux sous-onglets entre `#prime-clawback` et les résultats, via le pattern `.kpi-signed-tabs` existant.
- Onglet 1 « Tableau des primes » = `#kpiPrimeResults` existant, rendu masquable.
- Onglet 2 « État d'avancement » = `#kpiPrimeAdvancement`, alimenté par `GET /api/primes/avancement` · statuts versé / dû / à venir / provisoire, au total, par associé, par deal (drill-down). Gérer le cas « aucune prime ».
- État `primeView` persisté ; fonctions clonées de `renderKpiSignedTabs` / `switchKpiSignedTab`.

## 7. Ce qui NE change PAS
- **Aucun fold** des primes dans le JS de l'EBE (le canal charge reste `.Primes → CR_Prev`).
- **Trésorerie** (`byMonth`) inchangée.
- **Migration** : aucune nouvelle table ; le cron, le bouton et `primes_sheet_sync` restent compatibles (le front ne lit que `data.updated`). Le nouveau contrat de `reconciliation` est documenté pour tout futur consommateur.
- **Clawback** : reste un voyant indicatif (bandeau `#prime-clawback`), sans reprise automatique de charge · les montants négatifs / contre-passations ne sont pas gérés dans ce lot (cas rare, mécanisme lourd). Limite documentée.

## 8. Impacts chiffrés attendus (2026, à valider en dry-run)
- Charge étage 1 T3 : passe d'octobre 2026 (décaissement) à **septembre 2026** (charge).
- Charge étage 2 : passe de mars 2027 (décaissement) à **décembre 2026** (charge) · l'EBE 2026 baisse d'autant.
- Provisions (deals signés non facturés) : apparaissent dans `.Primes` au trimestre courant.
- Anciennes cellules (octobre 2026, mars 2027) remises à 0 · si le premier run intervient après leur clôture, prévoir un nettoyage one-shot (elles sont inertes pour l'EBE grâce à l'Option B, mais à assainir dans le Sheet).

## 9. Tests
`utils/kpiCompute.test.js` :
- Conserver les assertions `byMonth` (décaissement).
- Adapter « acompte non facturé » : `byMonth` vide **mais** `byPartnerMonthCharge` non vide (provision, statut provisoire).
- Ajouter : charge étage 1 = dernier mois du trimestre de facturation ; provision au trimestre courant (avec `now` réaliste) ; charge étage 2 = décembre N vs décaissement mars N+1 ; rattrapage R4 plafonné (ne dépasse pas le décaissement, reste dans l'exercice) ; deal signé N-1 / facturé N (charge dans l'exercice N) ; `lastMonthOfQuarter` unitaire.
- Réconciliation : `total charge = versé + dû + à venir + provisoire` à l'euro.
- Option B : test unitaire du filtrage de la sous-catégorie Qonto « Primes » si extrait en util pur.

## 10. Points de vigilance résiduels
1. **Formule GSheet hors repo** : vérifier manuellement que `.Primes → CR_Prev` agrège la colonne décembre dans l'exercice N.
2. **Étage 2 figé au 31/12** : si le CA facturé change après clôture, la charge de décembre est figée · acceptable en pilotage, ajustement de clôture éventuel plus tard.
3. **Colonnes GSheet** : `buildUpdates` n'écrit que dans les colonnes existantes · vérifier en recette la présence de 03/06/09/12 de l'exercice + colonnes de débordement, sinon charge perdue silencieusement.
4. **Sous-catégorie Qonto** : dépend d'une catégorisation manuelle disciplinée · si un virement de prime n'est pas catégorisé, il sera compté deux fois (réel + charge).
5. **Charge facturée après la clôture de l'exercice : perte, pas un simple report.** Un acompte du T4 de l'année N saisi dans Notion après le 31/12 produit une `dateCharge` en décembre N. R4 ne franchit jamais la frontière d'exercice, donc ne reporte pas cette charge dans l'exercice suivant ; le filtre de l'exercice courant l'écarte du calcul ; et le figement du write-back interdit d'écrire dans un exercice déjà clos dans le Sheet. Résultat : cette charge n'est écrite nulle part, elle est **perdue**, pas simplement différée. Contournement possible : lancer une dernière synchronisation de l'année avant le 31/12, ou traiter ces cas manuellement après coup. Un backfill des exercices clos reste hors périmètre de ce lot.
6. **`.Primes` ne doit contenir que les lignes des associés.** Pour un mois clos, la charge des primes est réinjectée en lisant *toutes* les lignes de la catégorie `.Primes` de l'onglet `Masse_salariale` (cf. §5), alors que l'exclusion côté Qonto ne retire que la sous-catégorie « Primes commerciales ». Si quelqu'un ajoute dans `.Primes` une ligne étrangère (la prime d'un salarié non associé, par exemple), elle serait comptée deux fois sur les mois clos (réel + charge). À vérifier une fois dans le tableur, et à garder en tête avant d'ajouter une ligne à cette catégorie.

## 11. Prérequis opérationnel
Créer / choisir dans Qonto une sous-catégorie stable pour les primes commerciales et y classer les virements de primes dès le premier versement.

## 12. Découpage prévisionnel en tâches (détaillé par le plan)
1. Helper `lastMonthOfQuarter` + tests.
2. Découplage dans `computePrimePayments` (accumulateurs de charge, statuts, étage 1 facturé, `detail` enrichi) + tests.
3. Provisions glissantes (R3) + rattrapage plafonné (R4) + `now` réel + tests.
4. Étage 2 charge décembre N (provisoire) + tests.
5. Helper partagé `computePrimesChargeSchedule` + énumération multi-exercice (R8) + réconciliation redéfinie.
6. Bascule du write-back sur la charge + suppression `PRIMES_PLANCHER`.
7. Option B : sous-catégorie Qonto exclue du réel + charge primes lue pour tous les mois dans `computeChargesHybride`.
8. Endpoint `GET /api/primes/avancement`.
9. Front : 2 sous-onglets + vue « État d'avancement ».
10. Documentation (note mémoire, bandeau REMPLACÉ sur la spec du 2026-07-31) + recette chiffrée + dry-run puis synchro réelle.
