# Méthodologie d'allocation du CA entre co-partners commerciaux

Date : 2026-07-30
Statut : conception validée (design), implémentation à planifier séparément.

## 1. Contexte et problème

Quand un deal est signé par plusieurs partners, le CA est réparti entre eux par un
pourcentage d'allocation. Aujourd'hui ce `%` n'obéit à AUCUNE règle :

- Le défaut du système est « parts égales » (`splitAmount`, `utils/kpiCompute.js`).
- Sinon, des `%` sont saisis à la main dans la table `splits` (axe `commercial` / `operationnel`, colonne `pct`).

Il n'existe donc pas de méthode partagée pour décider « qui touche quoi » sur un deal
co-géré. Résultat : des arbitrages au feeling, potentiellement conflictuels, et une
incitation commerciale non pilotée.

Rappel d'un fait structurant du système actuel :

- Les primes individuelles (étage 1, `signedByQuarter`) suivent le split de l'axe
  **commercial** (newsale / upsale). L'argent circule uniquement là.
- L'axe **opérationnel** (« opéré ») est un **indicateur KPI sans prime** : il ne verse rien.
- Aujourd'hui, un upsale est crédité à **100 % aux partners commerciaux** ; le partner
  opérationnel n'en touche rien.

## 2. Objectif stratégique

La chasse au nouveau client est la clé de voûte de la stratégie commerciale : dans ~2/3
des cas, un client devient du repeat. Deux conséquences directrices :

1. **Ramener un prospect doit être fortement récompensé**, y compris dans la durée,
   parce que la valeur d'un nouveau client se matérialise surtout dans ses repeats. Le
   poids du sourcing sur les **upsales** est donc le vrai levier de rémunération des
   « hunters » (la majorité des euros passe par le repeat), plus que sur le newsale.
2. **Un repeat récompense aussi le partner opérationnel** : s'il y a repeat, c'est en
   partie grâce à la qualité de la livraison passée (rétention).

## 3. Principe général : deux grilles par composantes

L'allocation d'un deal se calcule en décomposant le deal en **composantes pondérées**.
Chaque partner « coche » les composantes qu'il a assurées ; son `%` est la somme des
poids de ses composantes. Une composante partagée se coupe en deux (ou au prorata).

Les étapes d'un newsale et d'un upsale n'étant pas les mêmes, il y a **deux grilles
distinctes**. La classification Newsale / Upsale reste celle de Notion (`type_ca`).

## 4. Grille Newsale (total 100 %)

| Composante | Poids |
|---|---|
| Sourcing du prospect | 30 % |
| RDV + négociation | 30 % |
| Rédaction prez / proposition | 20 % |
| Relance + closing | 20 % |

Lecture : sourcing 30 % / gestion 70 %.

## 5. Grille Upsale (total 100 %)

| Composante | Poids |
|---|---|
| Sourcing / apporteur d'origine (rente à taux plein) | 30 % |
| Aspect opérationnel (rétention) | 35 % |
| RDV + négociation | 20 % |
| Rédaction prez / proposition | 15 % |

Pas de composante « relance + closing » sur un upsale : le client est déjà en relation,
le closing vient naturellement, en faire une composante créerait une ligne « gratuite »
que tout le monde cocherait.

