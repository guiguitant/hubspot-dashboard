# Proposal Engine — Documentation technique

## Vue d'ensemble

Le Proposal Engine génère automatiquement des propositions commerciales PowerPoint (et PDF) personnalisées pour Releaf Carbon. Il est intégré dans le dashboard interne (pilot.html) et repose sur un backend Node.js/Express.

**Flux global :**
1. L'utilisateur remplit un formulaire → 2. Claude API génère le texte personnalisé → 3. Le backend manipule le template PPTX → 4. Le fichier est téléchargé (PPTX ou PDF via CloudConvert)

---

## Architecture

### Fichiers clés

| Fichier | Rôle |
|---|---|
| `public/pilot.html` | Interface utilisateur (formulaire + JS frontend) |
| `server.js` (lignes ~6627–7400) | Routes API + logique de génération |
| `proposal_engine/Template master proposition v3.pptx` | Template PowerPoint maître (73 slides) |
| `proposal_engine/slide_config.json` | Config des slides par mission/subvention/langue |

### Stack
- **Frontend** : HTML/CSS/JS vanilla dans `pilot.html`
- **Backend** : Node.js/Express, manipulation PPTX via `adm-zip` (lecture/écriture du ZIP sans LibreOffice)
- **IA** : Claude API (claude-sonnet-4-6) pour personnaliser le contexte client
- **PDF** : CloudConvert API (Linux/Render) ou PowerShell COM PowerPoint (Windows local)
- **Stockage** : Supabase Storage (bucket `proposals`) + table `deal_metadata`

---

## Le template PPTX (73 slides)

Le template contient **toutes** les slides possibles. Le moteur sélectionne un sous-ensemble selon la mission, puis supprime les autres avant de livrer le fichier.

### Structure des slides

| Slides | Section | Conditions |
|---|---|---|
| 1 | Couverture | Toujours incluse |
| 2–9 | Introduction Releaf (FR) | Incluse si langue = FR |
| 10–17 | Introduction Releaf (EN) | Incluse si langue = EN |
| 18 | Header "Votre contexte" | Toujours incluse |
| 19 | Contexte client (FR) | Incluse si langue = FR |
| 20 | Contexte client (EN) | Incluse si langue = EN |
| 21–26 | Méthodo Outil sur-mesure | Si mission = Outil sur-mesure |
| 27–36 | Méthodo ACV | Si mission = ACV |
| 37–47 | Méthodo Bilan Carbone | Si mission = Bilan Carbone |
| 48–53 | Méthodo FDES / PEP | Si mission = FDES/PEP |
| 54–59 | Méthodo EPD | Si mission = EPD |
| 60 | Header "Calendrier" | Si nature = Standard |
| 61 | Calendrier Bilan Carbone | Si mission = BC |
| 62 | Calendrier ACV | Si mission = ACV |
| 63 | Calendrier FDES/PEP | Si mission = FDES/PEP |
| 64 | Calendrier EPD | Si mission = EPD |
| 65 | Header "Proposition financière" | Toujours incluse |
| 66 | Financière BC — Rev3 50% | |
| 67 | Financière BC — BPI 40% | |
| 68 | Financière BC — Rev3 30% | |
| 69 | Financière ACV — BPI 70% | |
| 70 | Financière ACV — BPI 60% | |
| 71 | Financière FDES/PEP | |
| 72 | Financière EPD | |
| 73 | Financière Outil sur-mesure | Si mission = Outil sur-mesure |

**Note :** La mission Outil sur-mesure n'a pas de section calendrier séparée (le slide 26 l'intègre).

### Exemples de composition finale

- **Bilan Carbone, Rev3 50%, FR** → 24 slides : [1, 2–9, 18–19, 37–47, 60–61, 65–66]
- **EPD, sans subvention, EN** → 21 slides : [1, 10–17, 18–20, 54–59, 60–64, 65–72]
- **Outil sur-mesure, FR** → 19 slides : [1, 2–9, 18–19, 21–26, 65–73]

---

## Les missions

| Mission | Nature | Langue auto | Subventions possibles |
|---|---|---|---|
| Bilan Carbone | Standard | FR | Rev3 50%, BPI 40%, Rev3 30%, Sans |
| ACV | Standard | FR | BPI 70%, BPI 60%, Sans |
| FDES / PEP | Standard | FR | Aucune (slide unique) |
| EPD | Standard | EN | Aucune (slide unique) |
| Outil sur-mesure | Outil_sur_mesure | FR | Aucune (montant libre) |

