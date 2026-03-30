# Releaf Prospector Skill

Workflow autonome pour l'exécution des séquences LinkedIn (Task 2).

## Account ID

Le compte utilisateur actif doit être passé en paramètre ou via variable d'environnement :
```bash
export RELEAF_ACCOUNT_ID="[uuid]"
```

Inclure le header `X-Account-Id: $RELEAF_ACCOUNT_ID` dans **TOUS** les appels API.

---

## URL de base

```
http://localhost:3000
```

---

## Workflow autonome (Sprint 2)

### Étape 0 — Vérifier les locks

Avant de commencer, acquérir un lock pour éviter l'exécution concurrente :

```bash
curl -X POST http://localhost:3000/api/task-locks/acquire \
  -H "Content-Type: application/json" \
  -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
  -d '{"lock_type": "linkedin_task2", "task_name": "task2"}'
```

**Réponse si succès :**
```json
{"acquired": true, "lock_id": "...", "expires_at": "..."}
```

**Réponse si lock existant :**
```json
{"acquired": false, "locked_by": "worker_12345", "acquired_at": "..."}
```

Si `acquired = false` → STOP et log "Compte verrouillé par [locked_by]"

---

### Étape 1 — Vérifier les quotas

```bash
curl -X GET http://localhost:3000/api/prospector/daily-stats \
  -H "X-Account-Id: $RELEAF_ACCOUNT_ID"
```

Réponse :
```json
{
  "invitations": {"sent": 5, "remaining": 15},
  "messages": {"sent": 2, "remaining": 8}
}
```

Si `remaining: 0` pour invitations ET messages → **arrêter proprement** et relâcher le lock.

---

### Étape 2 — Enrôler les nouveaux prospects

Récupérer les prospects en statut "Nouveau" et les enrôler dans leur séquence de campagne :

```bash
curl -X GET "http://localhost:3000/api/prospector/prospects?status=Nouveau" \
  -H "X-Account-Id: $RELEAF_ACCOUNT_ID"
```

Pour chaque prospect reçu :

```bash
curl -X POST http://localhost:3000/api/sequences/enroll \
  -H "Content-Type: application/json" \
  -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
  -d '{"prospect_id": "...", "campaign_id": "..."}'
```

Réponse :
- Si `enrolled: true` → prospect enrôlé, première étape prête à exécuter
- Si `enrolled: false` (reason: "no_active_sequence") → gérer manuellement (laisser en "Nouveau" pour maintenant)

---

### Étape 3 — Récupérer les actions dues

```bash
curl -X GET http://localhost:3000/api/sequences/due-actions \
  -H "X-Account-Id: $RELEAF_ACCOUNT_ID"
```

Réponse :
```json
{
  "sequence_actions": [
    {
      "id": "state_id_1",
      "prospect_id": "...",
      "current_step_order": 1,
      "step": {
        "type": "send_invitation",
        "delay_days": 0,
        "has_note": false,
        "note_content": null,
        ...
      },
      "prospect": {"first_name": "...", "last_name": "...", ...},
      "prospect_account": {"status": "Nouveau", "campaign_id": "..."}
    }
  ],
  "pending_messages": [...]
}
```

Pour chaque action due, exécuter l'étape appropriée (voir ci-dessous).

---

### Étape 3a — send_invitation

**Conditions :**
- `step.type === "send_invitation"`
- `invitations.remaining > 0`

**Actions :**

1. **Accès au profil LinkedIn du prospect :**
   - Naviguer vers `https://www.linkedin.com/in/{prospect.linkedin_url_slug}/`
   - Via Chrome automation (Puppeteer/Playwright)

2. **Envoyer l'invitation :**
   - Cliquer le bouton "Ajouter à mon réseau" / "Connect"
   - Si `step.has_note === true` :
     - Ajouter une note personnalisée : `step.note_content`
     - (Les placeholders ont déjà été résolus côté API)
   - Soumettre

3. **Mettre à jour le prospect :**
   ```bash
   curl -X POST http://localhost:3000/api/prospector/update-status \
     -H "Content-Type: application/json" \
     -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
     -d '{"prospect_id": "...", "status": "Invitation envoyée"}'
   ```

4. **Avancer l'étape :**
   ```bash
   curl -X POST http://localhost:3000/api/sequences/complete-step \
     -H "Content-Type: application/json" \
     -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
     -d '{"state_id": "...", "completed_step_order": 1}'
   ```

**Gestion erreurs :**
- Si URL `linkedin.com/login` ou `checkpoint` détecté → session expirée → **Étape 6**

---

### Étape 3b — send_message (sans note, préparation)

