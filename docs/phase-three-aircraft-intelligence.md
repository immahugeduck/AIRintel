# Phase Three Groundwork: Aircraft Intelligence

This branch establishes contracts, storage boundaries, a configuration-gated UI, and an operator validation command. It is not yet a completed FAA import/matching integration and must not be deployed publicly or populated with real FAA raw rows until every deployment gate below is complete.

## Scope

Aircraft Profile v1 combines only three evidence classes: identifiers observed by AIRIntel, facts from an explicitly imported official FAA registry snapshot, and deterministic statistics calculated from retained real observations. It does not infer the operator, occupants, mission, equipment, home base, or intent.

## FAA source contract

- Source: FAA Releasable Aircraft Database and accompanying layout documentation.
- Every import records the official URL, filename, SHA-256, snapshot date, importer version, schema version, counts, and status.
- Raw rows remain in `airintel_private`; browser DTOs never include exact street addresses or raw rows.
- Raw staging rows expire after 30 days. Before any real import, schedule and monitor `purge_expired_faa_registry_raw()` and separately remove expired source archives and backups.
- Permissible blank FAA fields are Unknown, not ingestion failures.
- Withheld or natural-person owner information is not repopulated from older releases or secondary sources.
- Registry snapshots are immutable and time-scoped. Present registry facts are not projected backward onto historical flights.

## Match rules

Exact FAA Mode-S hex to observed ICAO24 is the primary supported match. Exact registration string may corroborate a record but does not override a Mode-S conflict. Every match stores method, status, matcher version, limitations, and manual-review status.

## Calculated statistics

Statistics are grouped by provider, cover an explicit UTC window, include only observations explicitly marked airborne, use a minimum of 20 non-null samples per metric, and report median plus p10/p90 values. They are observation statistics, not flight counts. Provider coverage and retention limitations remain visible. Mixed altitude bases and globally truncated provider samples remain deployment blockers for the current scaffold.

## Deployment gates

- Import an official FAA snapshot through a hardened staging/validation workflow.
- Apply migrations (`npm run db:migrate`) to a staging Neon branch and review Neon's schema/security checks (Data API advisors are not applicable while the Data API stays disabled).
- Verify role and grant matrices for anonymous, authenticated, profile-authorized, importer, and administrative identities.
- Replace process-local rate limits with a durable distributed limiter before public exposure.
- Implement transactional stage/publish/match processing, make unresolved conflicts dominant, and select only published time-applicable FAA snapshots.
- Move per-provider statistics into deterministic SQL aggregation without mixing altitude bases or globally biasing samples.
- Complete keyboard, screen-reader, and responsive-layout review against real authorized data.


## Read-only resolution improvement (November 8, 2026)

The profile API can now resolve exact Mode-S matches without precomputed match
rows, using only the latest published, non-future FAA snapshot. This does not
import or publish data, persist matches, or complete the deployment gates above.
An absent record in the latest snapshot never falls back to an older owner.
Unresolved conflicts, rejected decisions, duplicate exact matches, mismatched
registration/Mode-S evidence, and retained non-ICAO namespace contamination fail
closed. Automatic matching also needs retained ICAO provenance or a verified
existing exact match. Public owner/natural-person redaction rules still apply.

The optional `registryMatch.unavailableReason` distinguishes no published source,
no exact match, missing identity provenance, and conflicts; older API responses
remain accepted. Tests exercise the actual registry migration and SQL inside an
ephemeral PGlite PostgreSQL instance containing labeled synthetic vectors only.
Neon Auth/role/grant integration still requires the separate throwaway-branch tests.

The runtime database role needs SELECT access to import-run metadata and retained
raw observations, in addition to its existing profile tables. No role/grant changes
are made by this patch. Production population and signed-in profile behavior have
not been verified, and no real database has been populated or modified.


## FAA import (November 10, 2026)

`npm run faa:import` loads an official FAA Releasable Aircraft Database snapshot (`scripts/lib/faa.mjs`):

1. Download `ReleasableAircraft.zip` from faa.gov (Aircraft Registry → Releasable Aircraft Database) and unzip it.
2. Stage it (no user-visible change):
   `DATABASE_URL_UNPOOLED=... npm run faa:import -- --input MASTER.txt --acftref ACFTREF.txt --snapshot-date <date on the FAA page>`
3. Review the JSON summary (row counts, error codes; no names), then publish the same file:
   `... npm run faa:import -- --input MASTER.txt --acftref ACFTREF.txt --snapshot-date <same date> --publish`
   The file is recognized by SHA-256, so publishing only promotes the validated run.

One transaction per run: expired raw rows are purged first (`purge_expired_faa_registry_raw()`), each row is staged in
`airintel_private.faa_registry_raw` (accepted / quarantined, 30-day retention) and accepted rows go to
`public.aircraft_registry_records`. More than 5% quarantined rows marks the run `rejected` (never published).
Street address lines and ZIP codes are dropped before anything is stored. Natural-person registrants (individuals,
co-owners) are stored as `individual_redacted` with no name; only business, government, partnership and LLC
registrants are displayable. Re-run the import (and therefore the purge) at least monthly; the raw-row purge still has
no scheduler of its own.

Once a snapshot is published, the profile view resolves owners as described above, and the Netted list shows the
FAA N-number (marked "(FAA)") for aircraft that broadcast no registration — exact, unique Mode-S match only, failing
closed on rejected or conflicting persisted matches (`lookupRegistryRegistrations`). That also clears the
"No registration on record" identity-gap reason in pattern flags.
