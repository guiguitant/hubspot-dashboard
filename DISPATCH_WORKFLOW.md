# Releaf Prospector — Dispatch Workflow (Source unique de vérité)

Workflow autonome pour l'exécution des séquences LinkedIn (Tâche 2).
**La séquence est la source de vérité du workflow. Dispatch est l'exécuteur.**

## Principes fondamentaux

1. **Séquence obligatoire** : Dispatch n'exécute AUCUNE action LinkedIn (invitation, message) sur une campagne sans séquence active.
2. **Scrapping OK sans séquence** : La Tâche 1 (scrapping Sales Nav) continue normalement même sans séquence.
3. **Un seul message** : Le message vient du template de la séquence (avec placeholders). Plus de génération de 2 versions.
4. **Icebreaker** : Scrapé lors de la détection d'acceptation. Résolu dans le template via `{{icebreaker}}`.
5. **Validation Nathan** : Tout message doit être validé par Nathan avant envoi. Jamais d'envoi automatique.

## Account ID

```bash
export RELEAF_ACCOUNT_ID="[uuid]"
```

Inclure le header `Authorization: Bearer [token]` dans **TOUS** les appels API.

---

## URL de base

```
http://localhost:3000
```

---

## Statuts des prospects

| Statut | Description | Transition |
|--------|-------------|-----------|
| Profil à valider | Scrapé, en attente de validation Nathan | → Nouveau (si validé) |
| Nouveau | Validé, prêt pour invitation | → Invitation envoyée |
| Invitation envoyée | Invitation LinkedIn envoyée | → Invitation acceptée |
| Invitation acceptée | Prospect a accepté (statut caché) | → Message à valider |
| Message à valider | Message résolu, en attente validation Nathan | → Message à envoyer |
| Message à envoyer | Validé par Nathan, prêt à envoyer | → Message envoyé |
| Message envoyé | Message envoyé via LinkedIn | → Discussion en cours (si réponse) |
| Discussion en cours | Prospect a répondu — **séquence arrêtée automatiquement** | Manuel |
| Gagné | Deal signé — **séquence arrêtée automatiquement** | Fin |
| Perdu | Prospect perdu — **séquence arrêtée automatiquement** | Fin |
| Non pertinent | Hors cible — **séquence arrêtée automatiquement** | Fin |
| Profil restreint | LinkedIn restreint l'accès (auto seulement) | — |

---

## Workflow Dispatch (Tâche 2 — 4x/jour)

### Étape 0 — Acquérir le lock

```bash
POST /api/task-locks/acquire
{"lock_type": "linkedin_task2", "task_name": "task2"}
```

Si `acquired: false` → STOP.

### Étape 1 — Vérifier les quotas

```bash
GET /api/prospector/daily-stats
```

Si `remaining: 0` pour invitations ET messages → relâcher lock et arrêter.

### Étape 2 — Traiter chaque campagne active

```bash
GET /api/prospector/campaigns?active=true
```

Pour chaque campagne, dans l'ordre de priorité :

**A) Vérifier qu'une séquence active existe :**
```bash
GET /api/sequences?campaign_id={campaign_id}
```
Si `null` → **SKIP cette campagne**. Aucune action LinkedIn.

**B) Enrôler les nouveaux prospects :**
```bash
GET /api/prospector/prospects?campaign_id={id}&status=Nouveau
```
Pour chaque prospect :
```bash
POST /api/sequences/enroll
{"prospect_id": "...", "campaign_id": "..."}
```

**C) Récupérer les actions dues :**
```bash
GET /api/sequences/due-actions
```

### Étape 3a — send_invitation

**Conditions :**
- `step.type === "send_invitation"`
- `quotas.invitations.remaining > 0`

**Actions :**
1. Naviguer vers `linkedin.com/in/{slug}/`
2. Cliquer "Se connecter" / "Connect"
3. Si `step.has_note === true` → ajouter `step.note_content` comme note d'invitation
4. Soumettre

**Mise à jour :**
```bash
POST /api/prospector/update-status
{"prospect_id": "...", "status": "Invitation envoyée"}

POST /api/sequences/complete-step
{"state_id": "...", "completed_step_order": 1}
```

### Étape 3b — Détecter les invitations acceptées + scraper l'icebreaker

**Actions :**
1. Naviguer vers `linkedin.com/mynetwork/invite-connect/connections/`
2. Récupérer la liste des connexions récentes
3. Croiser avec prospects en statut "Invitation envoyée"

Pour chaque match :
1. **Mettre à jour le statut** → "Invitation acceptée"
2. **Scraper l'icebreaker** : naviguer vers `linkedin.com/in/{slug}/recent-activity/shares/`
   - Récupérer 3-5 posts récents (texte + date)
   - Appeler Claude API pour évaluer la pertinence :
     ```
     "Ces posts ont-ils un lien avec le développement durable ?
     Thèmes : bilan carbone, ACV, CSRD, RSE, loi climat, résilience, environnement.
     Si pertinent → phrase d'accroche 10-15 mots, minuscule, sans 'j'ai vu que'.
     Si non → NOT_RELEVANT"
     ```
   - Sauvegarder :
     ```bash
     POST /api/prospects/{id}/linkedin-activity
     {"raw_posts": [...], "icebreaker_generated": "...", "icebreaker_mode": "personalized|generic", "is_relevant": true|false}
     ```

