# Spec · Write-back des primes vers Google Sheets

**Date** : 2026-07-31
**Statut** : **LIVRÉ** (branche `feat/prime-kpi-cr-tresorerie`)
**Amont** : suite des phases primes (`2026-07-30-prime-kpi-compte-resultat-design.md`,
`2026-07-30-prime-kpi-cr-phase1.md`, `2026-07-30-prime-kpi-tresorerie-phase2.md`).
Mémoire projet : `gsheet-primes-writeback.md`.

> Ce document décrit la solution **telle que livrée**. Le design a évolué en cours
> d'implémentation (alignement à l'euro, plancher de décaissement, périmètre exercice
> courant) ; les décisions ci-dessous sont les décisions finales.

## Objectif

Pilot écrit automatiquement (cron quotidien + bouton) les primes calculées dans l'onglet
KPI vers le Google Sheet, onglet **Masse_salariale**, catégorie **`.Primes`**, une
sous-ligne par associé (Vincent, Guillaume, Nathan), à la colonne du bon mois. Les montants
collent **à l'euro** à l'onglet KPI. Les retards sont regroupés sur une **première échéance
de décaissement fixe** (octobre 2026). En parallèle, le **double compte** des primes dans
l'EBE est retiré : elles entrent désormais par la formule `.Primes → CR_Prev`.

## Décisions validées (finales)

1. **Part collective** répartie à parts égales (÷ nombre de participants), écrite dans la
   **même ligne `.Primes`** que l'individuel, au mois de son versement.
2. **Version prudente** : acompte-gated, **deal par deal**. Une part de prime n'apparaît que
   si l'acompte de son deal est facturé ; sinon elle reste « en attente » (bucket
   `enAttente`, exclu de l'écriture) jusqu'à la facturation.
3. **Règle de date de versement** : la prime individuelle est versée à **M+1 de la clôture du
   trimestre où l'acompte est facturé**. Le trimestre de signature ne sert qu'au portillon et
   au montant. Le collectif est versé au mois configuré de N+1 (défaut mars).
