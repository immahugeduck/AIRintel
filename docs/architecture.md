# AIRIntel Phase One Architecture

## Decision

Phase One is split into **1A: read-only live feed** and **1B: secured persistence**. The browser never contacts an aircraft provider directly. It calls a server-side provider gateway that validates spatial inputs, enforces quotas, normalizes documented provider payloads, and returns a safe observation DTO.

No keys or provider contract means an explicit configuration-required state. AIRIntel does not generate fallback aircraft, tracks, or provider responses.

## Boundaries

- `src/domain`: strict Zod contracts, UTC timestamps, aviation units, provenance rules.
- `src/providers`: provider-neutral interface and typed configuration errors.
- `src/api`: safe browser client for a server-side aircraft gateway.
- `src/components`: Leaflet/MapQuest presentation and evidence-oriented states.
- `supabase/functions`: server-only provider integration point.
- `supabase/migrations`: PostGIS storage with RLS and no browser writes.

## Provider gate

Before a provider adapter is implemented, record its official documentation URL, authentication scheme, units/null semantics, quotas, storage and redistribution terms, attribution, allowed cache duration, historical availability, and error behavior in `docs/provider-onboarding.md`.

## Evidence rules

The UI uses the vocabulary Observed, Calculated, Supported inference, and Unknown. Track direction is not labeled aircraft heading. Ground speed is not airspeed. Barometric, geometric, and provider altitude remain distinct. Missing fields remain unknown. Reception gaps are never interpolated as observed positions.