**Conditions :**
- `step.type === "send_message"`
- `prospect_account.status !== "Message à envoyer"` (on ne renvoie pas ce qui a déjà été validé)
- Prospect doit avoir accepté l'invitation : `prospect_account.status` ∈ ["Invitation acceptée", "Message à valider", "Message envoyé"]

**Actions :**

1. **Résoudre les placeholders :**
   - Remplacer `{{prospect_first_name}}` → `prospect.first_name`
   - Remplacer `{{prospect_last_name}}` → `prospect.last_name`
   - Remplacer `{{prospect_company}}` → `prospect.company`
   - Remplacer `{{prospect_job_title}}` → `prospect.job_title`
   - Remplacer `{{campaign_name}}` → campaign.name
   - etc.

2. **Si `{{icebreaker}}` présent dans le message :**

   a) Récupérer l'activité LinkedIn en cache :
   ```bash
   curl -X GET http://localhost:3000/api/prospects/{prospect_id}/linkedin-activity \
     -H "X-Account-Id: $RELEAF_ACCOUNT_ID"
   ```

   b) Si réponse contient `needs_scraping: true` :
      - Scraper `https://www.linkedin.com/in/{slug}/recent-activity/shares/`
      - Récupérer les 3-5 derniers posts (texte + date)
      - Évaluer pertinence via Claude :
        ```
        Prompt : "Ces posts ont-ils un lien avec le développement durable et la transition écologique ?
        Thèmes pertinents : bilan carbone, ACV, CSRD, RSE, loi climat, résilience, environnement.
        Réponds NOT_RELEVANT si aucun lien, sinon génère une phrase d'accroche de 10-15 mots basée sur
        le post le plus pertinent, commençant par une minuscule, sans 'j'ai vu que'."
        ```
      - Si `NOT_RELEVANT` ou aucun post < 30 jours → utiliser icebreaker générique (selon campagne)
      - Sauvegarder :
        ```bash
        curl -X POST http://localhost:3000/api/prospects/{prospect_id}/linkedin-activity \
          -H "Content-Type: application/json" \
          -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
          -d '{
            "raw_posts": [...],
            "icebreaker_generated": "...",
            "icebreaker_mode": "personalized|generic",
            "is_relevant": true|false
          }'
        ```

   c) Remplacer `{{icebreaker}}` par l'icebreaker généré

3. **Soumettre à validation :**
   ```bash
   curl -X POST http://localhost:3000/api/prospector/update-status \
     -H "Content-Type: application/json" \
     -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
     -d '{
       "prospect_id": "...",
       "status": "Message à valider",
       "pending_message": "[message_résolu]"
     }'
   ```

4. **NE PAS avancer l'étape** — on attend la validation manuelle de Nathan

---

### Étape 4 — Envoyer les messages validés

```bash
curl -X GET http://localhost:3000/api/sequences/due-actions \
  -H "X-Account-Id: $RELEAF_ACCOUNT_ID"
```

Filtrer les éléments `pending_messages` avec `prospect.status === "Message à envoyer"`.

Pour chaque message validé :

1. **Accès à la messagerie LinkedIn :**
   - Naviguer vers `https://www.linkedin.com/messaging/`
   - Chercher la conversation avec le prospect

2. **Envoyer le message :**
   - Coller `prospect.pending_message` (déjà résolu)
   - Soumettre

3. **Mettre à jour :**
   ```bash
   curl -X POST http://localhost:3000/api/prospector/message-sent \
     -H "Content-Type: application/json" \
     -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
     -d '{"prospect_id": "...", "campaign_id": "..."}'
   ```

4. **Avancer l'étape :**
   ```bash
   curl -X POST http://localhost:3000/api/sequences/complete-step \
     -H "Content-Type: application/json" \
     -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
     -d '{"state_id": "...", "completed_step_order": 2}'
   ```

---

### Étape 5 — Détecter les invitations acceptées

Naviguer vers `https://www.linkedin.com/mynetwork/invite-connect/connections/`

Pour chaque nouvelle connexion :
1. Croiser avec prospects en statut "Invitation envoyée"
2. Mettre à jour :
   ```bash
   curl -X POST http://localhost:3000/api/prospector/update-status \
     -H "Content-Type: application/json" \
     -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
     -d '{"prospect_id": "...", "status": "Invitation acceptée"}'
   ```

**Note :** Ne pas appeler `complete-step` ici. L'acceptation ne change pas l'étape — le `next_action_at` a déjà été calculé à l'envoi de l'invitation.

---

### Étape 6 — Notification session expirée

Si une URL `linkedin.com/login` ou `checkpoint` est détectée :

