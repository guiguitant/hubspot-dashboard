# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Architecture Overview

**Releaf Prospector** is a dual-stack application for LinkedIn prospecting and CRM management:

### Backend (Node.js/Express)
- **Port**: 3000
- **Server**: `server.js` (~6000 lines)
- **Database**: Supabase PostgreSQL with Row Level Security (RLS)
- **Key Systems**:
  - Multi-tenant data isolation via `account_id` column and RLS policies
  - Supabase Magic Link authentication (passwordless email)
  - X-Account-Id header authentication for automated Dispatch tasks
  - HubSpot API integration (EU/US region detection)
  - Gmail integration with mailparser
  - Claude API for message generation

### Frontend (React/Vite)
- **Port**: 5173 (dev)
- **Entry**: `index.html` → `src/main.jsx` → `src/App.jsx`
- **Stack**: React 18, Vite 5, Supabase.js client
- **Key Files**:
  - `src/App.jsx`: Main app with auth state, session management, admin account switching
  - `src/components/LoginPage.jsx`: Magic Link email form + OTP verification
  - `src/lib/supabase.js`: Supabase client initialization
  - `src/lib/apiFetch.js`: API helper with Bearer token + admin header injection
  - `src/index.css`: Complete design system (green theme, responsive)

### Dispatch System (Autonomous Tasks)
- **File**: `public/js/prospector.js`
- **Auth**: `X-Account-Id` header (no JWT session)
- **Admin Switching**: `X-Switch-Account` header (Nathan only)
- **Purpose**: Automated LinkedIn sequence execution (Task 2)
- **Locking**: Task locks prevent concurrent execution on same account
- **Rate Limits**: Daily invitation/message quotas enforced

### Database
- **Supabase PostgreSQL**
- **Key Tables**:
  - `accounts`: User accounts with `email` and `is_admin` columns
  - `prospects`: Prospect data with LinkedIn URLs, company, job title
  - `prospect_account`: Junction table for prospect status/campaign/notes per account
  - `sequences`: LinkedIn outreach sequences with versioning
  - `sequence_steps`: Individual steps (visit_profile, send_invitation, send_message)
  - `prospect_sequence_state`: Real-time sequence state per prospect
  - `prospect_activity`: Prospect metadata (icebreaker, relevance score)
  - `task_locks`: Distributed locks to prevent concurrent task execution
- **RLS**: All tables protected by account_id policies (see RLS_SETUP.md)

### Authentication Flow

**Web Users (Magic Link)**:
1. User enters email → `POST /api/accounts/login` (Supabase OTP)
2. Click link in email → redirect to localhost:5173 with session hash
3. Supabase automatically creates session + JWT
4. `apiFetch` injects `Authorization: Bearer {token}` in all API requests
5. Server middleware `accountContext` verifies JWT and sets `req.accountId`

**Automated Tasks (Dispatch)**:
1. Task sends `X-Account-Id: {uuid}` header directly
2. Server middleware accepts header without JWT verification
3. `X-Switch-Account` header allows admin account switching (Nathan only)

---

## Development & Build

### Commands

```bash
# Backend development
npm start                 # Start Express server on port 3000
npm run dev             # Alias for npm start

# Frontend development
npm run frontend:dev    # Start Vite dev server on port 5173
npm run frontend:build  # Build React to /dist
npm run frontend:preview # Preview production build locally
```

### Development Workflow

**Terminal 1 (Backend)**:
```bash
npm start
# Starts on http://localhost:3000
# Serves /prospector for Dispatch, instructions for other routes
```

**Terminal 2 (Frontend)**:
```bash
npm run frontend:dev
# Starts Vite on http://localhost:5173
# Proxies /api/* requests to localhost:3000
# Magic Link auth redirects to localhost:5173
```

### Environment Variables

Required in `.env` (see `.env.example`):
```
# Supabase (from Settings → API → Project API Keys)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJh...
SUPABASE_SERVICE_ROLE_KEY=eyJh...
SUPABASE_JWT_SECRET=your_jwt_secret

# Frontend (same keys, prefixed with VITE_)
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJh...

# HubSpot API
HUBSPOT_API_KEY=pat-eu1-... or pat-us1-...

# Optional
PORT=3000
NODE_ENV=development
ANTHROPIC_API_KEY=sk-ant-...
```

**Note**: VITE_* variables are injected at build time by Vite. Restart `npm run frontend:dev` after changing `.env`.

