# Spec · Write-back des primes vers Google Sheets

**Date** : 2026-07-31
**Statut** : cadrage validé, prêt pour le plan d'implémentation
**Amont** : suite des phases primes déjà livrées
(`2026-07-30-prime-kpi-compte-resultat-design.md`,
`2026-07-30-prime-kpi-cr-phase1.md`, `2026-07-30-prime-kpi-tresorerie-phase2.md`).
Mémoire projet associée : `gsheet-primes-writeback.md`.

## Objectif

Pilot écrit automatiquement (cron) les primes calculées dans l'onglet KPI vers
le Google Sheet, onglet **Masse_salariale** (gid 798407110), catégorie
**`.Primes`**, une sous-ligne par associé (Vincent, Guillaume, Nathan), à la
colonne du bon mois. Le mécanisme est **multi-année** : les primes qui débordent
sur l'exercice suivant (T4 en janvier N+1, collectif en mars N+1) ne sont jamais
oubliées, même au passage d'année civile. En parallèle, on **retire le double
compte** des primes dans l'EBE et on **unifie la règle de date de versement**
dans le moteur commun.

## État existant (ce sur quoi on s'appuie)

- **`computePrimePayments`** (`utils/kpiCompute.js:398-466`) : échéancier
  `{ byMonth, detail, enAttente, verse }`. Étage 1 traité **deal par deal, par
  associé** (garde-fou acompte à `:433-434`, portillon trimestriel à `:427`),
  détail par associé dans `detail[mk][].partner`. Étage 2 collectif ajouté en
  **une seule ligne** (année+1, mois 03) **sans associé** (`:455-463`).
  Règle de date **actuelle** de l'étage 1 (`:435-437`) : le plus tardif entre
  M+1 de la clôture du trimestre de **signature** et M+1 du **mois** de
  facturation de l'acompte. **Cette règle change** (voir « Règle de versement »).
- **Trésorerie** (`server.js:6388-6410`) : appelle déjà `computePrimePayments`
  avec `versements: []` pour `[N-1, N]` et fusionne `byMonth`. C'est **la
  tuyauterie de données à réutiliser** (fetch config/splits/factOverrides +
  missions Notion + `computeBillingForYear` pour le CA facturé).
- **`computePrimesCommercialesForYear`** (`server.js:8228-8249`) : renvoie le
  pool annuel total ; **ajouté à `totalCharges`** dans `/api/ebe`
  (`server.js:8283-8284` et `:8333-8334`). C'est le **fold à retirer**.
- **`primesCommercialesVersees`** (`server.js:6063`) : décaissement de
  trésorerie (plan Plan_TRE). **À ne pas toucher** (c'est du cash, pas du
  compte de résultat, donc pas de double compte). Ses dates s'aligneront
  toutefois sur la nouvelle règle via le moteur commun (voulu).
- **Front `primeCompute`** (`public/pilot.html:11613-11645`) : `perso[name]`
  (individuel gated portillon), `collPart = collTotal / participants`,
  `total[name] = perso[name] + collPart`. Le GSheet doit refléter ces chiffres.
- **Conventions d'onglets** : Masse_salariale = catégories préfixées `.` ;
  CR_Prev = `cm.` (mère) / `.` (sous-catégorie) / sans préfixe (feuille).
  `.Primes` alimente CR_Prev via **formule** côté Sheet.
- **`googleapis`** est déjà en dépendance mais **jamais utilisé** (les lectures
  actuelles passent par le CSV public gviz, sans authentification). Creds du
  compte de service dans `.env` : `client_email`, `private_key_id`,
  `private_key`. `GOOGLE_SHEET_ID` déjà présent dans `.env`.
- **Aucun scheduler serveur** n'existe aujourd'hui.

## Décisions validées

1. **Part collective répartie ÷ nombre de participants** (÷ 3), écrite dans la
   **même ligne `.Primes`** que l'individuel, au mois de mars N+1.
2. **Version prudente** : acompte-gated, **deal par deal** (prorata). Une part
   de prime n'apparaît que si l'acompte de son deal est facturé ; sinon elle
   reste « en attente » et apparaîtra plus tard (voir règle de versement).
