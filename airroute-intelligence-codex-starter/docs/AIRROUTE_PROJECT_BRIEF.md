# AirRoute Intelligence — Master Project Brief

## 1. Product Definition

**Project name:** AirRoute Intelligence  
**Working abbreviation:** ARI

AirRoute Intelligence is a responsive web application that combines live and historical aircraft data with geospatial analysis. It should convert raw ADS-B observations into transparent, evidence-based route intelligence.

The product must help a user:

- View live aircraft on a map.
- Search by registration, ICAO hex, callsign, operator, or organization.
- Save raw aircraft observations.
- Reconstruct individual flights.
- Replay historical tracks.
- Compare two aircraft routes.
- Analyze activity around a selected address, point, radius, corridor, or polygon.
- Detect orbits, loitering, hovering, repeated passes, survey-like grids, racetrack patterns, low-speed maneuvering, and infrastructure-following behavior.
- Build an aircraft profile from FAA registration, operator, organization, and historical behavior.
- Clearly separate observed facts, calculated findings, supported inferences, and unknowns.

This application is an analytical tool. It must not present speculation about pilot intent, passengers, surveillance, or mission purpose as established fact.

---

## 2. MVP Scope

The first usable MVP must prove the full pipeline:

1. Display a MapQuest basemap through Leaflet.
2. Accept a center coordinate and search radius.
3. Retrieve nearby aircraft from the configured ADS-B provider.
4. Optionally supplement or cross-check using OpenSky.
5. Normalize both provider formats into one internal observation model.
6. Render aircraft markers with heading, altitude, speed, callsign, registration, and source.
7. Save position observations to Supabase/PostgreSQL.
8. Show the recent track for a selected aircraft.
9. Search previously observed aircraft by registration, ICAO hex, or callsign.
10. Display source freshness and last-received timestamps.
11. Never expose private API keys in browser code.

Do not attempt the complete AI investigator, nonprofit matching, historical bulk imports, or advanced behavior classification until this data pipeline works reliably.

---

## 3. Recommended Stack

### Frontend
- React
- Vite
- TypeScript
- Leaflet
- MapQuest raster tiles or MapQuest-supported Leaflet integration
- TanStack Query
- Zod
- Optional later: Tailwind CSS

### Backend
Choose one:
- **Preferred initial approach:** Supabase Edge Functions
- **Alternative when analytics become heavier:** Python FastAPI service

### Storage
- Supabase PostgreSQL
- PostGIS extension
- Row Level Security where browser access is permitted
- Service-role access only from server-side code

### Hosting
- Vercel for the frontend
- Supabase for database, auth, scheduled jobs, and initial server functions
- GitHub for source control

### Later analytics
- Python
- GeoPandas
- Shapely
- H3
- NumPy/SciPy
- scikit-learn only where deterministic geospatial methods are insufficient

---

## 4. Data Sources

### Existing
- ADS-B provider API
- OpenSky API
- MapQuest API/key

### Add later without paid APIs where practical
- FAA aircraft registry bulk files
- FAA airport/runway data
- IRS Exempt Organizations Business Master File
- IRS Form 990 bulk data or selected filing metadata
- Public infrastructure datasets
- Weather observations
- NOTAM/TFR data
- Terrain/elevation data

### Provider abstraction requirement
Do not couple the database or frontend directly to one ADS-B provider. Create adapters with the same output contract.

Suggested interface:

```ts
interface AircraftProvider {
  getAircraftInRadius(input: RadiusQuery): Promise<NormalizedAircraftObservation[]>;
  getAircraftByIcao?(icao24: string): Promise<NormalizedAircraftObservation[]>;
  getTrack?(icao24: string, start: string, end: string): Promise<NormalizedAircraftObservation[]>;
}
```

---

## 5. Canonical Observation Model

```ts
export interface NormalizedAircraftObservation {
  provider: string;
  providerRecordId?: string;

  icao24: string;
  registration?: string | null;
  callsign?: string | null;

  latitude: number;
  longitude: number;

  geometricAltitudeFt?: number | null;
  barometricAltitudeFt?: number | null;
  altitudeFt?: number | null;
  altitudeSource?: "geometric" | "barometric" | "provider" | null;

  groundSpeedKt?: number | null;
  trackDeg?: number | null;
  verticalRateFpm?: number | null;

  squawk?: string | null;
  onGround?: boolean | null;
  emergencyStatus?: string | null;

  aircraftTypeCode?: string | null;
  category?: string | null;

  observedAt: string;
  receivedAt: string;

  raw: unknown;
}
```

Rules:

