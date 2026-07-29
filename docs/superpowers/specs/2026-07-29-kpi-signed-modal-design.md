# Modale « détail CA signé » au clic sur un graphe KPI

Date : 2026-07-29
Fichier concerné : `public/pilot.html` (puis recopie identique dans `dist/pilot.html`)

## Contexte

Page KPI (« Objectifs & avancement »), section « Avancement par partner ». Aujourd'hui,
un clic ne fonctionne que si on tape précisément sur une barre : `openKpiDetail(block, typeKey)`
([public/pilot.html] `onClick` du chart) ouvre `kpiDetailModal` et liste les missions d'un seul
axe (Newsale, Upsale ou Opéré) avec le seul montant attribué.

## Objectif

Remplacer ce comportement par : un clic n'importe où sur une carte de graphe ouvre une modale
récapitulative du CA signé du bloc, avec deux sous-tabs (Newsale / Upsale) détaillant chaque deal.

## Comportement cible

### Déclencheur
- Toute la carte `.kpi-card` devient cliquable (curseur main + effet de survol léger).
- Un clic ouvre la nouvelle modale pour ce bloc (un partner, ou « Tous les partners »).
- Le clic-par-barre et le drill-down Opéré sont retirés.

### Contenu de la modale
- En-tête : pastille (couleur d'accent du bloc) + nom du bloc.
- Résumé : trois chiffres en CA signé réalisé : Newsale, Upsale, Total (= Newsale + Upsale).
- Deux sous-tabs : Newsale (actif par défaut), Upsale.
- Corps = deals du tab actif, triés par montant décroissant :
  - Modale d'un partner : chaque deal montre nom + client, et la part de CE partner uniquement,
    au format `montant € · %`. Aucune info sur les co-partners.
  - Modale « Tous les partners » : chaque deal montre nom + client + montant total du deal, puis
    la répartition par associé en dessous (`Nom · montant € · %`).

### Cas limites
- Sous-tab sans deal : message « Aucun deal Newsale/Upsale cette année. ».
- Deal « Tous » sans partner rattaché (orphelin d'attribution) : ligne « non attribué ».

## Données (100 % front, aucune modif serveur)

Tout est déjà présent dans `kpiData` (produit par `utils/kpiCompute.js`) :
- Résumé partner : `block.data.newsale.realise`, `block.data.upsale.realise`.
- Résumé « Tous » : `kpiData.all.newsale.realise`, `kpiData.all.upsale.realise`.
- Détail partner : `block.details[type]` = `[{ id, nom, client, montant }]` où `montant` est la part
  du partner après split.
- CA total d'un deal : `kpiData.allDetails[type]` = `[{ id, nom, client, montant }]` où `montant` est
  le CA plein. On l'associe au deal partner via `id`.
- % d'allocation partner = part du partner ÷ CA total du deal.
- Contributions « Tous » : on construit un index `dealId -> [{ partner, montant }]` en parcourant
  `kpiData.partners[].details[type]`, puis `%` = montant partner ÷ CA total du deal.

## Isolation technique

Nouvelle modale dédiée `kpiSignedModal` (markup + fonctions `openKpiSignedModal`,
`renderKpiSignedTab`, `closeKpiSignedModal`), distincte de `kpiDetailModal` qui reste utilisée par
5 autres écrans (avancement individuel/collectif, CA non attribué, clawback, prime trimestrielle).
Aucune de ces fonctions n'est modifiée : zéro risque de régression sur ces écrans.

## Hors périmètre

- Aucun changement serveur ni base de données.
- L'axe Opéré n'est plus accessible en drill-down (choix validé).