---

## Server Architecture (server.js)

### Key Sections & Middleware

**Lines 1-120**: Initialization
- Supabase clients (anon + admin)
- HubSpot configuration (EU/US detection)
- JWT generation for RLS

**Lines ~3300-3365**: `accountContext` Middleware
- Extracts JWT from `Authorization: Bearer` header (Magic Link)
- Falls back to `X-Account-Id` header (Dispatch tasks)
- Supports `X-Switch-Account` header (admin switching)
- Sets `req.accountId` for downstream routes

**Lines ~40-75**: Root Route Handler
- Shows instructions for development
- Links to `/prospector` (Dispatch) and localhost:5173 (React)

**Lines ~300-1200**: HubSpot API Integration
- `hubspotRequest()`, `hubspotSearch()`: Low-level HTTP requests
- Deal search, contact lookup, custom fields

**Lines ~1200-2500**: Prospector Endpoints
- `GET /api/prospector/prospects`: List prospects (filtered by account_id + RLS)
- `POST /api/prospector/prospects`: Create prospect
- `GET/PUT /api/prospector/prospects/:id`: Detail & edit
- `GET /api/prospector/daily-stats`: Quotas (invitations/messages sent)
- `POST /api/prospector/daily-stats`: Update quota after action
- `GET /api/prospector/logs`: Activity logs
- `GET /api/prospector/campaigns`: List campaigns

**Lines ~2500-3300**: Prospect Details & Actions
- Interactions, reminders, company enrichment
- LinkedIn normalization
- Gmail integration

**Lines ~3365-4000**: Sequences API
- `GET /api/sequences`: Get sequence for campaign
- `POST /api/sequences`: Create sequence (with versioning)
- `PUT/DELETE /api/sequences/:id`: Update/delete
- `POST /api/sequences/:sid/steps`: Add step to sequence
- `POST /api/sequences/:sid/steps/reorder`: Drag & drop reordering
- `POST /api/sequences/generate-message`: Claude message generation (rate-limited)
- `POST /api/sequences/enroll`: Enroll prospect in sequence
- `GET /api/sequences/due-actions`: Get actions to execute (Dispatch)
- `POST /api/sequences/complete-step`: Mark step as sent

**Lines ~4000-4500**: Admin Endpoints
- `POST /api/accounts/login`: Supabase OTP request
- `GET /api/accounts/me`: Current authenticated user
- `GET /api/accounts`: List all accounts (admin only)

**Lines ~4500-5000**: Task Locks & Gmail
- `POST/GET /api/task-locks/acquire|release`: Distributed locking
- `POST /api/gmail/followup`: Claude 2-option follow-up generation

**Lines ~5000-5500**: Message Preview & State
- `GET /api/sequences/preview`: Get sequence with real-time state + icebreaker
- `GET /api/sequences/states`: Map of prospect_id → sequence state (for badges)
- `GET /api/logs?type=sequence`: Activity logs filtered by type

**Lines ~5500+**: Server Startup
```javascript
app.listen(PORT, () => {
  console.log(`Releaf Pilot démarré sur http://localhost:${PORT}`);
});
```

### Key Patterns

**Always use `accountContext` middleware on protected routes**:
```javascript
app.get('/api/path', accountContext, async (req, res) => {
  // req.accountId is now set
  const { data, error } = await supabaseAdmin
    .from('table')
    .select(...)
    .eq('account_id', req.accountId);  // Always filter!
});
```

**RLS is the second layer of protection** — never rely solely on server-side filtering. Database RLS policies prevent data leakage even if server code has bugs.

**JWT tokens are generated server-side** via `generateSupabaseJWT(accountId)` for clients needing to query Supabase directly (with RLS protection).

---

## Frontend Structure (React/Vite)

### Flow

1. **App Initialization** (`src/App.jsx`)
   - Check for active Supabase session
   - If logged in: show MainApp (placeholder for prospector integration)
   - If not: show LoginPage

2. **LoginPage** (`src/components/LoginPage.jsx`)
   - Email input form
   - Supabase OTP: `supabase.auth.signInWithOtp({ email })`
   - Confirmation message
   - Automatic redirect after OTP click (via hash)

3. **Session Management** (`src/App.jsx`)
   - `setApiFetchContext()` initializes token + account switching
   - Admin banner shows yellow "🔧 Admin" switcher if `is_admin = true`
   - `sessionStorage` stores active account ID (survives page reload, reset on Ctrl+Shift+R)

4. **API Calls** (`src/lib/apiFetch.js`)
   - Wrapper around `fetch()`
   - Injects `Authorization: Bearer {JWT token}`
   - Injects `X-Switch-Account` header if admin is switching accounts
   - Used by components instead of raw `fetch()`

### CSS Design System (`src/index.css`)

- **Primary color**: `#2D6A4F` (green)
- **Primary hover**: `#245840`
- **Light green**: `#B7E4C7`
- **Warning color**: `#F59E0B` (yellow, used for admin badge)
- **Error color**: `#EF4444` (red, logout button)
- **Surface/background**: Light gray (`#F9FAFB`, `#FFFFFF`)

