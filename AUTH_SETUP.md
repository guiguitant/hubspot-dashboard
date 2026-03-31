# Authentification PIN — Guide de configuration

## Vue d'ensemble

Releaf Prospector utilise une **authentification PIN simple** au lieu de Magic Links.

**Avantages :**
- ✅ Pas de limite email Supabase
- ✅ Instantané (pas d'attendre un email)
- ✅ Parfait pour une app interne
- ✅ Sécurisé avec JWT tokens

---

## Prérequis à faire par Nathan

### 1. Ajouter colonne PIN à Supabase (déjà fait)

Si elle n'existe pas encore, exécuter dans **Supabase SQL Editor** :

```sql
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pin VARCHAR(255);
```

### 2. Configurer les 3 PINs pour les comptes

Dans **Supabase SQL Editor**, exécuter :

```sql
UPDATE accounts SET pin = '19970705' WHERE email = 'nathangourdin@releafcarbon.com';
UPDATE accounts SET pin = '19970921' WHERE email = 'guillaumetant@releafcarbon.com';
UPDATE accounts SET pin = '19970624' WHERE email = 'vincentmory@releafcarbon.com';
```

**Important:** Les PINs sont les dates de naissance des utilisateurs (YYYYMMDD).
- Nathan : 07/07/1997 → `19970705`
- Guillaume : 21/09/1997 → `19970921`
- Vincent : 24/06/1997 → `19970624`

### 3. Récupérer les variables d'environnement Supabase

1. Aller à **Settings → API → Project API keys**
2. Copier :
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` ⚠️ Secret!
   - `SUPABASE_JWT_SECRET`

3. Ajouter à `.env` :
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_ANON_KEY=eyJh...
   SUPABASE_SERVICE_ROLE_KEY=eyJh... (SECRET!)
   SUPABASE_JWT_SECRET=your_jwt_secret
   ```

### 4. Vérifier les permissions admin

Dans **Supabase SQL Editor** :

```sql
-- Nathan est le seul admin
UPDATE accounts SET is_admin = true  WHERE email = 'nathangourdin@releafcarbon.com';
UPDATE accounts SET is_admin = false WHERE email = 'guillaumetant@releafcarbon.com';
UPDATE accounts SET is_admin = false WHERE email = 'vincentmory@releafcarbon.com';
```

⚠️ **Important**: Nathan (`is_admin = true`) peut switcher entre les comptes sans se déconnecter.

### 5. Déployer les variables d'environnement sur Render

1. Aller à votre application Render: **Settings → Environment**
2. Ajouter :
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_JWT_SECRET`

3. Déclencher un redéploiement

---

## Architecture de l'authentification

### Flow utilisateur standard (Guillaume, Vincent)

1. Utilisateur va sur `/prospector-app`
2. Voit formulaire : Email + PIN
3. Entre email + PIN
4. Reçoit JWT token (stocké en sessionStorage)
5. Voit ses propres données (prospection, séquences, etc.)
6. Clique "Déconnexion" → retour formulaire login

### Mode admin (Nathan uniquement)

1. Nathan se connecte avec son email + PIN
2. Voit sélecteur de compte jaune "🔧 Admin" dans le header
3. Peut changer de compte (Guillaume, Vincent, Nathan)
4. Les données s'affichent pour le compte sélectionné
5. **sessionStorage** garde le compte actif (reset au Ctrl+Shift+R)
6. Nathan reste connecté — pas besoin de se ré-authentifier

---

## Endpoints API

### POST /api/accounts/login-pin

Authentifier un utilisateur avec email + PIN.

**Requête :**
```bash
curl -X POST http://localhost:3000/api/accounts/login-pin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "nathangourdin@releafcarbon.com",
    "pin": "19970705"
  }'
```

**Réponse (succès) :**
```json
{
  "token": "eyJh...",
  "account_id": "uuid-...",
  "account_name": "Nathan",
  "is_admin": true,
  "expires_in": 86400
}
```

**Réponse (erreur) :**
```json
{
  "error": "Email non trouvé"
}
```

ou

```json
{
  "error": "PIN incorrect"
}
```

### GET /api/accounts/me

Vérifier l'authentification actuelle (nécessite header `Authorization: Bearer {token}`).

**Requête :**
```bash
curl -X GET http://localhost:3000/api/accounts/me \
  -H "Authorization: Bearer eyJh..."
