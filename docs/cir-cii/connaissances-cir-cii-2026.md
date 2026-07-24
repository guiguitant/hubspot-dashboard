# CIR / CII · document de référence (règles à jour 2025-2026)

**Auteur :** agent de recherche (Claude), pour Releaf Carbon
**Date :** 24/07/2026
**Objet :** base de connaissances sourcée sur le Crédit d'Impôt Recherche (CIR) et le Crédit d'Impôt Innovation (CII), puis réponses aux 6 questions du fichier `docs/questions-comptables/2026-07-24-imputation-cii-cir-immobilisations.md`, et tableau des tests de l'outil « Pilot ».

> Convention de fiabilité utilisée dans tout le document : **[élevé]** = confirmé par texte officiel (Légifrance / BOFiP), **[moyen]** = confirmé par sources spécialisées concordantes, **[à confirmer]** = à valider avec l'expert-comptable (Actemis).

> ⚠️ **Point de vigilance méthodologique.** Un résumé automatisé de l'actualité BOFiP `ACTU-2025-00105` a prétendu, à tort, que la loi de finances 2025 avait **supprimé les dotations aux amortissements** de l'assiette du CIR. Après recoupement (doctrine BOFiP `BOI-BIC-RICI-10-10-20-10` **mise à jour le 13/08/2025**, qui les traite toujours comme éligibles ; service-public ; cabinets spécialisés Auvalie, Myriad), cette affirmation est **fausse** : les dotations aux amortissements **restent dans l'assiette** du CIR, et le forfait de 75 % sur ces dotations est **maintenu**. Ce qui a réellement changé en 2025 est détaillé au § 2.

---

## 1. CIR vs CII : définitions et périmètre

