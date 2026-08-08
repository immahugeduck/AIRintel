# AIRIntel

AIRIntel (AirRoute Intelligence) is an evidence-based live and historical aircraft analysis platform. Phase One establishes the Leaflet/MapQuest UI, strict aircraft observation contract, provider-neutral gateway boundary, and secured PostGIS foundation.

## Real-data policy

This repository contains no simulated or mock aircraft. Without approved MapQuest and aircraft-provider configuration, the application shows honest configuration-required states.

## Local setup

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Configure only browser-safe values in `VITE_*`. Aircraft-provider credentials and Supabase service-role credentials belong in Supabase Edge Function secrets, never `.env.local` values exposed through Vite.

## Verification

```powershell
npm run typecheck
npm test
npm run build
```

## Phase One status

- React, Vite, strict TypeScript, Leaflet, TanStack Query, and Zod foundation
- MapQuest layer activated only with approved browser configuration
- Canonical observation and radius-query validation
- Provider-neutral interface and safe browser gateway client
- Explicit provider-unconfigured, empty, refresh, and error states
- Phase 1 PostGIS migration with RLS and service-only ingestion
- Phase 2 authenticated registration/ICAO24/callsign search, atomic recorder transaction, 24-hour spatial replay, and per-source gap handling
- Phase 3 groundwork for authenticated aircraft-profile contracts, FAA storage boundaries, owner/operator separation, and per-source statistics; real FAA import and public profile deployment remain gated

Live aircraft remain blocked until the provider onboarding gate in `docs/provider-onboarding.md` is completed.

Phase Two implementation details and deployment gates are documented in `docs/phase-two-flight-recorder.md`.
