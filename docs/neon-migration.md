# Supabase → Neon migration

Status: implemented on branch `neon-migration`. Verified against a real (temporary) Neon project; see "Verification" below.

## What AIRIntel actually used from Supabase

| Supabase feature | Where | Neon replacement |
| --- | --- | --- |
| Postgres + PostGIS + pgcrypto | `supabase/migrations/0001-0003` | Neon Postgres 17 with the same extensions. Migrations moved to `db/migrations` unchanged except for Supabase role statements. |
| Roles `anon` / `authenticated` / `service_role` and their grants | every migration | Removed. The API connects as the Neon database owner (RLS-bypassing, owns everything). Browser-facing roles (`authenticated`, `anonymous` from the Neon Data API, legacy `anon`) are revoked by `db/repeatable/R__lock_down_browser_roles.sql` on every migrate. |
| RLS enabled, deny-by-default, no policies | all tables | Kept as defense in depth. No `auth.uid()` policies existed, so none needed converting. |
| `security definer` function `record_aircraft_observation` | `0002` | Kept. PostGIS calls are now schema-qualified (`public.st_setsrid(...)`) because the function sets `search_path = ''`; the unqualified form would have failed at runtime. |
| Supabase Auth (client `getSession()`, `auth.getUser()` in functions) | `src/lib/supabase.ts`, `history`, `aircraft-profile` | Neon Auth (Managed Better Auth) via `@neondatabase/neon-js`. Browser sends a 15-minute EdDSA JWT; the API verifies it with `jose` against the Neon Auth JWKS. The repo had no sign-in UI, so a minimal email/password panel was added (`src/components/AuthPanel.tsx`). |
| `app_metadata.airintel_access` / `airintel_profile_access` JWT flags | edge functions | Neon Auth does not support custom JWT claims. Replaced by `airintel_private.access_grants (user_id, scopes)`; manage with `npm run access:grant/revoke/list`. |
| Edge Functions (Deno): `aircraft-nearby`, `history`, `aircraft-profile`, `satellites-nearby`, `satellite-passes` | `supabase/functions` | One Hono app (`server/`) deployed as the Neon Function `api` (`functions/api.ts`, `neon.ts`). Same query parameters and JSON shapes; the PostgREST calls became SQL. The same app runs on any Node host (`npm run api:dev`). |
| `supabase-js` PostgREST queries / `rpc()` | edge functions | `pg` pool against the pooled `DATABASE_URL`. |
| Storage buckets | — | **Not used.** Nothing is uploaded or stored as a file. No bucket created. |
| Realtime | — | Not used (UI polls). |
| Cron / scheduled functions | — | Not used. The documented `purge_expired_faa_registry_raw()` job still needs a scheduler (see open decisions). |
| Seed data | — | None, by policy (`AGENTS.md`: no simulated aircraft). |
| CI / deploy | Dockerfile, `cloudbuild.yaml` (Cloud Run + nginx static SPA) | Unchanged hosting. Build args for the public `VITE_*` values were added. |

## Decisions and deviations

- **Storage:** no storage was needed, so none was added. (Neon now offers S3-compatible Object Storage and `buckets` in `neon.ts` if a future phase, e.g. FAA snapshot archives, needs files.)
- **API host:** the Edge Functions had to go somewhere. Neon Functions (Node 24, `fetch` handler) were chosen so the API sits next to the database and receives `DATABASE_URL`/`NEON_AUTH_*` automatically. The code is host-neutral (Hono), so Cloud Run or Vercel would also work.
- **Neon Data API stays off.** The browser never queries tables.
- **Existing users:** none can be migrated (Supabase password hashes are not importable) and none are known to exist; the project was unverified.
- **Beta SDK:** `@neondatabase/neon-js` is currently published as `0.7.0-beta`.

## Behaviour notes (parity with the Edge Functions)

- `insights.summary.sourceCount` now reports the real number of data sources (the old code always returned 0).
- `history?action=nearby` returns `callsign` (the old query never selected it).
- Pre-existing logic kept as is: a withheld/redacted FAA owner is reported with status `unknown` rather than `withheld_or_unavailable`; `nearby` still filters 5,000 most recent positions in memory with a flat-earth distance approximation; rate limits are per-process.

## Rollback

Nothing destructive happens to existing data (there was none to migrate). To go back: revert the PR (Supabase files are restored from git history), re-create the Supabase project, and re-apply the original three migrations. The Neon project can simply be deleted.

## Open decisions

1. Hosting for the API in production (Neon Function vs. Cloud Run) and the CORS origin list.
2. Email verification / password reset UI (Neon Auth supports both; not built).
3. OAuth providers (Google/GitHub) - one config switch in Neon plus a `signIn.social` button.
4. Durable rate limiting and a scheduler for `purge_expired_faa_registry_raw()` (already listed as deployment gates in `docs/phase-three-aircraft-intelligence.md`).

## CI

No GitHub Actions workflow existed. `docs/ci.example.yml` is a ready-to-copy workflow (typecheck, tests, build); it was not placed in `.github/workflows` because the automation token used for this migration cannot push workflow files.
