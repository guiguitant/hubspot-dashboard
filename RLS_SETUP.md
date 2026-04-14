# Row Level Security (RLS) Setup Guide

Ce document explique comment mettre en place et utiliser le Row Level Security (RLS) dans Supabase.

## Vue d'ensemble

Le RLS protège les données au niveau de la base de données en s'assurant qu'un utilisateur ne peut accéder que aux données de son account.

```
┌─────────────────────────────────────────┐
│  Client (Navigateur)                    │
│  - Utilise JWT token avec account_id    │
│  - Requêtes Supabase filtrées par RLS   │
├─────────────────────────────────────────┤
│  Server Node.js (API)                   │
│  - Utilise clé admin Supabase           │
│  - Filtre manuellement par account_id   │
├─────────────────────────────────────────┤
│  Supabase (PostgreSQL)                  │
│  - RLS Policies appliquées sur TOUTES   │
│    les requêtes                         │
│  - Impossible de contourner             │
└─────────────────────────────────────────┘
```

## Étape 1: Exécuter la migration SQL RLS

1. **Accédez à Supabase Dashboard:**
   - https://app.supabase.com
   - Sélectionnez votre projet

2. **Allez dans SQL Editor:**
   - Cliquez sur "SQL Editor" dans le menu de gauche

3. **Créez une nouvelle query:**
   - Cliquez sur "New Query"
   - Copiez le contenu de `migrations/02_rls_policies.sql`
   - Collez dans l'éditeur
   - Cliquez sur "Run"

4. **Vérifiez les policies:**
   ```sql
   SELECT schemaname, tablename, policyname
   FROM pg_policies
   WHERE schemaname = 'public'
   ORDER BY tablename, policyname;
   ```

## Étape 2: Configurer SUPABASE_JWT_SECRET

1. **Trouvez votre JWT secret:**
   - Allez dans Settings → API
   - Cherchez "JWT Secret" sous "JWT Settings"
   - Copiez-le

2. **Ajoutez à votre .env:**
   ```env
   SUPABASE_JWT_SECRET=votre_jwt_secret_ici
   ```

3. **Redémarrez le serveur:**
   ```bash
   npm start
   ```

## Étape 3: Mettre à jour le client pour utiliser les JWT tokens

Le client maintenant:
1. Obtient un JWT token de l'endpoint `/api/accounts/:id/jwt`
2. Utilise ce token pour authentifier les requêtes Supabase direct
3. Les RLS policies filtrent automatiquement les données

**Pas d'action manuelle requise** - le code côté client sera mis à jour automatiquement.

## Comment ça fonctionne

### JWT Token avec custom claims:

```javascript
{
  "sub": "account-uuid",
  "aud": "authenticated",
  "role": "authenticated",
  "account_id": "account-uuid",  // ← Custom claim for RLS
  "iat": 1234567890,
  "exp": 1234654290
}
```

### RLS Policy example:

```sql
CREATE POLICY prospects_select ON prospects
  FOR SELECT
  USING (auth.role() = 'service_role' OR can_access_account(account_id));
```

Cette policy dit: "Retourne les lignes où account_id correspond au account_id du JWT token de l'utilisateur (ou accès service_role)"

> **Note:** Depuis migration 13, `prospect_account` a été fusionné dans `prospects`. Les prospects portent directement leur `account_id`, `status`, et `campaign_id`.

## Architecture de sécurité (Defense in Depth)

### Couche 1: RLS à la base de données ✅
- **Ce que c'est:** PostgreSQL refuse les données si elles ne correspondent pas au policy
- **Avantages:** Impossible à contourner, même par admin
- **Où:** Supabase (PostgreSQL)

### Couche 2: Validation API ✅
- **Ce que c'est:** Node.js vérifie l'account_id du header X-Account-Id
- **Avantages:** Double-check, logging, audit trail
- **Où:** server.js

### Couche 3: Validation client ✅
- **Ce que c'est:** JavaScript filtre les résultats localement
- **Avantages:** UX rapide, offline-ready
- **Où:** prospector-db.js

## Tester le RLS

### Test 1: Vérifier les policies sont actives

```sql
-- Dans Supabase SQL Editor
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename;
```

Vous devriez voir 25+ policies créées.

### Test 2: Vérifier l'authentification JWT

```bash
# Obtenez un JWT token
curl http://localhost:3000/api/accounts/{account-id}/jwt

# Réponse:
{
  "token": "eyJhbGc...",
  "account_id": "...",
  "account_name": "Nathan"
}
```

### Test 3: Tester avec le client

1. Allez sur http://localhost:3000/prospector.html
2. Sélectionnez un account
3. Les données devraient être filtrées correctement

## Dépannage

### Erreur: "SUPABASE_JWT_SECRET not set"
- **Cause:** La variable d'environnement n'est pas définie
- **Solution:** Voir Étape 2

### Erreur: "Policy does not exist"
- **Cause:** La migration SQL n'a pas été exécutée
- **Solution:** Allez dans Supabase SQL Editor et exécutez `02_rls_policies.sql`

### Les données se chargent correctement mais côté client rien ne change
- **Cause:** Le JWT token n'est pas utilisé côté client
- **Solution:** Assurez-vous que account-context.js utilise les tokens
- **Note:** Cette partie sera implémentée dans la prochaine étape

## Prochaines étapes

1. ✅ Créer les RLS policies SQL
2. ✅ Créer l'endpoint JWT
3. ⏳ Mettre à jour account-context.js pour utiliser les JWT tokens
4. ⏳ Mettre à jour prospector-db.js pour utiliser les tokens
5. ⏳ Tester l'intégration complète

## Sécurité et bonnes pratiques

### ✅ À faire
- Utiliser RLS sur TOUTES les tables multi-tenant
- Générer des JWT tokens avec des expiry court (24h)
- Valider côté serveur ET côté BD
- Logger les accès suspects

### ❌ À éviter
- Ne pas ignorer les erreurs RLS
- Ne pas utiliser la clé admin côté client
- Ne pas faire confiance au filtrage côté client seul
- Ne pas expose les JWT secrets

## Références

- [Supabase RLS Documentation](https://supabase.com/docs/guides/auth/row-level-security)
- [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [JWT Custom Claims](https://supabase.com/docs/guides/auth/custom-claims)
