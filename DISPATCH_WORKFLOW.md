# Releaf Prospector — Dispatch Workflow (Source unique de vérité)

Workflow autonome pour l'exécution des séquences LinkedIn (Tâche 2).
**La séquence est la source de vérité du workflow. Dispatch est l'exécuteur.**

---

## Règles absolues d'exécution

1. **`fetch()` uniquement** : Tous les appels API vers `localhost:3000` doivent utiliser `fetch()` dans le navigateur. Jamais `curl`, jamais `bash`.
2. **LinkedIn classique uniquement** : Utiliser uniquement `linkedin.com`. Ne jamais utiliser Sales Navigator.
3. **LinkedIn doit être connecté** : Si la page LinkedIn redirige vers `/login` ou `/checkpoint` → arrêt immédiat (voir Étape 6 — Session expirée).
4. **Try/catch par prospect** : Chaque traitement individuel de prospect (Steps 4a, 4b, 4c, 5, 6) doit être enveloppé dans un `try/catch`. Si un prospect plante, loguer l'erreur dans `_errors[]` et continuer au prospect suivant. Ne jamais interrompre la boucle pour une erreur isolée.

```javascript
// Pattern à appliquer dans toutes les boucles prospect :
const _errors = []; // déclaré dans les variables globales
for (const prospect of prospects) {
  try {
    // ... traitement du prospect
  } catch (err) {
    _errors.push({ step: '4a', prospect_id: prospect.id, message: err.message });
  }
}
// _errors sera passé à _postSummary({ errors: _errors }) en fin de run
```

---

## Principes fondamentaux

1. **Séquence obligatoire** : Dispatch n'exécute AUCUNE action LinkedIn (invitation, message) sur une campagne sans séquence active.
2. **Pas de séquence = pas d'action** : Si une campagne n'a pas de séquence active, cette tâche la skip entièrement.
3. **Génération complète par Claude** : Le message est généré entièrement par Claude API à partir des paramètres de l'étape + données prospect + icebreaker. Plus de template, plus de placeholders.
4. **Contexte LinkedIn** : Posts récents scrapés lors de la détection d'acceptation. Claude intègre ce contexte naturellement dans le message.
5. **Validation Nathan** : Tout message doit être validé par Nathan avant envoi. Jamais d'envoi automatique.
6. **Profil Chrome** : La Tâche 2 doit vérifier qu'un onglet LinkedIn est ouvert sur le profil Chrome "Nathan". Si ce n'est pas le cas, notification Windows et arrêt.

---

## Account ID

```javascript
const ACCOUNT_ID = "[uuid]";
// Inclure dans TOUS les appels API :
headers: { 'Content-Type': 'application/json', 'X-Account-Id': ACCOUNT_ID }
```

---

## URL de base

```
http://localhost:3000
```

---

## Variables globales (déclarer en haut du script Task 2)

```javascript
const _startedAt = Date.now();
let _stats = null; // alimenté à l'Étape 1, utilisé partout et dans _postSummary
const _errors = []; // erreurs non-fatales, passé à _postSummary en fin de run

const _summary = {
  invitations_sent: 0,
  invitations_accepted: 0,
  messages_submitted: 0,
  messages_sent: 0,
  replies_detected: 0,
};
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

```javascript
const lockResp = await fetch('/api/task-locks/acquire', {
  method: 'POST', headers, body: JSON.stringify({ lock_type: 'linkedin_task2', task_name: 'task2' })
});
const lock = await lockResp.json();
```

Si `lock.acquired === false` → STOP.

### Étape 0b — Vérifier le profil Chrome LinkedIn

Naviguer vers `https://www.linkedin.com/feed` et vérifier que le compte connecté est bien Nathan.

```javascript
// Lire le nom du profil connecté dans le nav LinkedIn
const profileName = document.querySelector(
  '.profile-rail-card__actor-link, .feed-identity-module__actor-meta a, [aria-label*="profil"]'
)?.innerText?.trim() || '';

if (!profileName.toLowerCase().includes('nathan')) {
  // Notification Windows (ballon) si possible
  await fetch('/api/task-locks/release', { method: 'POST', headers, body: JSON.stringify({ lock_type: 'linkedin_task2' }) });
  await _postSummary({ stopped_reason: 'wrong_profile', errors: [{ step: '0b', message: `Profil Chrome incorrect : "${profileName}"` }] });
  return; // STOP
}
```

### Étape 1 — Vérifier les quotas

```javascript
const statsResp = await fetch('/api/prospector/daily-stats', { headers });
_stats = await statsResp.json(); // ← variable globale, réutilisée dans _postSummary
```

Si `_stats.invitations.remaining === 0` ET `_stats.messages.remaining === 0` → relâcher lock et arrêter.

### Étape 2 — Initialisation session LinkedIn (UNE SEULE FOIS)