Responsive design via `@media (max-width: 768px)` flexbox adjustments.

---

## Database Migrations

Run migrations in Supabase SQL Editor (Settings → SQL Editor → New Query):

```bash
# 1. Create sequences schema (Sprint 1)
migrations/01_sequences.sql

# 2. Create RLS policies (multi-tenant security)
migrations/02_rls_policies.sql
migrations/03_rls_policies_extended.sql

# 3. Add auth columns to accounts table
migrations/07_auth_supabase.sql
# Creates: email (UNIQUE), is_admin (DEFAULT false)
```

After migration, manually update email + is_admin in `accounts` table:
```sql
UPDATE accounts SET email = 'user@example.com', is_admin = false WHERE id = ...;
UPDATE accounts SET email = 'nathan@example.com', is_admin = true WHERE slug = 'nathan';
```

---

## Common Tasks

### Adding a New Protected API Endpoint

1. Add `accountContext` middleware
2. Always filter by `req.accountId`
3. Use `supabaseAdmin` (server has full access, trusts account_id)

```javascript
app.get('/api/new-endpoint', accountContext, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('my_table')
    .select('*')
    .eq('account_id', req.accountId);
  res.json(data);
});
```

### Exposing an Endpoint to Dispatch (X-Account-Id)

No changes needed — `accountContext` automatically handles both JWT + X-Account-Id. The endpoint works for both web and Dispatch.

### Integrating Prospector into React

Currently, the prospector UI is in `/prospector` (vanilla JS). To integrate it into React:

1. Migrate `public/js/prospector.js` UI components to `src/components/Prospector.jsx`
2. Replace `<MainApp />` placeholder in `src/App.jsx` with `<Prospector />`
3. Update `apiFetch.js` for any additional headers (most endpoints already use `accountContext`)

### Testing Admin Account Switching

1. Log in as Nathan (admin) on localhost:5173
2. Admin switcher dropdown appears in header
3. Select another account (Guillaume, Vincent)
4. `X-Switch-Account` header is injected, server honors it
5. Prospector data changes to selected account
6. Logout or refresh resets to Nathan's own data

---

## Deployment (Render)

**Backend + Frontend served together**:
- `npm run frontend:build` builds React to `/dist`
- Express serves `dist/` files on production
- Frontend routes go to React, `/api/*` routes go to Express
- ENV variables must include all SUPABASE_* and VITE_SUPABASE_* keys

**Manual redeploy required** after `git push`:
- Go to Render dashboard
- Click "Manual Deploy" or "Redeploy"
- Render rebuilds and restarts the service

---

## Key Documentation

- **AUTH_SETUP.md**: Manual Supabase configuration (Magic Links, redirect URLs, variables)
- **RLS_SETUP.md**: Row Level Security policies explanation
- **SKILL.md**: Dispatch workflow (Task 2) — task locks, quotas, actions, step completion
- **CRM/DISPATCH_INSTRUCTIONS.md**: High-level Dispatch architecture
- **CRM/PROSPECTOR_BRIEF.md**: Feature overview

---

## Important Notes

- **Do NOT modify `prospector.js` lightly** — it's used by automated Dispatch tasks and must remain stable
- **RLS is mandatory** — never bypass it, even for admin endpoints. Auth happens at two levels: server + database
- **X-Account-Id is trusted** — Dispatch tasks send it; server assumes they're authorized. In production, use secrets/tokens to verify
- **Package.json has no "type": "module"** — the backend is CommonJS (require/module.exports). Frontend uses ES modules via Vite
- **Vite proxies `/api/*` to localhost:3000** in development — this is configured in `vite.config.js`, not backend
