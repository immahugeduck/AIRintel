# AGENTS.md — Instructions for Codex

## Mission

Build AirRoute Intelligence as a reliable, transparent aviation-data and geospatial-analysis application.

Read `docs/AIRROUTE_PROJECT_BRIEF.md` before making architectural or domain changes.

## Working principles

1. Start with the smallest end-to-end vertical slice.
2. Prefer deterministic calculations over AI guesses.
3. Separate:
   - raw source data,
   - normalized observations,
   - derived flights,
   - analytical findings.
4. Never silently fabricate missing aircraft fields.
5. Preserve source name and timestamps on every observation.
6. Never expose or commit secrets.
7. Keep the ADS-B provider behind an adapter interface.
8. Use Leaflet as the map engine; MapQuest is the initial basemap provider.
9. Use PostgreSQL/PostGIS for spatial queries.
10. Add tests for normalizers and important geospatial logic.
11. Explain uncertainty and track gaps in both code and UI.
12. Do not claim aircraft intent, passengers, surveillance, or mission purpose from route geometry alone.

## Required evidence vocabulary

Analytical UI and generated reports must distinguish:

- **Observed**
- **Calculated**
- **Supported inference**
- **Unknown**

Do not label a movement pattern as a fact when it is an inference.

## Code quality

- TypeScript strict mode.
- Avoid `any` unless wrapping untyped provider payloads at a boundary.
- Validate external data with Zod.
- Use small pure functions for normalization and calculations.
- Use UTC internally.
- Include units in field names where ambiguity is possible.
- Provide useful error states.
- Do not draw solid tracks across large data gaps without an uncertainty indicator.
- Keep accessibility and mobile layouts in scope.

## Security

- Real keys must only be supplied through environment variables.
- Never print keys in logs.
- Never place server secrets in Vite `VITE_*` variables.
- Supabase service-role key is server-only.
- Validate radius, bounding box, date range, and search inputs.
- Apply rate limiting and caching before public deployment.

## Workflow for each task

1. Inspect existing files and git status.
2. Summarize the planned change.
3. Implement the smallest coherent change.
4. Run formatter, typecheck, tests, and build.
5. Fix failures caused by the change.
6. Summarize:
   - files changed,
   - commands run,
   - test/build results,
   - assumptions,
   - blockers,
   - recommended next task.

## Initial build order

1. Repository scaffolding.
2. Mock provider.
3. Canonical types and Zod schemas.
4. MapQuest/Leaflet map.
5. Provider adapters.
6. Supabase migration and persistence.
7. Track replay.
8. Watch zones.
9. Route intelligence.
10. Organization intelligence.
11. AI query layer.

Do not jump ahead to advanced AI features before the live-map and persistence pipeline works.