La langue peut être forcée en EN pour toute mission (client anglophone).

---

## Les placeholders (variables dans le PPTX)

Le moteur remplace des balises `{{VAR}}` dans le XML interne du PPTX.

### Variables formulaire (saisie humaine)

| Placeholder | Description | Slides concernées |
|---|---|---|
| `{{NOM_ENTREPRISE}}` | Nom du client | Footers, en-têtes, slides contexte |
| `{{TYPE_MISSION}}` | Type de mission | Slide 1 (couverture) |
| `{{LOGO_ENTREPRISE}}` | Logo client (PNG/JPG/SVG) | Slide 1 |
| `{{PROGRAMME_SUBVENTION}}` | Ex : "Booster Transformation" | Slides financières |
| `{{OPERATEUR_SUBVENTION}}` | Ex : "Rev3", "Bpifrance" | Slides financières |
| `{{POURCENTAGE_SUBVENTION}}` | Ex : "50%" | Slides financières |
| `{{COMPLEMENT_POURCENTAGE}}` | 100 - pourcentage (calculé auto) | Slides financières BC |
| `{{MONTANT}}` | Montant HT libre (Outil sur-mesure uniquement) | Slide 73 |

### Variables IA (générées par Claude)

| Placeholder | Description | Limite | Slides |
|---|---|---|---|
| `{{CONTEXTE_CLIENT}}` | 2-3 phrases décrivant le client (secteur, taille, spécificité) | ~250 chars | 19, 20 |
| `{{ENJEU_1}}` | Premier enjeu client, formulation nominale | ~90 chars | 19, 20 |
| `{{ENJEU_2}}` | Deuxième enjeu client | ~90 chars | 19, 20 |
| `{{ENJEU_3}}` | Troisième enjeu client | ~90 chars | 19, 20 |
| `{{POURQUOI_MAINTENANT}}` | Urgence / déclencheur externe | ~140 chars | 19, 20 |
| `{{NOTE_CONTEXTE}}` | Note bas de slide (optionnelle) | courte | 19, 20 |
| `{{CONTEXTE_METIER}}` | Outil sur-mesure : processus métier à couvrir | 1-2 phrases | Slide 23 |
| `{{ENJEUX_DATA}}` | Outil sur-mesure : enjeux data/IT | 1-2 phrases | Slide 24 |
| `{{PERIMETRE_OUTIL}}` | Outil sur-mesure : périmètre fonctionnel | 1 phrase | Slide 25 |

---

## Personnalisation IA

### Appel Claude

- **Modèle** : `claude-sonnet-4-6`
- **Max tokens** : 800
- **Format de sortie** : JSON brut (sans backticks)
- **Entrées** : nom entreprise, mission, nature, langue, données SIRENE, contexte rédigé par le consultant

### Source de données SIRENE

Le moteur interroge l'API publique `recherche-entreprises.api.gouv.fr` avec le numéro SIREN saisi. Les données récupérées (secteur NAF, effectif, adresse) enrichissent le prompt Claude.

### Contexte consultant

Champ texte libre rempli par le consultant avant génération. C'est **la source principale** pour Claude — il décrit les échanges avec le client, les enjeux discutés, le déclencheur de la proposition.

### Fallback si Claude échoue

Si l'appel API échoue (timeout, quota, erreur réseau), la propale est quand même générée avec des placeholders génériques neutres. Aucune erreur visible pour l'utilisateur.

### Pré-génération IA (aperçu du contexte)

Avant de générer le PPTX, l'utilisateur peut cliquer "Aperçu du contexte IA" (`POST /api/proposal/ai-context`). Cela appelle Claude et affiche le résultat pour relecture/correction avant la génération finale. Le contexte pré-validé est réutilisé lors de la génération (pas de double appel Claude).

---

## Interface utilisateur (formulaire)

Le formulaire se trouve dans l'onglet "Proposal Engine" de `pilot.html`.

### Étapes du formulaire

1. **Deal HubSpot** (optionnel) : search autocomplete sur les deals ouverts du pipeline → lie la propale à un deal pour stockage et redownload
2. **Nom de l'entreprise** : champ libre + recherche SIREN autocomplete (Data.gouv)
3. **Type de mission** : 5 cartes cliquables
4. **Personnalisation IA** : toggle Avec/Sans IA
5. **Subvention** : pills dynamiques selon la mission sélectionnée (masqué pour Outil sur-mesure)
6. **Montant HT** : champ numérique (Outil sur-mesure uniquement)
7. **Langue** : FR / EN (auto selon mission, forçable)
8. **Contexte consultant** : textarea (obligatoire si IA activée)
9. **Logo** : drag & drop image
10. **Format d'export** : PowerPoint / PDF
11. **Bouton "Aperçu du contexte IA"** : prégénère et affiche le texte Claude
12. **Bouton "Générer"** : lance la génération complète

