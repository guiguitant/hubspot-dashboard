# Prime KPI dans le compte de résultat et la trésorerie · conception

**Date :** 30/07/2026
**Auteur :** Nathan Gourdin (avec Claude)
**Statut :** conception validée, à relire avant plan d'implémentation

## Objectif

Faire remonter la prime commerciale calculée dans l'onglet KPI (le « pool ») dans deux endroits du Pilot :

1. le **compte de résultat**, comme charge d'exploitation qui réduit l'EBE puis le résultat net ;
2. la **trésorerie prévisionnelle**, comme décaissements datés au mois du versement réel.

## Contexte comptable

Les bénéficiaires des primes (partners commerciaux et opérationnels) **ne sont pas salariés** : ils facturent leurs commissions à Releaf. Comptablement, ces primes sont donc des **rémunérations d'intermédiaires / honoraires**, compte **622** (services extérieurs), et non des charges de personnel (classe 64).

Conséquences :
- **Pas de charges patronales** à ajouter (le bénéficiaire porte ses propres cotisations).
- C'est une **charge d'exploitation**, située **au-dessus de l'EBE** (elle le réduit).
- Confirmé : ces commissions **ne figurent nulle part** dans les charges actuelles du Pilot (ni Qonto réel, ni prévisionnel CR_Prev). Le pool KPI est donc la **seule source** de cette charge : aucun risque de double comptage.

## Concept central : « prime gagnée » ≠ « prime versée »

C'est la distinction qui structure toute la conception.

| | Prime **gagnée** | Prime **versée** |
|---|---|---|
| Logique | Comptabilité d'engagement | Trésorerie (cash) |
| Base | CA **signé** de l'année (avec portillon trimestriel) | Chaque part de deal, au **mois du versement réel** |
| Va dans | **Compte de résultat** | **Trésorerie prévisionnelle** |
| Année | Année de signature | Mois du décaissement (peut déborder en N+1) |

**L'écart entre les deux est une provision** = pool gagné − primes déjà versées. Il regroupe tout ce qui est engagé mais pas encore sorti en cash : les primes « en attente » (deals dont l'acompte n'est pas encore facturé) **et** les primes facturées pas encore payées (planifiées / rattrapage). Cet écart est une information de pilotage utile (engagement latent).

## Décisions validées

1. **Montant** : le **pool total** = étage 1 (primes perso trimestrielles) + étage 2 (prime collective annuelle).
2. **Périmètre** : compte de résultat **et** trésorerie.
3. **Base au compte de résultat** : **tout le pool gagné** (base signature), indépendamment de la facturation. L'écart avec la trésorerie constitue la provision.
4. **Calendrier de versement (trésorerie)** :
   - **Étage 1 (perso), deal par deal** : versé le mois suivant la clôture du trimestre de signature, **à condition que l'acompte du deal soit facturé**. Si l'acompte n'est pas encore facturé, le versement glisse jusqu'au mois qui suit sa facturation. Garde-fou anti-annulation : on ne verse pas la prime d'un deal signé tant qu'il n'est pas facturé.
   - **Étage 2 (collectif)** : versement unique en **N+1** après clôture des comptes (mois paramétrable, défaut **mars N+1**).
5. **Validation humaine des versements** : une prime n'est réputée versée que lorsque l'utilisateur la **valide manuellement**, **deal par deal** (par couple deal + partner pour l'étage 1, par partner pour l'étage 2). Une prime validée sort de la trésorerie prévisionnelle. Le rapprochement automatique avec les transactions Qonto est **repoussé à une phase 2** (assistance, pas automatisation).

## Comportement fonctionnel

### Compte de résultat (`/api/ebe`)

Nouvelle sous-ligne **« Primes commerciales »** à l'intérieur des Charges d'exploitation :

```
CA facturé (Notion)
  − Charges d'exploitation
      dont masse salariale (info)
      dont primes commerciales (NOUVEAU)   ← pool gagné de l'année
  + Subventions + Aides
  = EBE
  − Amortissements
  = Résultat d'exploitation
  − IS + Crédit d'impôt
  = Résultat net
```

- Le pool gagné est **ajouté à `totalCharges`** avant le calcul de l'EBE, en vue **factuelle et projetée** (même montant dans les deux : la prime est engagée quel que soit le pipeline).
- La réponse `/api/ebe` expose le montant de la prime en sous-champ (ex. `charges.primesCommerciales`) pour l'affichage et la modale de détail.
- La modale de détail des charges (`openCrDetailModal('charges')`) affiche la prime en sous-ligne, comme la masse salariale.

### Trésorerie (`buildPrevisionnel`)

