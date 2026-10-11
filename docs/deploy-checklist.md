# AIRIntel deployment checklist (Vercel + Neon)

Last updated: 2026-10-02 by the automation run on branch `neon-migration` (PR #8).
Status legend: **DONE** = finished and verified, **PENDING-USER** = needs an action only the repo/account owner can take, **N/A** = intentionally unused.
Secrets are listed by **name only**. Never commit values; set them in Vercel (Project → Settings → Environment Variables) or Neon.

## Target shape

One Vercel project serves everything from one origin:

- `dist/` – the Vite SPA (framework preset **Vite**).
- `api/index.ts` – a Vercel serverless function that mounts the Hono app from `server/` under `/api` (`vercel.json` rewrites `/api/*` to it).
- Browser env points at relative URLs (`/api/history`, `/api/aircraft-profile`, `/api/aircraft-nearby`), so there is no CORS between SPA and API, and no per-deployment URL to configure.
- `Dockerfile`/`cloudbuild.yaml` (Cloud Run) and `neon.ts`/`functions/api.ts` (Neon Function) stay in the repo, **unused** (N/A).
- `npm run api:dev` (Node server on :8787) keeps working for local development.

## 1. Environment variables

Set for **Preview** and **Production** (add **Development** if you use `vercel dev`).

| Name | Secret? | Value comes from |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon pooled connection string (Console → Connect, "Pooled"). Injected automatically if you add Neon through the Vercel Marketplace. |
| `NEON_AUTH_BASE_URL` | no (but server-side) | Neon Console → Auth → Configuration (ends in `/auth`). |
| `NEON_AUTH_JWKS_URL` | no | Optional; derived from `NEON_AUTH_BASE_URL` when empty. |
| `ALLOWED_ORIGINS` | no | Comma-separated browser origins that may call the API, e.g. the stable Vercel URL(s) and the custom domain. Same-origin SPA calls with `Sec-Fetch-Site: same-origin` are also accepted, so a missing entry will not break the SPA itself. |
| `VITE_NEON_AUTH_URL` | no (public) | Same value as `NEON_AUTH_BASE_URL`. |
| `VITE_HISTORY_API_URL` | no (public) | `/api/history` |
| `VITE_PROFILE_API_URL` | no (public) | `/api/aircraft-profile` |
| `VITE_AIRCRAFT_API_URL` | no (public) | `/api/aircraft-nearby` (optional on Vercel — SPA defaults to this path when empty) |
| `ADSB_PROVIDER` | no | `adsb_lol` (default when unset) or `off` to disable live aircraft |
| `VITE_MAPBOX_ACCESS_TOKEN` | no (public `pk.` token) | Mapbox account → public default token. Without it the UI shows the Mapbox setup modal. |
| `VITE_MAPBOX_STYLE` | no | `mapbox/streets-v12` |
| `VITE_APP_NAME`, `VITE_DEFAULT_*`, `VITE_POLL_INTERVAL_SECONDS` | no | Optional; defaults exist in `.env.example`. |
| `CRON_SECRET` | **yes (server-only)** | `openssl rand -hex 32` (≥ 24 chars). Required for the always-on net; the sweep endpoint answers 503 without it. Never a `VITE_` variable. |
| `NET_SWEEP_MAX_AREAS`, `NET_SWEEP_MARGIN_FACTOR`, `NET_SWEEP_MIN_INTERVAL_SECONDS`, `NET_SWEEP_BUDGET_MS` | no | Optional sweep tuning, defaults in `.env.example`. |
| `NET_RETENTION_DAYS` | no | Optional (≥ 7). Unset keeps all observations; recommended `90`. |
| `DATABASE_URL_UNPOOLED` | yes | **Not needed on Vercel.** Only for running `db:migrate` / `access:*` from your own machine (put it in `.env.local`). |

Every `VITE_*` value is baked in at build time: change one → redeploy.

**Vercel Neon integration prefix.** If Neon was connected through the Vercel Marketplace with the `SERVERSIDE_NEON` prefix, it writes `SERVERSIDE_NEON_NEON_AUTH_BASE_URL` (and `SERVERSIDE_NEON_NEON_AUTH_JWKS_URL` if present) and `SERVERSIDE_NEON_VITE_NEON_AUTH_URL`. The API and the SPA fall back to those names when `NEON_AUTH_BASE_URL` / `VITE_NEON_AUTH_URL` are unset; the plain names always win when both exist. Other prefixes (e.g. `NEON_STORE_`) are not read. `SERVERSIDE_NEON_VITE_` is listed in `envPrefix` in `vite.config.ts`, so it is baked into the bundle like any `VITE_*` value.

## 2. Neon project

- [ ] Create (or claim) a non-expiring Neon project (Postgres 17, PostGIS available). Recommended: Vercel dashboard → Storage → Create → Neon (Marketplace), which creates the project and injects `DATABASE_URL`.
- [ ] Enable **Neon Auth** (Console → Auth → Enable). Copy the Auth base URL into `NEON_AUTH_BASE_URL` and `VITE_NEON_AUTH_URL`.
- [ ] **Trusted origins/domains:** Console → Auth → Configuration → Domains → add every origin the SPA is served from (`https://<project>.vercel.app`, the preview alias, the custom domain). `localhost` is trusted by default. Neon Auth rejects sign-in/sign-up from any other origin with `INVALID_ORIGIN` (HTTP 403). CLI alternative: `neon neon-auth domain add <origin>`.
- [ ] Neon Data API stays **off** (the browser never queries tables).

## 3. Migrations

- [ ] `DATABASE_URL_UNPOOLED=<direct string> npm run db:migrate` (applies `db/migrations/0001-0005` and the repeatable role lockdown). Idempotent; re-run after every new migration. Migrations are **not** run by the Vercel build.

## 4. Vercel project / build settings

- [ ] Import `immahugeduck/AIRintel` (Vercel → Add New → Project). Framework preset **Vite**; root directory `.`; install `npm ci`; build `npm run build`; output `dist`. These are also pinned in `vercel.json`, so defaults are fine.
- [ ] Node.js version 20.x or newer (Project → Settings → General).
- [ ] Production branch `main`; the `neon-migration` branch gets Preview deployments automatically once the project is linked.
- [ ] Deployment Protection: if you want to open the Preview URL on a phone without a Vercel login, Settings → Deployment Protection → set **Vercel Authentication** to Disabled (or use a Protection Bypass).
- [ ] Verify `https://<deployment>/api/health` returns `{"ok":true,"database":true,"auth":true}`.

## 5. API hosting

- [x] **DONE (code):** `api/index.ts` + `vercel.json` rewrite; server imports use `.js` specifiers (strict ESM); DB pool capped at 3 on Vercel. Verified by compiling with `module: nodenext` and calling the handler, and by an end-to-end browser run of the same shape (built SPA + `/api` on one origin) against Neon.
- [ ] Function region: choose the Vercel region closest to the Neon region (Settings → Functions).
- N/A Cloud Run (`Dockerfile`, `cloudbuild.yaml`) and Neon Function (`neon.ts`, `functions/api.ts`) – unused, kept for reference.

## 6. Auth redirects / allowed origins

- Neon Auth: trusted domains (section 2). Email/password only; no redirect URLs are used today (no OAuth, no email-verification links).
- API: `ALLOWED_ORIGINS` (section 1). Requests from other browser origins get `403 origin_not_allowed`; same-origin calls from the SPA are accepted.

## 7. First-user access grant

1. Open the deployed app, **Sign in → Need an account?**, create the account.
2. From a machine with the repo and `DATABASE_URL_UNPOOLED` (or `DATABASE_URL`) set to the same database:
   `npm run access:grant -- --email you@example.com --scope history --scope profile`
3. Reload the app; History search and aircraft profiles now work. Without the grant they return `403`.
   `npm run access:list` / `npm run access:revoke -- --email …` manage grants.

## 8. CI

- [ ] `.github/workflows/ci.yml` runs typecheck, tests and build on every PR and push to `main` (node 22). Pushing workflow files needs a token with the `workflow` scope.
- [ ] Optional: set repo secrets `TEST_DATABASE_URL`/`TEST_NEON_AUTH_BASE_URL` to run `server/neon.integration.test.ts` against a throw-away Neon branch.

## 9. Always-on net

- [ ] `npm run db:migrate` (applies `0005_net_watch_areas.sql`).
- [ ] Set `CRON_SECRET` on Vercel (Production + Preview) and redeploy. Check `GET /api/health` → `config` is `ok`.
- [ ] GitHub → Settings → Secrets and variables → Actions: add `AIRINTEL_SWEEP_URL` (`https://<domain>/api/net/sweep`) and `CRON_SECRET` (same value). Run **Net sweep** manually once: it must succeed.
- [ ] Optional, 1-minute sweeps on Vercel **Pro**: add `"crons": [{ "path": "/api/net/sweep", "schedule": "* * * * *" }]` to `vercel.json`. Do not add this on Hobby (deploy fails). Or point a free external pinger at the URL with the bearer header (see `docs/netted-aircraft.md`).
- [ ] Optional: `NET_RETENTION_DAYS=90`.
- [ ] In the app: sign in → More → turn on **Keep netting when app is closed** → the status reads "Net active" after the first sweep.

## 10. Domains

- [ ] Optional custom domain: Vercel → Settings → Domains. Then add it to Neon Auth trusted domains and `ALLOWED_ORIGINS`.

---

## Production go-live checklist

- [ ] `npm run typecheck`, `npm test`, `npm run build` pass (CI is green on `main`).
- [ ] Migrations 0001–0005 applied (`npm run db:migrate`); `npm run access:list` shows your `history` + `profile` grants.
- [ ] Env set on Vercel: `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `ALLOWED_ORIGINS`, `VITE_NEON_AUTH_URL`, `VITE_MAPBOX_ACCESS_TOKEN`, `CRON_SECRET`, API URL vars; no secret in any `VITE_*` variable.
- [ ] `GET /api/health` returns `ok` with database reachable and no config errors; after the first sweep `net.lastSweepAgeSeconds` is small.
- [ ] Neon Auth trusted domains include the production domain; sign-in works on a phone (verify on the preview: the Neon Auth packages ship their own Zod copy, which the build now dedupes to the app's copy).
- [ ] Response headers show the CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`; the browser console shows no CSP violations on Map, Aircraft, Netted, History and More.
- [ ] Net sweep verified (section 9) and a pass made while the app was closed shows in Netted.
- [ ] Optional: install the PWA from the phone browser menu; revoke any tokens that were pasted into chats.

## Run log (2026-10-02)

| Item | State | Notes |
| --- | --- | --- |
| Checklist | DONE | this file |
| Code for Vercel (api/, vercel.json, relative API URLs, same-origin guard, ESM imports) | DONE | `npm run typecheck`, 53 unit tests, build, nodenext compile + handler call, local e2e all pass |
| Local e2e in the Vercel shape (sign-up, sign-in, denied search 403, `access:grant`, successful search 200) | DONE | against the temporary Neon project, origin `http://localhost:5173` |
| Vercel project creation | PENDING-USER | the automation's Vercel connector is read/limited: project creation returns 403 `forbidden`. Import the repo in the Vercel dashboard (section 4). |
| Vercel env vars | PENDING-USER | blocked until the project exists (section 1). |
| Preview deployment of `neon-migration` | PENDING-USER | starts automatically after import. |
| Real Neon project | PENDING-USER | no Neon API key / CLI / Marketplace access for the automation. |
| Neon trusted domain for the Vercel URL | PENDING-USER | Neon Auth returns `INVALID_ORIGIN` for non-localhost origins; trusted domains cannot be changed on an unclaimed project. |
| Temporary Neon project | TEMPORARY | `young-queen-06754269`, expires 2026-10-05 10:33 AM ET unless claimed. Migrations 0001-0004 already applied there. |
| CI workflow | PENDING-USER | token lacks `workflow` scope |