3. **Résoudre le message séquence** : le template de l'étape `send_message` est résolu avec les placeholders (y compris `{{icebreaker}}`)
4. **Soumettre à validation** :
   ```bash
   POST /api/prospector/update-status
   {"prospect_id": "...", "status": "Message à valider", "pending_message": "[message_résolu]"}
   ```

**NE PAS appeler complete-step ici.** On attend la validation de Nathan.

### Étape 4 — Envoyer les messages validés

Filtrer `pending_messages` avec `status === "Message à envoyer"`.

Pour chaque message :
1. Naviguer vers `linkedin.com/messaging/`
2. Chercher la conversation avec le prospect
3. Coller `prospect.pending_message`
4. Soumettre

```bash
POST /api/prospector/message-sent
{"prospect_id": "...", "campaign_id": "..."}

POST /api/sequences/complete-step
{"state_id": "...", "completed_step_order": 2}
```

### Étape 5 — Détecter les réponses

Naviguer vers `linkedin.com/messaging/`

Pour chaque nouveau message d'un prospect en "Message envoyé" :
```bash
POST /api/prospector/update-status
{"prospect_id": "...", "status": "Discussion en cours", "interaction": {"type": "Réponse reçue", "content": "[contenu]"}}
```

Le trigger PostgreSQL arrête automatiquement la séquence.

### Étape 6 — Session expirée

Si URL `linkedin.com/login` ou `checkpoint` détectée :
- Notification Windows (ballon)
- Pauser toutes les séquences actives :
```bash
POST /api/sequences/stop
{"prospect_id": "...", "reason": "error"}
```

### Étape 7 — Relâcher le lock + résumé

```bash
POST /api/task-locks/release
{"lock_type": "linkedin_task2"}
```

Résumé : invitations envoyées/acceptées, messages soumis/envoyés, réponses, quotas restants.

---

## Cache icebreaker

- Durée : **120h (5 jours calendaires ≈ 3 jours ouvrés)**
- Si cache frais → utiliser directement
- Si cache expiré ou absent → `needs_scraping: true` → Dispatch scrape au prochain passage
- Regénération manuelle : Nathan clique "Regénérer l'icebreaker" → Claude re-génère à partir des posts en cache

---

## Follow-ups (Messages 2, 3...)

Si la séquence a plusieurs étapes `send_message` :
- Après envoi du Message 1 + `complete-step`, le `next_action_at` est calculé avec le délai de l'étape suivante (+ jitter ±17%)
- Au prochain passage Dispatch, si `next_action_at` est passé et pas de réponse → résoudre le template Message 2 → "Message à valider"
- Même flow : validation Nathan → envoi → complete-step

---

## Enrôlement en masse d'une campagne existante

Pour les campagnes avec des prospects à différents stades :
```bash
POST /api/sequences/enroll-campaign
{"campaign_id": "..."}
```

Mapping automatique :
| Statut | Étape de départ |
|--------|----------------|
| Nouveau | Étape 1 (invitation) |
| Invitation envoyée | Étape message (en attente acceptation) |
| Invitation acceptée / Message à valider / Message à envoyer | Étape message |
| Message envoyé | Étape après message 1 (follow-up) |
| Profil à valider, Discussion en cours, Gagné, Perdu, Non pertinent | EXCLU |

---

## Endpoints récapitulatifs

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/task-locks/acquire` | Acquérir un lock |
| POST | `/api/task-locks/release` | Relâcher un lock |
| GET | `/api/prospector/daily-stats` | Vérifier les quotas |
| GET | `/api/prospector/campaigns?active=true` | Campagnes actives |
| GET | `/api/prospector/prospects?status=...` | Lister les prospects |
| GET | `/api/sequences?campaign_id=...` | Séquence active d'une campagne |
| POST | `/api/sequences/enroll` | Enrôler un prospect |
| POST | `/api/sequences/enroll-campaign` | Enrôler toute une campagne |
| GET | `/api/sequences/due-actions` | Actions prêtes à exécuter |
| POST | `/api/sequences/complete-step` | Avancer l'étape |
| POST | `/api/sequences/stop` | Arrêter une séquence |
| POST | `/api/prospects/:id/linkedin-activity` | Sauvegarder activité + icebreaker |
| GET | `/api/prospects/:id/linkedin-activity` | Récupérer activité (cache 120h) |
| POST | `/api/prospector/update-status` | Mettre à jour statut |
| POST | `/api/prospector/message-sent` | Marquer message comme envoyé |
| POST | `/api/prospector/regenerate-icebreaker` | Regénérer l'icebreaker via Claude |

---

**Version :** Sprint 2 — Unification Séquences + Dispatch
**Mise à jour :** 2026-04-01
