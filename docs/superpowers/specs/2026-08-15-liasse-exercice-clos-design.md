# Liasse fiscale des exercices clos dans le CR · design

> Statut : proposition validée par l'utilisateur le 2026-08-15 (« ok go faire ta proposition ») : zone fiscale ancrée sur la liasse, zone pilotage annotée par réconciliation, jamais de remplacement des calculs Pilot.
> Branche : `feat/liasse-et-da-comparatif`. Complète la spec CR hors capitalisation (2026-08-13, doctrine des deux zones : « la référence est la liasse du cabinet »).

## Objectif et principe

Quand un exercice est clos et sa liasse fiscale déposée, le CR de Pilot affiche les chiffres OFFICIELS là où ils font foi (la zone fiscale) et PROUVE sa fiabilité là où il garde sa méthode (la zone pilotage, comparable à méthode constante entre exercices). La liasse ne modifie JAMAIS un calcul : c'est un affichage et une réconciliation. Le comparatif N vs N-1 et tous les agrégats Pilot restent calculés comme avant.

## Données · `data/liasses/2025.json` (versionné, un fichier par exercice clos)

```json
{
  "exercice": 2025,
  "cloture": "2025-12-31",
  "depot": "2026-04-16",
  "source": "Liasse fiscale 2033/2065, SARL BDM Expertise & Audit",
  "chiffres": {
    "productionVendue": 409064,
    "subventionsExploitation": 11667,
    "autresProduits": 3,
    "totalProduitsExploitation": 420733,
    "chargesExploitation": 346794,
    "dontDotationsAmortissements": 1046,
    "dontAutresCharges": 13559,
    "productionImmobilisee": 0,
    "resultatExploitation": 73940,
    "impotSurBenefices": 3848,
    "cir": 10739,
    "resultatNet": 70092,
    "resultatFiscal": 75347
  }
}
```
NOTE : la liasse ne contient PAS d'EBE (solde de gestion, pas une rubrique fiscale) : on n'invente pas de champ. `impotSurBenefices` est l'IS APRÈS imputation du CIR (2033-B ligne 306) ; le CIR vient du 2069-RCI.

## Module pur `utils/liasses.js` (TDD)

- `chargerLiasses(dossier)` : lit tous les `NNNN.json` du dossier, tolérant (dossier absent → {}, JSON invalide → console.warn + fichier ignoré, jamais d'exception). Retourne `{ [exercice]: liasse }`.
- `verifierLiasse(liasse)` : gardes d'intégrité de saisie, retourne un tableau d'anomalies (vide attendu) : totalProduitsExploitation − chargesExploitation = resultatExploitation à ±2 € (arrondis de la liasse elle-même) ; resultatExploitation − impotSurBenefices = resultatNet à ±2 € ; champs numériques requis présents. Une liasse en anomalie est SERVIE quand même, avec ses anomalies exposées (jamais de silence).
- Tests : lecture nominale, dossier absent, JSON cassé, année sans fichier, anomalies détectées (valeurs dérivées à la main depuis la liasse 2025 réelle).

## Serveur (`/api/ebe`, additif)

Champ `liasse` dans la réponse : la liasse de l'année demandée (`null` si aucune), forme `{ exercice, cloture, depot, source, chiffres, anomalies }`. Chargement au démarrage avec cache (relecture par redémarrage : les liasses ne changent pas en cours de vie). AUCUN calcul existant modifié (EBE, retraite, comparatif : intacts). Miroir trésorerie intouché.

## Front (public/pilot.html + dist, page CR)

1. **Badge d'exercice clos** : à côté des pastilles d'exercice, quand `liasse` non nulle : badge « exercice clos · liasse du {cloture} » (patron .cr-tva-badge), cliquable → modale de réconciliation.
2. **Zone fiscale ancrée** (vue comptable ET hors capitalisation, exercice avec liasse) : les lignes IS, crédit d'impôt et résultat net affichent les chiffres RÉELS de la liasse en PLEIN (plus d'italique grisé pour ces lignes) : « Impôt sur les sociétés (réel, après CIR) : 3 848 € », « dont CIR : 10 739 € », « = Résultat net (liasse) : 70 092 € », en-tête de zone remplacé par « Chiffres fiscaux réels · liasse du {cloture} ». Les estimations Pilot de ces lignes restent consultables dans la modale de réconciliation (jamais côte à côte dans le tableau : un seul chiffre par ligne). En vue hors capitalisation, la zone fiscale reste l'IS THÉORIQUE contrefactuel (étiqueté comme aujourd'hui) : la liasse n'ancre que la vue comptable, le contrefactuel reste un contrefactuel ; seule la mention « IS réel (liasse) : 3 848 € » s'ajoute au bandeau de rappel.
3. **Modale « Réconciliation avec la liasse »** : tableau à 3 colonnes (Pilot · Liasse · Écart) : CA facturé Notion vs productionVendue ; Subventions+Aides Pilot vs subventionsExploitation ; Charges Pilot vs chargesExploitation ; Résultat d'exploitation Pilot vs resultatExploitation ; IS estimé vs impotSurBenefices ; Résultat net estimatif vs resultatNet. Sous le tableau, texte court expliquant les écarts structurels connus : CA à la facture Notion vs production vendue comptable (factures à établir, PCA), charges hybrides HT à périmètre Pilot vs rubriques fiscales, autres charges de gestion. Si `anomalies` non vide : bandeau danger listant les anomalies de saisie.
4. **Aucun changement** pour un exercice sans liasse (2026 aujourd'hui) : zone grisée estimative comme avant.
5. Contraintes habituelles : textes FR, pas de tiret cadratin, escapeHtml sur `source`, parité dist, gouvernance : le front ne lit la liasse que dans la zone CR.

## Recette (chiffres exacts attendus, liasse 2025)

Exercice précédent (2025) : IS réel 3 848 € (au lieu de l'estimation) ; RN 70 092 € ; CIR 10 739 € ; réconciliation : CA Pilot vs 409 064 ; charges Pilot vs 346 794 ; REX Pilot vs 73 940 ; production immobilisée 0 des deux côtés. Exercice courant (2026) : rendu strictement inchangé.

## Hors lot
- Import automatique d'un PDF de liasse (saisie manuelle du JSON assumée, une fois par an).
- Ancrage d'autres écrans (Analytics, trésorerie) sur la liasse.
