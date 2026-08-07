# AirRoute Intelligence

This repository is prepared for an initial Codex build.

## Start here

1. Read `AGENTS.md`.
2. Read `docs/AIRROUTE_PROJECT_BRIEF.md`.
3. Copy `.env.example` to `.env.local` when the app exists.
4. Paste the contents of `CODEX_START_PROMPT.txt` into the first Codex task.

## Important

- Do not add real credentials to the repository.
- Build with mock aircraft data first.
- Add live provider integrations only after documenting the exact provider, authentication method, rate limits, and storage terms.
- The first milestone is a working responsive map, canonical data model, provider adapter, database migration, tests, and clear setup documentation.

## Intended deployment

- Frontend: Vercel
- Database and initial server functions: Supabase
- Map engine: Leaflet
- Basemap: MapQuest
- Aircraft feeds: ADS-B provider and OpenSky
