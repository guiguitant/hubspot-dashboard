# CA à l'avancement (FAE/PCA) · design

Date : 2026-08-31 · Statut : validé par Nathan (design conversationnel), spec en relecture
Chantier : précision du CA par la méthode à l'avancement pour les missions à cheval sur deux exercices.

## 0. Contexte et objectif

Releaf facture de la prestation. Quand une mission est à cheval sur deux exercices (acompte en N,
solde en N+1), le CA comptable de chaque exercice dépend du **% d'avancement au 31/12**, pas des
dates de facturation. C'est le mécanisme des factures à établir (FAE, compte 418 : réalisé mais non
facturé, à AJOUTER au CA de N) et des produits constatés d'avance (PCA, compte 487 : facturé mais
non réalisé, à RETIRER du CA de N). Référence méthodologique : PCG art. 622-1 et suivants (méthode
à l'avancement), CGI art. 38-2 bis (le fiscal suit le comptable).

Preuve sur l'exercice clos : le fichier « Factures_cut-off 31122025.xlsx » (envoyé à l'EC) se
recoupe à l'euro près avec la liasse 2025 : PCA 5 000 + 4 650 = 9 650 € (compte 487000) ;
FAE 4 800 TTC + 23 790 TTC = 28 590 € (compte 418100).

**Objectif (mots de Nathan)** : « un CA à l'avancement dans Pilot toute l'année pour toutes les
missions à cheval sur 2 années, sinon aucun intérêt. Cet avancement va évoluer avec le temps, et ne
sera figé qu'après la clôture de l'année N. » Pas de production du fichier cut-off pour l'instant.

## 1. Décisions actées (réponses de Nathan, 2026-08-31)

