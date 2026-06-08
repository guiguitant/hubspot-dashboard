# Authentification du dashboard pilote — code TOTP

Le dashboard pilote (`/` → `public/pilot.html`) et **toutes ses API** sont protégés par un
**code d'authentification TOTP** (appli authenticator type Google Authenticator / Authy).

> Single-factor : le seul secret est le code TOTP (something you have). Pas de mot de passe.
> Le code tourne toutes les 30 s et le secret n'est pas devinable ; un lockout anti-brute-force
> limite les tentatives. Pour un vrai 2FA, on rajouterait un mot de passe en 1er facteur.

> Le Prospector (`/prospector`, `/api/prospector/*`, `/api/sequences/*`, …) et
> l'automatisation Dispatch gardent **leur propre auth** (`accountContext` / `X-Account-Id`).
> Ils sont allowlistés dans le gate et ne sont pas affectés.

## Comment ça marche

1. Un utilisateur non authentifié sur `/` reçoit la page `dashboard-login.html`.
2. Il saisit le **code à 6 chiffres** de son app authenticator.
3. `POST /api/dashboard-login` vérifie le code et pose un **cookie de session signé**
   (HMAC, HttpOnly, Secure en prod, SameSite=Lax, durée 12 h).
4. Le middleware `dashboardGate` (server.js) exige ce cookie pour la page `/` et toutes
   les routes `/api/*` du dashboard. Sans cookie : 401 sur les API, page de login sur les pages.
5. Déconnexion : bouton dans la barre latérale → `POST /api/dashboard-logout` (efface le cookie).

Anti-brute-force : 10 tentatives échouées max / 15 min / IP (lockout en mémoire).

## Variables d'environnement (obligatoires)

Si l'une manque, **le serveur refuse de démarrer** (évite un déploiement ouvert par accident).

| Variable | Rôle |
|---|---|
| `DASHBOARD_TOTP_SECRET` | Secret TOTP partagé en base32 |
| `DASHBOARD_SESSION_SECRET` | Clé HMAC pour signer le cookie de session |

### Générer les secrets (une seule fois)

```bash
node -e "const {authenticator}=require('otplib');const c=require('crypto');const s=authenticator.generateSecret();console.log('DASHBOARD_TOTP_SECRET='+s);console.log('DASHBOARD_SESSION_SECRET='+c.randomBytes(32).toString('hex'));console.log('OTPAUTH_URI='+authenticator.keyuri('releaf-dashboard','Releaf Dashboard',s));"
```

Mettre les 2 dans `.env` (local) **et** dans Render → Settings → Environment.

## Enrôler le TOTP dans l'app authenticator

À partir de l'`OTPAUTH_URI` généré, soit :
- scanner le QR code (généré via `qrcode`), soit
- ajouter le secret manuellement dans l'app (Google Authenticator / Authy / 1Password…).

Comme le secret est **partagé**, les associés enrôlent le **même** secret → chacun a le
même code à un instant T. C'est voulu pour un outil interne.

## Rotation / révocation

- **Invalider toutes les sessions actives** : changer `DASHBOARD_SESSION_SECRET` (les cookies
  existants ne valident plus).
- **Régénérer le code** : générer un nouveau secret, mettre à jour `DASHBOARD_TOTP_SECRET`,
  ré-enrôler les apps.

## Fichiers concernés

- `server.js` — bloc « Authentification du dashboard pilote » : env, helpers session,
  `dashboardGate`, endpoints `/api/dashboard-login|logout|auth-status`.
- `public/dashboard-login.html` — page de login (code à 6 chiffres).
- `public/pilot.html` — bouton de déconnexion (`dashboardLogout()`).
