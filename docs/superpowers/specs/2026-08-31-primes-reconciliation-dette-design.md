# Garde-fou de réconciliation « dette de primes » vs décaissements Qonto · design

> Statut : proposition validée par l'utilisateur le 2026-08-31 (« Validé, écris la spec et le plan »).
> Branche : à créer, `feat/primes-reconciliation-dette`. **Ne pas démarrer tant que la branche `feat/ca-avancement` est en cours** (arbre de travail occupé par une autre session).
> Prolonge : `2026-08-02-primes-charge-decaissement-decouplage-design.md` (Option B, exclusion des primes du réel Qonto) et `2026-08-06-charges-perimetre-tva-design.md` (module `utils/chargesPerimetre.js`).

## 1. Le problème

La ligne « Primes associés 2025 » du carnet **Dettes & engagements fermes** est retranchée du solde bancaire pour produire le KPI « trésorerie nette de dette ». Son montant restant dû n'est **ni calculé ni vérifié** par Pilot : il est lu tel quel dans la colonne G du Google Sheet (`parseDettes`, `server.js:4935-4954`), et compté dès que la case de contrôle en colonne H vaut TRUE.

Aucun mécanisme ne confirme qu'un versement a réellement eu lieu :

1. **Une seule ligne de dette est réconciliée au réel**, et ce n'est pas celle des primes : `estAvance(label)` (`server.js:6802`) substitue le réel calculé pour la seule avance remboursable BPI. Toutes les autres lignes gardent la valeur saisie.
2. **Le statut `verse` du moteur de primes n'est jamais alimenté** : `computePrimePayments` est appelé partout avec `versements: []` en dur (`server.js:6773`, `utils/kpiCompute.js:625`). La « Phase 3 » n'a jamais été branchée.
3. **Le virement bancaire est volontairement neutralisé** par l'Option B : les débits de la sous-catégorie de primes sont retirés du réel Qonto (`chargesPerimetre.isPrimeSubcategory`), pour que la charge ne se re-date pas au paiement.

Conséquence concrète : si un versement part sans que la colonne G soit mise à jour, Pilot retranche le même montant à un solde déjà diminué et **sous-estime la trésorerie nette de deux fois le versement**, sans aucun signal.

## 2. Principe retenu

Pilot **signale, ne décide pas**. Le garde-fou compare le remboursement déclaré dans le Sheet au réel bancaire, et lève une alerte au-delà d'un seuil. Il **ne modifie jamais** le restant dû ni la trésorerie nette de dette.

La substitution automatique façon avance BPI a été explicitement écartée : la source de l'avance (onglet Plan_TRE) est structurée par nature, alors qu'une seule transaction de primes mal catégorisée fausserait directement le KPI de trésorerie sans signal visible.

## 3. Décisions actées avec l'utilisateur

| Sujet | Décision |
|---|---|
| Sous-catégorie Qonto | Créée, et **100 % des virements de primes y sont classés**. La source de comparaison est fiable. |
| Millésimes | **Une ligne de dette par millésime, cumulées** : « Primes associés 2025 » et « Primes associés 2026 » cohabiteront. |
| Attribution par millésime | Résolue **à la source** : la sous-catégorie Qonto porte le **même nom** que la ligne de dette. Aucune règle d'imputation inventée (FIFO, bornage par date) n'est retenue. |
| Base de comparaison | **Dette HT, virements TTC à 20 %.** La comparaison se fait en HT, avec un diviseur explicite. |
| Décaissements multiples | Une prime peut être réglée en plusieurs virements : le rapprochement est **1 vers N** (agrégation par sous-catégorie), jamais un appariement transaction contre prime. |
| Effet sur le KPI | Aucun. Alerte seulement. |

### Pourquoi pas d'imputation par date ni FIFO

Les virements Qonto ne portent aucun marqueur de millésime, et le calendrier réel a dérivé du calendrier théorique : le moteur prévoyait un décaissement des primes 2026-T1 en avril 2026, rien n'est parti avant août 2026. Une imputation par date, comme une imputation FIFO, produirait une attribution fausse et silencieuse. La nommer à la source dans Qonto est exact et gratuit.

### Pourquoi pas la cascade TVA des charges