```bash
powershell -Command "
  Add-Type -AssemblyName System.Windows.Forms;
  \$notify = New-Object System.Windows.Forms.NotifyIcon;
  \$notify.Icon = [System.Drawing.SystemIcons]::Warning;
  \$notify.Visible = \$true;
  \$notify.ShowBalloonTip(10000, 'Releaf Prospector', 'Session LinkedIn expirée — reconnexion requise.', [System.Windows.Forms.ToolTipIcon]::Warning);
  Start-Sleep -Seconds 10;
  \$notify.Dispose()
"
```

Puis **PAUSE la tâche** :
```bash
curl -X POST http://localhost:3000/api/sequences/stop \
  -H "Content-Type: application/json" \
  -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
  -d '{"prospect_id": "...", "reason": "error"}'
```

(Ou boucler sur tous les states actifs et les pauser)

---

### Étape 7 — Détecter les réponses

Naviguer vers `https://www.linkedin.com/messaging/`

Pour chaque nouveau message d'un prospect en statut "Message envoyé" :

```bash
curl -X POST http://localhost:3000/api/prospector/update-status \
  -H "Content-Type: application/json" \
  -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
  -d '{
    "prospect_id": "...",
    "status": "Réponse reçue",
    "interaction": {
      "type": "Réponse reçue",
      "content": "[contenu du message]"
    }
  }'
```

**Note :** Le trigger PostgreSQL arrête automatiquement la séquence active.

---

### Étape 8 — Release lock + Résumé

Relâcher le lock :

```bash
curl -X POST http://localhost:3000/api/task-locks/release \
  -H "Content-Type: application/json" \
  -H "X-Account-Id: $RELEAF_ACCOUNT_ID" \
  -d '{"lock_type": "linkedin_task2"}'
```

Envoyer un résumé à Nathan :
- Nombre de prospects enrôlés
- Invitations envoyées / restantes
- Messages soumis à validation
- Messages envoyés
- Réponses détectées
- Séquences arrêtées
- Quotas restants

---

## Statuts des prospects

| Statut | Sens | Transition |
|--------|------|-----------|
| Nouveau | Prospect validé, en attente d'enrôlement | → Invitation envoyée |
| Invitation envoyée | Invitation envoyée sur LinkedIn | → Invitation acceptée |
| Invitation acceptée | Prospect a accepté l'invitation | (prêt pour message) |
| Message à valider | Message généré, en attente de validation Nathan | → Message à envoyer |
| Message à envoyer | Message validé par Nathan, prêt à envoyer | → Message envoyé |
| Message envoyé | Message envoyé via LinkedIn | → Réponse reçue |
| Réponse reçue | Prospect a répondu → **séquence arrêtée** | (fin) |

---

## Types d'interaction

```json
{
  "type": "Réponse reçue",
  "content": "Merci pour ton message !",
  "date": "2026-03-30T10:00:00Z"
}
```

---

## Règles importantes

1. **Respect des quotas :** Vérifier avant chaque envoi (invitation/message)
2. **Respect du délai :** Ne pas envoyer une étape si `next_action_at > NOW()`
3. **Placeholders :** Tous résolus côté API avant envoi
4. **Icebreaker :** Si scraping échoue ou pas pertinent → générique
5. **Validation Nathan :** Les messages doivent passer par Nathan avant envoi
6. **Session LinkedIn :** Détecter expiration et pauser proprement
7. **Concurrence :** Utiliser les locks pour éviter l'exécution concurrente
8. **Trigger DB :** Réponse reçue arrête la séquence automatiquement

---

## Endpoints récapitulatifs

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/task-locks/acquire` | Acquérir un lock |
| POST | `/api/task-locks/release` | Relâcher un lock |
| GET | `/api/prospector/daily-stats` | Vérifier les quotas |
| GET | `/api/prospector/prospects?status=...` | Lister les prospects |
| POST | `/api/sequences/enroll` | Enrôler un prospect |
| GET | `/api/sequences/due-actions` | Actions prêtes à exécuter |
| POST | `/api/prospects/:id/linkedin-activity` | Sauvegarder activité |
| GET | `/api/prospects/:id/linkedin-activity` | Récupérer activité |
| POST | `/api/prospector/update-status` | Mettre à jour statut |
| POST | `/api/sequences/complete-step` | Avancer l'étape |
| POST | `/api/sequences/stop` | Arrêter une séquence |
| POST | `/api/prospector/message-sent` | Marquer message comme envoyé |

---

**Version :** Sprint 2 Part 3
**Mise à jour :** 2026-03-30
**Auteur :** Releaf Prospector Team