Avant de traiter les campagnes, charger en mémoire :

**A) Connexions récentes**
```javascript
// Naviguer vers https://www.linkedin.com/mynetwork/invite-connect/connections/
// Extraire la liste des connexions récentes (noms + URLs de profil)
window._linkedinConnections = [...]; // stocker en mémoire
```

**B) Boîte de réception**
```javascript
// Naviguer vers https://www.linkedin.com/messaging/
// Extraire les conversations récentes et leur état (lu/non lu, dernier message, auteur)
window._linkedinMessages = [...]; // stocker en mémoire
```

Ces données sont réutilisées pour **toutes les campagnes** sans recharger ces pages.

### Étape 3 — Charger les campagnes et les actions dues

```javascript
// A) Campagnes actives
const campsResp = await fetch('/api/prospector/campaigns?active=true', { headers });
const campaigns = await campsResp.json();
// Trier par priorité croissante (1 = plus prioritaire)

// B) Actions dues — UNE SEULE FOIS (retourne toutes les campagnes)
// ⚠️ L'API retourne un objet { sequence_actions: [...], pending_messages: [...] }
const dueResp = await fetch('/api/sequences/due-actions', { headers });
const dueData = await dueResp.json();
const allDueActions = dueData.sequence_actions || [];
```

Pour chaque campagne, dans l'ordre de priorité :

**A) Vérifier qu'une séquence active existe :**
```javascript
const seqResp = await fetch(`/api/sequences?campaign_id=${campaign.id}`, { headers });
const sequence = await seqResp.json();
```
Si `null` → **SKIP cette campagne**. Aucune action LinkedIn.

**B) Enrôler les nouveaux prospects :**
```javascript
const prospectsResp = await fetch(`/api/prospector/prospects?campaign_id=${campaign.id}&status=Nouveau`, { headers });
const prospects = await prospectsResp.json();
for (const prospect of prospects) {
  await fetch('/api/sequences/enroll', {
    method: 'POST', headers, body: JSON.stringify({ prospect_id: prospect.id, campaign_id: campaign.id })
  });
}
```

**C) Filtrer les actions dues pour cette campagne :**
```javascript
const dueActions = allDueActions.filter(a => a.prospect_account.campaign_id === campaign.id);
```

### Étape 4a — send_invitation

**Conditions :**
- `action.step.type === "send_invitation"`
- `_stats.invitations.remaining > 0`

**Actions :**
1. Naviguer vers `linkedin.com/in/{slug}/`
2. Cliquer "Se connecter" / "Connect"
3. Si `action.step.has_note === true` → ajouter `action.step.note_content` comme note d'invitation
4. Soumettre

**Mise à jour :**
```javascript
await fetch('/api/prospector/update-status', {
  method: 'POST', headers,
  body: JSON.stringify({ prospect_id: action.prospect_id, status: 'Invitation envoyée' })
});
await fetch('/api/sequences/complete-step', {
  method: 'POST', headers,
  body: JSON.stringify({ state_id: action.state_id, completed_step_order: action.step.step_order })
});
_summary.invitations_sent++;
_stats.invitations.remaining--;
```

> Si LinkedIn répond HTTP **429** à n'importe quelle étape → arrêt immédiat (voir Étape 7 — Gestion 429).

### Étape 4b — Détecter les invitations acceptées + scraper l'activité LinkedIn

Croiser `window._linkedinConnections` avec les prospects en statut `"Invitation envoyée"` :
```javascript
const invResp = await fetch(`/api/prospector/prospects?campaign_id=${campaign.id}&status=Invitation envoyée`, { headers });
let invitedProspects = await invResp.json();
```

**Timeout d'invitation (30 jours)** — avant de croiser les connexions, éliminer les invitations expirées :
```javascript
const INVITATION_TIMEOUT_DAYS = 30;
for (const prospect of invitedProspects) {
  const sentAt = prospect.status_changed_at || prospect.updated_at;
  const ageDays = Math.floor((Date.now() - new Date(sentAt)) / 86400000);
  if (ageDays > INVITATION_TIMEOUT_DAYS) {
    await fetch('/api/prospector/update-status', {
      method: 'POST', headers,
      body: JSON.stringify({
        prospect_id: prospect.id,
        status: 'Non pertinent',
        interaction: { type: 'Invitation expirée', content: `Invitation sans réponse après ${ageDays} jours` }
      })
    });
    await fetch('/api/sequences/stop', {
      method: 'POST', headers,
      body: JSON.stringify({ prospect_id: prospect.id })
    });
  }
}
// Retirer les expirés de la liste
invitedProspects = invitedProspects.filter(p => {
  const sentAt = p.status_changed_at || p.updated_at;
  return Math.floor((Date.now() - new Date(sentAt)) / 86400000) <= INVITATION_TIMEOUT_DAYS;
});
```