Lecture : capital relationnel (qui l'a amené 30 % + qui l'a bien livré 35 %) = 65 % ;
exécution de la revente (chaude, plus facile qu'un newsale) = 35 %.

## 6. Règles d'affectation des composantes

### 6.1 Sourcing / apporteur d'origine, sur un upsale : la rente d'apport

On crédite **qui a fait exister l'opportunité en amont** :

- **Repeat prévu dès l'origine** (ex. petite mission test annoncée comme galop d'essai
  d'une grosse mission) : la grosse mission a été sourcée au départ → crédit à
  l'**apporteur d'origine** du client.
- **Repeat émergent** (besoin nouveau apparu en cours de route) : crédit au **détecteur
  réel** (souvent l'opé qui repère le besoin, ou un commercial qui réengage).

Cette part est une **rente à taux plein et constante** : le même 30 % sur chaque repeat,
sans dégressivité. Choix assumé au service de l'incitation à la chasse (« décroche un
logo, il te paie sur toute sa durée de vie »). Risque accepté du « propriétaire passif »
(un apporteur ancien qui touche sans plus contribuer) : la priorité stratégique prime.

On retrouve « qui a sourcé le client » via la grille **newsale de la mission d'origine**.

### 6.2 Aspect opérationnel (rétention), sur un upsale

Les 35 % récompensent la livraison passée qui a rendu le repeat possible. Point de
mécanisme **essentiel** : comme l'axe opéré ne verse aucune prime, cette part doit être
**bookée sur l'axe COMMERCIAL de l'upsale** (le seul qui paie). Le partner opérationnel
apparaît donc comme **contributeur commercial** de l'upsale à hauteur de 35 %. Effet de
bord assumé : il apparaît dans le KPI upsale commercial, ce qui est cohérent (il a
contribué au revenu) et c'est ce qui déclenche sa prime. Le mettre sur l'axe opéré
rendrait la récompense vide.

### 6.3 Convention « test → scale »

Une grosse mission signée après une mission test réussie est classée **Upsale** (pas
Newsale), justement parce que c'est la livraison du test qui l'a débloquée et qu'on veut
récompenser cette rétention (35 % opé) et la rente d'apport (30 %). Convention à poser
explicitement pour ne pas classer au feeling à chaque fois.

## 7. Cas particuliers

- **Grille non remplie** → repli sur parts égales (défaut actuel du système).
- **Cas évidents** → menu express (100/0, 70/30, 50/50) qui court-circuite la grille.
- **Apporteur d'origine inconnu** (client d'avant la méthodo) → repli sur le détecteur,
  sinon parts égales.
- **Plusieurs apporteurs / plusieurs opé d'origine** → la part de la composante concernée
  se répartit entre eux (au prorata de leur propre split d'origine, ou à parts égales).
- **Apporteur = opé** (fréquent en petite structure) : il cumule sourcing 30 % + opé 35 %
  = 65 % du repeat. Assumé : c'est récompenser le partner qui possède le compte de bout en
  bout. À garder en tête si un 3ᵉ partner est sollicité pour la seule négo (il ne touche
  que 35 %).

## 8. Découplage KPI vs prime

Décision retenue : **pas de découplage**. Le sourcing est une composante du `%` (pas un
bonus séparé), donc le `%` d'allocation pilote à la fois le tableau de bord et la prime,
comme aujourd'hui. Simplicité privilégiée.

## 9. Exemples chiffrés

**Newsale 20 000 €** — A source + relance ; B fait RDV/négo + prez.
- A = 30 + 20 = 50 % → 10 000 €
- B = 30 + 20 = 50 % → 10 000 €

**Upsale 12 000 € (test → scale)** — client apporté par A, mission test livrée par C,
grosse mission négociée et rédigée par B.
- A (apporteur d'origine, sourcing 30 %) → 3 600 €
- C (opé rétention 35 %) → 4 200 €
- B (RDV/négo 20 % + prez 15 % = 35 %) → 4 200 €

**Upsale, apporteur = opé** — A a amené ET livré le client ; B négocie le repeat.
- A (sourcing 30 % + opé 35 % = 65 %) → 65 %
- B (négo 20 % + prez 15 % = 35 %) → 35 %

## 10. Ce qui change par rapport à aujourd'hui

- Aujourd'hui : upsale = 100 % aux partners commerciaux ; l'opé ne touche rien ; `%`
  saisis au feeling.
- Demain : upsale réserve 35 % à l'opé (via l'axe commercial) et 30 % à l'apporteur
  d'origine ; le `%` se calcule via une grille explicite et défendable.

## 11. Hors périmètre (étape suivante : plan d'implémentation)

Ce document fige la **méthodologie**. L'outillage est une phase séparée à planifier :

- Décider si la méthodo reste une **règle documentée** ou devient un **helper** (aide qui
  suggère le `%` depuis les composantes cochées et pré-remplit la table `splits`,
  surchargeable, non bloquant). Reco retenue : aide, pas verrou.
- Point d'implémentation à traiter : pour que l'opé touche ses 35 %, il doit apparaître
  comme contributeur **commercial** de l'upsale. Or `splitAmount` ne répartit qu'entre
  les `partnerCommercial` de la mission ; un partner absent de cette liste ne reçoit rien.
  Le plan devra donc soit ajouter l'opé aux contributeurs commerciaux de l'upsale (saisie
  Notion / helper), soit étendre la logique de split.
- Récupération automatique de « qui a sourcé le client » depuis la mission d'origine.
- Éventuelle UI de saisie des composantes au closing.
