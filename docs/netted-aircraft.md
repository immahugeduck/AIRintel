# Netted aircraft and the 7-mile watch radius

## Units and radius

- `src/domain/units.ts` holds every conversion: `WATCH_RADIUS_MI = 7` statute miles, `WATCH_RADIUS_NM ≈ 6.0828`, 1 kt = 1.150779 mph, 1 NM = 1852 m, 1 mi = 1609.344 m.
- Internally the app and API keep aviation units (NM, kt, ft, UTC ISO timestamps). Statute miles and mph exist only in the user-facing radius setting and the display formatters.
- The watch area (center + radius) lives in browser storage (`airintel.watchArea.v1`, Zod-validated on load). Center sources: device geolocation (only after the user taps **Use my current location**), a manually entered location, or the deployment default `VITE_DEFAULT_CENTER_LAT/LON`. Radius default: 7 mi (`VITE_DEFAULT_RADIUS_MI`), adjustable 1–50 mi.

## Visit ("entry") definition — `netted-visits-v1`

Implemented once in `src/domain/netted.ts` (`countRadiusVisits`) and used by both the API and the session-only fallback.
Per ICAO24, observations are sorted by `observedAt`. An observation **inside** the radius (haversine distance ≤ radius, inclusive) starts a new visit when:

1. it is the first observation of that aircraft in the window, or
2. the previous observation of that aircraft was **outside** the radius, or
3. more than **10 minutes** (`VISIT_GAP_MINUTES`) passed since the previous observation (reception gap).

Consecutive inside observations within 10 minutes continue the same visit. Nothing is interpolated across gaps.

## API

`GET /history?action=netted&lat=<deg>&lon=<deg>&radiusMi=<1-50, default 7>&hours=<1-168, default 24>` (Vercel: `/api/history?...`).

- Same protection as every history action: origin guard → Neon Auth JWT → `history` scope in `airintel_private.access_grants` → per-user rate limit. Invalid input → `400 invalid_netted_query`.
- SQL loads positions (≤ 50,000 rows, `truncated` flag when exceeded) for aircraft that had at least one position within the radius in the window, including positions out to 3× the radius so exits are seen when they were recorded. The authoritative inside/outside decision is made in TypeScript.
- `aircraftTypeCode` is the provider-reported type designator (adsb.lol `t`) from the latest retained raw observation, or `null` (shown as Unknown).
- Counts are derived from `public.aircraft_positions` on every request. Each aircraft also carries a `visits` list (newest first, capped): `enteredAt`, `lastSeenInRadiusAt`, `closestMi`, `observationCount`. The response includes the user's net status (`enabled`, `lastSweepAt`, `state` = `paused` | `pending` | `active` | `stale`).

## Live view → recorder

`GET /aircraft-nearby` remains public. When the request carries a valid Neon Auth JWT whose user holds the `history` grant, the observations just returned by adsb.lol are written through `recordObservations` → `public.record_aircraft_observation` (dedupe by provider record id, raw row kept in `airintel_private.raw_observations`). Limits: radius ≤ 50 NM, 12 writes/min per user, 6 s wait budget. The response field `recording` reports `recorded`, `not_signed_in`, `no_history_access`, etc. Anonymous callers never write.

## Always-on net (server-side sweep)

The live view only records while the app is open. The always-on net records while it is closed:

1. **Watch area.** `GET /history?action=watch-area` / `PUT /history?action=watch-area` (same stack as every history action: origin guard → JWT → `history` grant → rate limit → Zod `.strict()` body: `latitude`, `longitude`, `radiusMi` 1–50, `enabled`). Stored in `airintel_private.net_watch_areas` (one row per user; migration `0005_net_watch_areas.sql`; RLS on, browser roles have zero privileges). **More → Keep netting when app is closed** saves it.
2. **Sweep.** `GET|POST /api/net/sweep` requires `Authorization: Bearer $CRON_SECRET` (constant-time compare). It fails closed: `503 sweep_not_configured` when `CRON_SECRET` is unset or shorter than 24 chars, `401` for a missing/wrong secret. It takes a database lease (`airintel_private.net_sweep_state`) so overlapping runs never double-write (a second caller gets a `skipped_locked` summary), loads enabled areas (least recently polled first, at most `NET_SWEEP_MAX_AREAS`, skipping areas polled less than `NET_SWEEP_MIN_INTERVAL_SECONDS` ago), merges overlapping areas into one provider query, fetches **real** aircraft from adsb.lol with timeout + retry/backoff, records them through the same `recordObservations` path as the live view (provider record id dedupe, observed and received timestamps, raw payload kept server-side only) and updates `last_polled_at` / `last_poll_status`. The JSON response is a compact summary (areas queried/covered/deferred, observations fetched/inserted/rejected, error codes). Raw provider payloads and secrets are never returned or logged.
3. **Fetch radius.** The watch radius × `NET_SWEEP_MARGIN_FACTOR` (default 2, max 3), never above 50 NM, so aircraft are seen approaching and leaving.
4. **No double counting.** Live-view and sweep writes for the same aircraft sample share the provider record id, so the database keeps one row; `countRadiusVisits` (`netted-visits-v1`) only ever sees observations, so a visit is counted once however many writers saw it (unit-tested in `server/net.test.ts`).
5. **Visibility of failures.** The Netted tab, drawer and More panel show "Net active – last sweep 2 min ago". If the net is enabled and no sweep succeeded in the last 15 min, the state becomes `stale` and a warning is shown. `GET /api/health` reports `net.lastSweepAgeSeconds` (no secrets).

### Scheduling

A fast jet crosses a 7-mile radius in about two minutes, so 1-minute polling is ideal, but the default must work on Vercel Hobby (cron jobs there run at most once a day and a more frequent expression fails the deploy). Options:

| Option | Interval | Cost | Setup |
| --- | --- | --- | --- |
| **GitHub Actions** (`.github/workflows/net-sweep.yml`, included) | every 5 min, best effort (may be delayed; paused after 60 days of repo inactivity) | free | Secrets `AIRINTEL_SWEEP_URL` (e.g. `https://your-app.vercel.app/api/net/sweep`) and `CRON_SECRET`; Actions → Net sweep → Run workflow to test |
| **Vercel Pro cron** | every minute | Vercel Pro | add the snippet below, redeploy; Vercel sends `Authorization: Bearer $CRON_SECRET` itself |
| **External pinger** (cron-job.org, UptimeRobot, Cloudflare Worker cron…) | 1 min | free tiers | `POST https://your-app.vercel.app/api/net/sweep` with header `Authorization: Bearer <CRON_SECRET>` every minute |

Vercel Pro snippet (add to `vercel.json`; do **not** add it on Hobby):

```json
"crons": [{ "path": "/api/net/sweep", "schedule": "* * * * *" }]
```

You can run GitHub Actions and one other trigger together: the lease and `NET_SWEEP_MIN_INTERVAL_SECONDS` make extra calls harmless.

Coverage caveat: with 5-minute polling, a slow aircraft that is inside the radius for under 5 minutes can still be missed entirely. The log shows only what was observed; nothing is interpolated.

### Retention

`NET_RETENTION_DAYS` (≥ 7, unset by default = keep everything) makes each sweep delete positions older than that in bounded batches (at most every 6 hours). To inspect or purge manually: `npm run db:retention -- --days 90` (dry run) and `--apply`. Recommended: 90 days.

## Owner verification checklist

1. Run `npm run db:migrate` (applies `0005_net_watch_areas.sql`), set `CRON_SECRET`, and deploy the branch to a preview with `DATABASE_URL`/Neon Auth configured.
2. Sign in with an account that has `--scope history --scope profile`, keep the Map open for a few minutes near traffic, then open **Netted**: aircraft should appear with entry counts.
3. Confirm that a signed-out browser still sees live aircraft but `recording` is `not_signed_in` and no rows are written.
4. Close the app, wait for a sweep (or run Actions → Net sweep → Run workflow), then reopen: **More** should read "Net active – last sweep … ago" and passes made while closed appear under **Netted**.
5. Without the secret the sweep must refuse: `curl -i -X POST https://<domain>/api/net/sweep` → `401` (or `503` when `CRON_SECRET` is unset).
