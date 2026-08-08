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
- Apply migrations and run Supabase database/security advisors in staging.
- Verify role and grant matrices for anonymous, authenticated, profile-authorized, importer, and administrative identities.
- Replace process-local rate limits with a durable distributed limiter before public exposure.
- Implement transactional stage/publish/match processing, make unresolved conflicts dominant, and select only published time-applicable FAA snapshots.
- Move per-provider statistics into deterministic SQL aggregation without mixing altitude bases or globally biasing samples.
- Complete keyboard, screen-reader, and responsive-layout review against real authorized data.