- Preserve provider raw data for debugging.
- Use UTC ISO-8601 timestamps.
- Do not infer missing altitude or speed values silently.
- Track whether altitude is barometric or geometric when known.
- Keep multiple-source observations rather than overwriting one source with another.

---

## 6. Initial Database Model

Core entities:

- `aircraft`
- `aircraft_aliases`
- `aircraft_positions`
- `flights`
- `flight_positions`
- `watch_zones`
- `zone_events`
- `orbit_events`
- `behavior_findings`
- `route_comparisons`
- `organizations`
- `aircraft_ownership`
- `data_sources`
- `ingestion_runs`

### Raw observations versus reconstructed flights

These must remain separate.

**Raw observation:** one provider report at one timestamp.

**Reconstructed flight:** a derived grouping of observations believed to belong to one continuous flight.

Never delete or rewrite raw observations merely because reconstruction logic changes.

---

## 7. Route Intelligence Requirements

### A. Orbit detection

Detect a probable orbit only when the geometry and time series support it.

Consider:

- Accumulated heading change
- Repeated returns near an estimated center
- Radius consistency
- Minimum duration
- Number of revolutions
- Position gaps
- Speed suitability for aircraft category

Output:

```json
{
  "pattern": "orbit",
  "startedAt": "...",
  "endedAt": "...",
  "estimatedCenter": {"lat": 0, "lon": 0},
  "meanRadiusMeters": 0,
  "radiusStdDevMeters": 0,
  "estimatedRevolutions": 0,
  "confidence": 0.0,
  "evidence": [],
  "limitations": []
}
```

### B. Loitering

Loitering means prolonged presence within a bounded area. It does not imply intent.

Calculate:

- Dwell time
- Convex hull or buffered area
- Median speed
- Heading-change frequency
- Distance from selected point
- Reception gaps

### C. Behavior labels

Supported labels may include:

- Point-to-point transit
- Airport traffic-pattern activity
- Orbit
- Racetrack
- Hover or near-hover
- Low-speed maneuvering
- Survey-grid-like pattern
- Repeated passes
- Search-pattern-like movement
- Infrastructure-following candidate
- Agricultural-pattern candidate
- Training-like movement
- Unclassified

Every label requires:

- Confidence score
- Measured evidence
- Alternative explanations
- A clear statement that mission intent remains unknown unless independently documented

### D. Route comparison

Compare two tracks using several transparent metrics:

- Time overlap
- Minimum horizontal separation
- Altitude separation
- Buffered route overlap
- Shared H3 cells
- Hausdorff distance
- Fréchet distance where practical
- Shared airports
- Repeated same-area/different-time events

Do not compress these into one unexplained “connection score.”

---

## 8. Evidence Standard

Every analytical response must use this structure:

### Observed
Directly supplied by a data source or calculated from raw coordinates:
- Position
- Timestamp
- Altitude
- Speed
- Heading
- Route geometry
- Registration record
- Published operator data

### Calculated
Deterministic results:
- Closest pass
- Time in zone
- Orbit count
- Similarity metrics
- Repeated-visit count

### Supported inference
A qualified interpretation:
- “The movement resembles flight training.”
- “The route follows the corridor within the configured tolerance.”

### Unknown
Not established by the available data:
- Pilot identity for a particular flight
- Passengers
- Camera direction
- Whether recording occurred
- Mission purpose
- Why a pilot chose a particular maneuver

Use terms such as **possible**, **consistent with**, and **not established** accurately.

---

## 9. Aircraft and Organization Intelligence

### FAA matching
Match ADS-B `icao24` and registration to FAA records where available.

Store:

- Registration
- Registered owner
- Owner type
- Manufacturer
- Model
- Serial number
- Registration status
- Registry source and update date

### Organization classification
Later, match registered owners to:

- Companies
- LLCs
- Government agencies
- Universities
- Hospitals
- Nonprofits
- Religious organizations
- Foundations

### Nonprofit matching
Use IRS exempt-organization datasets.

A nonprofit match must include:

- Match method
- Match confidence
- Name normalization result
- State/address agreement
- Manual-review status

Distinguish:

- Registered owner
- Probable operator
- Associated organization
- Actual operator unknown

Never equate ownership automatically with who was operating a particular flight.

---

## 10. Map and User Experience

### Basemap
Use Leaflet as the map engine and MapQuest as the default basemap.

Reason:
- Leaflet prevents hard coupling to one tile provider.
- The basemap can be replaced later without rewriting geospatial features.

### Primary screens

1. **Live Map**
2. **Aircraft Profile**
3. **Flight Replay**
4. **Location Intelligence**
5. **Route Comparison**
6. **Organization Search**
7. **Saved Investigations**
8. **System/Data Health**

