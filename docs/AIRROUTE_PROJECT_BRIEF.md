# AIRIntel Project Brief

AIRIntel is a responsive aviation-data and geospatial-analysis platform that converts live and historical ADS-B observations into transparent, evidence-based route intelligence.

## Product outcomes

- View real live aircraft on a Leaflet/MapQuest map.
- Search by registration, ICAO24, callsign, operator, or organization.
- Preserve raw observations and normalize them into a provider-neutral contract.
- Reconstruct and replay flights without rewriting raw evidence.
- Analyze selected points, radii, corridors, and polygons.
- Detect geometric patterns using documented deterministic methods.
- Build aircraft and organization profiles with source and match confidence.
- Clearly separate observed data, calculations, supported inference, and unknowns.

## Phase One: Foundation

The milestone is “I can watch airplanes live.” It includes repository foundation, React/Vite, Leaflet with MapQuest, a server-only provider gateway, ADS-B and OpenSky adapters after their contracts are documented, real aircraft markers, freshness, radius queries, and search by registration/ICAO24/callsign.

Because simulated or mock data is prohibited, missing provider configuration produces an explicit configuration-required state. It does not produce demo aircraft.

## Canonical observation

Every observation includes provider, ICAO24, coordinates, observed and received UTC timestamps, optional registration/callsign, explicit altitude provenance, ground speed, track, vertical rate, and other documented optional fields. Missing fields remain unknown. Provider payloads are validated at the server boundary and raw payloads remain in restricted server-side storage.

## Phases after the live pipeline

1. Secured persistence and replay
2. Aircraft profiles and FAA matching
3. Watch zones and proximity
4. Route intelligence: orbits, loitering, repeated passes, grids, racetracks
5. Route comparison with transparent metrics
6. Organization and nonprofit matching
7. Investigation workspace and Flight DNA baselines
8. Restricted AI query and evidence-summary layer

Advanced analytics must not precede a reliable live pipeline and secured persistence.