```

**Réponse :**
```json
{
  "account": {
    "id": "uuid-...",
    "name": "Nathan",
    "email": "nathangourdin@releafcarbon.com",
    "is_admin": true
  }
}
```

---

## Flux d'authentification côté frontend

1. **Utilisateur arrive sur `/prospector-app`**
   - App.jsx vérifie si un token existe en sessionStorage
   - Si oui → initialise la session
   - Si non → affiche LoginPage

2. **Utilisateur rentre email + PIN**
   - LoginPage appelle `POST /api/accounts/login-pin`
   - Si succès → stocke token en sessionStorage
   - Appelle `onLoginSuccess` callback → App.jsx se met à jour

3. **App.jsx initialise la session**
   - Appelle `GET /api/accounts/me` avec le token
   - Récupère infos du compte
   - Rend MainApp avec accès aux données

4. **Utilisateur se déconnecte**
   - Clique "Déconnexion"
   - sessionStorage est vidé
   - Retour à LoginPage

---

## Sécurité

- ✅ PINs stockés en base de données (jamais en code)
- ✅ JWT tokens générés côté serveur (avec SUPABASE_JWT_SECRET)
- ✅ Tokens vérifés sur chaque requête API
- ✅ Tokens stockés en sessionStorage (pas de localStorage → meilleur que cookies HTTP)
- ✅ Tokens expirés après 24h
- ✅ X-Account-Id fonctionne uniquement avec service_role (Dispatch tasks)
- ✅ X-Switch-Account réservé aux admins (`is_admin = true`)
- ✅ RLS policies protègent les données au niveau base de données

---

## Dépannage

### "Email non trouvé"
→ L'email n'existe pas dans la table `accounts`
→ Vérifier que c'est bien `nathangourdin@releafcarbon.com` (pas `nathan@...`)
→ Vérifier la base de données : `SELECT email FROM accounts;`

### "PIN incorrect"
→ Le PIN entré ne correspond pas
→ Vérifier auprès de Nathan quels sont les bons PINs
→ Vérifier en base : `SELECT email, pin FROM accounts;`

### "No session available" (erreur côté frontend)
→ Token n'est pas en sessionStorage
→ Se reconnecter via formulaire login
→ Vérifier que le formulaire appelle bien `loginSuccess` callback

### "Token invalide ou expiré"
→ Rafraîchir la page (F5)
→ Si erreur persiste → se reconnecter

### Le sélecteur admin n'apparaît pas (Nathan)
→ Vérifier que `is_admin = true` pour Nathan en base
→ Rafraîchir la page (Ctrl+Shift+R)

---

## Développement local

### 1. Démarrer le backend

```bash
npm start
# Écoute sur http://localhost:3000
```

### 2. Démarrer le frontend (dans un autre terminal)

```bash
npm run frontend:dev
# Écoute sur http://localhost:5173
# Proxie /api/* vers localhost:3000
```

### 3. Accéder à l'app

```
http://localhost:5173/prospector-app
```

### 4. Tester le login

Email: `nathangourdin@releafcarbon.com`
PIN: `19970705`

---

## Production (Render)

1. Build React app : `npm run frontend:build` (fait automatiquement par Procfile)
2. Express sert `/dist` et `/api` endpoints
3. Procfile : `web: npm run frontend:build && npm start`
4. Variables d'environnement configurées dans Render Settings

---

## Changement de PIN

Si un utilisateur veut changer son PIN (dans le futur) :

```sql
UPDATE accounts SET pin = 'nouveau_pin' WHERE email = '...';
```

Pas besoin de redéployer — le changement prend effet immédiatement.

---

## Notes importantes

- **Pas de reset PIN** : Contacter Nathan directement pour réinitialiser
- **Pas de "Mot de passe oublié"** : Le PIN est simple et connu de chaque utilisateur
- **Session timeout** : Les tokens expirent après 24h (relogin automatique)
- **Admin switching** : Seul Nathan peut switcher. Guillaume et Vincent voient uniquement leurs données
- **Logout clears everything** : sessionStorage est vidé complètement

---

**Version :** PIN Authentication (Sprint 2 Part 4)
**Mise à jour :** 2026-03-31
**Auteur :** Releaf Prospector Team
