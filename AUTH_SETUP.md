# Authentification Supabase Magic Link — Guide de configuration

## Prérequis à faire par Nathan

### 1. Configurer Supabase Auth dans le Dashboard

1. Aller à **Authentication → Settings** dans le dashboard Supabase
2. Section **Email Auth**:
   - ✅ Email Auth: **Actif** (par défaut)
   - ✅ Magic Links: **Actif** (par défaut)

3. Section **Email Templates** → **Magic Link**:
   - Vérifier le template par défaut ou personnaliser avec le branding "Releaf Carbon"

### 2. Configurer les Redirect URLs

1. Dans **Authentication → Settings** → **URL Configuration**:
   - Ajouter `https://hubspot-dashboard-1c7z.onrender.com` (production Render)
   - Ajouter `http://localhost:3000` (développement local)

2. Sauvegarder

### 3. Récupérer les variables d'environnement

1. Aller à **Settings → API → Project API keys**
2. Copier:
   - `SUPABASE_URL` (URL du projet)
   - `SUPABASE_ANON_KEY` (anon public key)
   - `SUPABASE_SERVICE_ROLE_KEY` (service_role secret key) ⚠️ À garder secret!
   - `SUPABASE_JWT_SECRET` (JWT secret)

3. Ajouter à `.env` (copier depuis `.env.example`):
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_ANON_KEY=eyJh...
   SUPABASE_SERVICE_ROLE_KEY=eyJh... (SECRET!)
   SUPABASE_JWT_SECRET=your_jwt_secret
   ```

4. Pour Vite (frontend), ajouter aussi:
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJh...
   ```

### 4. Exécuter la migration de base de données

1. Dans Supabase Dashboard → **SQL Editor**
2. Exécuter la migration `migrations/07_auth_supabase.sql`:
   ```sql
   ALTER TABLE accounts
     ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
   ALTER TABLE accounts
     ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
   CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
   ```

### 5. Mettre à jour les emails et permissions

Dans **SQL Editor**, mettre à jour les emails des utilisateurs:

```sql
UPDATE accounts SET email = 'nathan@releafcarbon.com', is_admin = true  WHERE slug = 'nathan';
UPDATE accounts SET email = 'guillaume@releafcarbon.com', is_admin = false WHERE slug = 'guillaume';
UPDATE accounts SET email = 'vincent@releafcarbon.com',  is_admin = false WHERE slug = 'vincent';
```

⚠️ **Important**: Nathan est le seul avec `is_admin = true`. Cela lui permet:
- De voir le sélecteur de compte dans le header
- De switcher entre les comptes de Guillaume et Vincent sans se déconnecter
- De debug l'app sans se ré-authentifier

### 6. Déployer les variables d'environnement sur Render

1. Aller à votre application Render: **Settings → Environment**
2. Ajouter les variables:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_JWT_SECRET`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

3. Déclencher un redéploiement

---

## Architecture de l'authentification

### Flow utilisateur classique (Guillaume, Vincent)

1. Utilisateur va sur l'app → page de login
2. Entre son email → reçoit un magic link par email
3. Clique sur le lien → redirigé et connecté automatiquement
4. Voit ses propres données (prospection, séquences, etc.)
5. Clique "Déconnexion" → retour page login

### Mode admin (Nathan uniquement)

1. Nathan se connecte avec son email
2. Voit un sélecteur de compte jaune "🔧 Admin" dans le header
3. Peut changer de compte (Guillaume, Vincent, Nathan)
4. Les données s'affichent pour le compte sélectionné
5. **sessionStorage** garde le compte actif (reset au Ctrl+Shift+R intentionnellement)
6. Nathan reste connecté avec son email — pas besoin de se ré-authentifier

---

## Sécurité

- ✅ Tokens JWT Supabase vérifiés côté serveur
- ✅ X-Account-Id ne fonctionne qu'avec les tasks Dispatch (via service_role)
- ✅ X-Switch-Account réservé aux admins (`is_admin = true`)
- ✅ RLS policies protègent les données au niveau base de données
- ✅ Tokens auto-refreshés par Supabase

---

## Dépannage

### "Aucun compte Releaf associé à cet email"
→ L'email n'existe pas dans la table `accounts` ou n'a pas la colonne `email` mise à jour.
→ Vérifier que la migration a bien été exécutée et les emails mis à jour.

### "Token invalide ou expiré"
→ Le token a expiré ou n'a pas été créé correctement.
→ Supabase devrait auto-refresh — rafraîchir la page ou se reconnecter.

### Magic Link ne reçoit pas d'email
→ Vérifier les **Email Templates** dans Supabase (sender, contenu)
→ Vérifier les logs d'envoi dans Supabase Dashboard → **Logs**
→ En dev, Magic Links sont toujours envoyés ; en prod, vérifier la configuration SMTP

### Le sélecteur admin n'apparaît pas (Nathan)
→ Vérifier que `is_admin = true` pour Nathan dans la base
→ Rafraîchir la page (Ctrl+Shift+R)

---

## Prochaines étapes

Une fois l'authentification testée:
1. Intégrer les composants existants (prospector, séquences, etc.) dans la nouvelle interface React
2. Remplacer le placeholder MainApp par le dashboard complet
3. Garder prospector.js pour Dispatch (inchangé)