Pour chaque match (prospect présent dans `window._linkedinConnections`) :

1. **Mettre à jour le statut** → `"Invitation acceptée"` + `_summary.invitations_accepted++`
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
     ```javascript
     await fetch(`/api/prospects/${prospect.id}/linkedin-activity`, {
       method: 'POST', headers,
       body: JSON.stringify({ raw_posts: [...], icebreaker_generated: '...', icebreaker_mode: 'personalized|generic', is_relevant: true|false })
     });
     ```

3. **Générer le message complet via Claude API** :
   - Le champ `step.message_params` (JSONB) contient : `{ angle, tone, objective, context, max_chars, instructions }`
   - Appeler `POST /api/sequences/generate-message` avec : `{ campaign, message_params: step.message_params, prospect, icebreaker }`

4. **Soumettre à validation** :
   ```javascript
   await fetch('/api/prospector/update-status', {
     method: 'POST', headers,
     body: JSON.stringify({ prospect_id: prospect.id, status: 'Message à valider', pending_message: messageGenere })
   });
   _summary.messages_submitted++;
   ```

**NE PAS appeler `complete-step` ici.** On attend la validation de Nathan.

### Étape 4c — Générer les messages de follow-up (send_message depuis due-actions)

Les messages 2, 3... sont des actions `send_message` qui apparaissent dans `dueActions` quand le délai est passé et qu'il n'y a pas eu de réponse.

```javascript
// Exclure les prospects déjà en attente (sinon duplication avec Step 4b)
const SKIP_STATUSES = ['Invitation acceptée', 'Message à valider', 'Message à envoyer'];
const followupActions = dueActions.filter(a =>
  a.step.type === 'send_message'
  && !SKIP_STATUSES.includes(a.prospect_account.status)
);

for (const action of followupActions) {
  // Récupérer les données du prospect
  const prospResp = await fetch(`/api/prospector/prospects/${action.prospect_id}`, { headers });
  const prospect = await prospResp.json();

  // Récupérer l'icebreaker en cache (120h)
  const actResp = await fetch(`/api/prospects/${action.prospect_id}/linkedin-activity`, { headers });
  const activity = actResp.ok ? await actResp.json() : null;

  // Générer le message complet via Claude API
  const msgResp = await fetch('/api/sequences/generate-message', {
    method: 'POST', headers,
    body: JSON.stringify({
      campaign,
      message_params: action.step.message_params,
      prospect,
      icebreaker: activity?.icebreaker_generated
    })
  });
  const { message: messageGenere } = await msgResp.json();

  // Soumettre à validation Nathan
  await fetch('/api/prospector/update-status', {
    method: 'POST', headers,
    body: JSON.stringify({ prospect_id: action.prospect_id, status: 'Message à valider', pending_message: messageGenere })
  });
  _summary.messages_submitted++;
}
```

**NE PAS appeler `complete-step` ici.** On attend la validation de Nathan.

### Étape 5 — Envoyer les messages validés

```javascript
const pendingResp = await fetch(`/api/prospector/prospects?campaign_id=${campaign.id}&status=Message à envoyer`, { headers });
const pendingMessages = await pendingResp.json();

// Charger la map des états séquences pour récupérer le state_id
// (GET /api/sequences/states retourne { prospect_id → { id, status, current_step_order, ... } })
const seqStatesResp = await fetch('/api/sequences/states', { headers });
const seqStatesMap = await seqStatesResp.json();
```

Pour chaque message (si `_stats.messages.remaining > 0`) :
1. Chercher la conversation dans `window._linkedinMessages`
2. Naviguer vers `linkedin.com/messaging/` → ouvrir la conversation
3. Coller `prospect.pending_message` et soumettre

```javascript
await fetch('/api/prospector/message-sent', {
  method: 'POST', headers,
  body: JSON.stringify({ prospect_id: prospect.id, campaign_id: campaign.id })
});

// Utiliser le state_id depuis la map (et non depuis dueActions)
const seqState = seqStatesMap[prospect.id];
if (seqState?.id) {
  await fetch('/api/sequences/complete-step', {
    method: 'POST', headers,
    body: JSON.stringify({ state_id: seqState.id, completed_step_order: seqState.current_step_order })
  });
}
_summary.messages_sent++;
_stats.messages.remaining--;
```

> Si LinkedIn répond HTTP **429** → arrêt immédiat (voir Étape 7 — Gestion 429).

### Étape 6 — Détecter les réponses

Croiser `window._linkedinMessages` avec les prospects en statut `"Message envoyé"` :

```javascript
const sentResp = await fetch(`/api/prospector/prospects?campaign_id=${campaign.id}&status=Message envoyé`, { headers });
const sentProspects = await sentResp.json();
```