3. **Règle de versement unifiée** : la prime individuelle est versée à **M+1 de
   la clôture du trimestre où l'acompte est facturé**. Le trimestre de signature
   ne sert plus qu'au portillon et au montant. Détail en section dédiée.
4. **Pas de rétroactivité · figement du passé** : la charge s'inscrit au mois de
   versement, jamais rétroactivement (avant, elle n'existe nulle part). Pilot
   écrit le **mois courant et les mois à venir** ; il ne réécrit pas un mois
   déjà passé (les valeurs des mois écoulés restent celles posées à l'époque).
5. **Multi-année** : Pilot calcule les primes des années **{précédente, en
   cours}** et écrit dans **toutes les colonnes existantes** du Sheet (présent +
   futur). Ainsi les primes qui débordent sur l'exercice suivant (T4 → janvier,
   collectif → mars) sont écrites même après le passage à la nouvelle année
   civile. Si tu ajoutes un jour des colonnes d'une année future, elles se
   remplissent sans changement de code.
6. **Cron 1×/nuit** (via `node-cron`) **+ bouton « Synchroniser maintenant »**
   dans Pilot.
7. **Découverte des coordonnées via l'API authentifiée live** (pas gviz, qui
   supprime les lignes vides du haut et décale les numéros de ligne).
8. **Sécurité stricte** : si une coordonnée attendue est introuvable, on
   **n'écrit rien** et on loggue l'erreur.
9. **Retrait du fold EBE dans la même livraison** que la première écriture. La
   trésorerie n'est pas touchée (hors alignement de dates via le moteur commun).
10. **Observabilité** : log détaillé à chaque run + horodatage « dernière
    synchro » exposé dans Pilot.

## Règle de versement (moteur)

La prime **individuelle** d'un deal est versée à **M+1 de la clôture du
trimestre civil dans lequel tombe la date de facturation de l'acompte** :

| Acompte facturé en | Prime versée en |
|---|---|
| janvier · février · mars (T1) | avril |
| avril · mai · juin (T2) | juillet |
| juillet · août · septembre (T3) | octobre |
| octobre · novembre · décembre (T4) | janvier de l'année suivante |

Le trimestre de **signature** conditionne le **portillon** (le CA signé du
trimestre atteint le seuil de rentabilité) et le **montant** (taux new/repeat),
mais **pas la date**.

Exemple (le « vieux deal enfin facturé ») : deal signé au T1, acompte facturé en
mai (T2) → prime versée en **juillet** (M+1 de la clôture du T2). Avant cette
date, la prime n'existe nulle part au compte de résultat. Pour un deal facturé
dans son propre trimestre de signature, cette règle donne le même résultat
qu'avant ; elle ne corrige que les deals facturés en retard.

L'**étage 2** (collectif) reste versé en **mars N+1** (inchangé).

**Changement de code** : dans `computePrimePayments` (`utils/kpiCompute.js:435-437`),
remplacer le calcul de `mk` (max entre M+1 clôture du trimestre de signature et
M+1 du mois de facture) par : `mk = M+1 de la clôture du trimestre de la date
d'acompte` (via `quarterOfDate` + `monthAfterQuarterClose`, en tenant compte de
l'année de l'acompte). `gateOk[q]` (portillon) et le montant restent inchangés.
Le moteur étant **partagé**, la trésorerie s'aligne automatiquement, ce qui est
cohérent (facture de la prime et décaissement étroitement liés).

## Comportement du moteur (rappel prorata)

Exemple : une prime « de 3000 € » composée de 3 deals générant chacun 1000 € de
part de prime, le deal 1 sans acompte facturé, les deals 2 et 3 facturés.

- Le moteur traite **chaque deal séparément** et applique le garde-fou de
  l'acompte deal par deal.
