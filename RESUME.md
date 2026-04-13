# Releaf Prospector - Project Resume

## Project Overview
**Releaf Prospector** is a dual-stack LinkedIn prospecting & CRM management application for Releaf Carbon. It combines automated LinkedIn prospect scraping with manual CRM management, featuring AI-powered messaging via Claude API and HubSpot integration.

**Core Features:**
- LinkedIn Sales Navigator prospect scraping (Task 1 - automated)
- LinkedIn sequence execution with AI-generated messages (Task 2 - manual validation required)
- CRM dashboard with prospect management, campaigns, and reminders
- HubSpot deal synchronization
- Multi-tenant architecture with Row Level Security (RLS)

## Tech Stack & Architecture

### Backend
- **Runtime:** Node.js/Express (CommonJS, ~6000 lines in `server.js`)
- **Database:** Supabase PostgreSQL with RLS policies
- **APIs:** HubSpot (EU/US region auto-detection), Claude AI, Gmail/mailparser, Google APIs
- **Auth:** PIN-based authentication (birthdates) → JWT tokens
- **Deployment:** Render (Procfile: `web: npm run frontend:build && npm start`)

### Frontend
- **Framework:** React 18 + Vite (ES modules) for auth/login
- **Legacy UI:** Vanilla JS + HTML/CSS for main CRM (`public/prospector.html`)
- **Styling:** Custom CSS variables matching design system
- **Charts:** Chart.js integration

### Key Dependencies
```json
{
  "@anthropic-ai/sdk": "^0.80.0",
  "@supabase/supabase-js": "^2.99.1",
  "express": "^4.18.2",
  "jsonwebtoken": "^9.0.3",
  "mailparser": "^3.9.4",
  "react": "^18.2.0",
  "googleapis": "^171.4.0"
}
```

## Project Structure

```
hubspot-dashboard/
├── server.js                 # Monolith backend (~6000 lines)
├── src/                      # React frontend (auth/login)
│   ├── App.jsx              # Main React app
│   ├── components/LoginPage.jsx
│   └── lib/
│       ├── apiFetch.js      # API helper with Bearer token injection
│       └── supabase.js      # Supabase client init
├── public/                   # Static files & legacy CRM UI
│   ├── prospector.html      # Main CRM SPA (vanilla JS)
│   ├── pilot.html          # Dashboard redirect
│   ├── css/prospector.css   # CRM styles
│   └── js/
│       ├── prospector.js    # CRM logic (~main dispatch system)
│       ├── prospector-db.js # Supabase layer
│       └── prospector-ui.js # UI components
├── migrations/              # Database setup (9 files)
│   ├── 01_multi_user_foundations.sql
│   ├── 02_rls_policies.sql
│   └── ... (through 09_dispatch_summaries.sql)
├── CRM/                     # Documentation & screenshots
├── data/                    # Static data files
└── .env.example            # Environment template
```

## Authentication & Security

### PIN-Based Auth (No Magic Links)
- **Users:** Nathan (19970705), Guillaume (19970921), Vincent (19970624)
- **Flow:** PIN entry → JWT token with `account_id` claim → RLS filtering
- **Multi-tenant:** All data filtered by `account_id` at database level

### Security Layers
1. **Client:** JWT Bearer tokens in localStorage
2. **Server:** `accountContext` middleware + manual `account_id` filtering
3. **Database:** RLS policies on all tables (cannot be bypassed)

### Admin Features
- Account switching via `X-Switch-Account` header (Nathan only)
- Access to all accounts via `/api/accounts` endpoint

## Database Schema & RLS

### Core Tables (Multi-tenant)
- `accounts` - User accounts with PIN auth
- `prospects` - LinkedIn prospects with status tracking
- `campaigns` - Prospecting campaigns
- `sequences` - Message sequences for campaigns
- `steps` - Individual sequence steps
- `enrollments` - Prospect-campaign relationships
- `task_locks` - Prevents concurrent automation tasks
- `dispatch_summaries` - Automation execution logs

### RLS Policies
- **Rule:** `account_id` column on every table
- **Policy:** `auth.jwt() ->> 'account_id' = account_id`
- **Server:** Uses `supabaseAdmin` client (bypasses RLS for cross-account operations)

## Core Workflows

### Task 1: LinkedIn Scraping (Automated)
- **Schedule:** Mon-Fri 10:05 AM
- **Chrome Profile:** `Sales_nav`
- **Source:** Sales Navigator searches
- **Output:** Prospect profiles → validation queue
- **Lock:** `linkedin_task1` (prevents concurrent runs)

### Task 2: Sequence Dispatch (Manual Validation)
- **Trigger:** Manual execution via UI
- **Chrome Profile:** `Nathan`
- **Process:** AI-generated messages via Claude → Nathan approval → LinkedIn actions
- **Lock:** `linkedin_task2` (prevents concurrent runs)