| | **CIR** (art. 244 quater B du CGI) | **CII** (art. 244 quater B bis du CGI) |
|---|---|---|
| Activité visée | **Recherche** : recherche fondamentale, recherche appliquée, développement expérimental | **Innovation** : conception de **prototypes** ou **installations pilotes** de **produits nouveaux** |
| Notion clé | Lever une incertitude scientifique ou technique (état de l'art) | Produit qui se distingue sur le marché par ses performances, l'écoconception, l'ergonomie ou ses fonctionnalités (au-delà de la R&D stricte) |
| Bénéficiaires | Toutes entreprises soumises à l'IS/IR (BIC) | **PME au sens communautaire uniquement** (< 250 salariés, CA ≤ 50 M€ ou bilan ≤ 43 M€) |
| Rattachement | Le CII est une extension du CIR pour les PME, sur la phase située **en aval de la R&D** (mise au point du produit avant lancement industriel/commercialisation) | |

**Frontière importante :** une opération relève soit du CIR (incertitude scientifique) soit du CII (nouveauté produit sans verrou scientifique), jamais des deux pour la même dépense. Le CII couvre les travaux **postérieurs** à la R&D et **antérieurs** au démarrage de la production.

Sources : Légifrance, art. 244 quater B et 244 quater B bis du CGI ; BOFiP `BOI-BIC-RICI-10-10-45` (CII) ; economie.gouv.fr, « Crédit d'impôt recherche ». Consultés le 24/07/2026. **[élevé]**

---

## 2. Taux en vigueur 2025-2026 et plafonds

### CIR
- **Taux : 30 %** de l'assiette jusqu'à **100 M€** de dépenses éligibles ; **5 %** pour la fraction au-delà de 100 M€.
- **DOM : 50 %.**
- **Pas de plafond global** de crédit (le plafond de 100 M€ ne fait que changer de taux, il ne bloque pas le crédit).
- Sources : art. 244 quater B, III du CGI ; economie.gouv.fr ; service-public.gouv.fr `F23533`. **[élevé]**

### CII
- **Taux : 20 %** en métropole **depuis le 1er janvier 2025** (auparavant 30 %, dont un relèvement temporaire à 30 % en 2023-2024). Baisse actée par la **loi de finances 2025, art. 56**.
- **DOM : 60 %.** Corse : 35 % / 40 % selon la taille.
- **Plafond de dépenses : 400 000 € par an et par entreprise** ⇒ **crédit maximal 80 000 €/an** en métropole (400 000 × 20 %).
- **Dispositif prorogé jusqu'au 31/12/2027.**
- Sources : art. 244 quater B bis du CGI ; BOFiP `ACTU-2025-00105` ; Leyton, « Guide CII 2026 » ; LégiFiscal, « PLF 2025, CII prorogé au taux de 20 % ». Consultés le 24/07/2026. **[élevé]**

### Ce que la loi de finances 2025 (n° 2025-127 du 14/02/2025) a réellement changé pour le CIR
Applicable aux **dépenses exposées à compter du 15 février 2025** (art. 55) :
1. **Forfait de frais de fonctionnement sur les dépenses de personnel : 43 % → 40 %.** Le forfait de **75 %** sur les dotations aux amortissements est **inchangé**.
2. **Suppression** de l'éligibilité : frais de **brevets** (dépôt, maintenance, défense) et certificats d'obtention végétale ; **veille technologique** ; dispositif **« jeune docteur »** (le doublement des dépenses de personnel pour l'embauche de docteurs est supprimé).
3. Précision sur les **subventions** publiques déductibles (art. 58).

Sources : BOFiP `ACTU-2025-00105` ; Myriad Consulting, « CIR 2025 : baisse du taux des frais de fonctionnement » ; LégiFiscal. **[élevé]** pour la baisse 43→40 et les suppressions ; **[élevé]** pour le maintien des amortissements et du forfait 75 % (voir point de vigilance en tête de document).

---

## 3. Assiette des dépenses éligibles

### CIR
| Poste | Règle | Fiabilité |
|---|---|---|
| **Dépenses de personnel** | Chercheurs et techniciens de recherche directement et exclusivement affectés. Retenues **l'année où elles sont exposées**. | [élevé] |
| **Forfait de frais de fonctionnement** | **40 % des dépenses de personnel** + **75 % des dotations aux amortissements** éligibles. Ajouté automatiquement à l'assiette. | [élevé] |
| **Dotations aux amortissements** | Des immobilisations **créées ou acquises à l'état neuf** et affectées directement et exclusivement à la recherche. Entrent par la **dotation annuelle** (voir § 4). Usage mixte : au prorata du temps d'utilisation en recherche. | [élevé] |
| **Sous-traitance** | Éligible **seulement si le prestataire est agréé** (organismes privés) ou est un organisme public/assimilé. Plafonnement (voir ci-dessous). | [élevé] |

**Sous-traitance CIR, règles de plafonnement :**
- Les dépenses de sous-traitance sont retenues **dans la limite globale de 3 fois** le montant des **autres dépenses éligibles** (dépenses internes). **[élevé]**
- Plafond annuel global des dépenses sous-traitées : **2 M€** (porté à 10 M€ dans certains cas). **[moyen, à confirmer]**
- **Entités liées / non liées :** depuis 2020, la distinction « doublement pour la recherche publique » a été supprimée ; les dépenses confiées à des organismes publics ne sont plus retenues pour le double de leur montant. Pour les prestataires **liés** à l'entreprise, le montant retenu est celui **réellement facturé** (pas de majoration). **[moyen]**

### CII
- **Depuis le 1er janvier 2023, le forfait de frais de fonctionnement est SUPPRIMÉ pour le CII.** L'assiette est donc composée des **dépenses réelles**, sans forfait.
- Postes : **dotations aux amortissements** des immobilisations créées/acquises neuves affectées à la conception ; **dépenses de personnel** ; **sous-traitance agréée** ; **frais de brevets / dessins et modèles** liés au prototype.
- Sources : art. 244 quater B bis ; BOFiP `BOI-BIC-RICI-10-10-45` ; Leyton, « Guide CII 2026 » ; CCI Paris IDF. **[élevé]** pour la suppression du forfait ; **[élevé]** pour la composition de l'assiette.

---

## 4. LE POINT CLÉ · traitement des immobilisations (assiette A vs B)

### Principe directeur (indépendance de l'éligibilité et de la comptabilisation)
> « Le crédit d'impôt recherche n'est conditionné que par la **nature** et la **réalité** des dépenses, **indépendamment de leur mode de comptabilisation** » (RM Feltesse n° 12558, JO AN 19/03/2013 ; reprise BOFiP `ACTU-2014-00101`). **[élevé]**

L'assiette dépend donc de **la nature de la dépense**, pas du fait qu'elle soit passée en charge ou immobilisée. Deux situations à distinguer :

### Cas (i) · Actif amortissable ACQUIS à l'état neuf, utilisé POUR la R&D (ex. « Outil SimaPro »)
- L'assiette est la **DOTATION AUX AMORTISSEMENTS annuelle** de l'actif, **étalée sur la durée d'amortissement** ⇒ **méthode B**.
- Ce n'est **pas** le coût d'acquisition pris en une fois l'année d'achat.
- Pour le CIR, s'ajoute le **forfait de 75 %** de cette dotation.
- Fondement : art. 244 quater B, II-a ; BOFiP `BOI-BIC-RICI-10-10-20-10` (mise à jour 13/08/2025) : « Seules les dotations aux amortissements correspondant à des biens créés ou acquis à l'état neuf affectés directement et exclusivement à des opérations de recherche sont à retenir. »
- **Conclusion : méthode B (dotations étalées).** **[élevé]**

### Cas (ii) · Frais de développement d'un logiciel CRÉÉ EN INTERNE, immobilisés (le livrable R&D lui-même, ex. « SaaS »)
- Les dépenses sous-jacentes (**personnel R&D, sous-traitance**) entrent dans l'assiette **dans leur poste propre, l'année où elles sont exposées** ⇒ **méthode A**.
- Le fait qu'elles soient capitalisées en immobilisation incorporelle (frais de développement) **ne change pas** l'année d'entrée dans l'assiette.
- **Règle anti double-comptage :** ces frais immobilisés **ne doivent PAS** être comptés une seconde fois via les dotations aux amortissements de l'immobilisation incorporelle qui en résulte.
  > « Les dépenses ainsi incluses dans l'assiette du crédit d'impôt ne doivent pas être prises en compte une seconde fois par le biais des amortissements » (RM Feltesse, 19/03/2013).
  > Les frais de développement inscrits à l'actif « ne doivent pas être pris en compte dans le poste des dotations aux amortissements, mais bien dans le poste de dépenses qui leur sont propres (dépenses externalisées, dépenses de personnel, etc.) » (F.initiatives ; Ayming ; Businove).
- **Conclusion : méthode A (dépenses l'année d'engagement), pas d'amortissement en plus.** **[élevé]**

### Synthèse
| Type d'immobilisation | Assiette | Année d'imputation |
|---|---|---|
| (i) Outil/matériel/logiciel **acquis** neuf, servant à la R&D | **Dotations aux amortissements** (+ forfait 75 % pour le CIR) | **B · étalée** sur la durée d'amortissement |
| (ii) **Frais de développement** d'un livrable créé en interne (personnel, sous-traitance capitalisés) | **Dépenses réelles dans leur poste** (personnel, sous-traitance) | **A · année d'engagement** ; amortissements ultérieurs **exclus** (anti double-comptage) |

Sources : art. 244 quater B II-a ; BOFiP `BOI-BIC-RICI-10-10-20-10` (13/08/2025) ; RM Feltesse 19/03/2013 / `ACTU-2014-00101` ; F.initiatives, Ayming, Businove. **[élevé]**

---

## 5. Aides publiques et subventions

- **Toute subvention publique** (définitivement acquise **ou** remboursable) affectée à des opérations éligibles est **déduite de l'assiette** du CIR/CII. Seule la quote-part relative aux opérations éligibles est déduite (au prorata si le projet est mixte).
- **Année de déduction :** au titre de **l'année (ou des années) où sont exposées les dépenses éligibles** que la subvention finance, **pas** nécessairement l'année de l'encaissement. Exemple BOFiP : subvention versée en N mais dépenses engagées à partir de N+1 ⇒ déduction à partir de N+1.
- **Avances remboursables :** traitées comme une subvention et **déduites** tant qu'elles ne sont pas remboursées ; **réintégrées à l'assiette au fur et à mesure des remboursements** (l'année de chaque remboursement).
- Sources : BOFiP `BOI-BIC-RICI-10-10-30-20` ; LF 2025 art. 58 ; Myriad Consulting ; Sogedev. **[élevé]**

---

## 6. Imputation sur l'IS, restitution PME, comptabilisation

- Le CIR/CII est **acquis au titre de l'exercice de réalisation des dépenses** (année civile) et **s'impute sur l'IS dû au titre de ce même exercice** (art. 199 ter B pour le CIR).
- **Excédent non imputé = créance sur l'État**, imputable sur l'IS des **3 exercices suivants** ; le solde est remboursé au terme des 3 ans.
- **PME au sens communautaire : restitution immédiate** de l'excédent (faculté, pas obligation ; confirmé par le Conseil d'État). Demande possible à partir du **15 mai N+1**.
- **Comptabilisation :** le crédit constitue un **produit** (diminution de la charge d'IS, voire produit net si l'IS est nul) et une **créance sur l'État** (compte 444). Millésime = exercice des dépenses.
- Sources : art. 199 ter B du CGI ; impots.gouv.fr, « Restitution de crédit d'impôt » ; BOFiP `BOI-BIC-RICI-10-10-50` ; Deloitte Société d'Avocats ; SOREC. **[élevé]**

---

## 7. Réponses directes aux 6 questions (fichier `questions-comptables`)

### Q1 · Assiette (A ou B) ? Dépend-elle de la nature ?
**Réponse : OUI, la réponse dépend de la nature de l'immobilisation.**
- **Immo 1 « SaaS » (logiciel développé en interne, livrable R&D, CII) : méthode A.** Les salaires et prestations sont pris **l'année où ils sont exposés**, dans leur poste propre, même s'ils sont capitalisés. Les dotations aux amortissements du logiciel créé **ne doivent pas** venir en plus (anti double-comptage). ⇒ **l'outil est correct** sur cette immo.
- **Immo 2 « Outil SimaPro » (outil acquis servant à la R&D, CIR) : méthode B.** L'assiette est la **dotation aux amortissements annuelle** (+ forfait 75 %), étalée sur la durée d'amortissement, **pas** le coût d'acquisition en une fois en 2026. ⇒ **l'outil est FAUX** sur cette immo (il applique A au lieu de B).
- **Confiance : [élevé].** Sources : art. 244 quater B II-a ; BOFiP `BOI-BIC-RICI-10-10-20-10` (13/08/2025) ; RM Feltesse 19/03/2013.

### Q2 · Dépenses de personnel capitalisées : année d'exposition ou via amortissements ? Anti double-comptage ?
**Réponse :** les salaires R&D immobilisés (frais de développement) entrent dans l'assiette **l'année où ils sont exposés** (méthode A), dans le poste « dépenses de personnel ». Il existe bien une **règle anti double-comptage** : on ne compte **pas** en plus les dotations aux amortissements de l'immobilisation incorporelle qui en résulte.
- **Confiance : [élevé].** Sources : RM Feltesse 19/03/2013 / `ACTU-2014-00101` ; F.initiatives ; Ayming.

### Q3 · Année d'acquisition du crédit et imputation ; exercice de la créance ?
**Réponse :** le crédit est **acquis au titre de l'exercice de la dépense** (pour l'immo acquise : au titre de l'exercice de la **dotation**) et s'impute sur l'**IS du même exercice** ; l'excédent est **restitué immédiatement** pour une PME. La **créance** est comptabilisée sur **l'exercice au titre duquel le crédit est calculé** (millésime des dépenses/dotations).
- **Confiance : [élevé].** Sources : art. 199 ter B ; impots.gouv.fr ; BOFiP `BOI-BIC-RICI-10-10-50`.

### Q4 · Taux et forfaits
**Réponse :**
- **CII 20 %** en métropole depuis le 01/01/2025 : **correct**. Forfait de fonctionnement **supprimé depuis le 01/01/2023** : **correct**. Ne pas oublier le **plafond de 400 000 €/an** de dépenses.
- **CIR 30 %** (jusqu'à 100 M€) : **correct**. **Mais le forfait de frais de fonctionnement du CIR n'est PAS 40 % « des dépenses de personnel » tout court** : il est de **40 % des dépenses de personnel + 75 % des dotations aux amortissements**, et il **s'ajoute** à l'assiette. Depuis la LF 2025, le taux sur le personnel est passé de **43 % à 40 %** (dépenses depuis le 15/02/2025).
- **Confiance : [élevé].** Sources : art. 244 quater B et B bis ; BOFiP `ACTU-2025-00105` ; Myriad ; Leyton.

### Q5 · Aides publiques (France 2030)
**Réponse :** déduire les aides de l'assiette est **correct**. En revanche, la règle stricte est de déduire l'aide **au rythme des dépenses éligibles qu'elle finance** (année d'exposition des dépenses), **pas** par un lissage calendaire uniforme sur la durée du projet : le **lissage prorata temporis de l'outil est une approximation** acceptable si les dépenses sont réparties régulièrement, mais peut diverger si les dépenses sont concentrées. La **déduction puis réintégration de l'avance récupérable au moment de chaque remboursement** est **correcte**.
- **Confiance : [élevé]** sur le principe et l'avance ; **[moyen]** sur l'acceptabilité du lissage (à confirmer avec Actemis selon le profil réel des dépenses).
- Sources : BOFiP `BOI-BIC-RICI-10-10-30-20` ; Myriad ; Sogedev.

### Q6 · Sous-traitance : agrément requis ? Plafonds ?
**Réponse :** **oui, l'agrément du prestataire est requis** (pour les organismes privés) pour que la prestation soit éligible ; les organismes publics et assimilés sont éligibles de plein droit. **Plafonds** : dépenses sous-traitées retenues dans la limite de **3× les autres dépenses éligibles**, et plafond annuel global (2 M€, porté à 10 M€ dans certains cas).
- **Confiance : [élevé]** sur l'agrément ; **[moyen / à confirmer]** sur les montants exacts des plafonds (à valider avec Actemis).
- Sources : art. 244 quater B II-d ; BOFiP `BOI-BIC-RICI-10-10-20-30` ; service-public.gouv.fr `F23533`.

---

## 8. Sources principales (consultées le 24/07/2026)

- **Légifrance** · art. 244 quater B (CIR) et 244 quater B bis (CII) du CGI ; art. 199 ter B ; loi n° 2025-127 du 14/02/2025 de finances pour 2025 (art. 55 à 58).
- **BOFiP** · `ACTU-2025-00105` (aménagements LF 2025) ; `BOI-BIC-RICI-10-10-20-10` (dotations aux amortissements, maj 13/08/2025) ; `BOI-BIC-RICI-10-10-30-20` (subventions/avances) ; `BOI-BIC-RICI-10-10-45` (CII) ; `BOI-BIC-RICI-10-10-50` (utilisation du crédit) ; `ACTU-2014-00101` (RM Feltesse, anti double-comptage).
- **Officiel** · economie.gouv.fr « Crédit d'impôt recherche » ; service-public.gouv.fr `F23533` ; impots.gouv.fr « Restitution de crédit d'impôt ».
- **Cabinets spécialisés** · Leyton (Guide CII 2026) ; Myriad Consulting (CIR 2025, subventions) ; F.initiatives, Ayming, Businove (immobilisation R&D, double comptage) ; Sogedev (avances remboursables) ; Deloitte, SOREC (restitution PME).
- **Exemples chiffrés** (phase 2) · Malibou, Birdinnov (CIR) ; Leyton (CII) ; Eurecia (seuil 100 M€).

---

## 9. Phase 2 · tests de l'outil « Pilot » face à des exemples chiffrés en ligne

Méthode : création d'immobilisations de test (libellé `TEST-AGENT-…`) via l'API, ajout des postes, lecture de `creditCir` / `creditCii` renvoyés par `GET /api/immobilisations`, comparaison au crédit attendu de l'exemple. **Toutes les immos de test ont été supprimées après coup** (vérifié : plus aucune `TEST-AGENT-` en base).

| # | Exemple (source) | Détail assiette | Crédit attendu | Crédit outil | Écart | Cause de l'écart |
|---|---|---|---:|---:|---:|---|
| T1 | **CII simple** · Leyton, Guide CII 2026 | 300 000 € × 20 % | **60 000 €** | 60 000 € | 0 | — (taux CII 20 % correct) |
| T2 | **CIR simple** · Malibou | 300 000 € × 30 % | **90 000 €** | 90 000 € | 0 | — (taux CIR 30 % correct) |
| T3 | **CIR détaillé** · Birdinnov | Salaires 150 000 + **forfait 40 % (60 000)** + ST agréée 40 000 + amort. 20 000 + **forfait 75 % (15 000)** = 285 000 × 30 % | **85 500 €** | 63 000 € | **−22 500 €** | **L'outil n'applique PAS le forfait de fonctionnement CIR** (40 % du personnel + 75 % des amortissements). 22 500 = 75 000 × 30 %. |
| T4 | **Agrément sous-traitance** (règle art. 244 quater B) | ST agréée 50 000 (éligible) + ST non agréée 30 000 (exclue), × 30 % | **15 000 €** | 15 000 € | 0 | — (l'outil exclut correctement la prestation non agréée) |
| T5 | **Subvention déduite** | (Salaires 300 000 − subvention 100 000) × 30 % | **60 000 €** | 60 000 € | 0 | — (déduction de la subvention au niveau du poste : correct) |

### Lecture des résultats
- **Ce qui est CORRECT dans l'outil :** taux CII 20 % et CIR 30 % ; assiette = somme des postes moins subventions ; exclusion de la sous-traitance non agréée ; déduction des subventions.
- **Divergence n° 1 (T3) · forfait de fonctionnement CIR absent.** L'outil prend les postes à leur valeur brute et n'ajoute jamais le forfait **40 % du personnel + 75 % des amortissements**. Pour toute assiette CIR reposant sur du personnel ou des amortissements, l'outil **sous-estime** le crédit. (Pour le CII, l'absence de forfait est au contraire **correcte** : il est supprimé depuis 2023.)
- **Divergence n° 2 (non testable en une année, confirmée par lecture du code `computeBasesParAnnee`) · année d'imputation A vs B.** L'outil rattache chaque poste à son **année d'engagement** (méthode A) pour toutes les immos. C'est **correct pour un livrable créé en interne** (frais de développement : personnel/prestations l'année d'exposition), mais **faux pour un actif amortissable acquis** (ex. SimaPro), dont l'assiette CIR devrait être la **dotation aux amortissements annuelle** (méthode B), étalée sur la durée d'amortissement.
- **Limites de modèle (hors périmètre PME Releaf mais à noter) :** l'outil applique un taux plat sans **tranche à 5 % au-delà de 100 M€** (CIR) ni **plafond de 400 000 €/an** (CII) ; au-delà de ces seuils il **surestimerait** le crédit.

### Verdict et corrections à envisager dans `computeBasesParAnnee` (à NE PAS appliquer sans validation Actemis)
1. **PRIORITÉ 1 · année d'imputation (A vs B).** Introduire un attribut sur l'immobilisation (ou le poste) distinguant :
   - « livrable créé en interne » ⇒ garder la **méthode A** (poste à l'année d'engagement) ;
   - « actif acquis amortissable affecté à la R&D » ⇒ **méthode B** : convertir le coût en **dotations annuelles** (réutiliser `computeDotationForYear`) et alimenter la base CIR de l'année de chaque dotation, en veillant à ne pas aussi compter le coût en année d'engagement (anti double-comptage).
2. **PRIORITÉ 2 · forfait de fonctionnement CIR.** Ajouter, pour les postes `credit_type='cir'` uniquement : **+40 %** sur les postes `source='salaire'` et **+75 %** sur les postes d'amortissement. **Ne rien ajouter pour le CII.**
3. **Secondaire · plafonds :** borner le CII à 400 000 €/an de dépenses ; appliquer la tranche 5 % au-delà de 100 M€ pour le CIR (peu prioritaire à l'échelle de Releaf).
4. **Aides :** remplacer, à terme, le lissage calendaire uniforme par une déduction **au rythme des dépenses éligibles** ; la réintégration de l'avance au remboursement est déjà correcte.

_Sources des exemples : Leyton (Guide CII 2026) ; Malibou (« Qu'est-ce que le CIR ») ; Birdinnov (« Calcul du CIR étape par étape »). Consultées le 24/07/2026._

