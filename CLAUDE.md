# Releaf Prospector
Dual-stack LinkedIn prospecting & CRM management application.

## Tech Stack
- Node.js/Express backend (CommonJS) + React 18/Vite frontend (ES modules)
- Supabase PostgreSQL with Row Level Security (RLS)
- HubSpot API (EU/US region detection), Claude API, Gmail/mailparser

## Commands
- `npm start` - Backend server (port 3000)
- `npm run frontend:dev` - Vite dev server (port 5173, proxies /api/* to backend)
- `npm run frontend:build` - Build React to /dist

## Important Files
- `server.js` - Monolith backend (~6000 lines) with all API endpoints
- `public/js/prospector.js` - Dispatch system (automated LinkedIn sequence execution)
- `src/lib/apiFetch.js` - API helper with Bearer token + admin header injection
- `src/lib/supabase.js` - Supabase client initialization

## Rules
- **NEVER** bypass RLS — auth is two layers: server middleware (`accountContext`) + database policies
- **ALWAYS** use `accountContext` middleware on protected routes and filter by `req.accountId`
- **NEVER** modify `prospector.js` without careful review — used by automated Dispatch tasks
- **ALWAYS** use `supabaseAdmin` on server side (not anon client)
- Multi-tenant isolation: all data queries MUST include `account_id` filtering
- Auth modes: JWT Bearer token (web users) and `X-Account-Id` header (Dispatch tasks)
- Admin switching uses `X-Switch-Account` header (Nathan only)
- Backend is CommonJS (`require`/`module.exports`) — no `import/export`

## Key Docs
- `AUTH_SETUP.md` - Supabase Magic Link config
- `RLS_SETUP.md` - Row Level Security policies
- `SKILL.md` - Dispatch workflow (task locks, quotas, step completion)
