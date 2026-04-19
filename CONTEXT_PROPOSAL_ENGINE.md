# Contexte — Proposal Engine Releaf Carbon

## Qui sommes-nous

Releaf Carbon est un cabinet de conseil en décarbonation (Lille). Co-dirigeants : Guillaume, Vincent, Nathan.
Missions proposées aux clients : Bilan Carbone, ACV, FDES/PEP, EPD.

---

## Ce qu'est le Proposal Engine aujourd'hui

Un outil intégré au dashboard de pilotage (Node.js/Express + HTML vanilla) qui génère automatiquement une proposition commerciale PowerPoint personnalisée.

### Comment ça marche techniquement

- Le template est un fichier `.pptx` master (~50 slides) qui contient TOUTES les sections possibles
- À la génération, on supprime les slides non pertinentes et on garde uniquement les slides correspondant à la mission + subvention choisies
- On remplace des placeholders texte (`{{NOM_ENTREPRISE}}`, `{{TYPE_MISSION}}`, `{{PROGRAMME_SUBVENTION}}`, etc.) dans le XML du PPTX via manipulation ZIP
- On remplace le logo client sur le slide de couverture

### Inputs du formulaire aujourd'hui

- **Nom de l'entreprise** (saisie manuelle ou pré-rempli depuis un deal HubSpot)
- **Type de mission** : Bilan Carbone / ACV / FDES PEP / EPD
- **Subvention** : Rev3 50%, BPI 40%, BPI 70%, BPI 60%, Rev3 30%, Sans subvention
- **Logo client** (optionnel, PNG/JPG/SVG)
- **Deal HubSpot lié** (optionnel — recherche dans le pipeline commercial)

### Ce que génère le PPTX

Structure fixe selon la mission :
1. Introduction (9 slides — toujours les mêmes)
2. Section mission (slides spécifiques Bilan Carbone / ACV / FDES / EPD)
3. Calendrier (slide spécifique à la mission)
4. Proposition financière (slide selon mission + subvention)

### Variables remplacées dans le template

```
{{NOM_ENTREPRISE}}
{{TYPE_MISSION}}
{{INTITULE_MISSION}}
{{PROGRAMME_SUBVENTION}}
{{OPERATEUR_SUBVENTION}}
{{POURCENTAGE_SUBVENTION}}
{{MONTANT_SUBVENTION}}        ← actuellement vide, baked dans la slide
{{PRIX_APRES_SUBVENTION}}     ← actuellement vide, baked dans la slide
```

---

## Ce qui a été développé récemment (session du 17/04/2026)

### Feature : Lier un deal HubSpot au formulaire

- Nouvelle route `GET /api/proposal/deals` : retourne les deals open des 4 stages du pipeline kanban (RDV Qualif, RDV Propale, Négociation, Contrat envoyé) avec le nom de l'entreprise associée (batch API HubSpot)
- Autocomplete dans le formulaire : deals chargés en cache au chargement de la page, filtrage client-side par token (chaque mot du nom commence par la saisie)
- Au clic sur un deal : pré-remplit le nom d'entreprise, affiche un chip "deal lié" avec le nom et le stage
- Le `deal_id` est transmis au backend à la génération (prêt pour écriture retour dans Supabase)

### Stack technique

- Backend : Node.js/Express (CommonJS), `server.js` monolithe ~6600 lignes
- Frontend : HTML vanilla dans `public/pilot.html`
- Base de données : Supabase (table `deal_metadata` avec `deal_id`, `tags`, `proposal_sent_at`, `updated_at`)
- API HubSpot : PAT token, helpers `hubspotSearch()`, `hubspotRequest()`, `hubspotWrite()`
- Génération PPTX : manipulation ZIP directe avec `adm-zip` (Node.js)

---

## Ce qu'on veut faire ensuite : personnalisation par IA

### Problème actuel

Le contenu des slides est 100% statique. Deux propositions pour deux clients différents du même secteur ont exactement le même texte, seuls le nom et la subvention changent.

### Idée explorée

Ajouter de nouveaux placeholders dans le template PPTX (ex: `{{ACCROCHE_CLIENT}}`, `{{ENJEUX_CLIENT}}`, `{{ARGUMENTAIRE}}`), et avant de générer le PPTX, appeler Claude API pour générer ces textes de façon contextuelle.

### Inputs supplémentaires envisagés pour l'IA

- Secteur d'activité du client (industrie, agroalimentaire, BTP, tertiaire…)
- Taille de l'entreprise (PME, ETI, grand groupe)
- Enjeu principal (CSRD, communication RSE, appel d'offres, démarche volontaire…)
- Éventuellement : données issues du deal HubSpot (notes, propriétés custom)

### Contrainte principale

Le format PPTX est rigide : on peut injecter du texte dans des placeholders existants mais on ne peut pas créer de nouveaux slides ou changer le layout programmatiquement sans casser le design. Donc l'approche IA doit rester dans les placeholders texte du template.

### Question posée à Claude

> Sachant ce contexte, qu'est-ce qu'on peut faire de smart avec l'IA pour personnaliser les propositions commerciales ? Quels placeholders créer, quels prompts utiliser, comment structurer l'appel API Claude pour que le résultat soit vraiment utile et pas du remplissage générique ?
