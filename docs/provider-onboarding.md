# Live Provider Onboarding Gate

Phase One live integration is blocked until these facts are supplied from official provider materials:

- Exact ADS-B vendor and product
- Official API documentation URL
- Authentication method and permitted server-side handling
- Radius/bounding-box semantics, maximum query area, pagination, and record caps
- Field dictionary, units, null/sentinel values, and timestamp semantics
- Rate limits, burst policy, polling cadence, and retry guidance
- Storage, caching, display, attribution, redistribution, and derived-data rights
- Historical/track coverage and retention
- Initial center, radius, and polling interval
- OpenSky role: fallback or independent corroborating source, plus its auth/limits/terms
- MapQuest plan, browser-key allowance, tile URL, limits, and attribution requirements

Real captured payload fixtures may be added only when the provider terms allow it and sensitive values are redacted. They must never be invented and labeled as provider data.
