# AIRIntel

AIRIntel (AirRoute Intelligence) is an evidence-based live and historical aircraft analysis platform. Phase One establishes the Leaflet/Mapbox UI, strict aircraft observation contract, provider-neutral gateway boundary, and secured PostGIS foundation on Neon.

## Real-data policy

This repository contains no simulated or mock aircraft. Without approved Mapbox and aircraft-provider configuration, the application shows honest configuration-required states.

## Mapbox setup

AIRIntel keeps Leaflet as the map engine and uses Mapbox Static Tiles as the basemap. The browser requires a **public Mapbox access token** beginning with `pk.`. Never use or commit a Mapbox secret token in frontend configuration.

Two setup paths are supported:

1. **Local browser setup:** Open **Map settings** in the live map, enter a public `pk.` token and a style such as `mapbox/streets-v12`, then save. The values are stored only in that browser's local storage.
2. **Deployment/environment setup:** Set `VITE_MAPBOX_ACCESS_TOKEN` and `VITE_MAPBOX_STYLE` in the deployment environment. Do not commit real credentials to this repository.

Accepted style input includes either `username/style-id` or `mapbox://styles/username/style-id`. The Leaflet Static Tiles integration currently cannot use Mapbox Standard/Standard Satellite; use a supported published classic/custom style such as `mapbox/streets-v12` or an eligible Mapbox Studio style.

## Stack

React + Vite + strict TypeScript (browser) · Hono API in `server/` (Neon Function or any Node host) · **Neon** Postgres/PostGIS · **Neon Auth** (Managed Better Auth) · raw SQL via `pg` (no ORM) · Zod contracts.

| Concern | Where |
| --- | --- |
| Database schema | `db/migrations/*.sql` (run with `npm run db:migrate`) |
| Auth (sign-up/in, sessions, JWTs) | Neon Auth; browser client in `src/lib/auth.ts`, JWT verification in `server/auth.ts` |
| API (history, profile, aircraft, satellites) | `server/` (entry `functions/api.ts`, declared in `neon.ts`) |
| Who may call protected routes | `airintel_private.access_grants` (manage with `npm run access:grant`) |

## Set up Neon

1. **Create a Neon project** at <https://console.neon.tech>. Pick an AWS region that supports Neon Functions (`aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1` or `aws-ap-southeast-1`) if you want Neon to host the API.
2. **Install and link the CLI** (`npm i -g neon`, `neon auth`, then `neon link` in this folder). `neon link` writes `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and, once Auth is enabled, `NEON_AUTH_BASE_URL` / `NEON_AUTH_JWKS_URL` to `.env.local` (git-ignored). Without the CLI, copy the same values from the Console (**Connect** and **Auth → Configuration**) into `.env.local` using `.env.example` as the template.
3. **Enable Neon Auth.** `neon deploy` reads `neon.ts` (`auth: true`) and enables Managed Better Auth on the branch, or enable it in Console → **Auth**. Add your deployed app origin(s) under **Auth → Configuration → Domains** (`neon neon-auth domain add https://your-app.example`); `localhost` is pre-approved.
4. **Apply the schema:** `npm run db:migrate` (idempotent; applies `db/migrations/*` once and re-applies `db/repeatable/*` every run). Requires PostGIS and pgcrypto, both available on Neon.
5. **Run locally:** `npm run api:dev` (API on <http://localhost:8787>) and `npm run dev` (UI on <http://localhost:5173>), with `VITE_NEON_AUTH_URL`, `VITE_HISTORY_API_URL=http://localhost:8787/history` and `VITE_PROFILE_API_URL=http://localhost:8787/aircraft-profile` set in `.env.local`.
6. **Create an account** in the UI (Sign in → Need an account?), then grant yourself access:
   `npm run access:grant -- --email you@example.com --scope history --scope profile`
   (`history` = recorded-aircraft search/replay/analytics, `profile` = FAA-registry-backed profiles).
7. **Deploy the API:** `ALLOWED_ORIGINS=https://your-app.example neon deploy` publishes the `api` Neon Function (`DATABASE_URL`, `NEON_AUTH_*` are injected). Put its invocation URL (`neon functions get api`) into `VITE_HISTORY_API_URL` (`<url>/history`), `VITE_PROFILE_API_URL` (`<url>/aircraft-profile`) and `VITE_AIRCRAFT_API_URL` (`<url>/aircraft-nearby`) and rebuild the UI. For Cloud Run, set the same values as the `_VITE_*` substitutions in the Cloud Build trigger (`cloudbuild.yaml`).

There is no object storage dependency: AIRIntel stores no user files. See `docs/neon-migration.md` for the Supabase → Neon mapping and open decisions.

## Local setup

```powershell
npm install
Copy-Item .env.example .env.local   # then fill in the Neon values (see "Set up Neon")
npm run db:migrate
npm run api:dev     # terminal 1
npm run dev         # terminal 2
```

Configure only browser-safe values in `VITE_*`. Aircraft-provider credentials, `DATABASE_URL` and other server values belong in the API's environment (Neon Function env / `.env.local` for local runs), never in a `VITE_*` variable.

## Verification

```powershell
npm run typecheck
npm test
npm run build
```

`npm test` also runs `server/neon.integration.test.ts` when `TEST_DATABASE_URL` (a **throwaway** Neon branch) and `TEST_NEON_AUTH_BASE_URL` are set; it applies the migrations, signs real users up through Neon Auth and exercises every protected route. Without them those 6 tests are skipped.

## Phase One status

- React, Vite, strict TypeScript, Leaflet, TanStack Query, and Zod foundation
- Mapbox Static Tiles basemap with local setup dialog and environment-variable support
- Canonical observation and radius-query validation
- Provider-neutral interface and safe browser gateway client
- Explicit provider-unconfigured, empty, refresh, and error states
- Phase 1 PostGIS migration with RLS and server-only ingestion
- Phase 2 authenticated registration/ICAO24/callsign search, atomic recorder transaction, 24-hour spatial replay, and per-source gap handling
- Phase 3 groundwork for authenticated aircraft-profile contracts, FAA storage boundaries, owner/operator separation, and per-source statistics; real FAA import and public profile deployment remain gated

Live aircraft remain blocked until the provider onboarding gate in `docs/provider-onboarding.md` is completed.

Phase Two implementation details and deployment gates are documented in `docs/phase-two-flight-recorder.md`.
