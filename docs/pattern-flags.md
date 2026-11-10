# Pattern flags (`pattern-flags-v1`)

A deterministic review-priority ranking for netted aircraft. Code: `src/domain/patterns.ts` (pure scoring),
`server/patterns.ts` (loads inputs), surfaced on `GET /history?action=netted` as `aircraft[].pattern`.

**What it is not.** Per AGENTS.md this never claims intent, mission, sensor use or surveillance. Training aircraft
fly turns around a point on purpose; medical, news, survey, pipeline and police flights loiter. A high score means
"look at this one first". Every reason carries an evidence label (Observed / Calculated / Supported inference / Unknown).

## Passes

1. **Routine explanations (weed out).** Scheduled airline/cargo flight numbers (`SCHEDULED_OPERATORS`), fractional/charter
   jets (`CHARTER_OPERATORS`), local training fleets (`TRAINING_FLEETS`: LIFT Academy `LTA*`, Vincennes University `N…VU`),
   cruise-altitude transit (median ≥ 10,000 ft), steady climb/descent (≥ 60% of samples at |VS| ≥ 500 fpm).
2. **Behavior inside the radius.** Circling (net heading change ≥ 300° in one visit, ≥ 4 track samples; S-turns cancel),
   orbit centroid within 2 NM of the watch center, dwell ≥ 15 min, low and slow (median ≤ 6,000 ft and ≤ 140 kt).
3. **Correlation with your locations.** The same airframe logged at ≥ 2 of your watch centers ≥ 20 NM apart (circles that
   cannot overlap). Disabled for cruise-altitude transit. This is the only pass that tests "follows me" rather than
   "flies around here", and it needs the watch center to actually move with you (see Limitations).

Plus recurrence (≥ 5 entries on ≥ 3 days; weight 0 for routine operators) and identity gaps (no callsign / registration).

Tiers: `routine` (explained by pass 1 and no pass-3 hit), `priority` (score ≥ 7), `review` (≥ 4), `low`.
Log scope scores the newest 20 encounters per aircraft with their recorded positions; window scope uses the window's
positions and cannot run pass 3.

## Limitations (Unknown, not guessed)

- The watch center is set once per tap of **Use my current location**; it does not follow the phone. Pass 3 can only
  fire for places where a center was actually set.
- With 5-minute sweeps most visits have 1–2 positions, so circling is only detectable while the app is open (live view)
  or with 1-minute polling. Such aircraft are marked `coverage: "sparse"`.
- Lists are regional defaults; extend `TRAINING_FLEETS` for your area.

## UI and export

Netted cards show a badge (Priority review / Review / Routine · reason) and a "Why flagged" list. A filter row offers
All / Flagged / Hide routine (sorted by tier then score). CSV adds `latest_entry_center_lat/lon`, `pattern_tier`,
`pattern_score`, `pattern_reasons`.
