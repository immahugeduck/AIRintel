# Skywatch → AIRIntel Integration Plan

## Decision

AIRIntel remains the canonical application and architecture. Skywatch is treated as a feature donor, not as a second runtime or framework to merge wholesale.

Do **not** import Skywatch's Express + Drizzle workspace architecture into AIRIntel. Port useful algorithms, contracts, UI concepts, and data semantics into AIRIntel's existing React/Vite + Supabase Edge Functions + PostgreSQL/PostGIS boundaries.

The integration branch is `integration/skywatch`. `main` must remain unchanged until each slice passes typecheck, tests, build, and review.

## Features selected from Skywatch

### P1 — Satellite awareness

Port these capabilities first:

- CelesTrak GP element acquisition.
- TLE parsing and source metadata.
- SGP4 propagation with `satellite.js`.
- Observer-relative elevation and azimuth.
- Current overhead-satellite query.
- Rise/set pass prediction with horizon-crossing refinement.
- Satellite class/category labels.
- Explicit source freshness and element-set age.

Skywatch implementation source:

- `artifacts/api-server/src/routes/aerial.ts`

AIRIntel targets:

- `src/domain/satellite.ts`
- `src/api/satellites.ts`
- `src/components/SkyWatchPanel.tsx`
- `src/components/SatelliteLayer.tsx`
- `supabase/functions/satellites-nearby/index.ts`
- `supabase/functions/satellite-passes/index.ts`

### P1 — Contact events

Preserve Skywatch's distinction between polling samples and distinct entries/passes, but redesign persistence for AIRIntel.

Do not copy Skywatch's `contacts` table directly. It is single-observer and stores accumulated client state as the authoritative record. AIRIntel should instead store event-oriented records tied to an authenticated owner and a watch zone/location.

Proposed entities:

- `tracked_objects`
- `satellites`
- `satellite_element_sets`
- `satellite_observations`
- `contact_events`

Aircraft identity remains in the existing aircraft tables. A generic tracked-object layer should be introduced only where it prevents duplicated map/timeline/event logic; it must not erase the evidence differences between ADS-B observations and propagated satellite positions.

Proposed `contact_events` semantics:

- `subject_kind`: `aircraft | satellite`
- `aircraft_id` or `satellite_id`
- `watch_zone_id`
- `entered_at`
- `exited_at`
- `closest_approach_m`
- `peak_elevation_deg` for satellites
- `sample_count`
- `source`
- `calculation_version`

A contact event is **Calculated**, not a raw observation.

### P2 — Local sky dashboard

Keep Skywatch's useful local question: **what is above this location right now?**

Add a SkyWatch view/module inside AIRIntel rather than a separate application. It should combine:

- nearby aircraft from approved AIRIntel aircraft providers;
- satellites calculated from current GP element sets;
- upcoming satellite passes;
- recent contact events;
- source freshness/health.

Do not combine aircraft and satellite positions into one canonical observation type. They have different provenance:

- aircraft coordinates are externally observed/reported;
- satellite coordinates are calculated from a published orbital element set at a specified propagation time.

The UI must label these correctly.

### P2 — Route enrichment review

Skywatch also uses ADSBDB for callsign-route and registration enrichment. Do not migrate this automatically. It must pass AIRIntel's provider onboarding gate first, including terms, provenance, null semantics, cache policy, and whether the data duplicates or conflicts with the planned FAA/official-data pipeline.

### P3 — Aircraft feed ideas

Skywatch contains working Airplanes.live → adsb.lol fallback logic. This is useful implementation evidence but must not bypass AIRIntel's provider gate. AIRIntel's existing provider-neutral adapter and explicit no-fabrication behavior remain authoritative.

## Features intentionally not copied as-is

- Skywatch Express API server.
- Skywatch pnpm monorepo structure.
- Drizzle database layer.
- Client-authoritative contact accumulation.
- A single global observer/contact namespace.
- Satellite `isVisible` as a factual optical-visibility claim based only on elevation/altitude.
- Internal HTTP calls from one server route to another for summary generation.
- Any estimated/fabricated metrics.

## Visibility terminology

Skywatch currently derives an `isVisible` boolean from a simple altitude/elevation heuristic. AIRIntel should replace this with separate calculated fields such as:

- `above_horizon`
- `elevation_deg`
- `sunlit` (only if actually calculated)
- `observer_in_darkness` (only if actually calculated)
- `optical_visibility_candidate` (only when supported by a documented deterministic method)

Do not state naked-eye visibility unless the implemented model supports that claim and lists its limitations.

## CelesTrak source contract

Official GP query documentation:

`https://celestrak.org/NORAD/documentation/gp-data-formats.php`

The supported query form is:

`https://celestrak.org/NORAD/elements/gp.php?{QUERY}=VALUE&FORMAT=VALUE`

AIRIntel will request an explicit format rather than relying on the provider default. TLE/3LE remains appropriate for the first port because `satellite.js` directly supports TLE propagation, but OMM JSON should be evaluated later for a more explicit structured ingestion format.

Initial groups to evaluate:

- `STATIONS`
- `VISUAL`
- `WEATHER`
- `IRIDIUM-NEXT`

Do not include very large constellations in expensive pass prediction loops until batching, caching, and compute budgets are tested.

## satellite.js contract

Upstream project:

`https://github.com/shashwatak/satellite-js`

Start with the version already proven in Skywatch (`7.0.1`) unless compatibility testing identifies a reason to use a later release.

Use it server-side for the first implementation so element acquisition, caching, propagation version, and calculation semantics remain controlled and auditable.

## Evidence model

Satellite features use AIRIntel's existing evidence vocabulary.

### Observed / sourced

- NORAD catalog ID.
- Object name from the selected source.
- Raw GP/TLE or OMM source record.
- Element epoch and source retrieval timestamp.

### Calculated

- propagated latitude/longitude/altitude at a specified time;
- observer-relative elevation/azimuth;
- rise time;
- set time;
- peak elevation;
- contact/pass event;
- distance/closest approach.

### Supported inference

- possible optical-visibility candidate, only if a documented visibility model is implemented;
- repeated local passes over a configured time window.

### Unknown unless separately sourced

- mission purpose;
- payload use at a particular moment;
- whether an imaging sensor was active;
- sensor pointing direction;
- whether the satellite observed a specific person/property.

## Implementation slices

### Slice 0 — integration contract

- [x] Create `integration/skywatch` branch.
- [x] Record migration decisions.
- [ ] Extend provider onboarding documentation for orbital data sources.
- [ ] Add satellite domain Zod contracts with fixtures that are clearly synthetic unit-test inputs, not purported provider data.

### Slice 1 — server-side satellite engine

- [ ] Add `satellite.js` dependency.
- [ ] Implement CelesTrak fetch/parser with explicit `FORMAT=TLE`.
- [ ] Cache source responses with retrieval timestamps.
- [ ] Propagate selected satellites at a requested UTC time.
- [ ] Add observer-relative elevation/azimuth.
- [ ] Add deterministic tests using published/sample TLE values clearly identified as test vectors.

### Slice 2 — pass prediction

- [ ] Port Skywatch's coarse step + binary-refined horizon crossing algorithm.
- [ ] Prebuild one `SatRec` per object per request.
- [ ] Apply explicit candidate caps.
- [ ] Fine-sample peak elevation.
- [ ] Return limitations and source-element age.

### Slice 3 — persistence

- [ ] Add satellite source/element tables.
- [ ] Add contact-event table with RLS.
- [ ] Associate events with authenticated user/watch zone.
- [ ] Keep calculated satellite positions separate from raw element records.

### Slice 4 — UI

- [ ] Add satellite map layer toggle.
- [ ] Add SkyWatch panel/view.
- [ ] Add upcoming passes.
- [ ] Add recent contact events.
- [ ] Display Observed vs Calculated provenance clearly.

### Slice 5 — optional donor features

- [ ] Review ADSBDB through provider gate.
- [ ] Review Airplanes.live/adsb.lol adapters through provider gate.
- [ ] Evaluate weather/sun-position data for visibility modeling.

## Acceptance criteria before merge to main

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- No secret or server credential is added to `VITE_*` variables.
- External providers have documented onboarding records.
- Satellite calculations include propagation timestamp, source retrieval timestamp, and source identity.
- No UI text represents propagated satellite coordinates as directly observed positions.
- Contact counting distinguishes dwell samples from distinct entry/pass events.
- RLS is enabled for every new exposed table.
- Large constellation queries cannot create unbounded propagation loops.
- AIRIntel aircraft behavior remains unchanged unless covered by new tests.
