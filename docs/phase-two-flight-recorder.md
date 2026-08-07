# Phase Two: Flight Recorder

## Delivered scope

- Immutable real-observation storage remains separate from restricted raw payload storage.
- Aircraft can be searched by ICAO24 or registration through a server-only history gateway.
- A bounded 24-hour track query returns at most 10,000 ordered observations.
- Replay uses only actual observations and labels reception gaps over 120 seconds.
- Flight and flight-position tables are ready for a later deterministic reconstruction job.
- Registration aliases retain source/time bounds, and historical points use the registration observed with that position rather than the mutable aircraft summary.
- Ingestion runs record counts and safe error codes without provider secrets or request geometry.

## Deliberately blocked

- No migration is applied without a connected non-production Supabase project.
- Legacy Phase One rows may keep nullable provenance fields; new recorder RPC writes always supply a dedupe key and normalization version. A future audited backfill may tighten those columns without inventing legacy provenance.
- No provider payload is persisted until storage and redistribution rights are documented.
- Callsign lookup searches observations and returns aircraft matches without treating callsign as stable aircraft identity.
- Flight reconstruction is schema-ready but not activated until real observation cadence and gap behavior can be measured.

## Deployment checks still required

Run Supabase migrations and database advisors in staging, verify browser roles cannot query protected tables, verify the service function can search and retrieve tracks, and test idempotent inserts using legally retained real observations.

History requires a verified non-anonymous Supabase user whose server-controlled `app_metadata.airintel_access` value is `true`. The function also applies a per-user in-memory burst limit; production deployment still requires a durable distributed rate limiter.