### Panneau de récapitulatif (colonne droite)

Affiche en temps réel : mission sélectionnée, subvention, langue, slides qui seront incluses (liste avec chips colorées). Permet de vérifier avant génération.

---

## Routes API

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/proposal/deals` | Liste des deals HubSpot ouverts (pipeline default) |
| GET | `/api/proposal/siren-search?q=` | Autocomplete SIREN / raison sociale (Data.gouv, 5 résultats) |
| GET | `/api/proposal/config` | Options de subvention disponibles par mission |
| POST | `/api/proposal/ai-context` | Pré-génération du contexte IA sans créer le PPTX |
| POST | `/api/proposal/generate` | Génération complète PPTX ou PDF |
| GET | `/api/proposal/redownload/:deal_id` | Re-téléchargement d'une propale liée à un deal |

### POST `/api/proposal/generate` — payload

```json
{
  "nom_entreprise": "Groupe Leclerc",
  "mission": "Bilan Carbone",
  "subvention": "Rev3_50pct",
  "langue": "FR",
  "montant_ht": null,
  "logo_base64": "...",
  "deal_id": "12345",
  "contexte_consultant": "...",
  "siren": "123456789",
  "ai_context": null,
  "format": "pptx"
}
```

Si `ai_context` est fourni (pré-généré via l'aperçu), Claude n'est pas rappelé.

---

## Génération PPTX (mécanique)

Le PPTX est un fichier ZIP contenant du XML. Le moteur utilise `adm-zip` pour :

1. **Lire** le template PPTX en mémoire
2. **Supprimer les slides** non pertinentes (manipulation de `presentation.xml` + suppression des fichiers `slideN.xml`)
3. **Remplacer le logo** client dans `slide1.xml` (remplacement binaire de l'image existante)
4. **Remplacer les placeholders** texte dans tous les `slideN.xml` via `String.replace()`
5. **Re-zipper** et envoyer le buffer au client

Aucun logiciel tiers (LibreOffice, PowerPoint) n'est nécessaire pour générer le PPTX.

---

## Conversion PDF

La conversion PPTX → PDF dépend de l'environnement :

- **Windows (local)** : PowerShell + COM automation PowerPoint (`SaveAs` format 32)
- **Linux / Render** : CloudConvert REST API (var d'env `CLOUDCONVERT_API_KEY`)
  - Gratuit jusqu'à 25 conversions/jour
  - Upload PPTX → conversion → téléchargement PDF (~5–15s)

---

## Stockage et historique

Quand un deal HubSpot est lié à la génération :
- Le PPTX est uploadé dans Supabase Storage (bucket `proposals`, path `{deal_id}.pptx`)
- La table `deal_metadata` est mise à jour avec : `proposal_sent_at`, `proposal_mission`, `proposal_nom`, `proposal_storage_path`
- La route `/api/proposal/redownload/:deal_id` permet de re-télécharger le fichier plus tard (PPTX ou PDF)

---

## Variables d'environnement requises

| Variable | Usage |
|---|---|
| `ANTHROPIC_API_KEY` | Appels Claude pour personnalisation IA |
| `CLOUDCONVERT_API_KEY` | Conversion PDF sur Linux/Render |
| `PROPOSAL_TEMPLATE_PATH` | Chemin du template PPTX (optionnel, défaut : `proposal_engine/Template master proposition v3.pptx`) |

---

## Limites actuelles / points d'attention

- **Pas de prompt caching** sur les appels Claude (le system prompt est long ~2000 tokens, potentiel d'optimisation)
- **Le template est unique** : tout changement de design nécessite de modifier le PPTX maître et de re-déployer
- **Les subventions sont hardcodées** dans `server.js` (PROPOSAL_SUBVENTION) — tout nouveau programme nécessite un déploiement
- **Pas d'authentification** sur les routes `/api/proposal/*` (pas de middleware `accountContext`) — accessible à tout utilisateur connecté au pilot
- **CloudConvert gratuit** limité à 25 PDF/jour — à monitorer si usage intensif
- **Pas de versioning** des propales générées (le redownload écrase toujours `{deal_id}.pptx`)
- **Logo replacement** : fonctionne uniquement si le template contient une image placeholder sur slide 1 au bon format