- Deal 1 (pas d'acompte) → 1000 € dans `enAttente`, **non écrit**.
- Deals 2 et 3 (acompte facturé) → **2000 € écrits** au mois de versement (règle
  de date ci-dessus).
- Quand l'acompte du deal 1 est facturé (disons en mai, T2), ses 1000 €
  apparaissent en **juillet** (M+1 de la clôture du T2), jamais rétroactivement.
- Préalable distinct : le **portillon trimestriel** (CA signé total du trimestre
  de signature ≥ seuil). Un trimestre gelé ne verse aucune prime.

## Architecture

### A. Moteur · `utils/kpiCompute.js`

Deux évolutions :

1. **Règle de date** (cf. « Règle de versement ») : `mk` de l'étage 1 = M+1 de
   la clôture du trimestre de la **date d'acompte**. Portillon et montant
   inchangés.
2. **Nouvelle sortie `byPartnerMonth`** : `{ [partner]: { 'YYYY-MM': montant } }`.
   - Étage 1 : agréger le `detail` existant par `(partner, mois)`.
   - Étage 2 : collectif **÷ nombre de participants**, posé sur **chaque**
     participant en `(année+1)-03`.
   - Passer une **liste explicite de participants** en paramètre pour que la
     division soit toujours « ÷ 3 », même si un associé n'a rien signé (aligné
     sur le front `primeParticipants`).

`byMonth`, `detail`, `enAttente`, `verse` restent cohérents avec la nouvelle
règle de date. Les consommateurs existants (trésorerie) profitent de
l'alignement de dates ; `byPartnerMonth` est purement additif.

### B. Helper de données partagé · `server.js`

Factoriser la récupération des données primes pour une année (config + splits +
factOverrides + missions + CA facturé) et l'appel moteur, renvoyant
`byPartnerMonth`. Réutilise le bloc déjà présent en trésorerie
(`server.js:6388-6410`).

Pour le write-back : calculer et **fusionner les années {N-1, N}** par
`(associé, mois)`, avec :
- **`versements: []`** : la cellule montre la **charge totale**, indépendante des
  validations internes Phase 3 (sinon une prime validée « versée » disparaîtrait
  du compte de résultat).
- **`pastPolicy: 'drop'`** : les versements dont le mois est déjà passé ne sont
  pas produits → **figement du passé** assuré à la source. Seuls le mois courant
  et les mois futurs ressortent. Le calcul de l'année N-1 capte ainsi les
  débordements encore à venir (collectif N-1 en mars N, T4 N-1 en janvier N).

### C. Client Google Sheets authentifié · nouveau module `utils/googleSheets.js`

- Auth via `google.auth.JWT(client_email, null, private_key, [scope])`, scope
  `https://www.googleapis.com/auth/spreadsheets`.
- Gérer la `private_key` de `.env` (remplacer les `\n` littéraux par de vrais
  retours à la ligne).
- `readRange(tabName, range)` → `spreadsheets.values.get`.
- `batchWrite(updates)` → `spreadsheets.values.batchUpdate` (plusieurs plages
  en un seul appel réseau).
- Module isolé et testable (auth injectable pour les tests).

### D. Module de synchronisation · nouveau `services/primesSheetSync.js`

Orchestration d'un run :

1. Calculer `byPartnerMonth` fusionné {N-1, N} via le helper B.
2. Lire l'onglet Masse_salariale via C (plage large, ex. `A1:BZ200`).
3. **Découvrir les coordonnées** :
   - **Ligne d'en-tête des mois** : la ligne contenant des cellules au format
     mois (voir « à vérifier »), qui donne la map `'YYYY-MM' → index colonne`.
   - **Catégorie `.Primes`** : la cellule de la colonne des libellés qui
     commence par `.Primes`.
   - **Sous-lignes associés** : les lignes suivantes (libellé sans préfixe `.`)
     jusqu'à la prochaine catégorie ; associées par nom.
4. Construire la liste des écritures `(associé × mois → montant)` **pour chaque
   mois dont la colonne existe dans le Sheet**. Le figement du passé est déjà
   garanti à l'étape 1 (`pastPolicy: 'drop'` ne produit aucun mois passé).
5. **Garde-fous** : en-tête absente, catégorie absente, ou associé introuvable
   → **abort du run, log, aucune écriture**.
6. `batchWrite`.
7. Persister l'horodatage « dernière synchro » et un résumé du run (ex. petite
   table Supabase ou ligne de config), pour survivre au redémarrage et être lu
   par l'endpoint E.

### E. Endpoint + bouton · `server.js` + `public/pilot.html`

- `POST /api/primes/sync-gsheet` (protégé, réservé admin) → lance un run,
  renvoie `{ ok, cellulesEcrites, skipped, erreurs, timestamp }`.
- Bouton **« Synchroniser maintenant »** dans l'onglet KPI (zone primes) +
  affichage de « dernière synchro ».