`montantHT(tx, tableTaux, indexExact)` convertit TTC vers HT en trois étages (TVA exacte Pennylane, table de taux, repli TTC inchangé). Le troisième étage **retombe sur le TTC** quand Pennylane n'a pas la facture, ce qui fabriquerait un faux écart de 20 % : exactement le signal que ce garde-fou cherche à rendre fiable. On utilise donc un taux fixe et nommé.

## 4. Architecture

### 4.1 Module pur `utils/primesReconciliation.js`

Sur le modèle de `utils/dealsNotionCoherence.js` : aucun appel réseau, aucun effet de bord, entièrement testable. `server.js` récupère les données et les passe ; le module compare.

```js
reconcilePrimes({
  dettes,          // [{ label, montantInitial, restant, controle }] issues de parseDettes
  transactions,    // [{ side, amount, cashflow_subcategory: { name }, settled_at }] Qonto bruts
  primesSubcats,   // liste normalisée d'exclusion (défaut : chargesPerimetre.PRIMES_SUBCATS)
  tauxTva,         // défaut PRIMES_TVA_TAUX (0.20)
  tolerance,       // défaut PRIMES_ECART_TOLERANCE (1)
}) -> {
  lignes: [{
    label, montantInitial, restant,
    declareRembourseHT,   // montantInitial - restant
    reelTTC, reelHT,      // agrégat Qonto de la sous-catégorie homonyme
    nbTransactions,
    ecart,                // reelHT - declareRembourseHT
    statut,               // 'ok' | 'sous_declare' | 'sur_declare' | 'sans_reel'
    couvertParExclusion,  // false => risque de double compte dans les charges
  }],
  totaux: { declareRembourseHT, reelHT, ecart },
  alertes: [{ type, label, montant, message }],
}
```