Les versements de primes sont injectés comme **décaissements ponctuels datés** (motif proche de `subventionsAnnoncees`, mais en sortie de cash).

- Seules les primes **à verser** (non validées comme versées) alimentent le prévisionnel : une prime validée est déjà sortie (et, une fois payée via Qonto, déjà dans le réel), donc **exclue de l'injection** pour ne pas double-compter.
- Étage 1 : un décaissement par deal `à verser`, au mois de versement calculé (voir règle ci-dessous).
- Étage 2 : un décaissement par partner `à verser`, au mois configuré (défaut mars N+1).
- Ces montants viennent en plus des décaissements existants (`decaissements` et `decaissementsTRE`) du mois concerné.
- Ils font partie de la **trésorerie de base** (charge réellement engagée), donc sont naturellement repris dans les scénarios (qui partent de la base).
- Le détail du mois (tooltip / modale trésorerie) gagne une ligne « Primes commerciales » listant les deals versés ce mois-là, avec une sous-ligne « rattrapage » le cas échéant.

### Les 4 états d'une prime (étage 1, par deal)

À tout instant « maintenant », chaque part de prime (deal + partner) est dans **un seul** état, qui décide de sa place dans la trésorerie :

1. **Versée** · l'utilisateur a validé le paiement (voir « Suivi des versements » ci-dessous). **Exclue** du prévisionnel.
2. **Planifiée** · non validée, acompte facturé, mois de versement calculé **dans le futur**. **Injectée** à ce mois.
3. **Rattrapage** · non validée, acompte facturé, mois de versement calculé **déjà passé**. **Reportée sur le mois courant** du prévisionnel (ligne distincte « rattrapage »), pour ne pas réécrire l'historique bancaire et garder une prévision honnête.
4. **En attente** · acompte **non facturé**. Reste en **provision**, hors trésorerie ; bascule en « planifiée » dès que l'acompte est facturé.

L'étage 2 suit la même logique au niveau partner : versé (validé) → exclu ; sinon planifié au mois configuré, ou en rattrapage sur le mois courant si ce mois est passé.

### Règle de calcul du mois de versement (étage 1, par deal)

Pour un deal signé au trimestre `q` de l'année `Y`, attribué à un partner :

- `mois_cloture` = mois qui suit la fin du trimestre `q` : T1 → avril `Y`, T2 → juillet `Y`, T3 → octobre `Y`, T4 → janvier `Y+1`.
- `mois_facture` = mois qui suit le mois de `dateFactureAcompte` du deal.
- Si l'acompte **n'est pas facturé** (`dateFactureAcompte` absente) → état **en attente**, aucun décaissement planifié.
- Sinon : **mois de versement = le plus tardif** entre `mois_cloture` et `mois_facture`. S'il est déjà passé → état **rattrapage** (mois courant).
- Le montant versé pour ce deal = `part de CA attribuée × taux` (`txNew` si Newsale, `txRepeat` si Upsale), **et seulement si le portillon du trimestre `q` est passé** (sinon 0, comme au compte de résultat).

### Suivi des versements (validation humaine, phase 1)

Une prime n'est réputée versée que lorsque l'utilisateur le **valide manuellement**. C'est cette validation, et non une heuristique de date, qui fait autorité sur l'état « versée ». Elle sécurise le process et protège du double comptage : une prime validée est retirée de l'injection trésorerie, car une fois payée elle apparaît dans le réel Qonto.

- **Granularité** : par couple **deal + partner** pour l'étage 1 ; par **partner** pour l'étage 2.
- **Stockage** : une nouvelle table `kpi_prime_versements` (voir Architecture). La **présence d'une ligne = état « versée »** ; son absence = « à verser ».
- **Ce que l'utilisateur saisit** : la date de versement réelle et, optionnellement, le montant réel (qui peut différer du calcul). Le champ de rattachement à une transaction Qonto existe dès maintenant dans la table mais reste **non alimenté en phase 1** (réservé à la phase 2).
- **UI** : dans l'onglet KPI, à côté des résultats de primes, une liste des primes **payables** (facturées, portillon passé) avec un bouton « Valider le versement » par ligne, et un raccourci de masse « marquer versé jusqu'à Tx » qui crée les lignes correspondantes (remplace le curseur automatique évoqué en analyse).
- **Dévalidation** : possibilité de retirer une validation (supprime la ligne), utile en cas d'erreur.

Le rapprochement Qonto automatique (proposer les débits candidats à rattacher) est **hors périmètre de la phase 1** ; il viendra alimenter le champ `qonto_tx_id` en phase 2.

## Architecture technique