| # | Décision |
|---|----------|
| D1 | Périmètre = **FAE/PCA uniquement**. Jamais d'AAE (avoirs à établir) chez Releaf. |
| D2 | Le % d'avancement est fixé **au jugé, par mission, par Nathan**. Pilot lui offre la saisie. |
| D3 | Source des données = **Notion** (une mission = une page, avec CA total HT, montant d'acompte, dates d'émission acompte/solde). **Aucun lien Pennylane**, jamais. |
| D4 | Le fichier cut-off ne sert qu'à une chose : fournir l'**ancre figée au 31/12/2025** des 7 missions à cheval (§3.4). |
| D5 | On travaille en **HT** partout (l'entête « HT »/formules TTC du fichier était une incohérence). |
| D6 | Le mécanisme s'applique aux **exercices ≥ 2026**. Le CA affiché de 2025 ne bouge pas (exercice clos : la liasse fait foi). |
| D7 | **Primes intouchées** : étage 1 sur le CA signé, étage 2 sur le facturé (billing.js). La rémunération ne dépend pas d'un % au jugé. Rediscutable plus tard. |
| D8 | **Miroir trésorerie intouché** (`computeResultatFactuelForYear`) : la trésorerie reste aux dates de facture, ce qui est correct (l'avancement déplace du CA comptable, pas des encaissements). |
| D9 | Design validé : **couche d'ajustement additive** (on ne réécrit pas le calcul existant, on pose un remplacement par mission par-dessus, réversible et traçable). |

## 2. Modèle de données

### 2.1 Table Supabase `mission_avancements` (migration `migrations/44_mission_avancements.sql`)

```sql
create table if not exists mission_avancements (
  mission_id text not null,          -- id de la page Notion (stable au renommage, patron migration 42)
  exercice integer not null,         -- exercice comptable : pct = avancement au 31/12/exercice
  pct numeric not null check (pct >= 0 and pct <= 100),
  nom text,                          -- copie informative du nom de mission au moment de la saisie
  fige_le timestamptz,               -- null = modifiable ; non null = exercice clos, ligne verrouillée
  updated_at timestamptz not null default now(),
  primary key (mission_id, exercice)
);
alter table mission_avancements enable row level security;
-- RLS activée SANS policy (patron migrations/42) : accessible uniquement via supabaseAdmin (service-role).
```

Points du patron repris de l'existant :
- clé = **id Notion** (comme `deals_notion_validations`), jamais le nom (leçon `facture_overrides`) ;
- dimension **exercice** dans la clé (patron `plan_tre_validations.month_key`) : le % 2026 et le % 2027 d'une même mission coexistent ;
- figeage **horodaté** (`fige_le`, patron gel de deal migration 43), pas un booléen sec ;
- **dégradation douce** : table absente → fonctionnalité inactive, aucun 500, boutons désactivés côté front (patron migration 42).

### 2.2 Sémantique d'une ligne

`(mission_id, exercice, pct)` = « au 31/12/{exercice}, la mission est avancée à {pct} % ».
Pendant l'exercice en cours, la ligne de cet exercice porte l'estimation **du moment** (Nathan la
met à jour au fil de l'eau) ; à la clôture, elle est figée et devient l'avancement officiel au 31/12.

## 3. Sémantique de calcul

### 3.1 Fonction de lecture : `pctFin(mission, E)`

Pour une mission et un exercice E : la valeur `pct` de la ligne d'exercice le plus récent ≤ E
(**report en avant**, carry-forward) ; **0 si aucune ligne ≤ E**.

Le report en avant est essentiel : une mission finie à 100 % en 2025 et facturée en 2026 n'a qu'une
ligne (2025, 100). En 2026, `pctFin(2026) = 100` (reporté), donc CA 2026 = ca × (100 − 100) = 0 :
les 4 factures « FAE 100 % » sortent du CA 2026 sans saisie supplémentaire.

### 3.2 CA à l'avancement d'une mission pour l'exercice Y

```
caAvancement(m, Y) = m.ca × (pctFin(m, Y) − pctFin(m, Y−1)) / 100
```

`m.ca` = prix total HT de la mission (champ Notion « CA mission »). Le résultat peut être négatif si
Nathan baisse un % d'une année sur l'autre (révision au jugé) : accepté, c'est une correction.

### 3.3 Règle de remplacement (le cœur du design)

Une mission est **suivie à l'avancement** si elle possède au moins une ligne `mission_avancements`.
Pour tout agrégat annuel de CA d'un exercice **Y ≥ 2026**, la contribution d'une mission suivie est
**REMPLACÉE** par `caAvancement(m, Y)` ; les missions non suivies gardent le comportement actuel de
l'agrégat (aucun changement). Pour les exercices ≤ 2025, aucun remplacement nulle part (D6).

Pourquoi un remplacement par consommateur et pas un delta global : les deux bases existantes ne
rattachent pas pareil (totalCaAnnee replie sur « Année final » quand la facture n'est pas émise ;
le caFacture du CR ne compte que les factures émises). Un delta unique serait faux pour l'une des
deux. Le module expose donc le remplacement, chaque consommateur l'applique à SA base.

### 3.4 Ancre 2025 (saisie unique par Nathan via l'UI, puis exercice figé)

Valeurs issues du fichier cut-off (font foi, recoupées liasse) ; les `mission_id` Notion seront
sélectionnés par Nathan dans l'UI de saisie :

| Mission (repère fichier) | CA total HT | pct 2025 |
|---|---|---|
| Groupe Elise · Développement outil bilan carbone franchise | 10 000 | 90 |
| Ferme des Arches · Diag Décarbon'Action | 10 000 | 10 |
| Alphapro · mission F-2025-92 (facturée 100 % en mai 2025) | 15 500 | 70 |
| Bureau Veritas · audit Domaine Lafage | 1 650 | 100 |
| Bureau Veritas · audit Cristal Union ECP | 4 950 | 100 |
| Bureau Veritas · vérification bilan carbone Télévision de France | 5 225 | 100 |
| Alphapro · Mise à jour FDES In Alpha | 8 000 | 100 |

NB : les CA côté Notion peuvent différer légèrement de ces montants (reconstitués depuis les
factures) ; la valeur qui fait foi dans le calcul est `m.ca` de Notion. Les lignes 2025 sont
saisies puis **figées** (action « figer 2025 »).

### 3.5 Invariant vie-entière (garde testée)

Pour une mission suivie dont le dernier exercice à ligne est L avec pct = 100 :
`Σ caAvancement(m, Y) pour Y = première ligne … L` = `m.ca` exactement (télescopage de la somme).
Autrement dit : l'avancement **déplace** du CA entre exercices, il n'en crée ni n'en détruit.
Le module expose `verifierInvariantAvancement(missions, lignes)` (patron `verifierInvariantImmos`),
tolérance ±1 € (arrondis), résultat affichable en anomalie front.

Cas limite documenté : la part 2025 d'une mission ancrée (ex : 90 % de Groupe Elise) est reconnue
par la LIASSE, pas par Pilot (D6). L'invariant se vérifie sur la somme liasse + Pilot, pas sur les
seuls exercices affichés par Pilot ; le test unitaire le vérifie sur la série complète calculée.

## 4. Serveur

### 4.1 Module pur `utils/caAvancement.js` (TDD, zéro I/O)

Exporte :
- `pctFin(lignesMission, exercice)` → number (0 si aucune ligne ≤ exercice) ;
- `caAvancementMission(mission, lignesMission, exercice)` → number (§3.2) ;
- `computeAvancement(missions, lignes, exercice)` → `{ suivies: [{ missionId, nom, ca, pctPrec, pctCourant, caAvancement }], actif: bool }` avec `actif = false` si `lignes` est null/vide (dégradation douce) et **aucun remplacement si exercice < 2026** (constante `PREMIER_EXERCICE_AVANCEMENT = 2026` exportée) ;
- `ajusterTotal(base, contributionsBase, suivi)` : helper de remplacement `base − Σ contributionsBase(mission suivie) + Σ caAvancement` ;
- `verifierInvariantAvancement(missions, lignes)` → liste d'anomalies (§3.5).

Les lignes exclues du CA restent exclues : une mission `etat === 'Annulé'` n'est jamais remplacée ni
comptée, même si elle a des lignes d'avancement (cohérent avec `SIGNE_EXCLUDED_STATES`).

### 4.2 Accès données + endpoints (server.js)

- `fetchMissionAvancements()` : lecture `mission_avancements` via `supabaseAdmin`, patron
  `fetchDealsNotionValidations` (dégradation douce si table absente → `null`, flag
  `avancementDisponible: false` dans les réponses concernées).
- `GET /api/avancement?year=YYYY` → `{ disponible, lignes, calcul: computeAvancement(...) }`
  (liste pour la modale : missions suivies + valeurs par exercice + figeage).
- `POST /api/avancement` `{ missionId, exercice, pct, nom }` : upsert idempotent. **Gardes** :
  pct ∈ [0, 100] ; exercice ∈ [2025, année courante + 1] ; refus HTTP 409 si la ligne (ou
  l'exercice entier) est figée ; refus 400 si missionId inconnu des missions Notion en cache.
- `DELETE /api/avancement` `{ missionId, exercice }` : retire une mission du suivi (refus si figé).
- `POST /api/avancement/figer` `{ exercice }` : pose `fige_le = now()` sur TOUTES les lignes de
  l'exercice. Action volontaire de Nathan à la clôture (pas de couplage automatique à la liasse :
  YAGNI, on garde la main). Pas d'action « défiger » : si besoin exceptionnel, SQL à la main.
- Auth : mêmes protections que les autres endpoints dashboard (`dashboardGate` TOTP). Invalidation
  du cache missions non nécessaire (la table est lue à chaque requête, patron migration 42).

### 4.3 Intégration aux agrégats (exercices ≥ 2026 uniquement)

| Consommateur | Base actuelle | Intégration |
|---|---|---|
| `GET /api/ebe` (CR) | boucle locale `caFacture` (server.js:9522-9540) | `caFacture` remplacé mission par mission (base = volets émis datés dans l'année). EBE/REX/IS/RN suivent mécaniquement. Réponse **additive** : bloc `avancement { actif, delta, parMission }` pour le front (badge + réconciliation). La vue hors capitalisation hérite via `ebeFactuel`/`ebeProjete` (aucun changement dans `computeRetraiteForYear`). |
| `GET /api/ca-annee` (Cockpit) | `totalCaAnnee` | total ajusté par remplacement (base = `signedAmountForYear`, repli « Année final » compris) + champ additif `avancement`. |
| `GET /api/analytics` (card `caAnnee`) | `totalCaAnnee` | idem Cockpit. Le **graphe mensuel reste à la facture** (un % d'avancement n'a pas de mois naturel) : divergence card/graphe documentée en infobulle. |
| `GET /api/kpi` (tuile + avancement collectif) | `totalCaAnnee` via `computeKpi` | idem : `caAnnee` ajusté (champ additif `avancementCa` dans la réponse pour le badge). L'incohérence préexistante tuile (totalCaAnnee) vs paliers primes (billing.total) demeure et reste documentée. |

Implémentation recommandée : une fonction `totalCaAnneeAvecAvancement(missions, lignes, year)` dans
`utils/kpiCompute.js` (ou le module avancement) qui NE MODIFIE PAS `totalCaAnnee` existante : les
trois consommateurs `totalCaAnnee` l'appellent explicitement. Le CR applique le même principe à sa
propre boucle. Aucune signature existante ne change.

### 4.4 Intouchés (liste de non-régression, à vérifier en revue)

- `computeResultatFactuelForYear` (miroir trésorerie) : **aucune modification, aucune divergence de
  forme des missions en entrée** (le module avancement ne touche pas les objets mission).
- `signedAmountForYear`, `totalCaAnnee`, `signedByQuarter` (CA signé primes étage 1) : inchangés.
- `utils/billing.js` (base primes étage 2), write-back GSheet, `kpi_prime_config` : inchangés.
- Trésorerie/scénarios (`buildPrevisionnel`), pipeline pondéré, CA mensuel Commercial (HubSpot),
  alerte deals-Notion (tolérance sur `m.ca`), `prospector.js` : inchangés.
- Divergence CR (avancement) vs trésorerie (facture) : ASSUMÉE et documentée (D8), comme la
  divergence CR vs miroir du lot hors capitalisation.

## 5. Front (public/pilot.html ≡ dist/pilot.html)

### 5.1 Saisie : modale « Avancement des missions » (onglet Facturation)

Bouton dans l'entête de l'onglet Facturation (le tableau existant liste des FACTURES acompte/solde,
pas des missions : la saisie par mission passe par une modale, patron `ponderationModal`).
Contenu :
- tableau des missions suivies : Mission · Client · CA HT · une colonne par exercice pertinent
  (N−1 : lecture seule si figé, badge « figé » ; N : input % 0-100) · CA N à l'avancement calculé
  affiché en direct ;
- sélecteur « + suivre une mission » (liste des missions Notion non annulées et non suivies,
  recherche par nom/client) ;
- bouton « Figer {exercice} » avec confirmation explicite (irréversible côté UI) ;
- bandeau d'anomalies si `verifierInvariantAvancement` remonte quelque chose ;
- boutons désactivés + message si `disponible: false` (table absente, patron deals-notion).
- Sauvegarde par bouton explicite par ligne ou « OK » global (patron `savePonderation` : POST puis
  re-fetch, le serveur reste la seule source de vérité).

### 5.1 bis Sélection d'une mission : recherche, lecture directe, filtre à cheval

Amendement du 2026-09-01, après mise en service (retour de Nathan : « le moteur de recherche des
missions est nul »). Le sélecteur `<select>` simple de la version initiale est remplacé.

**Ce que le serveur expose en plus** (additif, dans le tableau `missions` de `GET /api/avancement`) :
`montantAcompte`, `dateFactureAcompte`, `montantSolde`, `dateFactureFinale`, `anneeAcompte`,
`anneeSolde` et `aCheval`. Les deux `annee*` valent l'année de la date de facture du volet quand
elle est émise, sinon l'année du champ Notion « Année final » (même règle de rattachement que
`signedAmountForYear`), sinon `null`. `montantSolde` vaut `max(0, ca − montantAcompte)`, comme
partout ailleurs dans le lot.

**Règle « à cheval »** : `aCheval` est vrai quand les deux volets existent (montants supérieurs au
seuil de 5 €, cohérent avec le reste du code), que leurs deux années de rattachement sont connues,
et qu'elles diffèrent. C'est la règle demandée par Nathan : deux volets sur la même année signifient
mission lancée et terminée dans l'année, sans intérêt pour l'avancement.

**Filtre par défaut et échappatoire** : la liste de sélection n'affiche par défaut que les missions
`aCheval`. Une case à cocher « afficher toutes les missions » lève le filtre. Cette échappatoire est
NÉCESSAIRE et non décorative : une mission facturée en une fois sur l'exercice N mais dont le
travail déborde sur N+1 est un produit constaté d'avance, elle n'est pas « à cheval » au sens des
dates de facture, et le filtre la masquerait. C'est exactement le cas d'« Alphapro groupe »
(15 500 €, facturée intégralement le 2025-04-30, avancée à 70 % au 31/12/2025, PCA de 4 650 €),
l'une des sept missions du fichier de cut-off.

**Recherche** : un champ texte filtre la liste sur le nom de mission et sur le client, sans
distinction de casse ni d'accents (réutiliser la normalisation déjà présente dans le fichier).

**Lecture directe** : chaque entrée de la liste montre le nom, le client, puis les deux volets sous
la forme « Acompte {montant} le {date} · Solde {montant} le {date} », un volet non émis affichant
« non émis ». Le tableau des missions déjà suivies affiche les mêmes informations, pour que Nathan
juge l'avancement sans quitter la modale.

### 5.1 ter Refonte de la modale (retours Nathan du 2026-09-01, après mise en service)

Sept demandes, formulées après usage réel. Cette section remplace le contenu de 5.1 et 5.1 bis
partout où elle les contredit.

**a. Exercices affichés : N et N+1, jamais N−1.** L'exercice d'ancrage 2025 est saisi et figé, il
n'a plus à encombrer la saisie. La modale affiche donc les colonnes de l'exercice courant N et du
suivant N+1. Le CALCUL continue d'utiliser l'avancement de fin N−1 par report en avant : c'est le
sous-onglet « Calcul » (point e) qui rend ce point de départ visible, pas la grille de saisie.

**b. Toutes les missions consultables, y compris celles d'une seule année.** La grille cesse d'être
la liste des seules missions suivies : chaque mission devient une ligne, qu'elle porte ou non un
pourcentage. Saisir un pourcentage dans une ligne crée la ligne d'avancement ; le sélecteur
« ajouter une mission » disparaît, devenu inutile. Périmètre par défaut : les missions ayant une
activité en N ou N+1, c'est-à-dire une facture datée de ces exercices ou un avancement déjà saisi.
Une case « toutes les missions » lève ce périmètre. Le drapeau `aCheval` reste calculé et s'affiche
comme un badge sur la ligne, mais il ne filtre plus par défaut : il informe au lieu d'exclure.

**c. Modale agrandie et alignée sur le design de l'application.** La modale actuelle est décrite
comme archaïque par l'utilisateur. Reprendre les conventions déjà en place : conteneur
`<div class="modal kpi-modal" style="max-width:1100px;width:96%">` (la plus large de l'application,
cf. la modale de détail des ressources), titres de section `kpi-rg-h` avec badge `kpi-rg-badge`,
tableau `kpi-obj-table`, boutons `kpi-btn` et `kpi-btn--primary`. Aucun style inventé : tout doit
exister ailleurs dans le fichier.

**d. Sous-onglets.** Reprendre le patron `kpi-signed-tabs` / `kpi-signed-tab` déjà utilisé par les
primes. Deux onglets : « Saisie » (la grille) et « Calcul » (le pont).

**e. Sous-onglet « Calcul » : le pont du CA.** Il explique, pour l'exercice N, le passage du point de
départ au résultat : CA Notion aux dates de facture, puis les retraitements mission par mission
(montant remplacé vers montant retenu), puis le CA à l'avancement, présenté comme **le CA estimé à
la clôture**. Reprendre le patron visuel de `_crPontHtml` (lignes libellé/valeur, filet et gras sur
les totaux). Les données viennent du champ `avancement` de `/api/ebe` : `base`, `delta`, et le
tableau `suivies` où chaque entrée porte `contributionBase` et `caAvancement`.

**f. Figeage à la clôture de N.** Le bouton « Figer {N} » vit dans le sous-onglet Saisie, avec
confirmation explicite. Le mécanisme serveur existe déjà : une fois figé, l'exercice refuse toute
écriture (HTTP 409) et son CA à l'avancement devient définitif. Ce CA figé est celui qu'affichent le
compte de résultat, le Cockpit, l'onglet Analytics et le KPI, sans traitement particulier
supplémentaire : ils lisent déjà la valeur ajustée.

**g. Infobulle et renvoi vers le calcul, partout.** Chaque endroit affichant un CA à l'avancement
(ligne du compte de résultat, card Cockpit, card Analytics, tuile KPI) porte déjà une infobulle
explicative ; elle doit désormais s'accompagner d'un renvoi cliquable qui ouvre la modale
directement sur le sous-onglet « Calcul ». Cela suppose une fonction globale d'ouverture ciblée,
appelable depuis n'importe quel onglet, la modale étant une surcouche globale.

### 5.1 quater Périmètre strict N/N+1 et lisibilité du calcul (retour Nathan du 2026-09-01, après usage de la v2)

Deux constats de l'utilisateur : « je ne trouve pas que ce soit très compréhensible » et, en exemple,
une mission dont l'acompte ET le solde tombent en N+1 apparaît quand même dans la modale pendant la
clôture N. Cette section corrige le point b de 5.1 ter, que Nathan révoque explicitement.

**a. Périmètre strict : seules les missions à cheval sur N et N+1.** La règle du point b de 5.1 ter
(« toute mission ayant une activité en N ou N+1 ») est abandonnée. Une mission n'apparaît que si l'un
de ses deux volets est rattaché à N et l'autre à N+1. Une mission dont les deux volets tombent sur le
même exercice disparaît de la modale, quel que soit cet exercice : c'est le cas de l'exemple donné
(acompte et solde en N+1), qui n'a rien à faire dans la clôture N.

**Doctrine qui fonde cette règle, à énoncer dans l'interface.** Nathan : « c'est à nous d'être très
carré sur la date d'émission des factures ; si une mission a ses acompte et solde en N, ça veut dire
que tout est réalisé en N, sinon le manager modifie la date de facture du solde. » La date d'émission
fait donc foi, et l'absence d'une mission dans la modale n'est pas un trou de l'outil mais un signal :
la donnée Notion est à corriger. Le message affiché quand la liste est vide, et la note de bas de
grille, doivent le dire en clair, sans quoi l'utilisateur croira à un défaut.

**b. Conséquence assumée, et l'échappatoire qui reste.** Cette règle rend invisible le cas du produit
constaté d'avance : une mission facturée en une fois sur N dont le travail déborde sur N+1 a ses deux
volets sur N et disparaît, alors qu'elle appelle un retraitement. La case « afficher toutes les
missions » demeure donc le seul chemin pour ce cas ; son libellé doit expliquer à quoi elle sert
plutôt que de rester muette.

**c. Rendre chaque montant auto-explicatif.** Le CA d'un exercice vaut
`prix total × (avancement fin N − avancement fin N−1)`, mais l'avancement de fin N−1 n'est plus
affiché depuis 5.1 ter point a : un montant peut donc sembler faux. Chaque cellule de CA doit porter
une infobulle donnant le calcul en toutes lettres avec ses trois nombres. Et lorsque l'avancement de
départ n'est pas nul, la cellule doit le signaler visiblement, car c'est le seul cas où le montant
n'est pas déductible de ce qui est à l'écran.

**d. Nettoyage.** Le badge « à cheval » perd son sens puisque toutes les missions affichées le sont
désormais : le retirer.

### 5.1 quinquies Le chevauchement se lit sur les dates, et une mission suivie ne disparaît jamais

Trois constats de Nathan après la mise en service de 5.1 quater, dont deux défauts réels de ma part.

**a. Le seuil de 5 € n'a rien à faire dans la détection du chevauchement (défaut).** `missionAvancementInfo`
exige aujourd'hui que les DEUX volets dépassent 5 € pour déclarer une mission à cheval. Ce seuil vient
de `utils/billing.js`, où il sert à décider s'il faut afficher une ligne de facture ; l'appliquer ici
est un contresens. Conséquence mesurée : « Wienerberger - Phaunis », acompte au 01/12/2026 et solde au
01/02/2027, est déclarée non à cheval parce que son acompte vaut 1 €, et la grille de la clôture 2026
se retrouve VIDE alors que cette mission la concerne au premier chef. L'acompte symbolique de 1 € est
justement le motif employé pour les facturations en une fois : il porte une DATE, qui est
l'information utile.

Nouvelle règle : une mission est à cheval quand ses deux volets portent une **date d'émission connue**
et que ces deux dates tombent sur des **années différentes**. Les montants ne participent plus à cette
décision. C'est la stricte application de la doctrine de Nathan, « la date d'émission fait foi ».
Effet de bord souhaitable : les missions à acompte symbolique deviennent visibles, or c'est
précisément le motif des factures à établir.

Le repli sur le champ Notion « Année final » reste en vigueur pour `anneeAcompte` et `anneeSolde`,
qui servent au rattachement comptable ; mais le drapeau `aCheval` se fonde, lui, sur les seules dates
de facture réellement émises. Les deux notions sont distinctes et doivent le rester.

**b. Une mission déjà suivie reste toujours affichée (défaut).** Suivre une mission fait que Pilot
REMPLACE sa contribution au lieu de la compter : tant que le pourcentage de l'exercice courant n'est
pas saisi, le report en avant donne un écart nul et le chiffre d'affaires de cette mission tombe à
zéro. La masquer parce qu'elle sort du périmètre reviendrait donc à rendre ce trou incorrigible. Cas
réel : « Elise V2 », ancrée à 90 % en 2025, apportait 5 000 € à 2026 par son solde de janvier ; sans
saisie 2026 elle apporte 0. Toute mission portant au moins une ligne d'avancement figure donc dans la
grille, quel que soit le périmètre, avec une mention expliquant qu'elle y est parce qu'elle est
suivie et non parce qu'elle est à cheval.

**c. Ce qui est éditable, et ce qui ne l'est pas (clarification, pas un changement).** Question de
Nathan : pourquoi les missions ancrées seraient-elles modifiables alors que le cabinet les a validées ?
Elles ne le sont pas. L'ancre 2025 est figée en base, refusée en écriture par le serveur, et n'est même
plus affichée depuis 5.1 ter point a. Seules les colonnes N et N+1 sont éditables, c'est-à-dire des
exercices que personne n'a encore arrêtés. Une cellule reste modifiable tant que son exercice est
ouvert et bascule définitivement en lecture seule au figeage. Aucun code à changer ; l'interface doit
en revanche le rendre évident, faute de quoi la question se reposera.

### 5.2 Affichage du CA ajusté

- **CR (onglet Compte de résultat)** : la ligne CA affiche la valeur ajustée ; badge
  « à l'avancement » à côté du libellé quand `avancement.actif` et delta ≠ 0, infobulle avec le
  détail par mission (nom, pct, montant remplacé → montant retenu). Le comparatif N vs N-1 garde la
  convention : N à l'avancement, N−1 = liasse (exercice clos) ; note de convention mise à jour.
- **Modale de réconciliation liasse** : la note de convention actuelle (« Pilot compte à la facture
  Notion ») est réécrite : « Pilot compte à l'avancement depuis 2026 ; 2025 et antérieurs restent à
  la facture, la liasse fait foi ». Nouvelle ligne explicative dans la colonne Pilot si l'exercice
  affiché a un ajustement.
- **Cockpit card, Analytics card, tuile KPI** : même chiffre ajusté partout (c'était déjà la raison
  d'être de `totalCaAnnee`), badge discret « à l'avancement » en infobulle.
- Aucune nouvelle couleur, aucun graphe nouveau : pas de travail dataviz dans ce lot (si un graphe
  devait naître plus tard, invoquer le skill dataviz d'abord).

## 6. Tests et recette

### 6.1 Tests unitaires (module pur, TDD)

- `pctFin` : aucune ligne → 0 ; report en avant multi-années ; ligne exacte prioritaire.
- `caAvancementMission` : cas Groupe Elise (90→100 : 1 000 en 2026), Ferme des Arches (10→100 :
  9 000 en 2026), FAE 100 % (100→100 : 0 en 2026), révision à la baisse (négatif accepté).
- `computeAvancement` : mission annulée jamais remplacée ; exercice < 2026 → jamais actif ;
  lignes null/vides → `actif: false` ; missions non suivies absentes de `suivies`.
- `verifierInvariantAvancement` : télescopage exact à pct final 100 ; anomalie si incohérence.
- Intégrations : totalCaAnneeAvecAvancement vs totalCaAnnee sur missions mixtes (suivies + non
  suivies + repli « Année final ») ; garde de figeage côté endpoint (409).
- Gouvernance (patron I7) : un test vérifie que `computeResultatFactuelForYear` et
  `utils/billing.js` ne référencent AUCUN symbole du module avancement (mordant prouvé par
  mutation à la revue).

### 6.2 Recette live (lecture seule, port dédié, comme les lots précédents)

1. Table créée, 7 ancres 2025 saisies par Nathan, exercice 2025 figé.
2. `GET /api/ebe?year=2026` : `avancement.actif`, delta attendu ≈ −(volets 2026 des 7 missions
   ancrées) tant que les % 2026 ne sont pas saisis ; puis Nathan pousse Groupe Elise et Ferme des
   Arches à leur jugé du moment et on vérifie le chiffre à la main.
3. Cockpit, Analytics, KPI : même CA ajusté au euro près sur les trois pages.
4. `GET /api/tresorerie` : STRICTEMENT identique avant/après (miroir + billing intouchés).
5. Cible de contrôle vie-entière : quand les 7 missions seront à 100 %, le CA cumulé
   2025 (liasse) + 2026 (Pilot) de chacune = son `ca` Notion (invariant §3.5) ; l'effet net attendu
   sur 2026, toutes à 100 % et facturées, est ≈ −14 175 € HT (−19 825 FAE − 4 000 GE + 5 000 FdA
   + 4 650 Alphapro), à recouper avec les CA Notion réels.

## 7. Procédure annuelle (à ajouter à la doctrine de clôture)

À chaque clôture d'exercice N : (1) passer en revue les missions à cheval et ajuster leur % au
31/12/N dans la modale ; (2) « Figer N » ; (3) saisir la liasse N (`data/liasses/N.json`) quand
elle arrive : la réconciliation doit alors montrer un écart CA réduit aux seuls éléments hors
avancement (subventions, arrondis, méthode).

## 8. Contraintes globales (rappel, inchangées)

CommonJS ; jamais de tiret cadratin ; `public/pilot.html` ≡ `dist/pilot.html` (cmp) ;
`prospector.js` intouché ; `computeResultatFactuelForYear` intouché ; réponses API additives ;
aucun appel HTTP dans les tests ; aucune écriture Supabase par les agents ; commits en français
finissant par `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` ; merge uniquement sur
« go » explicite ; ne jamais toucher `kpi_prime_config` du 1er au 20 janvier.