**Séparation des deux canaux, pour lever toute ambiguïté.** `lignes[].statut` porte le résultat du **rapprochement comptable** (l'écart entre déclaré et réel) ; `alertes` porte uniquement les deux **anomalies structurelles** de la section 6 (nommage et exclusion). Un écart de montant ne crée donc jamais d'entrée dans `alertes`, et une anomalie structurelle ne change jamais un statut de ligne. Le front lit les deux et les affiche distinctement.

**Politique d'arrondi.** Tous les montants exposés sont arrondis à l'euro **à la sortie du module**, et le statut est calculé **sur ces valeurs arrondies**. C'est délibéré : comparer sur les flottants tout en affichant des entiers permettrait à un badge d'annoncer « écart de 0 € » tout en étant en alerte. Les totaux sont la somme des valeurs de ligne déjà arrondies, ce qui rend l'invariant du test 11 exact et non approché.

### 4.2 Serveur

Une lecture Qonto dédiée, en cache 5 minutes sur le modèle de `dettesCache` (`server.js:4931-4933`). Deux points de correction par rapport à ce que fait déjà le calcul des charges :

- **Tous les comptes bancaires**, pas seulement le compte principal. `computeChargesHybride` ne balaie que `mainAccount` (le solde le plus élevé) ; un virement de prime parti d'un autre compte produirait un faux `sur_declare`. Le KPI de trésorerie nette utilise déjà `soldeTousComptes`, la réconciliation doit être cohérente avec lui.
- **Débits uniquement** (`side === 'debit'`) : un virement entrant d'un associé ne doit jamais éteindre une dette.

**Fenêtre de lecture** : du 1er janvier du plus ancien millésime détecté dans les libellés des lignes de primes (motif `\b(20\d{2})\b`) jusqu'à aujourd'hui. Sans millésime détectable, repli sur le début de l'exercice courant.

Le résultat est ajouté à la réponse de l'endpoint de trésorerie qui sert déjà `dettes` et `totalDettes` (`server.js:6820-6830`), sous une clé `reconciliationPrimes`. Aucun nouvel endpoint.

### 4.3 Front

Deux touches dans `public/pilot.html`, aucune nouvelle page :

- un badge sur la ligne concernée de `renderTresoDettes` (`pilot.html:15489`), en réutilisant les classes `.cr-tva-badge` / `.cr-tva-badge.warn` déjà définies (`pilot.html:4336`) ;
- une ligne d'explication dans la modale « Trésorerie nette de dette » (`openNetteDetteModal`, `pilot.html:15443`) donnant les trois montants (déclaré HT, réel HT, écart) et le sens de l'écart.

Report obligatoire dans `dist/pilot.html` : le projet maintient la parité des deux fichiers.

## 5. Le rattachement

Une ligne du Sheet est une **ligne de primes** si son libellé vérifie `/prime/i`, sur le modèle exact de `estAvance = (label) => /avance/i.test(label)` déjà en place.

Elle est rattachée aux transactions dont `cashflow_subcategory.name`, passé par `normalizeLabel`, est **égal** au libellé de la ligne normalisé. `normalizeLabel` (`utils/chargesPerimetre.js:16`) neutralise déjà accents, casse et espaces multiples.

Ajouter un millésime ne demande **aucune modification de code** : créer la ligne dans le Sheet et la sous-catégorie du même nom dans Qonto suffit à brancher le rapprochement.

> **Vigilance de nommage.** L'égalité est stricte après normalisation : « Primes associés 2025 » et « Primes associées 2025 » ne se rattachent pas l'un à l'autre (le `e` du féminin survit à la normalisation, qui ne retire que les diacritiques). C'est un choix assumé : un rapprochement approximatif rattacherait deux millésimes voisins entre eux. Le statut `sans_reel` et l'alerte `reel_orphelin` rendent toute faute de frappe immédiatement visible.

## 6. Le garde-fou anti-double-compte

`PRIMES_QONTO_SUBCATS` pilote l'**exclusion** des primes du réel Qonto (Option B). Créer « Primes associés 2026 » sans l'ajouter à cette liste ferait réapparaître ces débits dans les charges alors qu'ils y sont déjà par le calcul : **double compte silencieux au compte de résultat**.

Le module lève donc deux alertes symétriques :

| Type | Déclencheur | Risque signalé |
|---|---|---|
| `sous_categorie_non_exclue` | Ligne de primes du Sheet dont le libellé normalisé n'est pas dans `primesSubcats` | Double compte dans les charges |
| `reel_orphelin` | Débits classés dans une sous-catégorie de `primesSubcats` sans ligne de dette homonyme | Versement réel non suivi au carnet de dettes |

**Pourquoi la liste d'exclusion reste en variable d'environnement** plutôt que déduite des lignes du Sheet : une panne de lecture du Sheet réintroduirait alors les primes dans les charges sans aucun signal. On garde une source explicite et on rend le piège visible, au lieu de créer une dépendance réseau silencieuse dans un module pur.

## 7. La formule et les statuts

Pour chaque ligne de primes :

```
declareRembourseHT = montantInitial - restant
reelTTC            = somme des amount des débits Qonto de la sous-catégorie homonyme
reelHT             = reelTTC / (1 + tauxTva)
ecart              = reelHT - declareRembourseHT
```

| Statut | Condition | Lecture métier |
|---|---|---|
| `ok` | `abs(ecart) <= tolerance` | Le Sheet dit vrai |
| `sous_declare` | `ecart > tolerance` | Versé plus que le Sheet ne l'admet : dette surévaluée, trésorerie nette pessimiste |
| `sur_declare` | `ecart < -tolerance` | Le Sheet dit remboursé, Qonto ne le voit pas |
| `sans_reel` | `nbTransactions === 0` | Rien n'est parti, ou la sous-catégorie n'existe pas encore |

Constantes nommées, surchargeables par variable d'environnement au chargement du module, sur le modèle de `PRIMES_QONTO_SUBCATS` :

- `PRIMES_TVA_TAUX`, défaut `0.20`
- `PRIMES_ECART_TOLERANCE`, défaut `1` (euro), calibré pour n'absorber que l'arrondi de la division par 1,20

**Deux règles de portée explicites**, pour lever toute ambiguïté d'interprétation :

- Le rapprochement s'applique à **toutes** les lignes de primes, y compris celles dont la case de contrôle est décochée. La question posée est « ce chiffre est-il vrai », pas « ce chiffre compte-t-il dans la photo ».
- `sans_reel` prime sur les autres statuts : une ligne sans aucune transaction rattachée n'est jamais qualifiée de `sur_declare`, même si un remboursement est déclaré. Les deux situations appellent des actions différentes (créer la sous-catégorie, ou chercher le virement).

## 8. Tests · `utils/primesReconciliation.test.js`

Écrits avant le module (TDD, Jest déjà en place). Cas décisifs :

1. Rattachement insensible aux accents, à la casse et aux espaces multiples.
2. Non-rattachement de deux libellés proches mais distincts (« associés » vs « associées », millésimes voisins).
3. Agrégation de plusieurs débits sur une même ligne (le cas « une prime, plusieurs décaissements »).
4. Conversion TTC vers HT au taux paramétré, et surcharge du taux par argument.
5. Les quatre statuts, avec un test **juste sous** et **juste au-dessus** du seuil pour chaque borne.
6. Ligne de primes sans aucune transaction rattachée : statut `sans_reel`, jamais `sur_declare`.
7. Ligne de primes absente de la liste d'exclusion : alerte `sous_categorie_non_exclue`.
8. Débits de primes sans ligne de dette homonyme : alerte `reel_orphelin`.
9. Lignes de dette non-primes (avance, emprunt) ignorées et absentes du résultat.
10. Transactions au crédit ignorées.
11. Invariant : `totaux.ecart` égale **exactement** la somme des `ecart` de ligne (totaux calculés sur les valeurs déjà arrondies, cf. politique d'arrondi en 4.1).
12. Un écart de montant ne produit aucune entrée dans `alertes` ; une anomalie structurelle ne modifie aucun `statut` de ligne.

## 9. Limites connues

1. **Virements en cours.** Qonto n'est interrogé qu'avec `status[]=completed`. Un virement lancé le jour même produit un `sur_declare` transitoire qui se résorbe seul. Le message d'alerte doit citer explicitement cette cause avant les autres.
2. **Taux de TVA unique.** Le design suppose 20 % sur toutes les primes. Si un associé passait en paie (sans TVA) ou si un taux différent apparaissait, l'écart deviendrait structurel et le garde-fou crierait à tort. La parade est le taux en variable d'environnement, mais un mix réel demanderait une conversion transaction par transaction, hors périmètre.
3. **Discipline de nommage.** Le rapprochement repose sur une égalité stricte de libellés entre deux systèmes tenus à la main. Les deux alertes symétriques de la section 6 sont la seule protection.
4. **Coût Qonto.** La fenêtre de lecture s'allonge d'un an à chaque millésime ajouté. À l'échelle actuelle (2 ans, quelques dizaines de transactions) c'est négligeable ; au-delà de 5 millésimes il faudra borner la fenêtre aux millésimes non soldés.

## 10. Hors périmètre · lot suivant

La **table de matching prime par prime** évoquée par l'utilisateur n'est pas dans ce lot. Elle répond à une question plus ambitieuse : « quelle prime de quel associé est payée », alors que ce garde-fou répond à « ce chiffre est-il vrai ».

Elle constituerait le vrai chantier « Phase 3 » : une table Supabase de versements validés, un écran de rapprochement manuel, et l'alimentation enfin réelle du paramètre `versements` de `computePrimePayments`, qui allumerait le statut `verse` déjà entièrement implémenté et testé (`utils/kpiCompute.js:470-486`) mais jamais atteint.

**Rien dans le présent lot ne la contredit** : le module de réconciliation agrège par sous-catégorie sans jamais apparier une transaction à une prime, donc la table pourra plus tard consommer les mêmes transactions Qonto pour un appariement fin, sans avoir à défaire le garde-fou.

## 11. Procédure opérationnelle, à chaque nouveau millésime

1. Créer la ligne « Primes associés AAAA » dans l'onglet Dettes du Sheet, colonnes E (montant initial HT) et G (restant dû HT).
2. Créer dans Qonto une sous-catégorie **au libellé strictement identique**.
3. Ajouter ce libellé à `PRIMES_QONTO_SUBCATS` dans le `.env`, puis redémarrer le serveur.

L'étape 3 oubliée est détectée par l'alerte `sous_categorie_non_exclue` ; l'étape 2 mal orthographiée est détectée par `sans_reel` et `reel_orphelin`.