Principe : **une seule source de vérité**, calculée **côté serveur** à partir de la config **sauvegardée en base**, logique **pure et testée** (règle du repo : la logique financière vit dans `utils/` et est couverte par jest).

### Nouvelles fonctions pures dans `utils/kpiCompute.js`

Elles réutilisent les briques existantes (`signedByQuarter`, `splitAmount`, `totalCaAnnee`).

1. `computePrimePool({ missions, splits, config, year, caFacture })` → `{ etage1, etage2, pool, ratio, detail }`
   - Reproduit la logique de `primeCompute` (front, `pilot.html`) : primes perso trimestrielles gelées sous le seuil (portillon), + prime collective (`taux du palier × resultatAnnuel`).
   - Sert au **compte de résultat**. `pool` = charge de l'année.

2. `computePrimePayments({ missions, splits, config, year, versements, now })` → `{ byMonth: { 'YYYY-MM': montant }, detail: { 'YYYY-MM': [{ deal, partner, montant, rattrapage }] }, enAttente, verse }`
   - Étage 1 : décompose le pool perso deal par deal (via `signedByQuarter().detailByPartner`), applique le portillon du trimestre, calcule l'état (versée / planifiée / rattrapage / en attente) et le mois de versement (règle ci-dessus, à partir de `dateFactureAcompte` et de `now`).
   - Exclut les couples (deal, partner) présents dans `versements` (déjà validés). Empile les autres par mois (rattrapage → mois courant).
   - Étage 2 : un montant par partner au mois configuré (défaut mars `year+1`), sauf partners déjà validés.
   - `enAttente` = somme des primes non encore payables (acompte non facturé) ; `verse` = somme des primes validées. La **provision** globale (repère de pilotage) se déduit côté appelant : `pool gagné − verse`.
   - Sert à la **trésorerie**.

> Note d'implémentation : `detailByPartner` fourni par `signedByQuarter` ne porte pas encore `dateFactureAcompte`. `computePrimePayments` construira une map `id → dateFactureAcompte` depuis `missions` pour dater chaque versement.

### Backend (`server.js`)

- **`/api/ebe`** : charger la config (`kpi_prime_config`, id `default`) via `supabaseAdmin`, appeler `computePrimePool`, ajouter le pool à `totalCharges`, exposer le détail dans la réponse.
- **`buildPrevisionnel`** : charger les versements validés (`kpi_prime_versements`), appeler `computePrimePayments`, injecter `byMonth` dans les décaissements des mois concernés (nouvel accumulateur, comme `subvAnnonceesParMois`), et transmettre le détail pour l'affichage.
- **Endpoints de versements** (nouveaux) : `GET /api/kpi/prime-versements?year=` (liste), `POST` (valider un versement), `DELETE` (dévalider). Auth : mêmes règles que les autres endpoints Pilot (gate dashboard TOTP).
- Réutiliser l'endpoint / la logique de lecture de config déjà en place (`GET /api/kpi/prime-config`).

### Front (`public/pilot.html`)

- **Compte de résultat** (`renderCompteResultat` / `openCrDetailModal`) : afficher la sous-ligne « Primes commerciales » et son détail. Afficher aussi la **provision** (pool gagné − primes versées) comme repère, avec le sous-total « dont en attente de facturation » (`enAttente`).
- **Trésorerie** : afficher la ligne « Primes commerciales » dans le détail mensuel, avec sous-ligne « rattrapage » le cas échéant.
- **Onglet KPI · suivi des versements** : liste des primes payables par deal + partner, bouton « Valider le versement » (date + montant réel optionnel), raccourci de masse « marquer versé jusqu'à Tx », dévalidation.
- **Onglet KPI (réglages)** : ajouter le paramètre **mois de versement de l'étage 2** (défaut mars N+1) dans la config prime.
- `dist/pilot.html` est un artefact de build ; la source à modifier est `public/pilot.html`.

### Base de données