4. **Alignement à l'euro avec l'onglet KPI** : le montant de prime est calculé **comme le
   front** (au niveau trimestre agrégé : `CA_signé_trimestre × taux`), puis **réparti sur les
   deals au prorata** de leur montant (pour conserver l'échéance et le garde-fou par deal),
   **sans arrondi intermédiaire** ; l'arrondi final se fait à l'écriture en **préservant le
   total par associé** (méthode du plus grand reste). Résultat : le total écrit par associé =
   ce que Pilot affiche, à l'euro.
5. **Plancher de décaissement fixe** (`PRIMES_PLANCHER = '2026-10'`) : les primes de
   l'exercice courant dont l'échéance théorique est **antérieure** au plancher y sont
   **regroupées** ; les autres restent à leur échéance. Le plancher étant **fixe** (et non
   recalculé chaque jour), la charge **ne glisse pas** dans le temps. (Ce mécanisme remplace
   le « figement / drop » initialement envisagé.)
6. **Périmètre = exercice courant uniquement**. Ses primes couvrent déjà octobre N → avril
   N+1 (le débordement du T4 vers janvier N+1 est inclus dans le calcul de l'exercice). L'année
   N-1 (exercice clos) n'est **pas** réécrite ; un backfill séparé reste possible si besoin.
7. **Déclenchement** : **cron quotidien** (`node-cron`, 03:00) + **bouton « Synchroniser le
   GSheet »** dans l'onglet KPI, avec affichage « dernière synchro ».
8. **Découverte des coordonnées via l'API authentifiée live** (compte de service, pas gviz).
   **Sécurité stricte** : coordonnée introuvable (en-tête mois, catégorie `.Primes`, ou un
   associé) → **on n'écrit rien** et on loggue.
9. **Retrait du double compte EBE** : les primes ne sont plus ajoutées au total des charges
   dans `/api/ebe` ni dans `computeResultatFactuelForYear` (le « fold » du pool annuel). Elles
   entrent **une seule fois** via la formule `.Primes → CR_Prev` (agrégées dans les Frais de
   personnel). Compta de caisse : la charge tombe au mois de décaissement.
10. **Observabilité** : horodatage « dernière synchro » persisté en base (table
    `primes_sheet_sync`), exposé dans Pilot.

## Règle de versement (finale)

Prime **individuelle** : versée à **M+1 de la clôture du trimestre civil de la date d'acompte**
(acompte T1 → avril, T2 → juillet, T3 → octobre, T4 → janvier N+1), **puis** application du
plancher : si l'échéance est antérieure à `PRIMES_PLANCHER`, elle est reportée sur ce mois.

Exemple (mise en place juillet 2026, aucune prime versée) : les deals facturés au T1/T2/T3
2026 se regroupent sur **octobre 2026** ; les deals facturés au T4 2026 vont en **janvier
2027** ; un deal facturé au T1 2027 va en **avril 2027**. Total écrit = 100 % des primes
gagnées de l'exercice.

Prime **collective** (étage 2) : `collTotal ÷ participants`, versée au mois de N+1 configuré.

## Point de vigilance : primes décaissées dans le réel Qonto

`computeChargesHybride` bascule par mois : **mois clos → réel Qonto**, **mois futurs →
prévisionnel CR_Prev** (avec `.Primes`). Une prime n'est donc comptée **qu'une fois** : tant
que son mois est futur, via `.Primes`/CR_Prev ; une fois le mois clôturé, via le décaissement
Qonto (et `.Primes` ne compte plus pour ce mois). Pas de double compte, à condition que le
fold EBE soit retiré (décision 9).

## Architecture (livrée)

- **`utils/kpiCompute.js`** · `computePrimePayments` :
  - Règle de date unifiée (M+1 clôture trimestre d'acompte).
  - Prime façon KPI (agrégée par trimestre) répartie au prorata des deals, en float.
  - Sorties : `byMonth` (agrégé), **`byPartnerMonth`** (par associé/mois), `detail`,
    **`enAttenteByPartner`**, `enAttente`, `verse`. Paramètre `participants` (÷ collectif).
- **`utils/primesSheetMap.js`** (pur, testé) : `colToLetter`, `parseMonthHeader`,
  `discoverLayout` (en-tête mois + `.Primes` + associés), `assertPartners` (garde-fou),
  `buildUpdates` (cellules >= mois courant, valeur ou 0 pour figer/nettoyer),
  **`roundPreservingSum`** (arrondi préservant le total par associé).
- **`utils/googleSheets.js`** : client `google.auth.JWT` (compte de service, `.env`),
  `readGrid(spreadsheetId, tab, range)`, `batchWrite(spreadsheetId, updates)`.
- **`server.js`** :
  - `MASSE_TAB = 'Masse_salariale'`, `PRIMES_PLANCHER = '2026-10'`.
  - `primeParticipantsForYear(kpi)` : réplique `primeCommercialPartners()` du front.
  - `computePrimesByPartnerMonth(years, nowIso)` : calcule les échéances réelles (now ancien),
    applique le plancher (exercice courant), arrondit en préservant le total, renvoie
    `{ byPartnerMonth, participants, reconciliation }`.
  - `syncPrimesToSheet()` : compute → lit le Sheet → découvre → écrit (batchUpdate) →
    persiste. Tolérant. `PRIMES_SYNC_DRYRUN=1` = lecture seule.
  - Endpoints `POST /api/primes/sync-gsheet` et `GET /api/primes/sync-status` (protégés par
    le `dashboardGate` global).
  - Cron `node-cron` (03:00) dans `app.listen`.
  - **Retrait du fold** dans `/api/ebe` et `computeResultatFactuelForYear`
    (`primesCommerciales` n'est plus calculé ni ajouté ; `charges.primesCommerciales`
    disparaît du retour, donc la ligne « dont primes commerciales » ne s'affiche plus).
  - **Non touché** : `primesCommercialesVersees` (trésorerie / Plan_TRE).
- **`public/pilot.html`** (+ `dist/pilot.html`) : bouton « Synchroniser le GSheet »,
  `syncPrimesGsheet()`, `loadPrimesSyncStatus()`, statut « dernière synchro ».
- **`migrations/41_primes_sheet_sync.sql`** : table d'état de synchro.
- **`package.json`** : dépendance `node-cron`.

## Tests

- `utils/kpiCompute.test.js` : règle de date (T2 → juillet, T4 → janvier N+1), `byPartnerMonth`,
  collectif ÷ participants, `enAttenteByPartner`, rattrapage/drop.
- `utils/primesSheetMap.test.js` : `colToLetter`, `parseMonthHeader`, `discoverLayout`
  (lignes vides en tête), `assertPartners`, `buildUpdates` (figement), `roundPreservingSum`.
- Vérification live : dry-run puis écriture réelle validés contre le Sheet (60 cellules,
  totaux alignés à l'euro sur Pilot : Guillaume 3 498, Nathan 2 958, Vincent 444).

## À surveiller / suites possibles

- **Table Supabase** : exécuter `migrations/41_primes_sheet_sync.sql` (sinon l'horodatage
  n'est pas persisté, sans bloquer la synchro).
- **Changement d'année civile** : à revoir avant janvier 2027 pour capter le débordement de
  l'exercice N vers N+1 quand l'exercice courant deviendra N+1 (réactiver un calcul {N-1, N}
  borné, ou avancer le plancher).
- **Décaissement réel d'octobre** : quand octobre 2026 sera versé puis clôturé, vérifier que
  le montant Qonto réel correspond au `.Primes` prévu (bascule clos/futur).
- **Backfill** : non nécessaire avec le plancher (les retards vont sur octobre, pas dans le
  passé). Un remplissage one-shot d'exercices antérieurs reste possible si souhaité.
