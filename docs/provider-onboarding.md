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

## Documented aircraft provider: adsb.lol

Status: **approved for the live `/aircraft-nearby` gateway** (public community feed).

| Field | Value |
| --- | --- |
| Vendor / product | adsb.lol open data API (readsb/tar1090-compatible JSON) |
| Docs | https://www.adsb.lol/docs/open-data/api/ and https://api.adsb.lol/docs |
| Auth | None for anonymous read. Optional future feeder API keys are not required. |
| Query | `GET {base}/v2/lat/{lat}/lon/{lon}/dist/{radiusNm}` — radius in **nautical miles**, max 250 |
| Default base | `https://api.adsb.lol` |
| Units | lat/lon decimal degrees; `alt_*` feet; `gs` knots; `track` degrees; `*_rate` ft/min; `seen` / `seen_pos` seconds |
| Null / sentinels | Missing lat/lon → drop row. `alt_baro` may be the string `"ground"`. `emergency: "none"` → treat as absent |
| Timestamps | Response `now` is Unix epoch **milliseconds**. Observation time ≈ `now - seen_pos*1000` (fallback `seen`) |
| Rate limits | Dynamic / load-based. Treat 429/5xx as upstream failure; do not invent aircraft |
| Licensing | ODbL 1.0 — preserve attribution in product docs; do not claim ownership of raw ADS-B |
| Cache | No long-term redistribution of raw payloads beyond the flight-recorder tables AIRIntel already gates behind auth |
| AIRIntel env | `ADSB_PROVIDER=adsb_lol` (default when unset). `ADSB_PROVIDER=off` disables. `ADSB_API_BASE_URL` optional override |

OpenSky and keyed commercial ADS-B products remain gated until their rows in this document are completed.