Pour chaque nouveau message détecté d'un prospect en "Message envoyé" :
```javascript
await fetch('/api/prospector/update-status', {
  method: 'POST', headers,
  body: JSON.stringify({
    prospect_id: prospect.id,
    status: 'Discussion en cours',
    interaction: { type: 'Réponse reçue', content: '[contenu du message]' }
  })
});
_summary.replies_detected++;
```

Le trigger PostgreSQL arrête automatiquement la séquence.

### Étape 7 — Gestion 429 (rate limiting LinkedIn)

Si LinkedIn retourne HTTP 429 à n'importe quel moment :

1. Arrêter immédiatement tout traitement
2. Relâcher le lock
3. Enregistrer le résumé avec `stopped_reason: "rate_limited"`

```javascript
await fetch('/api/task-locks/release', { method: 'POST', headers, body: JSON.stringify({ lock_type: 'linkedin_task2' }) });
await _postSummary({ stopped_reason: 'rate_limited', errors: [{ step: '...', message: 'HTTP 429 reçu' }] });
```

### Étape 8 — Session LinkedIn expirée

Si URL `linkedin.com/login` ou `linkedin.com/checkpoint` détectée :
- Notification Windows (ballon)
- Relâcher le lock
- Enregistrer le résumé avec `stopped_reason: "session_expired"`

```javascript
await fetch('/api/task-locks/release', { method: 'POST', headers, body: JSON.stringify({ lock_type: 'linkedin_task2' }) });
await _postSummary({ stopped_reason: 'session_expired' });
```

### Étape 9 — Relâcher le lock + résumé final

```javascript
await fetch('/api/task-locks/release', {
  method: 'POST', headers,
  body: JSON.stringify({ lock_type: 'linkedin_task2' })
});
await _postSummary({ stopped_reason: null, errors: _errors });
```

**Fonction `_postSummary`** à appeler dans tous les cas de fin (normale ou erreur) :

```javascript
async function _postSummary({ stopped_reason, errors = [] }) {
  const duration = Math.round((Date.now() - _startedAt) / 1000);
  await fetch('/api/dispatch/summary', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ran_at: new Date(_startedAt).toISOString(),
      duration_seconds: duration,
      invitations_sent:        _summary.invitations_sent,
      invitations_accepted:    _summary.invitations_accepted,
      messages_submitted:      _summary.messages_submitted,
      messages_sent:           _summary.messages_sent,
      replies_detected:        _summary.replies_detected,
      quota_invitations_remaining: _stats?.invitations?.remaining ?? null,
      quota_messages_remaining:    _stats?.messages?.remaining ?? null,
      stopped_reason,
      errors,
    })
  });
}
```

---

## Cache contexte LinkedIn

- Durée : **120h (5 jours calendaires ≈ 3 jours ouvrés)**
- Si cache frais → utiliser directement
- Si cache expiré ou absent → `needs_scraping: true` → Dispatch scrape au prochain passage
- Regénération manuelle : Nathan clique "Regénérer" dans la Review → Claude génère un nouveau message complet

---

## Follow-ups (Messages 2, 3...)

Si la séquence a plusieurs étapes `send_message` :
- Après envoi du Message 1 + `complete-step`, le `next_action_at` est calculé avec le délai de l'étape suivante (+ jitter ±17%)
- Au prochain passage Dispatch, si `next_action_at` est passé et pas de réponse → Claude génère le Message 2 (avec les paramètres de l'étape 2) → "Message à valider"
- Même flow : validation Nathan → envoi → complete-step

---

## Enrôlement en masse d'une campagne existante

Pour les campagnes avec des prospects à différents stades :
```javascript
await fetch('/api/sequences/enroll-campaign', {
  method: 'POST', headers,
  body: JSON.stringify({ campaign_id: '...' })
});
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
| GET | `/api/sequences/due-actions` | Actions prêtes à exécuter (retourne `{ sequence_actions, pending_messages }`) |
| GET | `/api/sequences/states` | Map `{ prospect_id → { id, status, current_step_order, sequence_id } }` |
| POST | `/api/sequences/complete-step` | Avancer l'étape |
| POST | `/api/sequences/stop` | Arrêter une séquence |
| POST | `/api/prospects/:id/linkedin-activity` | Sauvegarder activité + icebreaker |
| GET | `/api/prospects/:id/linkedin-activity` | Récupérer activité (cache 120h) |
| POST | `/api/prospector/update-status` | Mettre à jour statut |
| POST | `/api/prospector/message-sent` | Marquer message comme envoyé |
| POST | `/api/sequences/generate-message` | Générer un message complet via Claude |
| POST | `/api/dispatch/summary` | Enregistrer le résumé d'exécution |

---

**Version :** Sprint 2 V4 — Corrections review complète (duplication, compteurs, due-actions, try/catch)
**Mise à jour :** 2026-04-02