### F. Cron · `server.js`

- `node-cron`, tâche quotidienne (ex. `0 3 * * *`), appelant le module D.
- Idempotent : une double exécution réécrit les mêmes cellules (présent +
  futur), donc sans effet de bord.

### G. Retrait du double compte EBE · `server.js`

- Retirer l'ajout de `primesCommerciales` à `totalCharges` dans `/api/ebe`
  (`:8283-8284` et `:8333-8334`), les primes entrant désormais par la formule
  `.Primes → CR_Prev` (déjà comptée dans `totalCharges` via
  `fetchAndParseCRPrev`).
- Conserver éventuellement une valeur d'info (affichage) sans la ré-additionner.
- **Ne pas toucher** `primesCommercialesVersees` (trésorerie).

## Flux de données

```
computePrimePayments  (moteur : règle de date unifiée, acompte-gated)
        -> byPartnerMonth, fusion années {N-1, N}, pastPolicy 'drop'
        -> primesSheetSync (découverte coords + batchWrite, colonnes existantes)
        -> cellules .Primes du Sheet (mois courant + futurs)
        -> [formule Google Sheets]
        -> CR_Prev (compte de résultat HT)
        -> /api/previsionnel-charges (Analytics)  et  /api/ebe (via fetchAndParseCRPrev)
```

## Gestion des erreurs et sécurité

- Auth ou API en échec : log, run abandonné, horodatage non mis à jour,
  endpoint renvoie une erreur explicite.
- Découverte incomplète : abort, **aucune écriture** (« ne rien faire plutôt
  qu'écrire au mauvais endroit »).
- Colonne d'un mois attendu absente du Sheet : skip de ce mois, log, on continue.
- Secrets Google : jamais commités, traités comme des mots de passe.

## Stratégie de test

- **Unitaire règle de date** (jest, `utils/`) : deal signé T1 / acompte facturé
  T2 → versement juillet ; deal facturé dans son trimestre de signature →
  résultat inchangé ; T4 → janvier N+1.
- **Unitaire `byPartnerMonth`** : individuel ventilé par associé ; collectif ÷ 3
  en mars N+1 ; part sans acompte exclue (`enAttente`).
- **Unitaire fusion {N-1, N} + `pastPolicy: 'drop'`** : aucun mois passé produit ;
  débordements N-1 (collectif mars N, T4 janvier N) bien présents.
- **Unitaire découverte de coordonnées** : sur une grille mockée (retour de
  `values.get`) avec lignes vides en tête → trouve en-tête, catégorie, associés.
- **Unitaire `batchWrite`** : construction correcte des plages (mock du client).
- **Garde-fous** : coordonnée manquante → aucune écriture émise.
- **Intégration en lecture seule (dry-run)** contre le vrai Sheet pour valider
  la découverte avant la première écriture réelle.

## À vérifier au moment de l'implémentation

- **Format exact des en-têtes de mois** dans la vraie grille (la mémoire note
  `MM/YYYY`, colonnes espacées de 2) : confirmer via une lecture live, et
  vérifier quelles **années** sont présentes en colonnes.
- **Libellés exacts des sous-lignes associés** (Vincent / Guillaume / Nathan ou
  autres) : confirmer via lecture live et établir la table de correspondance.
- **La formule `.Primes → CR_Prev` est-elle déjà active** et `.Primes`
  actuellement vide ? Cela conditionne le moment précis du retrait du fold EBE.
- **Backfill initial** : à la première mise en place, faut-il remplir en one-shot
  les mois **déjà écoulés** de l'année en cours (avec leurs vraies dates), ou
  laisser les valeurs manuelles existantes ? Le régime courant fige le passé ;
  ce remplissage initial est une décision de démarrage à trancher alors.
- **Impact trésorerie** : revoir le plan de trésorerie après l'alignement de la
  règle de date (cas des deals facturés en retard) pour confirmer qu'il n'est
  pas dégradé.

## Hors périmètre (YAGNI)

- Écriture d'autres catégories de Masse_salariale (Pilot ne touche que
  `.Primes` ; salaires, charges sociales, etc. restent gérés à la main).
- Réécriture rétroactive des mois passés : exclue par conception (décision 4).
  Un éventuel remplissage initial est un one-shot distinct (cf. « à vérifier »).
