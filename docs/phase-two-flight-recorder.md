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

- No migration is applied to production without first running it on a non-production Neon branch (`npm run db:migrate`, then `TEST_DATABASE_URL=... npm test`).
- Legacy Phase One rows may keep nullable provenance fields; new recorder RPC writes always supply a dedupe key and normalization version. A future audited backfill may tighten those columns without inventing legacy provenance.
- No provider payload is persisted until storage and redistribution rights are documented.
- Callsign lookup searches observations and returns aircraft matches without treating callsign as stable aircraft identity.
- Flight reconstruction is schema-ready but not activated until real observation cadence and gap behavior can be measured.

## Deployment checks still required

Run the migrations on a staging Neon branch, verify browser roles cannot query protected tables (covered by `server/neon.integration.test.ts`), verify the API can search and retrieve tracks, and test idempotent inserts using legally retained real observations.

History requires a verified Neon Auth user (valid EdDSA JWT from the Neon Auth issuer) who holds the `history` scope in `airintel_private.access_grants` (`npm run access:grant -- --email <email> --scope history`); the profile route requires the `profile` scope. The API also applies a per-user in-memory burst limit; production deployment still requires a durable distributed rate limiter.