### Key Rules
- **Never bypass RLS** - auth is two-layer (server middleware + database policies)
- **Always use `accountContext`** middleware on protected routes
- **Never modify `prospector.js`** without review (used by automated tasks)
- **Always use `supabaseAdmin`** on server side
- **Multi-tenant isolation:** ALL queries MUST include `account_id` filtering

## API Endpoints

### Authentication
- `POST /api/auth/login` - PIN authentication
- `GET /api/accounts/me` - Current account info
- `GET /api/accounts` - All accounts (admin only)

### CRM Core
- `GET /api/prospects` - List prospects with filtering
- `POST /api/prospects` - Create prospect
- `PUT /api/prospects/:id` - Update prospect
- `GET /api/campaigns` - List campaigns
- `POST /api/campaigns` - Create campaign
- `GET /api/sequences` - Campaign sequences
- `POST /api/sequences` - Create sequence

### Automation
- `POST /api/task-locks/acquire` - Acquire automation locks
- `POST /api/task-locks/release` - Release locks
- `POST /api/dispatch/summaries` - Log automation results
- `POST /api/prospects/batch` - Bulk prospect import

### HubSpot Integration
- `GET /api/hubspot/deals` - Fetch closed-won deals
- `GET /api/hubspot/contacts` - Search contacts
- `POST /api/hubspot/sync` - Sync prospect to HubSpot

### AI Integration
- `POST /api/claude/generate` - Generate messages via Claude
- `POST /api/claude/context` - Get LinkedIn context for messaging

## Environment Setup

### Required Variables
```bash
# Supabase (from Settings → API)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
SUPABASE_JWT_SECRET=your_jwt_secret_here

# Frontend
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here

# APIs
HUBSPOT_API_KEY=pat-eu1-xxxxx...  # or hapikey-xxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxx...

# Server
PORT=3000
NODE_ENV=development
```

### Development Commands
```bash
npm start              # Backend server (port 3000)
npm run dev           # Backend with auto-restart
npm run frontend:dev  # Vite dev server (port 5173, proxies /api/*)
npm run frontend:build # Build React to /dist
npm run frontend:preview # Preview built app
```

### Database Setup
1. Run migrations in order: `01_multi_user_foundations.sql` through `09_dispatch_summaries.sql`
2. Configure RLS policies via `02_rls_policies.sql`
3. Set user PINs in `accounts` table

## Testing

### E2E Tests (Playwright)
- `test_campaigns_sequences.py` - Full workflow testing
- `test_prospector.py` - Additional test scenarios
- **Browser:** Headless Chromium
- **Auth:** Nathan account (admin)
- **Coverage:** Login, prospect management, campaign creation, sequence execution

### Test Data
- `data/revenus-exceptionnels.json` - Sample prospect data
- Screenshots in `CRM/` folder for UI validation

## Important Constraints & Rules

### Code Quality
- **Backend:** CommonJS (`require/module.exports`) - NO ES modules
- **Frontend:** Mixed - React (ES modules) + Vanilla JS (CommonJS)
- **Styling:** CSS custom properties, no CSS-in-JS
- **API Calls:** `fetch()` only, never `curl` or bash commands

### Automation Safety
- **LinkedIn Sessions:** Must verify active sessions before automation
- **Error Handling:** Try/catch per prospect, never fail entire batch
- **Locks:** Task locks prevent concurrent automation runs
- **Validation:** All AI-generated messages require Nathan approval

### Security
- **RLS:** Cannot be bypassed - enforced at database level
- **Auth:** Two-layer (middleware + policies)
- **Admin:** Account switching restricted to Nathan
- **API Keys:** PAT tokens (preferred) vs legacy hapikey

### Deployment
- **Platform:** Render
- **Build:** `npm run frontend:build && npm start`
- **Environment:** Production environment variables required
- **Database:** Supabase (managed PostgreSQL)

## Current State & Next Steps

### Implemented
- ✅ Multi-tenant architecture with RLS
- ✅ PIN-based authentication
- ✅ Basic CRM UI (prospects, campaigns, sequences)
- ✅ HubSpot deal synchronization
- ✅ LinkedIn scraping automation (Task 1)
- ✅ AI-powered message generation
- ✅ Sequence dispatch framework (Task 2)

### In Development
- 🔄 Full sequence execution automation
- 🔄 Advanced filtering and search
- 🔄 Email integration via Gmail API
- 🔄 Reminder system
- 🔄 Bulk import/export features

### Known Issues
- ⚠️ Mixed module systems (CommonJS/ES modules)
- ⚠️ Large monolithic `server.js` file
- ⚠️ Legacy vanilla JS UI needs modernization
- ⚠️ Limited error handling in automation tasks

---

**Last Updated:** April 7, 2026
**Project Status:** Active Development
**Primary Contact:** Nathan Gourdin (nathangourdin@releafcarbon.com)</content>
<parameter name="filePath">c:\Users\gourdin\hubspot-dashboard\RESUME.md