- La table `kpi_prime_config` existe déjà. Ajouter un champ `versementEtage2Mois` (ex. `"03"`) dans le JSONB `config`, avec valeur par défaut si absente (rétrocompatible, aucune migration SQL nécessaire).
- **Nouvelle table `kpi_prime_versements`** (migration SQL, même motif RLS que `kpi_prime_config`) :
  - `id` (clé primaire),
  - `year` (int),
  - `etage` (1 ou 2),
  - `mission_id` (text, id Notion du deal ; null pour l'étage 2),
  - `partner` (text),
  - `montant` (numeric, montant réel versé ; peut différer du calcul),
  - `date_versement` (date),
  - `qonto_tx_id` (text, nullable, réservé phase 2),
  - `created_at` (timestamptz).
  - Unicité logique : un couple (`year`, `etage`, `mission_id`, `partner`) = un versement. La présence de la ligne vaut état « versée ».

## Garde-fous et cas limites

- **Étage 2 sans boucle de calcul** : la prime collective se base sur `resultatAnnuel` (saisi à la main, « résultat avant bonus », défaut 150 000 €), pas sur le résultat live. Réduire le résultat par la prime ne recalcule donc rien. Prévoir un **repère visuel** si `resultatAnnuel` saisi diverge fortement du résultat d'exploitation calculé.
- **Pas de double comptage aujourd'hui** : confirmé, les commissions sont absentes des charges actuelles (Qonto et CR_Prev).
- **Anti double comptage dans le temps** : le jour où les commissions seront réellement payées, elles apparaîtront dans le réel Qonto. Deux garde-fous :
  - *Trésorerie* : une prime **validée** (table `kpi_prime_versements`) est exclue de l'injection ; le réel Qonto prend le relais.
  - *Compte de résultat* : **prérequis à caler avec la comptable** · isoler les virements de commissions dans une **catégorie Qonto dédiée, exclue du calcul des charges** (comme les « Virements internes »). Ainsi le pool calculé reste la **seule source** de la charge au compte de résultat. Ce n'est pas du code, c'est une convention de catégorisation à mettre en place **avant** de commencer à payer les commissions via Qonto.
- **Clawback exclu** : les candidats au clawback (reprise sur deals annulés) restent indicatifs et manuels ; ils n'entrent ni dans le pool du compte de résultat ni dans les versements automatiques.
- **Alignement des années** : la prime de l'année N alimente le compte de résultat de l'année N ; les versements peuvent tomber en N+1 (étage 2, et étage 1 de T4).
- **Config absente / partielle** : la fonction pure applique **les mêmes défauts que le panneau KPI** (`tiers` [650k/7, 600k/5, 550k/3], `resultatAnnuel` 150 000, `gateTrimestriel` 120 000, taux par défaut Guillaume 2,25/1,25 sinon 4,5/2,5). Ainsi le compte de résultat affiche exactement le même pool que l'onglet KPI. Ne jamais bloquer / lever d'erreur : au pire un pool de 0 si aucune donnée signée et `caFacture` sous le premier palier.

## Tests (jest)

Sur les deux fonctions pures :
- Portillon trimestriel : un trimestre sous le seuil ne verse rien (pool et versements).
- Étage 1 + étage 2 : somme correcte du pool.
- Les 4 états : deal facturé à temps (planifiée, mois suivant clôture) ; deal facturé en retard (glissement) ; deal facturé mais mois de versement passé (rattrapage sur mois courant) ; acompte non facturé (en attente, aucun versement, compté en provision).
- Exclusion des versements validés : une prime présente dans `versements` n'est pas injectée.
- Étage 2 : versement au mois configuré en N+1 ; partner validé exclu.
- Changement d'année.
- Config absente → pool 0, aucun versement.

## Fichiers concernés

- `utils/kpiCompute.js` : deux nouvelles fonctions pures (`computePrimePool`, `computePrimePayments`).
- `utils/kpiCompute.test.js` : tests.
- `migrations/<n>_kpi_prime_versements.sql` : nouvelle table.
- `server.js` : `/api/ebe`, `buildPrevisionnel`, endpoints `GET/POST/DELETE /api/kpi/prime-versements`.
- `public/pilot.html` : compte de résultat, trésorerie, suivi des versements et réglages KPI.

## Hors périmètre

- **Rapprochement Qonto automatique** (phase 2) : proposer les débits candidats à rattacher pour alimenter `qonto_tx_id`. En phase 1, seule la validation manuelle existe.
- Le versement réel / la comptabilisation officielle (le Pilot reste un outil de pilotage, pas la compta légale).
- Le calendrier configurable fin de l'étage 1 (on garde la règle automatique clôture + facturation).
- La reprise (clawback) automatisée.
- La convention de catégorisation Qonto dédiée aux commissions (prérequis à mettre en place avec la comptable, hors code).

## Découpage d'implémentation suggéré

Le lot est cohérent mais volumineux. Ordre conseillé, chaque étape étant testable seule :
1. `computePrimePool` + branchement au compte de résultat (`/api/ebe`) + affichage. Livre déjà la moitié de la demande.
2. `computePrimePayments` + injection trésorerie (sans validation : tout est « à verser »).
3. Table `kpi_prime_versements` + endpoints + validation humaine + exclusion dans la trésorerie.