### Aircraft marker behavior
- Rotate to heading.
- Visually distinguish helicopters, fixed-wing aircraft, and unknown types.
- Show freshness.
- Do not animate across large gaps as if the path were known.
- Mark stale tracks clearly.

### Track gaps
Do not draw a continuous solid line across long reception gaps without marking the segment as uncertain.

---

## 11. Security and Privacy

- Never commit real API keys.
- Browser receives only safe public configuration.
- ADS-B, OpenSky, MapQuest secret usage, Supabase service role, and OpenAI keys belong in server-side environment variables.
- Validate all user input.
- Rate-limit public endpoints.
- Add API response caching.
- Log provider errors without logging secrets.
- Avoid exposing private addresses in public deployments.
- Saved personal watch zones should be private to the authenticated user.
- Do not build features for identifying private individuals aboard aircraft.

---

## 12. Performance and Cost Controls

- Poll only the active viewport or configured watch zones.
- Cache provider responses briefly.
- Deduplicate observations by aircraft, source, and timestamp.
- Batch database inserts.
- Use spatial indexes.
- Apply retention policies to raw high-frequency data if storage grows significantly.
- Downsample old tracks for map rendering while preserving raw evidence separately.
- Track provider quota usage.

---

## 13. Initial Repository Structure

```text
airroute-intelligence/
├── AGENTS.md
├── README.md
├── .env.example
├── apps/
│   ├── web/
│   └── ingestion/
├── packages/
│   ├── aircraft-types/
│   ├── provider-adapters/
│   ├── geo-analysis/
│   └── shared/
├── supabase/
│   ├── migrations/
│   ├── functions/
│   └── seed.sql
├── docs/
│   ├── AIRROUTE_PROJECT_BRIEF.md
│   ├── architecture.md
│   ├── data-dictionary.md
│   ├── evidence-standard.md
│   └── route-analysis-methods.md
└── tests/
```

A simpler structure is acceptable for the first commit, but preserve clear boundaries between frontend, provider adapters, persistence, and analytics.

---

## 14. Development Phases

### Phase 0 — Repository and contracts
- Initialize repository.
- Write README.
- Add environment template.
- Add canonical types.
- Add schema migration.
- Add mocked provider adapter.
- Add tests for normalization.

### Phase 1 — Live aircraft map
- Leaflet + MapQuest.
- Radius/viewport query.
- ADS-B adapter.
- OpenSky adapter.
- Live markers.
- Aircraft detail drawer.
- Source freshness.

### Phase 2 — Persistence and replay
- Save observations.
- Search aircraft.
- Recent track.
- Flight reconstruction v1.
- Replay timeline.
- Track-gap handling.

### Phase 3 — Watch zones
- Radius and polygon drawing.
- Save private zones.
- Detect entries/exits.
- Repeated visitor report.
- Closest-pass calculations.

### Phase 4 — Route intelligence
- Orbit detection.
- Loitering detection.
- Repeated-pass detection.
- Behavior findings with evidence and confidence.
- Nearby airport/context matching.

### Phase 5 — Comparison
- Two-aircraft comparison.
- Shared-area analysis.
- Time-aware proximity.
- Similarity methods.
- Explanation panel.

### Phase 6 — Ownership and organizations
- FAA bulk import.
- Organization matching.
- IRS nonprofit matching.
- Confidence and manual review.

### Phase 7 — AI query layer
- Natural-language requests translated into restricted, validated query plans.
- AI summarizes returned data only.
- No unrestricted generated SQL against production.
- Include citations to internal records and calculation methods.

---

## 15. Definition of Done for the First Codex Task

The first task is complete only when:

- The repo installs successfully.
- The app starts locally.
- A MapQuest-backed Leaflet map renders.
- Mock aircraft appear when no provider keys are configured.
- Environment variables are documented.
- A canonical observation type exists.
- At least one provider adapter interface exists.
- Supabase SQL migration exists.
- Tests for normalization pass.
- README includes exact local commands.
- No secrets are committed.
- Codex reports changed files, commands run, test results, and remaining blockers.

---

## 16. First Real Data Integration Questions

Before enabling production polling, record:

1. Exact ADS-B provider name.
2. API documentation URL.
3. Authentication method.
4. Rate limits.
5. Historical data availability.
6. Terms regarding storage and redistribution.
7. OpenSky authentication method and limits.
8. MapQuest plan and tile/API usage limits.
9. Desired initial watch area.
10. Desired polling interval.

Build provider-neutral mocks first so missing answers do not block repository setup.
