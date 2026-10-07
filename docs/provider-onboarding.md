# External Data Provider Onboarding Gate

AIRIntel does not connect an external aviation or orbital-data source until its contract and evidence semantics are documented. Missing provider configuration must produce an explicit unavailable/configuration-required state rather than invented data.

## Aircraft / ADS-B providers

Before live aircraft integration, record:

- Exact ADS-B vendor and product.
- Official API documentation URL.
- Authentication method and permitted server-side handling.
- Radius/bounding-box semantics, maximum query area, pagination, and record caps.
- Field dictionary, units, null/sentinel values, and timestamp semantics.
- Rate limits, burst policy, polling cadence, and retry guidance.
- Storage, caching, display, attribution, redistribution, and derived-data rights.
- Historical/track coverage and retention.
- Initial center, radius, and polling interval.
- OpenSky role: fallback or independent corroborating source, plus its auth/limits/terms.
- MapQuest plan, browser-key allowance, tile URL, limits, and attribution requirements.

## Orbital element providers

Before satellite integration, record:

- Exact catalog/source and official documentation URL.
- Query/API format and supported identifiers/groups.
- Requested data format (for example TLE/3LE or OMM JSON); never depend silently on a provider default.
- Element epoch semantics and source retrieval timestamp.
- Update cadence and recommended cache interval.
- Rate/query restrictions and guidance for automated clients.
- Attribution, storage, redistribution, and derived-calculation rights.
- Handling of stale, malformed, missing, duplicate, or decayed-object records.
- Maximum candidate set permitted for synchronous propagation/pass prediction.
- Propagation library and version used to calculate positions.
- Calculation timestamp and coordinate/reference-frame transformations.

### CelesTrak candidate

Skywatch currently uses CelesTrak GP data. AIRIntel may adopt it only through the server-side orbital adapter.

Official documentation:

- `https://celestrak.org/NORAD/documentation/gp-data-formats.php`

Query family:

- `https://celestrak.org/NORAD/elements/gp.php?{QUERY}=VALUE&FORMAT=VALUE`

The first implementation should request `FORMAT=TLE` explicitly because the donor algorithm uses `satellite.js` TLE parsing. OMM JSON should be evaluated separately before changing the canonical source-record format.

A propagated satellite coordinate is **Calculated** from an orbital element set. It must not be labeled as a directly observed position. Preserve the raw source record, source identity, element epoch, retrieval time, propagation time, and calculation/library version needed to reproduce the result.

## Provider fixtures

Real captured payload fixtures may be added only when provider terms allow it and sensitive values are redacted. They must never be invented and labeled as provider data.

Synthetic fixtures are permitted for unit tests only when they are conspicuously labeled as synthetic/test vectors and are never exposed as real-world observations.
