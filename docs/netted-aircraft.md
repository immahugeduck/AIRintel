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
- No new table or migration: counts are derived from `public.aircraft_positions` on every request.

## Live view → recorder

`GET /aircraft-nearby` remains public. When the request carries a valid Neon Auth JWT whose user holds the `history` grant, the observations just returned by adsb.lol are written through `recordObservations` → `public.record_aircraft_observation` (dedupe by provider record id, raw row kept in `airintel_private.raw_observations`). Limits: radius ≤ 50 NM, 12 writes/min per user, 6 s wait budget. The response field `recording` reports `recorded`, `not_signed_in`, `no_history_access`, etc. Anonymous callers never write.

## Owner verification checklist

1. Deploy the branch to a preview with `DATABASE_URL`/Neon Auth configured (migrations 0001–0004 already applied; this change adds none).
2. Sign in with an account that has `--scope history --scope profile`, keep the Map open for a few minutes near traffic, then open **Netted**: aircraft should appear with entry counts.
3. Confirm that a signed-out browser still sees live aircraft but `recording` is `not_signed_in` and no rows are written.
